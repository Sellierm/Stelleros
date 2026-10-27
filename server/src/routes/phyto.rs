use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use chrono::NaiveDate;
use serde_json::{Map, Value, json};
use sqlx::{MySql, Row, Transaction};

use super::require_user;
use crate::db::{bind_json, row_to_json, rows_to_json};
use crate::js;
use crate::middleware::{fail, json_response, query_values, read_body};
use crate::state::AppState;

/// Erreurs qui faisaient échouer le `try` côté Node (→ rollback + 500).
enum Failure {
    Db(sqlx::Error),
    /// Équivalent d'un `TypeError` JS (élément `null` dans `products`).
    Type,
    /// Quantité non numérique liée à une requête.
    NotANumber,
}

impl From<sqlx::Error> for Failure {
    fn from(err: sqlx::Error) -> Self {
        Failure::Db(err)
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Db(err) => write!(f, "{err}"),
            Failure::Type => f.write_str("TypeError: Cannot read properties of null"),
            Failure::NotANumber => f.write_str("quantité non numérique"),
        }
    }
}

/// Issue d'une transaction : réponse à renvoyer après commit ou rollback.
enum Outcome {
    Commit(Response),
    Rollback(Response),
}

fn prop<'a>(item: &'a Value, key: &str) -> Result<Option<&'a Value>, Failure> {
    match item {
        Value::Null => Err(Failure::Type),
        Value::Object(map) => Ok(map.get(key)),
        _ => Ok(None),
    }
}

/// `value || fallback`
fn or_else(value: Option<&Value>, fallback: Value) -> Value {
    if js::truthy(value) {
        value.cloned().unwrap_or(fallback)
    } else {
        fallback
    }
}

fn finite(f: f64) -> Result<f64, Failure> {
    if f.is_finite() {
        Ok(f)
    } else {
        Err(Failure::NotANumber)
    }
}

async fn begin(
    state: &AppState,
    error_message: &str,
    log_label: &str,
) -> Result<Transaction<'static, MySql>, Response> {
    state.pool.begin().await.map_err(|err| {
        eprintln!("{log_label}: {err}");
        fail(StatusCode::INTERNAL_SERVER_ERROR, error_message)
    })
}

/// Valide ou annule la transaction selon l'issue, comme le bloc
/// `try/catch` + `commit`/`rollback` de la version Node.
async fn finish(
    tx: Transaction<'static, MySql>,
    result: Result<Outcome, Failure>,
    error_message: &str,
    log_label: &str,
) -> Response {
    match result {
        Ok(Outcome::Commit(res)) => match tx.commit().await {
            Ok(()) => res,
            Err(err) => {
                eprintln!("{log_label}: {err}");
                fail(StatusCode::INTERNAL_SERVER_ERROR, error_message)
            }
        },
        Ok(Outcome::Rollback(res)) => {
            if let Err(err) = tx.rollback().await {
                eprintln!("{log_label}: {err}");
            }
            res
        }
        Err(err) => {
            if let Err(rollback_err) = tx.rollback().await {
                eprintln!("{log_label}: {rollback_err}");
            }
            eprintln!("{log_label}: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, error_message)
        }
    }
}

fn placeholders(groups: usize, per_group: usize) -> String {
    let group = format!("({})", vec!["?"; per_group].join(", "));
    vec![group; groups].join(", ")
}

// ── Produits ──────────────────────────────────────────────────────────────

pub async fn list_products(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    match sqlx::query("SELECT * FROM phyto_products ORDER BY name ASC")
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => json_response(StatusCode::OK, Value::Array(rows_to_json(&rows))),
        Err(err) => {
            eprintln!("Error fetching products: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Error fetching products")
        }
    }
}

struct ProductFields {
    name: Value,
    category: Value,
    stock: Value,
    unit: Value,
    notes: Value,
}

