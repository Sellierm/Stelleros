//! Pointage des heures de travail.
//!
//! Une journée par utilisateur et par date, en deux demi-journées (matin,
//! après-midi) avec leurs horaires et les travaux effectués. Seuls les
//! utilisateurs listés dans `TIMESHEET_USERS` (tous si la liste est vide) ont
//! un pointage : chacun saisit et modifie ses propres journées. Tout utilisateur connecté peut consulter
//! et exporter leurs journées (export Excel au format de la feuille d'heures).
//!
//! L'après-midi peut se terminer après minuit (moisson, labour de nuit) : une
//! heure de fin antérieure au début, jusqu'à 6 h, compte pour le lendemain.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use chrono::{NaiveDate, NaiveTime, Timelike};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Formula, Workbook, XlsxError};
use serde::Deserialize;
use serde_json::{Value, json};

use super::require_user;
use crate::middleware::{fail, json_response, query_values, read_body};
use crate::state::AppState;

pub const XLSX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// Longueur maximale d'un descriptif de travaux (caractères).
const MAX_TASKS_LEN: usize = 1000;

/// Dernière heure de fin acceptée pour un après-midi qui passe minuit.
const OVERNIGHT_MAX_END_SECS: u32 = 6 * 3600;

// ── Modèle ────────────────────────────────────────────────────────────────

/// Demi-journée travaillée. Une fin antérieure au début (après-midi
/// seulement, validé à la saisie) tombe le lendemain.
#[derive(Debug, Clone, PartialEq)]
pub struct HalfDay {
    pub start: NaiveTime,
    pub end: NaiveTime,
    pub tasks: Option<String>,
}

impl HalfDay {
    fn minutes(&self) -> i64 {
        let minutes = (self.end - self.start).num_minutes();
        if minutes < 0 {
            minutes + 24 * 60
        } else {
            minutes
        }
    }
}

/// Journée validée, prête à être enregistrée.
#[derive(Debug, Clone, PartialEq)]
pub struct Day {
    pub date: NaiveDate,
    pub morning: Option<HalfDay>,
    pub afternoon: Option<HalfDay>,
}

#[derive(sqlx::FromRow)]
struct EntryRow {
    id: i32,
    user_id: String,
    date: NaiveDate,
    morning_start: Option<NaiveTime>,
    morning_end: Option<NaiveTime>,
    morning_tasks: Option<String>,
    afternoon_start: Option<NaiveTime>,
    afternoon_end: Option<NaiveTime>,
    afternoon_tasks: Option<String>,
}

const ENTRY_COLUMNS: &str = "id, user_id, date, morning_start, morning_end, morning_tasks, \
     afternoon_start, afternoon_end, afternoon_tasks";

fn half_day(
    start: Option<NaiveTime>,
    end: Option<NaiveTime>,
    tasks: &Option<String>,
) -> Option<HalfDay> {
    Some(HalfDay {
        start: start?,
        end: end?,
        tasks: tasks.clone(),
    })
}

impl EntryRow {
    fn morning(&self) -> Option<HalfDay> {
        half_day(self.morning_start, self.morning_end, &self.morning_tasks)
    }

    fn afternoon(&self) -> Option<HalfDay> {
        half_day(
            self.afternoon_start,
            self.afternoon_end,
            &self.afternoon_tasks,
        )
    }

    fn to_json(&self) -> Value {
        let time = |t: Option<NaiveTime>| t.map(|t| t.format("%H:%M").to_string());
        json!({
            "id": self.id,
            "user_id": self.user_id,
            "date": self.date.format("%Y-%m-%d").to_string(),
            "morning_start": time(self.morning_start),
            "morning_end": time(self.morning_end),
            "morning_tasks": self.morning_tasks,
            "afternoon_start": time(self.afternoon_start),
            "afternoon_end": time(self.afternoon_end),
            "afternoon_tasks": self.afternoon_tasks,
        })
    }
}

