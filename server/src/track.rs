//! Historique GPS : jours disponibles (`gps_days`), simplification des traces
//! et compaction quotidienne de `gps_track`.
//!
//! La compaction tourne chaque jour à 5 h (heure de Paris) sur les jours
//! précédents non encore traités. Elle supprime les points qui n'apportent
//! aucune information au-delà de la précision de la mesure :
//!  - à l'arrêt, les positions qui restent dans la précision du point
//!    d'ancrage (on garde l'arrivée et le départ) ;
//!  - sur une ligne droite, tous les points intermédiaires situés à moins de
//!    leur propre précision du segment (Douglas-Peucker).

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Days, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Europe::Paris;
use serde_json::{Map, Value};
use sqlx::Row;

use crate::state::AppState;

/// Tolérance minimale : précision d'un RTK Fix.
const MIN_TOLERANCE_M: f64 = 0.02;
/// Tolérance maximale : au-delà, une position (réseau ±400 m…) ne permettrait
/// plus de distinguer un vrai déplacement, on ne s'y fie pas pour supprimer.
const MAX_TOLERANCE_M: f64 = 2.0;
/// Tolérance d'un point sans précision connue.
const DEFAULT_TOLERANCE_M: f64 = 0.5;
/// Un écart plus long entre deux points conservés (arrêt, coupure) borne les
/// segments simplifiés : on ne relie pas deux passages distincts.
const SEGMENT_GAP_MS: i64 = 30_000;
/// Jours précédents rattrapés à chaque passage (serveur arrêté à 5 h…).
const CATCH_UP_DAYS: u64 = 7;
const COMPACTION_HOUR: u32 = 5;
const DELETE_CHUNK: usize = 1_000;
const EARTH_RADIUS_M: f64 = 6_371_000.0;

// ── Jours calendaires (Paris) ─────────────────────────────────────────────

/// Minuit (heure de Paris) du jour donné, en ms epoch.
pub fn paris_midnight_ms(date: NaiveDate) -> i64 {
    let naive = date.and_time(NaiveTime::MIN);
    match Paris.from_local_datetime(&naive) {
        LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => dt.timestamp_millis(),
        LocalResult::None => Utc.from_utc_datetime(&naive).timestamp_millis(),
    }
}

/// Jour calendaire (Paris) d'un timestamp en ms.
pub fn paris_day(timestamp_ms: i64) -> Option<NaiveDate> {
    DateTime::from_timestamp_millis(timestamp_ms).map(|dt| dt.with_timezone(&Paris).date_naive())
}

fn paris_today() -> NaiveDate {
    Utc::now().with_timezone(&Paris).date_naive()
}

/// Enregistre les jours (Paris) couverts par ces points dans `gps_days`.
pub async fn record_days(
    state: &AppState,
    points: &[Map<String, Value>],
) -> Result<(), sqlx::Error> {
    let days: HashSet<(NaiveDate, &str)> = points
        .iter()
        .filter_map(|p| {
            let day = paris_day(p.get("timestamp")?.as_i64()?)?;
            Some((day, p.get("device_id")?.as_str()?))
        })
        .collect();
    if days.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "INSERT IGNORE INTO gps_days (day, device_id) VALUES {}",
        vec!["(?, ?)"; days.len()].join(", ")
    );
    let mut query = sqlx::query(&sql);
    for (day, device_id) in days {
        query = query.bind(day).bind(device_id);
    }
    query.execute(&state.pool).await?;
    Ok(())
}

/// Recalcule `gps_days` pour un jour à partir de `gps_track`.
async fn refresh_day(state: &AppState, day: NaiveDate) -> Result<(), sqlx::Error> {
    let Some(next) = day.succ_opt() else {
        return Ok(());
    };
    sqlx::query(
        "INSERT IGNORE INTO gps_days (day, device_id) SELECT ?, device_id FROM gps_track WHERE timestamp >= ? AND timestamp < ? GROUP BY device_id",
    )
    .bind(day)
    .bind(paris_midnight_ms(day))
    .bind(paris_midnight_ms(next))
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Remplit `gps_days` depuis l'historique s'il n'y figure pas encore
/// (premier démarrage) : du premier jour de `gps_track` au premier jour connu.
async fn backfill_days(state: &AppState) -> Result<(), sqlx::Error> {
    let row = sqlx::query(
        "SELECT (SELECT MIN(timestamp) FROM gps_track) AS lo, (SELECT MAX(timestamp) FROM gps_track) AS hi, (SELECT MIN(day) FROM gps_days) AS known",
    )
    .fetch_one(&state.pool)
    .await?;
    let (Some(lo), Some(hi)) = (
        row.try_get::<Option<i64>, _>("lo")?.and_then(paris_day),
        row.try_get::<Option<i64>, _>("hi")?.and_then(paris_day),
    ) else {
        return Ok(());
    };
    let known: Option<NaiveDate> = row.try_get("known")?;
    if known.is_some_and(|known| known <= lo) {
        return Ok(());
    }
    let mut day = lo;
    while day <= hi {
        refresh_day(state, day).await?;
        let Some(next) = day.succ_opt() else { break };
        day = next;
    }
    println!("[GPS] gps_days initialisée ({lo} → {hi})");
    Ok(())
}

// ── Simplification ────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct TrackPoint {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: Option<f64>,
    pub timestamp: i64,
    pub source: Option<String>,
}

