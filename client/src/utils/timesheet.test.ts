import { describe, expect, it } from "vitest";
import {
  dayMinutes,
  emptyPayload,
  formatDayLabel,
  formatDuration,
  halfDayMinutes,
  monthPeriod,
  parseTime,
  validatePayload,
  yearPeriod,
} from "./timesheet";
import type { TimesheetPayload } from "../types/api";

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