// ── Validation ────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct EntryInput {
    pub date: Option<String>,
    pub morning_start: Option<String>,
    pub morning_end: Option<String>,
    pub morning_tasks: Option<String>,
    pub afternoon_start: Option<String>,
    pub afternoon_end: Option<String>,
    pub afternoon_tasks: Option<String>,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// `HH:MM` (ou `HH:MM:SS`, envoyé par certains navigateurs).
fn parse_time(value: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(value, "%H:%M:%S"))
        .ok()
        .map(|t| t.with_second(0).unwrap_or(t))
}

fn validate_half(
    label: &str,
    start: &Option<String>,
    end: &Option<String>,
    tasks: &Option<String>,
    overnight: bool,
) -> Result<Option<HalfDay>, String> {
    let tasks = non_empty(tasks).map(str::to_string);
    if tasks
        .as_ref()
        .is_some_and(|t| t.chars().count() > MAX_TASKS_LEN)
    {
        return Err(format!(
            "{label} : travaux limités à {MAX_TASKS_LEN} caractères"
        ));
    }
    let parse = |value: &Option<String>| -> Result<Option<NaiveTime>, String> {
        non_empty(value)
            .map(|v| parse_time(v).ok_or_else(|| format!("{label} : heure invalide « {v} »")))
            .transpose()
    };
    match (parse(start)?, parse(end)?) {
        (None, None) if tasks.is_some() => {
            Err(format!("{label} : indiquez les heures de début et de fin"))
        }
        (None, None) => Ok(None),
        (Some(start), Some(end))
            if end > start
                || (overnight
                    && end < start
                    && end.num_seconds_from_midnight() <= OVERNIGHT_MAX_END_SECS) =>
        {
            Ok(Some(HalfDay { start, end, tasks }))
        }
        (Some(_), Some(_)) if overnight => Err(format!(
            "{label} : l'heure de fin doit être après l'heure de début (ou au plus tard 6:00 le lendemain)"
        )),
        (Some(_), Some(_)) => Err(format!(
            "{label} : l'heure de fin doit être après l'heure de début"
        )),
        _ => Err(format!("{label} : indiquez les heures de début et de fin")),
    }
}

pub fn validate(input: &EntryInput) -> Result<Day, String> {
    let date = non_empty(&input.date)
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .ok_or_else(|| "Date invalide".to_string())?;
    let morning = validate_half(
        "Matin",
        &input.morning_start,
        &input.morning_end,
        &input.morning_tasks,
        false,
    )?;
    let afternoon = validate_half(
        "Après-midi",
        &input.afternoon_start,
        &input.afternoon_end,
        &input.afternoon_tasks,
        true,
    )?;
    if morning.is_none() && afternoon.is_none() {
        return Err("Renseignez au moins une demi-journée".into());
    }
    if let (Some(m), Some(a)) = (&morning, &afternoon)
        && m.end > a.start
    {
        return Err("Les horaires du matin et de l'après-midi se chevauchent".into());
    }
    Ok(Day {
        date,
        morning,
        afternoon,
    })
}

/// Lit et valide le corps JSON d'une journée (400 avec message sinon).
async fn read_day(headers: &HeaderMap, body: Body) -> Result<Day, Response> {
    let body = read_body(headers, body).await?;
    let input: EntryInput = serde_json::from_value(body)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "Données invalides"))?;
    validate(&input).map_err(|msg| fail(StatusCode::BAD_REQUEST, &msg))
}

// ── Paramètres de consultation ────────────────────────────────────────────

struct Query {
    user_id: String,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

fn single(uri: &Uri, name: &str) -> Option<String> {
    query_values(uri.query(), name)
        .into_iter()
        .next()
        .filter(|v| !v.is_empty())
}

/// `?user=<id>&from=AAAA-MM-JJ&to=AAAA-MM-JJ` ; utilisateur connecté par défaut.
fn parse_query(uri: &Uri, me: &str) -> Result<Query, Response> {
    let date = |name: &str| -> Result<Option<NaiveDate>, Response> {
        single(uri, name)
            .map(|v| {
                NaiveDate::parse_from_str(&v, "%Y-%m-%d")
                    .map_err(|_| fail(StatusCode::BAD_REQUEST, "Période invalide"))
            })
            .transpose()
    };
    Ok(Query {
        user_id: single(uri, "user").unwrap_or_else(|| me.to_string()),
        from: date("from")?,
        to: date("to")?,
    })
}

async fn fetch_entries(state: &AppState, q: &Query) -> Result<Vec<EntryRow>, sqlx::Error> {
    sqlx::query_as::<_, EntryRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {ENTRY_COLUMNS} FROM timesheet_entries
         WHERE user_id = ? AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)
         ORDER BY date ASC"
    )))
    .bind(&q.user_id)
    .bind(q.from)
    .bind(q.from)
    .bind(q.to)
    .bind(q.to)
    .fetch_all(&state.pool)
    .await
}