impl TrackPoint {
    fn tolerance(&self) -> f64 {
        self.accuracy
            .filter(|a| a.is_finite() && *a > 0.0)
            .unwrap_or(DEFAULT_TOLERANCE_M)
            .clamp(MIN_TOLERANCE_M, MAX_TOLERANCE_M)
    }
}

/// Projection plane locale (équirectangulaire) en mètres : exacte à quelques
/// millimètres près à l'échelle d'une exploitation.
fn project(points: &[TrackPoint]) -> Vec<(f64, f64)> {
    let Some(origin) = points.first() else {
        return Vec::new();
    };
    let k = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
    let cos_lat = origin.latitude.to_radians().cos();
    points
        .iter()
        .map(|p| {
            (
                (p.longitude - origin.longitude) * k * cos_lat,
                (p.latitude - origin.latitude) * k,
            )
        })
        .collect()
}

fn distance(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// Distance de `p` au segment `[a, b]` (et non à la droite : un demi-tour sur
/// la même ligne reste détecté).
fn distance_to_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return distance(p, a);
    }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0);
    distance(p, (a.0 + t * dx, a.1 + t * dy))
}

/// Indices (croissants) des points à conserver. Les points doivent être
/// triés par timestamp. Premier et dernier point toujours conservés.
///
/// Garantie : chaque point retiré est à moins de sa propre précision
/// (bornée à [`MIN_TOLERANCE_M`], [`MAX_TOLERANCE_M`]) de la trace conservée.
pub fn simplify(points: &[TrackPoint]) -> Vec<usize> {
    let n = points.len();
    if n <= 2 {
        return (0..n).collect();
    }
    let xy = project(points);
    let mut keep = vec![false; n];
    let mut segment_start = 0;
    let mut idx = 0;
    while idx < n {
        // Arrêt : l'engin reste au moins SEGMENT_GAP_MS dans la précision du
        // point d'arrivée. Seuls l'arrivée et le départ sont gardés, et l'arrêt
        // borne les segments (on ne le « traverse » pas en ligne droite).
        let mut j = idx + 1;
        while j < n
            && points[j].source == points[idx].source
            && distance(xy[idx], xy[j]) <= points[j].tolerance()
        {
            j += 1;
        }
        let last = j - 1;
        if last > idx && points[last].timestamp - points[idx].timestamp >= SEGMENT_GAP_MS {
            douglas_peucker(segment_start, idx, points, &xy, &mut keep);
            keep[last] = true;
            segment_start = last;
            idx = last;
            continue;
        }
        // Coupure ou changement de source : fin de segment.
        if idx + 1 < n
            && (points[idx + 1].timestamp - points[idx].timestamp > SEGMENT_GAP_MS
                || points[idx + 1].source != points[idx].source)
        {
            douglas_peucker(segment_start, idx, points, &xy, &mut keep);
            segment_start = idx + 1;
        }
        idx += 1;
    }
    douglas_peucker(segment_start, n - 1, points, &xy, &mut keep);
    (0..n).filter(|&i| keep[i]).collect()
}

/// Douglas-Peucker sur `points[first..=last]`, à tolérance par point : marque
/// dans `keep` les points nécessaires pour que chaque point retiré reste à
/// moins de sa propre précision de la trace simplifiée.
fn douglas_peucker(
    first: usize,
    last: usize,
    points: &[TrackPoint],
    xy: &[(f64, f64)],
    keep: &mut [bool],
) {
    keep[first] = true;
    keep[last] = true;
    // Pile explicite : une journée à 10 Hz dépasserait la pile d'appels.
    let mut stack = vec![(first, last)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 {
            continue;
        }
        let (a, b) = (xy[lo], xy[hi]);
        let mut worst = None;
        let mut worst_excess = 0.0;
        for k in lo + 1..hi {
            let excess = distance_to_segment(xy[k], a, b) - points[k].tolerance();
            if excess > worst_excess {
                worst_excess = excess;
                worst = Some(k);
            }
        }
        if let Some(k) = worst {
            keep[k] = true;
            stack.push((lo, k));
            stack.push((k, hi));
        }
    }
}