fn product_fields(body: &Value) -> Option<ProductFields> {
    let get = |key: &str| body.as_object().and_then(|m| m.get(key));
    if !js::truthy(get("name")) {
        return None;
    }
    Some(ProductFields {
        name: get("name").cloned().unwrap_or(Value::Null),
        category: or_else(get("category"), json!("Autre")),
        stock: or_else(get("stock"), json!(0)),
        unit: or_else(get("unit"), json!("L")),
        notes: or_else(get("notes"), json!("")),
    })
}

pub async fn create_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let body = match read_body(&headers, body).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(fields) = product_fields(&body) else {
        return fail(StatusCode::BAD_REQUEST, "Product name is required");
    };
    let mut query = sqlx::query(
        "INSERT INTO phyto_products (name, category, stock, unit, notes) VALUES (?, ?, ?, ?, ?)",
    );
    for value in [
        &fields.name,
        &fields.category,
        &fields.stock,
        &fields.unit,
        &fields.notes,
    ] {
        query = bind_json(query, Some(value));
    }
    match query.execute(&state.pool).await {
        Ok(result) => json_response(
            StatusCode::CREATED,
            json!({ "success": true, "id": result.last_insert_id(), "message": "Product created" }),
        ),
        Err(err) => {
            eprintln!("Error creating product: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Error creating product")
        }
    }
}

pub async fn update_product(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let body = match read_body(&headers, body).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(fields) = product_fields(&body) else {
        return fail(StatusCode::BAD_REQUEST, "Product name is required");
    };
    let mut query = sqlx::query(
        "UPDATE phyto_products SET name = ?, category = ?, stock = ?, unit = ?, notes = ? WHERE id = ?",
    );
    for value in [
        &fields.name,
        &fields.category,
        &fields.stock,
        &fields.unit,
        &fields.notes,
    ] {
        query = bind_json(query, Some(value));
    }
    match query.bind(id).execute(&state.pool).await {
        Ok(_) => json_response(
            StatusCode::OK,
            json!({ "success": true, "message": "Product updated" }),
        ),
        Err(err) => {
            eprintln!("Error updating product: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Error updating product")
        }
    }
}

pub async fn delete_product(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    match sqlx::query("DELETE FROM phyto_products WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => json_response(
            StatusCode::OK,
            json!({ "success": true, "message": "Product deleted" }),
        ),
        Err(err) => {
            eprintln!("Error deleting product: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Error deleting product")
        }
    }
}

// ── Interventions ─────────────────────────────────────────────────────────

pub async fn list_applications(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let result = sqlx::query(
        "SELECT
        a.id, a.date, a.notes, a.created_at, a.updated_at,
        COALESCE(JSON_ARRAYAGG(
          CASE WHEN ap.id IS NOT NULL THEN JSON_OBJECT(
            'id', ap.id,
            'product_id', ap.product_id,
            'product_name', p.name,
            'quantity_used', ap.quantity_used
          ) END
        ), JSON_ARRAY()) as products
      FROM phyto_applications a
      LEFT JOIN phyto_application_products ap ON a.id = ap.application_id
      LEFT JOIN phyto_products p ON ap.product_id = p.id
      GROUP BY a.id
      ORDER BY a.date DESC",
    )
    .fetch_all(&state.pool)
    .await;
    match result {
        Ok(rows) => json_response(StatusCode::OK, Value::Array(rows_to_json(&rows))),
        Err(err) => {
            eprintln!("Error fetching applications: {err}");
            fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Error fetching applications",
            )
        }
    }
}

struct ApplicationInput {
    date: Value,
    notes: Value,
    products: Vec<Value>,
}

fn application_input(body: &Value) -> Option<ApplicationInput> {
    let get = |key: &str| body.as_object().and_then(|m| m.get(key));
    let products = match get("products") {
        Some(Value::Array(items)) if !items.is_empty() => items.clone(),
        _ => return None,
    };
    if !js::truthy(get("date")) {
        return None;
    }
    Some(ApplicationInput {
        date: get("date").cloned().unwrap_or(Value::Null),
        notes: or_else(get("notes"), json!("")),
        products,
    })
}