/// Nom affiché : `displayUsername`, sinon `username`, sinon `name`.
const LABEL: &str = "COALESCE(NULLIF(displayUsername, ''), NULLIF(username, ''), name)";

/// Le compte a-t-il un pointage (`TIMESHEET_USERS`, tous si vide) ?
fn is_worker(state: &AppState, username: Option<&str>) -> bool {
    let names = &state.cfg.timesheet_users;
    names.is_empty()
        || username.is_some_and(|name| names.iter().any(|w| w.eq_ignore_ascii_case(name)))
}

/// Comptes ayant un pointage : `(id, nom affiché)`, triés par nom.
async fn workers(state: &AppState) -> Result<Vec<(String, String)>, sqlx::Error> {
    let names = &state.cfg.timesheet_users;
    if names.is_empty() {
        return sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id, {LABEL} AS label FROM auth_user ORDER BY label ASC"
        )))
        .fetch_all(&state.pool)
        .await;
    }
    let sql = format!(
        "SELECT id, {LABEL} AS label FROM auth_user
         WHERE LOWER(username) IN ({}) ORDER BY label ASC",
        vec!["?"; names.len()].join(", ")
    );
    // SQL dynamique audité : uniquement des `?` (valeurs liées par bind).
    let mut query = sqlx::query_as(sqlx::AssertSqlSafe(sql));
    for name in names {
        query = query.bind(name);
    }
    query.fetch_all(&state.pool).await
}

/// Nom affiché du compte s'il a un pointage, `None` sinon (ou inconnu).
async fn worker_label(state: &AppState, user_id: &str) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT username, {LABEL} FROM auth_user WHERE id = ?"
    )))
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row
        .filter(|(username, _)| is_worker(state, username.as_deref()))
        .map(|(_, label)| label))
}

/// Journées d'un compte sans pointage : 404, comme un compte inconnu.
async fn require_worker(state: &AppState, user_id: &str) -> Result<String, Response> {
    match worker_label(state, user_id).await {
        Ok(Some(label)) => Ok(label),
        Ok(None) => Err(fail(
            StatusCode::NOT_FOUND,
            "Pas de pointage pour cet utilisateur",
        )),
        Err(err) => Err(server_error(
            err,
            "Erreur lecture utilisateur",
            "Erreur de lecture",
        )),
    }
}

/// Saisie et modification : réservées aux comptes ayant un pointage.
fn require_own_timesheet(state: &AppState, me: &crate::auth::AuthUser) -> Result<(), Response> {
    if is_worker(state, me.username.as_deref()) {
        Ok(())
    } else {
        Err(fail(
            StatusCode::FORBIDDEN,
            "Ce compte n'a pas de pointage des heures",
        ))
    }
}

fn server_error(err: sqlx::Error, label: &str, message: &str) -> Response {
    eprintln!("{label}: {err}");
    fail(StatusCode::INTERNAL_SERVER_ERROR, message)
}

// ── Handlers ──────────────────────────────────────────────────────────────

/// `GET /api/timesheet/users` : utilisateur connecté, s'il peut saisir ses
/// heures, et comptes ayant un pointage.
pub async fn list_users(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let me = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(res) => return res,
    };
    match workers(&state).await {
        Ok(rows) => json_response(
            StatusCode::OK,
            json!({
                "me": me.id,
                "canEdit": is_worker(&state, me.username.as_deref()),
                "users": rows
                    .into_iter()
                    .map(|(id, name)| json!({ "id": id, "name": name }))
                    .collect::<Vec<_>>(),
            }),
        ),
        Err(err) => server_error(err, "Erreur liste utilisateurs", "Erreur de lecture"),
    }
}