// ── Compaction quotidienne ────────────────────────────────────────────────

/// Compacte un jour pour un device. Retourne (points avant, points après).
async fn compact_device_day(
    state: &AppState,
    day: NaiveDate,
    device_id: &str,
) -> Result<(usize, usize), sqlx::Error> {
    let Some(next) = day.succ_opt() else {
        return Ok((0, 0));
    };
    let rows = sqlx::query(
        "SELECT id, latitude, longitude, accuracy, timestamp, source FROM gps_track WHERE device_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp",
    )
    .bind(device_id)
    .bind(paris_midnight_ms(day))
    .bind(paris_midnight_ms(next))
    .fetch_all(&state.pool)
    .await?;

    let mut ids = Vec::with_capacity(rows.len());
    let mut points = Vec::with_capacity(rows.len());
    for row in &rows {
        ids.push(row.try_get::<i64, _>("id")?);
        points.push(TrackPoint {
            latitude: row.try_get("latitude")?,
            longitude: row.try_get("longitude")?,
            accuracy: row.try_get::<Option<f32>, _>("accuracy")?.map(f64::from),
            timestamp: row.try_get("timestamp")?,
            source: row.try_get("source")?,
        });
    }
    let before = points.len();
    let kept = tokio::task::spawn_blocking(move || simplify(&points))
        .await
        .unwrap_or_else(|_| (0..before).collect());
    let kept_set: HashSet<usize> = kept.iter().copied().collect();
    let removed: Vec<i64> = (0..before)
        .filter(|i| !kept_set.contains(i))
        .map(|i| ids[i])
        .collect();

    let mut tx = state.pool.begin().await?;
    for chunk in removed.chunks(DELETE_CHUNK) {
        let sql = format!(
            "DELETE FROM gps_track WHERE id IN ({})",
            vec!["?"; chunk.len()].join(", ")
        );
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(id);
        }
        query.execute(&mut *tx).await?;
    }
    sqlx::query(
        "INSERT INTO gps_compaction (day, device_id, points_before, points_after) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE points_before = VALUES(points_before), points_after = VALUES(points_after), compacted_at = CURRENT_TIMESTAMP",
    )
    .bind(day)
    .bind(device_id)
    .bind(before as i64)
    .bind(kept.len() as i64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((before, kept.len()))
}

