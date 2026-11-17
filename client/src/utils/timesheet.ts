// Calculs du pointage des heures. Les règles de validation reprennent celles
// du serveur (server/src/routes/timesheet.rs) pour signaler les erreurs avant
// l'envoi ; le serveur reste la référence.

import type { TimesheetEntry, TimesheetPayload } from "../types/api";

/** « HH:MM » (ou « HH:MM:SS ») → minutes depuis minuit ; null si vide ou invalide. */
export function parseTime(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Dernière heure de fin (6:00) d'un après-midi qui passe minuit. */
export const OVERNIGHT_MAX_END = 6 * 60;

/**
 * L'heure de fin tombe-t-elle le lendemain ? Seul l'après-midi peut passer
 * minuit (moisson, labour de nuit), et au plus tard jusqu'à 6 h.
 */
export function endsNextDay(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  const s = parseTime(start);
  const e = parseTime(end);
  return s !== null && e !== null && e < s && e <= OVERNIGHT_MAX_END;
}

/** Durée d'une demi-journée en minutes (0 si incomplète ou incohérente). */
export function halfDayMinutes(
  start: string | null | undefined,
  end: string | null | undefined,
  overnight = false,
): number {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === null || e === null) return 0;
  if (e > s) return e - s;
  return overnight && endsNextDay(start, end) ? e + 24 * 60 - s : 0;
}

type Times = Pick<
  TimesheetEntry,
  "morning_start" | "morning_end" | "afternoon_start" | "afternoon_end"
> &
  Partial<Pick<TimesheetEntry, "morning_double" | "afternoon_double">>;

/** Heures comptées du matin : la durée, doublée si la case « x2 » est cochée. */
export function morningMinutes(entry: Times): number {
  const minutes = halfDayMinutes(entry.morning_start, entry.morning_end);
  return entry.morning_double ? minutes * 2 : minutes;
}

/** Heures comptées de l'après-midi (passage de minuit compris, « x2 » doublé). */
export function afternoonMinutes(entry: Times): number {
  const minutes = halfDayMinutes(
    entry.afternoon_start,
    entry.afternoon_end,
    true,
  );
  return entry.afternoon_double ? minutes * 2 : minutes;
}

export function dayMinutes(entry: Times): number {
  return morningMinutes(entry) + afternoonMinutes(entry);
}

/** Minutes → « 7:30 », comme le format [h]:mm d'Excel (pas de limite à 24 h). */
export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

function validateHalf(
  label: string,
  start: string,
  end: string,
  tasks: string,
  double: boolean,
  overnight: boolean,
): string | null {
  const hasStart = start.trim() !== "";
  const hasEnd = end.trim() !== "";
  if (!hasStart && !hasEnd) {
    return tasks.trim() || double
      ? `${label} : indiquez les heures de début et de fin`
      : null;
  }
  if (!hasStart || !hasEnd) {
    return `${label} : indiquez les heures de début et de fin`;
  }
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === null || e === null) return `${label} : heure invalide`;
  if (e > s || (overnight && endsNextDay(start, end))) return null;
  return overnight
    ? `${label} : l'heure de fin doit être après l'heure de début (ou au plus tard 6:00 le lendemain)`
    : `${label} : l'heure de fin doit être après l'heure de début`;
}

/** Message d'erreur de saisie, ou null si la journée est valide. */
export function validatePayload(form: TimesheetPayload): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return "Date invalide";
  const morningError = validateHalf(
    "Matin",
    form.morning_start,
    form.morning_end,
    form.morning_tasks,
    form.morning_double,
    false,
  );
  if (morningError) return morningError;
  const afternoonError = validateHalf(
    "Après-midi",
    form.afternoon_start,
    form.afternoon_end,
    form.afternoon_tasks,
    form.afternoon_double,
    true,
  );
  if (afternoonError) return afternoonError;

  const morning = morningMinutes(form);
  const afternoon = afternoonMinutes(form);
  if (!morning && !afternoon) return "Renseignez au moins une demi-journée";
  if (
    morning &&
    afternoon &&
    (parseTime(form.morning_end) ?? 0) > (parseTime(form.afternoon_start) ?? 0)
  ) {
    return "Les horaires du matin et de l'après-midi se chevauchent";
  }
  return null;
}

// ─── Dates et périodes (dates locales « AAAA-MM-JJ ») ─────────