/// `GET /api/timesheet/entries?user=&from=&to=`
pub async fn list_entries(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let me = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(res) => return res,
    };
    let q = match parse_query(&uri, &me.id) {
        Ok(q) => q,
        Err(res) => return res,
    };
    if let Err(res) = require_worker(&state, &q.user_id).await {
        return res;
    }
    match fetch_entries(&state, &q).await {
        Ok(rows) => json_response(
            StatusCode::OK,
            Value::Array(rows.iter().map(EntryRow::to_json).collect()),
        ),
        Err(err) => server_error(err, "Erreur lecture pointage", "Erreur de lecture"),
    }
}

fn duplicate_or_error(err: sqlx::Error, label: &str) -> Response {
    if err
        .as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        return fail(
            StatusCode::CONFLICT,
            "Une journée est déjà enregistrée à cette date",
        );
    }
    server_error(err, label, "Erreur d'enregistrement")
}

fn bind_day<'q>(
    query: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    day: &'q Day,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    let m = day.morning.as_ref();
    let a = day.afternoon.as_ref();
    query
        .bind(day.date)
        .bind(m.map(|h| h.start))
        .bind(m.map(|h| h.end))
        .bind(m.and_then(|h| h.tasks.as_deref()))
        .bind(a.map(|h| h.start))
        .bind(a.map(|h| h.end))
        .bind(a.and_then(|h| h.tasks.as_deref()))
}

/// `POST /api/timesheet/entries` : journée de l'utilisateur connecté.
pub async fn create_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let me = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(res) => return res,
    };
    if let Err(res) = require_own_timesheet(&state, &me) {
        return res;
    }
    let day = match read_day(&headers, body).await {
        Ok(day) => day,
        Err(res) => return res,
    };
    let query = sqlx::query(
        "INSERT INTO timesheet_entries
           (date, morning_start, morning_end, morning_tasks,
            afternoon_start, afternoon_end, afternoon_tasks, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    match bind_day(query, &day)
        .bind(&me.id)
        .execute(&state.pool)
        .await
    {
        Ok(result) => json_response(
            StatusCode::CREATED,
            json!({ "success": true, "id": result.last_insert_id() }),
        ),
        Err(err) => duplicate_or_error(err, "Erreur création pointage"),
    }
}

/// Vérifie que la journée existe et appartient à l'utilisateur connecté.
async fn owned_entry(state: &AppState, id: i32, user_id: &str) -> Result<(), Response> {
    let owner: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM timesheet_entries WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|err| server_error(err, "Erreur lecture pointage", "Erreur de lecture"))?;
    match owner {
        None => Err(fail(StatusCode::NOT_FOUND, "Journée introuvable")),
        Some(owner) if owner != user_id => Err(fail(
            StatusCode::FORBIDDEN,
            "Seules vos propres journées sont modifiables",
        )),
        Some(_) => Ok(()),
    }
}

/// `PUT /api/timesheet/entries/{id}`
pub async fn update_entry(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let me = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(res) => return res,
    };
    if let Err(res) = require_own_timesheet(&state, &me) {
        return res;
    }
    let day = match read_day(&headers, body).await {
        Ok(day) => day,
        Err(res) => return res,
    };
    if let Err(res) = owned_entry(&state, id, &me.id).await {
        return res;
    }
    let query = sqlx::query(
        "UPDATE timesheet_entries SET
           date = ?, morning_start = ?, morning_end = ?, morning_tasks = ?,
           afternoon_start = ?, afternoon_end = ?, afternoon_tasks = ?
         WHERE id = ? AND user_id = ?",
    );
    match bind_day(query, &day)
        .bind(id)
        .bind(&me.id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => json_response(StatusCode::OK, json!({ "success": true })),
        Err(err) => duplicate_or_error(err, "Erreur modification pointage"),
    }
}