fn missing_application_fields() -> Response {
    fail(
        StatusCode::BAD_REQUEST,
        "Date and at least one product are required",
    )
}

/// Insère les lignes `phyto_application_products` d'une intervention.
async fn insert_application_products(
    tx: &mut Transaction<'static, MySql>,
    application_id: &Value,
    products: &[Value],
) -> Result<(), Failure> {
    let sql = format!(
        "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES {}",
        placeholders(products.len(), 3)
    );
    let mut query = sqlx::query(&sql);
    for p in products {
        let product_id = prop(p, "product_id")?;
        let quantity = prop(p, "quantity_used")?;
        query = bind_json(query, Some(application_id));
        query = bind_json(query, product_id);
        query = bind_json(query, Some(&or_else(quantity, Value::Null)));
    }
    query.execute(&mut **tx).await?;
    Ok(())
}

pub async fn create_application(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let body = match read_body(&headers, body).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(input) = application_input(&body) else {
        return missing_application_fields();
    };

    const MSG: &str = "Error creating application";
    let mut tx = match begin(&state, MSG, MSG).await {
        Ok(tx) => tx,
        Err(res) => return res,
    };
    let result = create_application_tx(&mut tx, &input).await;
    finish(tx, result, MSG, MSG).await
}

async fn create_application_tx(
    tx: &mut Transaction<'static, MySql>,
    input: &ApplicationInput,
) -> Result<Outcome, Failure> {
    // Produits avec une quantité > 0 : contrôle du stock disponible.
    let mut with_qty = Vec::new();
    for p in &input.products {
        let quantity = prop(p, "quantity_used")?;
        if js::truthy(quantity) && js::to_number(quantity) > 0.0 {
            with_qty.push(p);
        }
    }

    if !with_qty.is_empty() {
        let sql = format!(
            "SELECT id, name, stock, unit FROM phyto_products WHERE id IN ({})",
            vec!["?"; with_qty.len()].join(", ")
        );
        let mut query = sqlx::query(&sql);
        for p in &with_qty {
            query = bind_json(query, prop(p, "product_id")?);
        }
        let existing: Vec<Map<String, Value>> = query
            .fetch_all(&mut **tx)
            .await?
            .iter()
            .map(row_to_json)
            .collect();

        for p in &with_qty {
            let product_id = prop(p, "product_id")?;
            let found = existing.iter().find(|ep| {
                match (ep.get("id").and_then(Value::as_f64), product_id) {
                    (Some(id), Some(Value::Number(n))) => n.as_f64() == Some(id),
                    _ => false,
                }
            });
            let Some(found) = found else {
                return Ok(Outcome::Rollback(fail(
                    StatusCode::BAD_REQUEST,
                    &format!("Produit ID {} introuvable", js::to_js_string(product_id)),
                )));
            };
            let stock = or_else(found.get("stock"), json!(0));
            if js::to_number(prop(p, "quantity_used")?) > js::to_number(Some(&stock)) {
                return Ok(Outcome::Rollback(fail(
                    StatusCode::BAD_REQUEST,
                    &format!(
                        "Stock insuffisant pour {}. Disponible : {} {}",
                        js::to_js_string(found.get("name")),
                        js::to_js_string(found.get("stock")),
                        js::to_js_string(found.get("unit")),
                    ),
                )));
            }
        }
    }

    let mut insert = sqlx::query("INSERT INTO phyto_applications (date, notes) VALUES (?, ?)");
    insert = bind_json(insert, Some(&input.date));
    insert = bind_json(insert, Some(&input.notes));
    let application_id = insert.execute(&mut **tx).await?.last_insert_id();

    insert_application_products(tx, &json!(application_id), &input.products).await?;

    for p in &with_qty {
        let quantity = finite(js::to_number(prop(p, "quantity_used")?))?;
        let query =
            sqlx::query("UPDATE phyto_products SET stock = stock - ? WHERE id = ?").bind(quantity);
        bind_json(query, prop(p, "product_id")?)
            .execute(&mut **tx)
            .await?;
    }

    Ok(Outcome::Commit(json_response(
        StatusCode::CREATED,
        json!({ "success": true, "id": application_id, "message": "Application created" }),
    )))
}

