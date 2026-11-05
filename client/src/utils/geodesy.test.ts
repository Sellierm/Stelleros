import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_M, polygonAreaM2, ringAreaM2 } from "./geodesy";
import { at, rect, sphericalBoxArea } from "../test/geo";

const relativeError = (actual: number, expected: number) =>
  Math.abs(actual - expected) / expected;

describe("ringAreaM2", () => {
  it("donne l'aire exacte d'un rectangle en latitude et longitude", () => {
    for (const box of [
      rect(0, 0, 100, 100),
      rect(-500, 2000, 300, 2600),
      rect(0, 0, 3000, 3000),
    ]) {
      expect(
        relativeError(ringAreaM2(box), sphericalBoxArea(box)),
      ).toBeLessThan(1e-9);
    }
  });

  it("utilise le rayon de Google Maps (outil de mesure de My Maps)", () => {
    expect(EARTH_RADIUS_M).toBe(6378137);
    // Un degré sur un degré à l'équateur : R² × π/180 × sin(1°).
    const square = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
      { lat: 1, lng: 0 },
    ];
    const expected =
      EARTH_RADIUS_M ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180);
    expect(relativeError(ringAreaM2(square), expected)).toBeLessThan(1e-12);
  });

  it("ne dépend ni du sens de parcours ni du premier sommet", () => {
    const box = rect(0, 0, 250, 400);
    const area = ringAreaM2(box);
    expect(ringAreaM2([...box].reverse())).toBeCloseTo(area, 4);
    expect(ringAreaM2([...box.slice(1), box[0]])).toBeCloseTo(area, 4);
  });

  it("accepte un anneau fermé comme en KML (premier sommet répété)", () => {
    const box = rect(0, 0, 250, 400);
    expect(ringAreaM2([...box, box[0]])).toBeCloseTo(ringAreaM2(box), 4);
  });

  it("mesure un triangle et un contour non convexe", () => {
    // Triangle rectangle de 300 m × 200 m : 3 ha à 0,01 % près (la grille
    // de test est un plan local, la mesure se fait sur la sphère).
    expect(
      relativeError(ringAreaM2([at(0, 0), at(300, 0), at(0, 200)]), 30000),
    ).toBeLessThan(1e-4);
    const lShape = [
      at(0, 0),
      at(200, 0),
      at(200, 100),
      at(100, 100),
      at(100, 200),
      at(0, 200),
    ];
    const expected =
      sphericalBoxArea(rect(0, 0, 200, 100)) +
      sphericalBoxArea(rect(0, 100, 100, 200));
    expect(relativeError(ringAreaM2(lShape), expected)).toBeLessThan(1e-9);
  });

  it("vaut 0 pour moins de 3 sommets", () => {
    expect(ringAreaM2([])).toBe(0);
    expect(ringAreaM2([at(0, 0), at(100, 100)])).toBe(0);
  });
});

describe("polygonAreaM2", () => {
  it("déduit les enclaves", () => {
    const outer = rect(0, 0, 200, 200);
    const holes = [rect(20, 20, 60, 60), rect(100, 100, 150, 120)];
    const expected =
      sphericalBoxArea(outer) -
      holes.reduce((sum, hole) => sum + sphericalBoxArea(hole), 0);
    expect(relativeError(polygonAreaM2(outer, holes), expected)).toBeLessThan(
      1e-9,
    );
  });

  it("ne descend pas sous 0 si les enclaves dépassent le contour", () => {
    expect(polygonAreaM2(rect(0, 0, 10, 10), [rect(-10, -10, 20, 20)])).toBe(0);
  });
});