/// `DELETE /api/timesheet/entries/{id}`
pub async fn delete_entry(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    let me = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(res) => return res,
    };
    if let Err(res) = require_own_timesheet(&state, &me) {
        return res;
    }
    if let Err(res) = owned_entry(&state, id, &me.id).await {
        return res;
    }
    match sqlx::query("DELETE FROM timesheet_entries WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(&me.id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => json_response(StatusCode::OK, json!({ "success": true })),
        Err(err) => server_error(err, "Erreur suppression pointage", "Erreur de suppression"),
    }
}

/// Nom de fichier ASCII sans caractère problématique pour `Content-Disposition`.
fn file_slug(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "utilisateur".into()
    } else {
        slug
    }
}

/// `GET /api/timesheet/export?user=&from=&to=` : feuille d'heures `.xlsx`.
pub async fn export_entries(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let me = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(res) => return res,
    };
    let q = match parse_query(&uri, &me.id) {
        Ok(q) => q,
        Err(res) => return res,
    };
    let label = match require_worker(&state, &q.user_id).await {
        Ok(label) => label,
        Err(res) => return res,
    };
    let rows = match fetch_entries(&state, &q).await {
        Ok(rows) => rows,
        Err(err) => return server_error(err, "Erreur export pointage", "Erreur lors de l'export"),
    };
    let days: Vec<Day> = rows
        .iter()
        .map(|r| Day {
            date: r.date,
            morning: r.morning(),
            afternoon: r.afternoon(),
        })
        .collect();
    let bytes = match build_workbook(&days) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("Erreur génération Excel: {err}");
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "Erreur lors de l'export");
        }
    };

    let period = match (q.from, q.to) {
        (Some(from), Some(to)) => format!("_{}_{}", from.format("%Y-%m-%d"), to.format("%Y-%m-%d")),
        (Some(from), None) => format!("_depuis_{}", from.format("%Y-%m-%d")),
        (None, Some(to)) => format!("_jusqu_{}", to.format("%Y-%m-%d")),
        (None, None) => String::new(),
    };
    let filename = format!("heures_{}{period}.xlsx", file_slug(&label));
    let mut res = (StatusCode::OK, bytes).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(XLSX_CONTENT_TYPE),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

// ── Classeur Excel ────────────────────────────────────────────────────────

/// Numéro de série Excel d'une date (jours depuis le 30/12/1899).
fn excel_date(date: NaiveDate) -> f64 {
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30).expect("date fixe");
    (date - epoch).num_days() as f64
}

/// Heure en fraction de journée, comme Excel la stocke.
fn excel_time(time: NaiveTime) -> f64 {
    f64::from(time.num_seconds_from_midnight()) / 86_400.0
}

fn minutes_fraction(minutes: i64) -> f64 {
    minutes as f64 / 1_440.0
}

/// Nom de colonne Excel (0 → A) ; la feuille n'en a que dix.
fn col_letter(col: u16) -> char {
    char::from(b'A' + col as u8)
}