pub async fn update_application(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let body = match read_body(&headers, body).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(input) = application_input(&body) else {
        return missing_application_fields();
    };

    const MSG: &str = "Error updating application";
    let mut tx = match begin(&state, MSG, MSG).await {
        Ok(tx) => tx,
        Err(res) => return res,
    };
    let result = update_application_tx(&mut tx, &id, &input).await;
    finish(tx, result, MSG, MSG).await
}

async fn update_application_tx(
    tx: &mut Transaction<'static, MySql>,
    id: &str,
    input: &ApplicationInput,
) -> Result<Outcome, Failure> {
    // Restitution du stock consommé par l'ancienne version.
    let old_products = sqlx::query(
        "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    for row in old_products.iter().map(row_to_json) {
        if !js::truthy(row.get("quantity_used")) {
            continue;
        }
        let query = sqlx::query("UPDATE phyto_products SET stock = stock + ? WHERE id = ?");
        let query = bind_json(query, row.get("quantity_used"));
        bind_json(query, row.get("product_id"))
            .execute(&mut **tx)
            .await?;
    }

    let mut update = sqlx::query("UPDATE phyto_applications SET date = ?, notes = ? WHERE id = ?");
    update = bind_json(update, Some(&input.date));
    update = bind_json(update, Some(&input.notes));
    update.bind(id).execute(&mut **tx).await?;

    sqlx::query("DELETE FROM phyto_application_products WHERE application_id = ?")
        .bind(id)
        .execute(&mut **tx)
        .await?;

    insert_application_products(tx, &Value::String(id.to_string()), &input.products).await?;

    for p in &input.products {
        let quantity = prop(p, "quantity_used")?;
        if !js::truthy(quantity) {
            continue;
        }
        let quantity = finite(js::to_number(quantity))?;
        let query =
            sqlx::query("UPDATE phyto_products SET stock = stock - ? WHERE id = ?").bind(quantity);
        bind_json(query, prop(p, "product_id")?)
            .execute(&mut **tx)
            .await?;
    }

    Ok(Outcome::Commit(json_response(
        StatusCode::OK,
        json!({ "success": true, "message": "Application updated" }),
    )))
}

pub async fn delete_application(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let restore_stock = matches!(
        query_values(uri.query(), "restoreStock").as_slice(),
        [value] if value == "true"
    );

    const MSG: &str = "Error deleting application";
    let mut tx = match begin(&state, MSG, MSG).await {
        Ok(tx) => tx,
        Err(res) => return res,
    };
    let result = delete_application_tx(&mut tx, &id, restore_stock).await;
    finish(tx, result, MSG, MSG).await
}

async fn delete_application_tx(
    tx: &mut Transaction<'static, MySql>,
    id: &str,
    restore_stock: bool,
) -> Result<Outcome, Failure> {
    if restore_stock {
        let products = sqlx::query(
            "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
        )
        .bind(id)
        .fetch_all(&mut **tx)
        .await?;
        for row in products.iter().map(row_to_json) {
            if !js::truthy(row.get("quantity_used")) {
                continue;
            }
            let query = sqlx::query("UPDATE phyto_products SET stock = stock + ? WHERE id = ?");
            let query = bind_json(query, row.get("quantity_used"));
            bind_json(query, row.get("product_id"))
                .execute(&mut **tx)
                .await?;
        }
    }

    sqlx::query("DELETE FROM phyto_applications WHERE id = ?")
        .bind(id)
        .execute(&mut **tx)
        .await?;

    Ok(Outcome::Commit(json_response(
        StatusCode::OK,
        json!({ "success": true, "message": "Application deleted" }),
    )))
}

