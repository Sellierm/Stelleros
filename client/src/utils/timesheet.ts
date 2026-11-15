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

/** Durée d'une demi-journée en minutes (0 si incomplète ou incohérente). */
export function halfDayMinutes(
  start: string | null | undefined,
  end: string | null | undefined,
): number {
  const s = parseTime(start);
  const e = parseTime(end);
  return s === null || e === null || e <= s ? 0 : e - s;
}

type Times = Pick<
  TimesheetEntry,
  "morning_start" | "morning_end" | "afternoon_start" | "afternoon_end"
>;

export function morningMinutes(entry: Times): number {
  return halfDayMinutes(entry.morning_start, entry.morning_end);
}

export function afternoonMinutes(entry: Times): number {
  return halfDayMinutes(entry.afternoon_start, entry.afternoon_end);
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
): string | null {
  const hasStart = start.trim() !== "";
  const hasEnd = end.trim() !== "";
  if (!hasStart && !hasEnd) {
    return tasks.trim()
      ? `${label} : indiquez les heures de début et de fin`
      : null;
  }
  if (!hasStart || !hasEnd) {
    return `${label} : indiquez les heures de début et de fin`;
  }
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === null || e === null) return `${label} : heure invalide`;
  if (e <= s)
    return `${label} : l'heure de fin doit être après l'heure de début`;
  return null;
}

/** Message d'erreur de saisie, ou null si la journée est valide. */
export function validatePayload(form: TimesheetPayload): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return "Date invalide";
  const morningError = validateHalf(
    "Matin",
    form.morning_start,
    form.morning_end,
    form.morning_tasks,
  );
  if (morningError) return morningError;
  const afternoonError = validateHalf(
    "Après-midi",
    form.afternoon_start,
    form.afternoon_end,
    form.afternoon_tasks,
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
    afternoon_start: "",
    afternoon_end: "",
    afternoon_tasks: "",
  };
}

export function entryToPayload(entry: TimesheetEntry): TimesheetPayload {
  return {
    date: entry.date,
    morning_start: entry.morning_start ?? "",
    morning_end: entry.morning_end ?? "",
    morning_tasks: entry.morning_tasks ?? "",
    afternoon_start: entry.afternoon_start ?? "",
    afternoon_end: entry.afternoon_end ?? "",
    afternoon_tasks: entry.afternoon_tasks ?? "",
  };
}