/// Feuille d'heures au format habituel :
///
/// | Date | Matin (Début, Fin) | Total Matin | Travaux effectués | Après-midi (Début, Fin) | Total apm | Travaux effectués | Nbre h/jour |
///
/// Les totaux sont des formules (le tableau reste juste si on corrige une heure
/// dans Excel), avec leur valeur précalculée pour les lecteurs qui ne
/// recalculent pas. Une ligne « Total » termine la feuille.
pub fn build_workbook(days: &[Day]) -> Result<Vec<u8>, XlsxError> {
    const DATE: u16 = 0;
    const M_START: u16 = 1;
    const M_END: u16 = 2;
    const M_TOTAL: u16 = 3;
    const M_TASKS: u16 = 4;
    const A_START: u16 = 5;
    const A_END: u16 = 6;
    const A_TOTAL: u16 = 7;
    const A_TASKS: u16 = 8;
    const DAY_TOTAL: u16 = 9;
    const FIRST_ROW: u32 = 2;

    let border = |f: Format| f.set_border(FormatBorder::Thin);
    let header = border(
        Format::new()
            .set_bold()
            .set_align(FormatAlign::Center)
            .set_align(FormatAlign::VerticalCenter)
            .set_text_wrap()
            .set_background_color(0xD9EAD3),
    );
    let date_fmt = border(
        Format::new()
            .set_num_format("dd/mm/yyyy")
            .set_align(FormatAlign::Center),
    );
    let time_fmt = border(
        Format::new()
            .set_num_format("h:mm")
            .set_align(FormatAlign::Center),
    );
    let total_fmt = border(
        Format::new()
            .set_num_format("[h]:mm")
            .set_align(FormatAlign::Center),
    );
    let text_fmt = border(
        Format::new()
            .set_text_wrap()
            .set_align(FormatAlign::VerticalCenter),
    );
    let blank_fmt = border(Format::new());
    let sum_label = border(Format::new().set_bold());
    let sum_fmt = border(
        Format::new()
            .set_bold()
            .set_num_format("[h]:mm")
            .set_align(FormatAlign::Center),
    );

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("Heures")?;

    // En-tête sur deux lignes, cellules fusionnées comme la feuille d'origine.
    sheet.merge_range(0, DATE, 1, DATE, "Date", &header)?;
    sheet.merge_range(0, M_START, 0, M_END, "Matin", &header)?;
    sheet.merge_range(0, M_TOTAL, 1, M_TOTAL, "Total Matin", &header)?;
    sheet.merge_range(0, M_TASKS, 1, M_TASKS, "Travaux effectués", &header)?;
    sheet.merge_range(0, A_START, 0, A_END, "Après-midi", &header)?;
    sheet.merge_range(0, A_TOTAL, 1, A_TOTAL, "Total apm", &header)?;
    sheet.merge_range(0, A_TASKS, 1, A_TASKS, "Travaux effectués", &header)?;
    sheet.merge_range(0, DAY_TOTAL, 1, DAY_TOTAL, "Nbre h/jour", &header)?;
    for col in [M_START, A_START] {
        sheet.write_string_with_format(1, col, "Début", &header)?;
    }
    for col in [M_END, A_END] {
        sheet.write_string_with_format(1, col, "Fin", &header)?;
    }

    let diff = |row: u32, start: u16, end: u16, minutes: i64| {
        let n = row + 1;
        // MOD(…;1) : un après-midi qui passe minuit (fin < début) reste positif.
        Formula::new(format!(
            "=MOD({}{n}-{}{n},1)",
            col_letter(end),
            col_letter(start)
        ))
        .set_result(minutes_fraction(minutes).to_string())
    };

    let mut total = [0i64; 3];
    for (i, day) in days.iter().enumerate() {
        let row = FIRST_ROW + i as u32;
        sheet.write_number_with_format(row, DATE, excel_date(day.date), &date_fmt)?;

        let halves = [
            (&day.morning, M_START, M_END, M_TOTAL, M_TASKS),
            (&day.afternoon, A_START, A_END, A_TOTAL, A_TASKS),
        ];
        let mut day_minutes = 0;
        for (k, (half, start, end, sum, tasks)) in halves.into_iter().enumerate() {
            let minutes = half.as_ref().map_or(0, HalfDay::minutes);
            match half {
                Some(h) => {
                    sheet.write_number_with_format(row, start, excel_time(h.start), &time_fmt)?;
                    sheet.write_number_with_format(row, end, excel_time(h.end), &time_fmt)?;
                    match &h.tasks {
                        Some(t) => sheet.write_string_with_format(row, tasks, t, &text_fmt)?,
                        None => sheet.write_blank(row, tasks, &text_fmt)?,
                    };
                }
                None => {
                    sheet.write_blank(row, start, &blank_fmt)?;
                    sheet.write_blank(row, end, &blank_fmt)?;
                    sheet.write_blank(row, tasks, &text_fmt)?;
                }
            }
            sheet.write_formula_with_format(
                row,
                sum,
                diff(row, start, end, minutes),
                &total_fmt,
            )?;
            total[k] += minutes;
            day_minutes += minutes;
        }
        let n = row + 1;
        sheet.write_formula_with_format(
            row,
            DAY_TOTAL,
            Formula::new(format!(
                "={}{n}+{}{n}",
                col_letter(M_TOTAL),
                col_letter(A_TOTAL)
            ))
            .set_result(minutes_fraction(day_minutes).to_string()),
            &total_fmt,
        )?;
        total[2] += day_minutes;
    }

    // Ligne « Total ».
    let sum_row = FIRST_ROW + days.len() as u32;
    sheet.write_string_with_format(sum_row, DATE, "Total", &sum_label)?;
    for col in [M_START, M_END, M_TASKS, A_START, A_END, A_TASKS] {
        sheet.write_blank(sum_row, col, &sum_label)?;
    }
    for (col, minutes) in [
        (M_TOTAL, total[0]),
        (A_TOTAL, total[1]),
        (DAY_TOTAL, total[2]),
    ] {
        if days.is_empty() {
            sheet.write_number_with_format(sum_row, col, 0.0, &sum_fmt)?;
        } else {
            let c = col_letter(col);
            let formula = Formula::new(format!("=SUM({c}{}:{c}{sum_row})", FIRST_ROW + 1))
                .set_result(minutes_fraction(minutes).to_string());
            sheet.write_formula_with_format(sum_row, col, formula, &sum_fmt)?;
        }
    }

    for (col, width) in [
        (DATE, 12.0),
        (M_START, 8.0),
        (M_END, 8.0),
        (M_TOTAL, 9.0),
        (M_TASKS, 40.0),
        (A_START, 8.0),
        (A_END, 8.0),
        (A_TOTAL, 9.0),
        (A_TASKS, 40.0),
        (DAY_TOTAL, 10.0),
    ] {
        sheet.set_column_width(col, width)?;
    }
    sheet.set_freeze_panes(FIRST_ROW, 1)?;
    sheet.set_repeat_rows(0, FIRST_ROW - 1)?;
    sheet.set_landscape();
    sheet.set_print_fit_to_pages(1, 0);

    workbook.save_to_buffer()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(date: &str, m: (&str, &str, &str), a: (&str, &str, &str)) -> EntryInput {
        let s = |v: &str| Some(v.to_string());
        EntryInput {
            date: s(date),
            morning_start: s(m.0),
            morning_end: s(m.1),
            morning_tasks: s(m.2),
            afternoon_start: s(a.0),
            afternoon_end: s(a.1),
            afternoon_tasks: s(a.2),
        }
    }

    fn t(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn journee_complete() {
        let day = validate(&input(
            "2026-04-13",
            ("06:00", "11:00", " comptage betterave "),
            ("15:00", "21:00", "terrier maïs"),
        ))
        .unwrap();
        assert_eq!(day.date, NaiveDate::from_ymd_opt(2026, 4, 13).unwrap());
        let m = day.morning.unwrap();
        assert_eq!((m.start, m.end), (t(6, 0), t(11, 0)));
        assert_eq!(m.tasks.as_deref(), Some("comptage betterave"));
        assert_eq!(m.minutes() + day.afternoon.unwrap().minutes(), 11 * 60);
    }

    #[test]
    fn demi_journee_vide_et_secondes_ignorees() {
        let day = validate(&input(
            "2026-01-17",
            ("", "", ""),
            ("13:00:00", "16:30", ""),
        ))
        .unwrap();
        assert!(day.morning.is_none());
        let a = day.afternoon.unwrap();
        assert_eq!(a.minutes(), 210);
        assert_eq!(a.tasks, None);
    }

    #[test]
    fn horaires_atypiques_acceptes() {
        // Moisson de 11 h à 23 h saisie l'après-midi, labour de 8 h à 18 h le matin.
        assert!(
            validate(&input(
                "2026-07-10",
                ("", "", ""),
                ("11:00", "23:00", "moisson")
            ))
            .is_ok()
        );
        assert!(
            validate(&input(
                "2026-09-29",
                ("08:00", "18:00", "labour"),
                ("", "", "")
            ))
            .is_ok()
        );
    }

    #[test]
    fn apres_midi_apres_minuit() {
        // Moisson de 22 h à 3 h du matin : 5 h, fin le lendemain.
        let day = validate(&input(
            "2023-07-18",
            ("09:00", "12:00", "betteraves montées"),
            ("22:00", "03:00", "moisson"),
        ))
        .unwrap();
        let a = day.afternoon.unwrap();
        assert_eq!((a.start, a.end), (t(22, 0), t(3, 0)));
        assert_eq!(a.minutes(), 5 * 60);
        // Jusqu'à 6 h du matin seulement : au-delà, c'est une erreur de saisie.
        assert!(validate(&input("2023-07-18", ("", "", ""), ("19:00", "06:00", ""))).is_ok());
        let err = validate(&input("2023-07-18", ("", "", ""), ("14:00", "13:00", ""))).unwrap_err();
        assert!(err.contains("lendemain"), "{err}");
        assert!(validate(&input("2023-07-18", ("", "", ""), ("14:00", "14:00", ""))).is_err());
        // Le matin ne passe jamais minuit.
        assert!(validate(&input("2023-07-18", ("23:00", "02:00", ""), ("", "", ""))).is_err());
    }

    #[test]
    fn erreurs_de_saisie() {
        let err = |i: EntryInput| validate(&i).unwrap_err();
        assert_eq!(
            err(input("", ("9:00", "12:00", ""), ("", "", ""))),
            "Date invalide"
        );
        assert_eq!(
            err(input("13/04/2026", ("09:00", "12:00", ""), ("", "", ""))),
            "Date invalide"
        );
        assert_eq!(
            err(input("2026-04-13", ("", "", ""), ("", "", ""))),
            "Renseignez au moins une demi-journée"
        );
        assert!(err(input("2026-04-13", ("09:00", "", ""), ("", "", ""))).starts_with("Matin"));
        assert!(err(input("2026-04-13", ("12:00", "09:00", ""), ("", "", ""))).contains("après"));
        assert!(err(input("2026-04-13", ("12:00", "12:00", ""), ("", "", ""))).contains("après"));
        assert!(
            err(input("2026-04-13", ("", "", ""), ("", "", "labour"))).starts_with("Après-midi")
        );
        assert!(
            err(input("2026-04-13", ("25:00", "26:00", ""), ("", "", ""))).contains("invalide")
        );
        assert!(
            err(input(
                "2026-04-13",
                ("09:00", "14:00", ""),
                ("13:00", "17:00", "")
            ))
            .contains("chevauchent")
        );
        let long = "x".repeat(MAX_TASKS_LEN + 1);
        assert!(
            err(input("2026-04-13", ("09:00", "12:00", &long), ("", "", ""))).contains("limités")
        );
    }

    #[test]
    fn conversions_excel() {
        assert_eq!(
            excel_date(NaiveDate::from_ymd_opt(1900, 1, 1).unwrap()),
            2.0
        );
        assert_eq!(
            excel_date(NaiveDate::from_ymd_opt(2026, 4, 13).unwrap()),
            46125.0
        );
        assert_eq!(excel_time(t(6, 0)), 0.25);
        assert_eq!(excel_time(t(18, 0)), 0.75);
        assert_eq!(minutes_fraction(180), 0.125);
        assert_eq!(col_letter(0), 'A');
        assert_eq!(col_letter(9), 'J');
    }

    #[test]
    fn nom_de_fichier() {
        assert_eq!(file_slug("Jean Dupré"), "jean_dupr");
        assert_eq!(file_slug("../.."), "utilisateur");
    }

    #[test]
    fn classeur_genere() {
        let days = vec![
            validate(&input(
                "2025-12-21",
                ("10:00", "13:00", "labour"),
                ("", "", ""),
            ))
            .unwrap(),
            validate(&input(
                "2026-04-13",
                ("06:00", "11:00", "comptage"),
                ("15:00", "21:00", "terrier"),
            ))
            .unwrap(),
            validate(&input(
                "2023-07-18",
                ("", "", ""),
                ("22:00", "03:00", "moisson"),
            ))
            .unwrap(),
        ];
        for days in [days.as_slice(), &[]] {
            let bytes = build_workbook(days).unwrap();
            assert!(bytes.starts_with(b"PK"), "fichier xlsx (zip)");
        }
    }
}