// ── Exports CSV ───────────────────────────────────────────────────────────

/// `String(number).replace(".", ",")` (première occurrence seulement).
fn decimal_fr(value: &Value) -> String {
    js::to_js_string(Some(value)).replacen('.', ",", 1)
}

fn quoted_notes(notes: Option<String>) -> String {
    match notes.filter(|n| !n.is_empty()) {
        Some(notes) => format!("\"{}\"", notes.replace('"', "\"\"")),
        None => String::new(),
    }
}

fn float_value(value: Option<f32>) -> Option<Value> {
    value.map(js::clean_f32)
}

fn csv_response(headers: &[&str], rows: Vec<Vec<String>>, filename_prefix: &str) -> Response {
    let mut lines = vec![headers.join(";")];
    lines.extend(rows.into_iter().map(|r| r.join(";")));
    let content = format!("\u{feff}{}", lines.join("\r\n"));
    let today = chrono::Utc::now().format("%Y-%m-%d");
    let mut res = (StatusCode::OK, content).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&format!(
        "attachment; filename=\"{filename_prefix}_{today}.csv\""
    )) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

fn export_error(err: sqlx::Error, label: &str) -> Response {
    eprintln!("{label}: {err}");
    fail(StatusCode::INTERNAL_SERVER_ERROR, "Erreur lors de l'export")
}

pub async fn export_applications(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let rows = match sqlx::query(
        "SELECT
        a.id,
        a.date,
        a.notes,
        ap.quantity_used,
        p.name  AS product_name,
        p.unit  AS product_unit,
        p.category
      FROM phyto_applications a
      LEFT JOIN phyto_application_products ap ON a.id = ap.application_id
      LEFT JOIN phyto_products p ON ap.product_id = p.id
      ORDER BY a.date DESC, a.id, p.name",
    )
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => return export_error(err, "Erreur export CSV"),
    };

    let mut lines = Vec::with_capacity(rows.len());
    for row in &rows {
        let date: Option<NaiveDate> = row.try_get_unchecked("date").ok().flatten();
        let quantity: Option<f32> = row.try_get_unchecked("quantity_used").ok().flatten();
        let text = |name: &str| -> String {
            row.try_get::<Option<String>, _>(name)
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        lines.push(vec![
            date.map(|d| d.format("%d/%m/%Y").to_string())
                .unwrap_or_default(),
            text("product_name"),
            text("category"),
            float_value(quantity)
                .map(|q| decimal_fr(&q))
                .unwrap_or_default(),
            text("product_unit"),
            quoted_notes(row.try_get::<Option<String>, _>("notes").ok().flatten()),
        ]);
    }
    csv_response(
        &["Date", "Produit", "Catégorie", "Quantité", "Unité", "Notes"],
        lines,
        "phyto_interventions",
    )
}

pub async fn export_products(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let rows = match sqlx::query(
        "SELECT id, name, category, stock, unit, notes FROM phyto_products ORDER BY category ASC, name ASC",
    )
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => return export_error(err, "Erreur export CSV produits"),
    };

    let mut lines = Vec::with_capacity(rows.len());
    for row in &rows {
        let stock: Option<f32> = row.try_get_unchecked("stock").ok().flatten();
        let text = |name: &str| -> String {
            row.try_get::<Option<String>, _>(name)
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        let stock = float_value(stock)
            .filter(|s| js::truthy(Some(s)))
            .unwrap_or(json!(0));
        lines.push(vec![
            text("name"),
            text("category"),
            decimal_fr(&stock),
            text("unit"),
            quoted_notes(row.try_get::<Option<String>, _>("notes").ok().flatten()),
        ]);
    }
    csv_response(
        &["Produit", "Catégorie", "Stock", "Unité", "Notes"],
        lines,
        "phyto_produits",
    )
}
