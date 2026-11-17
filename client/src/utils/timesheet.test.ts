import { describe, expect, it } from "vitest";
import {
  afternoonMinutes,
  dayMinutes,
  emptyPayload,
  endsNextDay,
  formatDayLabel,
  formatDuration,
  formatMonthLabel,
  groupStats,
  halfDayMinutes,
  monthKey,
  monthPeriod,
  morningMinutes,
  parseTime,
  sumStats,
  validatePayload,
  yearKey,
  yearPeriod,
} from "./timesheet";
import type { TimesheetEntry, TimesheetPayload } from "../types/api";

function payload(overrides: Partial<TimesheetPayload>): TimesheetPayload {
  return { ...emptyPayload("2026-04-13"), ...overrides };
}

describe("parseTime", () => {
  it("lit HH:MM et HH:MM:SS", () => {
    expect(parseTime("06:00")).toBe(360);
    expect(parseTime("9:30")).toBe(570);
    expect(parseTime("23:59:00")).toBe(1439);
  });

  it("rejette les valeurs vides ou hors limites", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("12:60")).toBeNull();
    expect(parseTime("midi")).toBeNull();
  });
});

describe("durées", () => {
  it("calcule une demi-journée et une journée", () => {
    expect(halfDayMinutes("10:00", "13:00")).toBe(180);
    expect(halfDayMinutes("13:00", "10:00")).toBe(0);
    expect(halfDayMinutes(null, "10:00")).toBe(0);
    expect(
      dayMinutes({
        morning_start: "06:00",
        morning_end: "11:00",
        afternoon_start: "15:00",
        afternoon_end: "21:00",
      }),
    ).toBe(11 * 60);
  });

  it("formate comme [h]:mm, au-delà de 24 h", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(210)).toBe("3:30");
    expect(formatDuration(12 * 60)).toBe("12:00");
    expect(formatDuration(87 * 60 + 5)).toBe("87:05");
  });
});

describe("après-midi après minuit", () => {
  it("compte la fin le lendemain, jusqu'à 6 h", () => {
    const entry = {
      morning_start: "09:00",
      morning_end: "12:00",
      afternoon_start: "22:00",
      afternoon_end: "03:00",
    };
    expect(endsNextDay("22:00", "03:00")).toBe(true);
    expect(dayMinutes(entry)).toBe(3 * 60 + 5 * 60);
    expect(halfDayMinutes("19:00", "06:00", true)).toBe(11 * 60);
    expect(halfDayMinutes("14:00", "13:00", true)).toBe(0);
    // Le matin ne passe pas minuit.
    expect(halfDayMinutes("22:00", "03:00")).toBe(0);
  });

  it("valide comme le serveur", () => {
    expect(
      validatePayload(
        payload({ afternoon_start: "22:00", afternoon_end: "03:00" }),
      ),
    ).toBeNull();
    expect(
      validatePayload(
        payload({ afternoon_start: "14:00", afternoon_end: "13:00" }),
      ),
    ).toMatch(/lendemain/);
    expect(
      validatePayload(
        payload({ morning_start: "23:00", morning_end: "02:00" }),
      ),
    ).toMatch(/^Matin/);
  });
});

describe("case x2", () => {
  it("double les heures de la demi-journée cochée", () => {
    const day = payload({
      morning_start: "10:00",
      morning_end: "12:00",
      afternoon_start: "15:00",
      afternoon_end: "21:00",
      afternoon_double: true,
    });
    expect(morningMinutes(day)).toBe(120);
    expect(afternoonMinutes(day)).toBe(12 * 60);
    expect(dayMinutes(day)).toBe(14 * 60);
    expect(validatePayload(day)).toBeNull();
  });

  it("double aussi un après-midi qui passe minuit", () => {
    const day = payload({
      afternoon_start: "22:00",
      afternoon_end: "03:00",
      afternoon_double: true,
    });
    expect(afternoonMinutes(day)).toBe(10 * 60);
  });

  it("refuse x2 sans horaires", () => {
    expect(
      validatePayload(
        payload({
          morning_double: true,
          afternoon_start: "14:00",
          afternoon_end: "17:00",
        }),
      ),
    ).toMatch(/^Matin/);
  });
});

describe("validatePayload", () => {
  it("accepte une demi-journée seule, même à horaires atypiques", () => {
    expect(
      validatePayload(
        payload({ afternoon_start: "11:00", afternoon_end: "23:00" }),
      ),
    ).toBeNull();
    expect(
      validatePayload(
        payload({ morning_start: "08:00", morning_end: "18:00" }),
      ),
    ).toBeNull();
  });

  it("signale les saisies incomplètes ou incohérentes", () => {
    expect(validatePayload(payload({}))).toBe(
      "Renseignez au moins une demi-journée",
    );
    expect(validatePayload(payload({ date: "" }))).toBe("Date invalide");
    expect(validatePayload(payload({ morning_start: "09:00" }))).toMatch(
      /^Matin/,
    );
    expect(
      validatePayload(
        payload({ morning_start: "12:00", morning_end: "09:00" }),
      ),
    ).toMatch(/après/);
    expect(validatePayload(payload({ afternoon_tasks: "labour" }))).toMatch(
      /^Après-midi/,
    );
    expect(
      validatePayload(
        payload({
          morning_start: "09:00",
          morning_end: "14:00",
          afternoon_start: "13:00",
          afternoon_end: "17:00",
        }),
      ),
    ).toMatch(/chevauchent/);
  });
});

describe("périodes", () => {
  it("donne le mois courant, le précédent et l'année", () => {
    const date = new Date(2026, 0, 15);
    expect(monthPeriod(date)).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(monthPeriod(date, -1)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(monthPeriod(new Date(2028, 1, 10))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(yearPeriod(date)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("affiche une date sans décalage de fuseau", () => {
    expect(formatDayLabel("2026-04-13")).toMatch(/13\/04\/2026$/);
  });
});

describe("statistiques", () => {
  const entry = (
    id: number,
    date: string,
    overrides: Partial<TimesheetEntry> = {},
  ): TimesheetEntry => ({
    id,
    user_id: "u1",
    date,
    morning_start: "09:00",
    morning_end: "12:00",
    morning_tasks: null,
    morning_double: false,
    afternoon_start: null,
    afternoon_end: null,
    afternoon_tasks: null,
    afternoon_double: false,
    ...overrides,
  });
  const entries = [
    entry(1, "2026-05-02"),
    entry(2, "2026-04-30", {
      afternoon_start: "15:00",
      afternoon_end: "21:00",
      afternoon_double: true,
    }),
    entry(3, "2025-12-01"),
  ];

  it("regroupe par mois, x2 compris", () => {
    const rows = groupStats(entries, monthKey);
    expect(rows.map((r) => r.key)).toEqual(["2025-12", "2026-04", "2026-05"]);
    expect(rows[1]).toEqual({
      key: "2026-04",
      days: 1,
      morning: 180,
      afternoon: 720,
      total: 900,
      doubled: 360,
    });
  });

  it("regroupe par année et totalise", () => {
    const rows = groupStats(entries, yearKey);
    expect(rows.map((r) => [r.key, r.days, r.total])).toEqual([
      ["2025", 1, 180],
      ["2026", 2, 1080],
    ]);
    expect(sumStats(rows)).toMatchObject({
      days: 3,
      total: 1260,
      doubled: 360,
    });
  });

  it("libellé du mois", () => {
    expect(formatMonthLabel("2026-05")).toBe("mai 2026");
  });
});