/// Compacte les jours `[from, to]` non encore compactés.
pub async fn compact_days(
    state: &AppState,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<(), sqlx::Error> {
    backfill_days(state).await?;
    let mut day = from;
    while day <= to {
        refresh_day(state, day).await?;
        let Some(next) = day.succ_opt() else { break };
        day = next;
    }
    let pending = sqlx::query(
        "SELECT d.day, d.device_id FROM gps_days d LEFT JOIN gps_compaction c ON c.day = d.day AND c.device_id = d.device_id WHERE d.day BETWEEN ? AND ? AND c.day IS NULL ORDER BY d.day, d.device_id",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&state.pool)
    .await?;
    for row in &pending {
        let day: NaiveDate = row.try_get("day")?;
        let device_id: String = row.try_get("device_id")?;
        let (before, after) = compact_device_day(state, day, &device_id).await?;
        println!("[GPS] Compaction {day} device={device_id} : {before} → {after} points");
    }
    Ok(())
}

/// Supprime l'historique plus ancien que la durée de conservation.
async fn apply_retention(state: &AppState, days: u32) -> Result<(), sqlx::Error> {
    let Some(cutoff) = paris_today().checked_sub_days(Days::new(u64::from(days))) else {
        return Ok(());
    };
    let cutoff_ms = paris_midnight_ms(cutoff);
    let mut total = 0;
    loop {
        let res = sqlx::query("DELETE FROM gps_track WHERE timestamp < ? LIMIT 10000")
            .bind(cutoff_ms)
            .execute(&state.pool)
            .await?;
        total += res.rows_affected();
        if res.rows_affected() == 0 {
            break;
        }
    }
    sqlx::query("DELETE FROM gps_days WHERE day < ?")
        .bind(cutoff)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM gps_compaction WHERE day < ?")
        .bind(cutoff)
        .execute(&state.pool)
        .await?;
    if total > 0 {
        println!("[GPS] Rétention {days} j : {total} points antérieurs au {cutoff} supprimés");
    }
    Ok(())
}

/// Passage quotidien : rattrapage des derniers jours puis rétention.
async fn nightly(state: &AppState) -> Result<(), sqlx::Error> {
    let today = paris_today();
    if let (Some(from), Some(to)) = (
        today.checked_sub_days(Days::new(CATCH_UP_DAYS)),
        today.pred_opt(),
    ) {
        compact_days(state, from, to).await?;
    }
    if let Some(days) = state.cfg.gps_retention_days {
        apply_retention(state, days).await?;
    }
    Ok(())
}

/// Prochain passage à 5 h, heure de Paris.
fn next_run(now: DateTime<Utc>) -> DateTime<Utc> {
    let local = now.with_timezone(&Paris);
    let at = |date: NaiveDate| {
        let naive = date.and_hms_opt(COMPACTION_HOUR, 0, 0).unwrap_or_default();
        Paris
            .from_local_datetime(&naive)
            .earliest()
            .map(|dt| dt.with_timezone(&Utc))
    };
    match at(local.date_naive()) {
        Some(today) if today > now => today,
        _ => local
            .date_naive()
            .succ_opt()
            .and_then(at)
            .unwrap_or(now + chrono::Duration::days(1)),
    }
}

/// Migrations, initialisation de `gps_days`, puis compaction à 5 h chaque jour.
/// Les erreurs de base (MariaDB pas encore prête…) sont réessayées.
pub fn spawn_maintenance(state: AppState) {
    tokio::spawn(async move {
        loop {
            match crate::db::migrate(&state.pool).await {
                Ok(()) => break,
                Err(err) => {
                    eprintln!("[DB] Migrations impossibles, nouvel essai dans 30 s : {err}");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        }
        if let Err(err) = backfill_days(&state).await {
            eprintln!("[GPS] Erreur initialisation gps_days: {err}");
        }
        if let Err(err) = nightly(&state).await {
            eprintln!("[GPS] Erreur compaction: {err}");
        }
        loop {
            let wait = (next_run(Utc::now()) - Utc::now())
                .to_std()
                .unwrap_or(Duration::from_secs(60));
            tokio::time::sleep(wait).await;
            if let Err(err) = nightly(&state).await {
                eprintln!("[GPS] Erreur compaction: {err}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point à `x` m à l'est et `y` m au nord d'un point de référence.
    fn at(x: f64, y: f64, t_s: i64, accuracy: f64) -> TrackPoint {
        let lat0: f64 = 48.0;
        let k = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
        TrackPoint {
            latitude: lat0 + y / k,
            longitude: -1.0 + x / (k * lat0.to_radians().cos()),
            accuracy: Some(accuracy),
            timestamp: 1_800_000_000_000 + t_s * 1000,
            source: Some("RTK RTK Fix".into()),
        }
    }

    #[test]
    fn straight_line_keeps_ends_only() {
        let points: Vec<_> = (0..100)
            .map(|i| at(i as f64, 0.001 * (i % 2) as f64, i, 0.02))
            .collect();
        assert_eq!(simplify(&points), vec![0, 99]);
    }

    #[test]
    fn turns_are_kept() {
        // Aller vers l'est puis demi-tour vers le nord : l'angle reste.
        let mut points: Vec<_> = (0..=50).map(|i| at(i as f64, 0.0, i, 0.02)).collect();
        points.extend((1..=50).map(|i| at(50.0, i as f64, 50 + i, 0.02)));
        assert_eq!(simplify(&points), vec![0, 50, 100]);
    }

    #[test]
    fn back_and_forth_on_same_line_is_kept() {
        let mut points: Vec<_> = (0..=10).map(|i| at(i as f64, 0.0, i, 0.02)).collect();
        points.extend((1..=10).map(|i| at(10.0 - i as f64, 0.0, 10 + i, 0.02)));
        assert_eq!(simplify(&points), vec![0, 10, 20]);
    }

    #[test]
    fn stop_keeps_arrival_and_departure() {
        let mut points: Vec<_> = (0..=10).map(|i| at(i as f64, 0.0, i, 0.5)).collect();
        // 10 min à l'arrêt, bruit de 20 cm.
        points.extend((1..=600).map(|i| at(10.0 + 0.2 * ((i % 3) as f64 - 1.0), 0.0, 10 + i, 0.5)));
        points.extend((1..=10).map(|i| at(10.0 + i as f64, 0.0, 610 + i, 0.5)));
        let kept = simplify(&points);
        assert_eq!(kept.first(), Some(&0));
        assert_eq!(kept.last(), Some(&(points.len() - 1)));
        assert_eq!(kept.len(), 4, "{kept:?}");
        // Arrivée et départ de l'arrêt conservés : sa durée reste visible.
        assert!(kept.contains(&10) && kept.contains(&610), "{kept:?}");
        assert_within_accuracy(&points, &kept);
    }

    #[test]
    fn deviation_beyond_accuracy_is_kept() {
        // Écart de 10 cm au milieu d'une ligne : gardé en RTK Fix (±2 cm),
        // supprimé avec un GPS interne (±3 m).
        let line = |acc| -> Vec<TrackPoint> {
            (0..=20)
                .map(|i| at(i as f64, if i == 10 { 0.1 } else { 0.0 }, i, acc))
                .collect()
        };
        // Avec ±2 cm, les voisins du pic sont eux aussi à ~9 cm des segments
        // qui y mènent : ils sont gardés.
        assert_eq!(simplify(&line(0.02)), vec![0, 9, 10, 11, 20]);
        assert_eq!(simplify(&line(3.0)), vec![0, 20]);
    }

    #[test]
    fn removed_points_stay_within_their_accuracy() {
        // Trajectoire sinueuse : chaque point retiré est à moins de sa
        // précision de la trace conservée.
        let points: Vec<_> = (0..2000)
            .map(|i| {
                let t = i as f64 / 10.0;
                at(t * 3.0, (t / 5.0).sin() * 20.0, i, 0.05)
            })
            .collect();
        let kept = simplify(&points);
        assert!(kept.len() < points.len() / 4, "{}", kept.len());
        assert_within_accuracy(&points, &kept);
    }

    #[test]
    fn noisy_stop_and_go_stays_within_accuracy() {
        // GPS interne (±3 m) bruité, avec arrêts courts et longs.
        let mut points = Vec::new();
        let mut t = 0;
        for leg in 0..20 {
            for i in 0..60 {
                let noise = ((t * 7919) % 13) as f64 / 13.0 - 0.5;
                points.push(at(leg as f64 * 30.0 + i as f64 * 0.5, noise, t, 3.0));
                t += 1;
            }
            for _ in 0..(leg * 5) {
                let noise = ((t * 104_729) % 11) as f64 / 11.0 - 0.5;
                points.push(at(leg as f64 * 30.0 + 30.0, noise, t, 3.0));
                t += 1;
            }
        }
        let kept = simplify(&points);
        assert!(kept.len() < points.len() / 10, "{}", kept.len());
        assert_within_accuracy(&points, &kept);
    }

    /// Chaque point retiré est à moins de sa précision de la trace conservée.
    fn assert_within_accuracy(points: &[TrackPoint], kept: &[usize]) {
        let xy = project(points);
        for w in kept.windows(2) {
            for i in w[0] + 1..w[1] {
                let d = distance_to_segment(xy[i], xy[w[0]], xy[w[1]]);
                assert!(d <= points[i].tolerance() + 1e-9, "point {i} à {d} m");
            }
        }
    }

    #[test]
    fn next_run_is_5am_paris() {
        // 29/10/2026 08:00 UTC (09:00 Paris) → 30/10 05:00 Paris = 04:00 UTC.
        let now = Utc.with_ymd_and_hms(2026, 10, 29, 8, 0, 0).unwrap();
        assert_eq!(
            next_run(now),
            Utc.with_ymd_and_hms(2026, 10, 30, 4, 0, 0).unwrap()
        );
        // 29/10/2026 02:00 UTC (03:00 Paris) → même jour 05:00 Paris.
        let early = Utc.with_ymd_and_hms(2026, 10, 29, 2, 0, 0).unwrap();
        assert_eq!(
            next_run(early),
            Utc.with_ymd_and_hms(2026, 10, 29, 4, 0, 0).unwrap()
        );
    }

    #[test]
    fn paris_day_bounds() {
        // Heure d'hiver : UTC+1 ; heure d'été : UTC+2.
        let winter = NaiveDate::from_ymd_opt(2026, 1, 15).unwrap();
        assert_eq!(paris_midnight_ms(winter), 1_768_431_600_000);
        let summer = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();
        assert_eq!(paris_midnight_ms(summer), 1_784_066_400_000);
        assert_eq!(paris_day(1_768_431_600_000), Some(winter));
        assert_eq!(paris_day(1_768_431_599_999), winter.pred_opt());
    }
}