export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface Period {
  from: string;
  to: string;
}

/** Mois contenant `date`, décalé de `offset` mois. */
export function monthPeriod(date: Date, offset = 0): Period {
  const first = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: isoDate(first), to: isoDate(last) };
}

export function yearPeriod(date: Date, offset = 0): Period {
  const year = date.getFullYear() + offset;
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** « 2026-04-13 » → « lun. 13/04/2026 », sans décalage de fuseau. */
export function formatDayLabel(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("fr-FR", { weekday: "short" });
  return `${weekday} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

export function emptyPayload(date: string): TimesheetPayload {
  return {
    date,
    morning_start: "",
    morning_end: "",
    morning_tasks: "",
    morning_double: false,
    afternoon_start: "",
    afternoon_end: "",
    afternoon_tasks: "",
    afternoon_double: false,
  };
}

export function entryToPayload(entry: TimesheetEntry): TimesheetPayload {
  return {
    date: entry.date,
    morning_start: entry.morning_start ?? "",
    morning_end: entry.morning_end ?? "",
    morning_tasks: entry.morning_tasks ?? "",
    morning_double: entry.morning_double,
    afternoon_start: entry.afternoon_start ?? "",
    afternoon_end: entry.afternoon_end ?? "",
    afternoon_tasks: entry.afternoon_tasks ?? "",
    afternoon_double: entry.afternoon_double,
  };
}

// ─── Statistiques ─────────────────────────────────────────────

export interface StatRow {
  key: string;
  days: number;
  morning: number;
  afternoon: number;
  total: number;
  /** Minutes ajoutées par les cases « x2 » (déjà comprises dans total). */
  doubled: number;
}

/** Totaux par groupe (mois, année…), dans l'ordre croissant des clés. */
export function groupStats(
  entries: TimesheetEntry[],
  keyOf: (entry: TimesheetEntry) => string,
): StatRow[] {
  const rows = new Map<string, StatRow>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const row = rows.get(key) ?? {
      key,
      days: 0,
      morning: 0,
      afternoon: 0,
      total: 0,
      doubled: 0,
    };
    const morning = morningMinutes(entry);
    const afternoon = afternoonMinutes(entry);
    if (morning + afternoon > 0) row.days += 1;
    row.morning += morning;
    row.afternoon += afternoon;
    row.total += morning + afternoon;
    if (entry.morning_double) row.doubled += morning / 2;
    if (entry.afternoon_double) row.doubled += afternoon / 2;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Somme de plusieurs lignes (ligne « Total » d'un tableau). */
export function sumStats(rows: StatRow[], key = "total"): StatRow {
  return rows.reduce(
    (sum, row) => ({
      key,
      days: sum.days + row.days,
      morning: sum.morning + row.morning,
      afternoon: sum.afternoon + row.afternoon,
      total: sum.total + row.total,
      doubled: sum.doubled + row.doubled,
    }),
    { key, days: 0, morning: 0, afternoon: 0, total: 0, doubled: 0 },
  );
}

export const monthKey = (entry: Pick<TimesheetEntry, "date">) =>
  entry.date.slice(0, 7);
export const yearKey = (entry: Pick<TimesheetEntry, "date">) =>
  entry.date.slice(0, 4);

/** « 2026-05 » → « mai 2026 ». */
export function formatMonthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });
}

/**
 * Lignes mensuelles contiguës : les mois sans journée entre le premier et le
 * dernier valent 0, pour qu'un graphique garde un axe du temps régulier.
 */
export function fillMonths(rows: StatRow[]): StatRow[] {
  if (rows.length === 0) return [];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const [firstYear, firstMonth] = rows[0].key.split("-").map(Number);
  const last = rows[rows.length - 1].key;
  const out: StatRow[] = [];
  for (let i = 0; ; i += 1) {
    const date = new Date(firstYear, firstMonth - 1 + i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    out.push(
      byKey.get(key) ?? {
        key,
        days: 0,
        morning: 0,
        afternoon: 0,
        total: 0,
        doubled: 0,
      },
    );
    if (key >= last) return out;
  }
}

/** « 2026-05 » → « mai 26 » (axe des graphiques). */
export function formatMonthShort(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const month = new Date(y, m - 1, 1)
    .toLocaleDateString("fr-FR", { month: "short" })
    .replace(".", "");
  return `${month} ${String(y).slice(2)}`;
}
