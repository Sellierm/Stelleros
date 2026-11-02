import { describe, expect, it } from "vitest";
import {
  computeCoverageArea,
  type CoverageTrack,
  type FieldPolygon,
  type LatLngPoint,
} from "./coverageCalculator";

// Repère local : x mètres vers l'est, y mètres vers le nord d'un point de
// référence (premier sommet du premier champ, comme le calcul).
const LAT0 = 50.4;
const LNG0 = 3.0;
const M_PER_DEG = (6371000 * Math.PI) / 180;
const T0 = 1_800_000_000_000;

function at(x: number, y: number, tS?: number): LatLngPoint {
  return {
    lat: LAT0 + y / M_PER_DEG,
    lng: LNG0 + x / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)),
    t: tS === undefined ? undefined : T0 + tS * 1000,
  };
}

function rect(x0: number, y0: number, x1: number, y1: number) {
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
}

/** Passage rectiligne à `speed` m/s, un point toutes les `stepS` s. */
function pass(
  from: [number, number],
  to: [number, number],
  { speed = 2, stepS = 1, startS = 0 } = {},
): LatLngPoint[] {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const duration = Math.hypot(x1 - x0, y1 - y0) / speed;
  const n = Math.max(1, Math.round(duration / stepS));
  return Array.from({ length: n + 1 }, (_, i) =>
    at(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, startS + (duration * i) / n),
  );
}

function track(points: LatLngPoint[], widthM: number | string = 3, deviceId = "tracteur"): CoverageTrack {
  return { deviceId, points, widthM };
}

function area(fields: FieldPolygon[], tracks: CoverageTrack[]) {
  return computeCoverageArea(fields, tracks).totalAreaM2;
}

/** Surface d'une bande de `length` m et de largeur `width` m, bouts arrondis. */
function stadium(length: number, width: number) {
  return length * width + Math.PI * (width / 2) ** 2;
}

/** Mêmes points avec une précision (m) et une source. */
function withAccuracy(points: LatLngPoint[], accuracy: number | null, source = "GPS Interne") {
  return points.map((point) => ({ ...point, accuracy, source }));
}

/** Écart relatif inférieur à 2 % (discrétisation de la grille de 1 m). */
function expectArea(actual: number, expected: number) {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(0.02);
}

// Champ de 200 m × 200 m ; passage de 100 m au milieu, sur un centre de
// cellule (y = 100,5) pour éviter les cas limites de la grille.
const FIELD = rect(0, 0, 200, 200);
const PASS = pass([50.5, 100.5], [150.5, 100.5]);

describe("computeCoverageArea", () => {
  it("compte la bande d'un passage (largeur × longueur + bouts)", () => {
    const result = computeCoverageArea([FIELD], [track(PASS)]);
    expectArea(result.totalAreaM2, stadium(100, 3));
    expect(result.totalAreaHa).toBe(result.totalAreaM2 / 10000);
    expect(result.fieldsProcessed).toBe(1);
    expect(result.devicesUsed).toEqual(["tracteur"]);
    expect(result.warnings).toEqual([]);
    expect(result.fields).toEqual([
      { name: "Contour 1", areaM2: expect.closeTo(40000, 3), coveredM2: result.totalAreaM2 },
    ]);
  });

  it("ne compte qu'une fois un aller-retour sur la même ligne", () => {
    const back = pass([150.5, 100.5], [50.5, 100.5], { startS: 51 });
    expectArea(area([FIELD], [track([...PASS, ...back])]), stadium(100, 3));
  });

  it("additionne deux passages distincts", () => {
    // Plus de 30 s après le premier : le trajet entre les deux n'est pas compté.
    const second = pass([50.5, 110.5], [150.5, 110.5], { startS: 100 });
    expectArea(area([FIELD], [track([...PASS, ...second])]), 2 * stadium(100, 3));
  });

  it("donne la surface du champ quand il est entièrement travaillé", () => {
    // Allers-retours espacés d'une largeur d'outil sur un champ de 60 m × 60 m.
    const points: LatLngPoint[] = [];
    for (let k = 0; k < 20; k++) {
      const y = 1.5 + 3 * k;
      const [from, to]: [number, number][] = k % 2 ? [[60, y], [0, y]] : [[0, y], [60, y]];
      points.push(...pass(from, to, { startS: k * 32 }));
    }
    expect(area([rect(0, 0, 60, 60)], [track(points)])).toBe(3600);
  });

  it("ignore un passage hors du champ", () => {
    expect(area([FIELD], [track(pass([50.5, -50.5], [150.5, -50.5]))])).toBe(0);
  });

  it("ne garde que la partie d'un passage située dans le champ", () => {
    const crossing = pass([-49.5, 100.5], [50.5, 100.5]);
    expectArea(area([FIELD], [track(crossing)]), 50.5 * 3 + stadium(0, 3) / 2);
  });

  it("exclut les enclaves du champ", () => {
    const withHole: FieldPolygon = { outer: FIELD, holes: [rect(80, 80, 120, 120)] };
    expectArea(area([withHole], [track(PASS)]), stadium(100, 3) - 40 * 3);
  });

  it("ne compte qu'une fois deux champs qui se chevauchent", () => {
    const result = computeCoverageArea([FIELD, rect(0, 0, 200, 200)], [track(PASS)]);
    expect(result.fieldsProcessed).toBe(2);
    expectArea(result.totalAreaM2, stadium(100, 3));
  });

  it("ne compte qu'une fois deux engins sur le même passage", () => {
    const result = computeCoverageArea([FIELD], [track(PASS, 3, "a"), track(PASS, 3, "b")]);
    expect(result.devicesUsed).toEqual(["a", "b"]);
    expectArea(result.totalAreaM2, stadium(100, 3));
  });

  describe("segments de travail", () => {
    it("compte des points espacés de 20 s (trace simplifiée par le serveur)", () => {
      const sparse = [
        at(50.5, 100.5, 0),
        at(90.5, 100.5, 20),
        at(130.5, 100.5, 40),
        at(150.5, 100.5, 50),
      ];
      expectArea(area([FIELD], [track(sparse)]), stadium(100, 3));
    });

    it("ignore un segment de plus de 30 s (coupure)", () => {
      const ends = [at(50.5, 100.5, 0), at(150.5, 100.5, 50)];
      expect(area([FIELD], [track(ends)])).toBe(0);
    });

    it("ignore un engin trop lent (arrêt, dérive GPS)", () => {
      expect(area([FIELD], [track(pass([50.5, 100.5], [60.5, 100.5], { speed: 0.1 }))])).toBe(0);
    });

    it("ignore un saut trop rapide (position aberrante)", () => {
      expect(area([FIELD], [track(pass([50.5, 100.5], [150.5, 100.5], { speed: 20 }))])).toBe(0);
    });

    it("sans horodatage, relie les points distants de 50 m au plus", () => {
      const close = [at(50.5, 100.5), at(90.5, 100.5), at(130.5, 100.5), at(150.5, 100.5)];
      expectArea(area([FIELD], [track(close)]), stadium(100, 3));
      const far = [at(50.5, 100.5), at(150.5, 100.5)];
      expect(area([FIELD], [track(far)])).toBe(0);
    });
  });

  describe("largeur d'outil", () => {
    it("accepte une largeur saisie en texte", () => {
      // y = 100 : avec 2 m de demi-largeur, aucun centre de cellule en limite.
      const points = pass([50, 100], [150, 100]);
      expectArea(area([FIELD], [track(points, "4")]), stadium(100, 4));
    });

    it("ignore un engin à la largeur invalide, avec un avertissement", () => {
      for (const width of ["abc", 0, -2, 31]) {
        const result = computeCoverageArea([FIELD], [track(PASS, 3, "ok"), track(PASS, width, "ko")]);
        expect(result.devicesUsed).toEqual(["ok"]);
        expect(result.warnings).toEqual(["Largeur ignorée pour ko : valeur invalide"]);
        expectArea(result.totalAreaM2, stadium(100, 3));
      }
    });

    it("échoue si aucune largeur n'est valide", () => {
      expect(() => computeCoverageArea([FIELD], [track(PASS, "")])).toThrow(/Aucune trace valide/);
    });
  });

  describe("détail par parcelle", () => {
    it("répartit la surface entre les parcelles traversées", () => {
      const fields = [
        { outer: rect(0, 0, 100, 200), name: "A" },
        { outer: rect(100, 0, 200, 200), name: "B" },
      ];
      const result = computeCoverageArea(fields, [track(PASS)]);
      const [a, b] = result.fields;
      expect(result.fields.map((field) => field.name)).toEqual(["A", "B"]);
      expect(a.areaM2).toBeCloseTo(20000, 3);
      expect(b.areaM2).toBeCloseTo(20000, 3);
      expectArea(a.coveredM2, 49.5 * 3 + stadium(0, 3) / 2);
      expectArea(b.coveredM2, 50.5 * 3 + stadium(0, 3) / 2);
      expect(a.coveredM2 + b.coveredM2).toBe(result.totalAreaM2);
    });

    it("déduit les enclaves de la surface de la parcelle", () => {
      const field = { outer: FIELD, holes: [rect(80, 80, 120, 120)], name: "P" };
      const [detail] = computeCoverageArea([field], [track(PASS)]).fields;
      expect(detail.areaM2).toBeCloseTo(40000 - 1600, 3);
    });

    it("regroupe les contours d'une même parcelle", () => {
      const fields = [
        { outer: rect(0, 0, 100, 200), name: "P" },
        { outer: rect(100, 0, 200, 200), name: "P" },
      ];
      const result = computeCoverageArea(fields, [track(PASS)]);
      expect(result.fieldsProcessed).toBe(2);
      expect(result.fields).toHaveLength(1);
      expect(result.fields[0].areaM2).toBeCloseTo(40000, 3);
      expect(result.fields[0].coveredM2).toBe(result.totalAreaM2);
    });

    it("nomme les contours sans nom d'après leur rang dans le plan", () => {
      const result = computeCoverageArea([[at(0, 0), at(1, 1)], FIELD], [track(PASS)]);
      expect(result.fields.map((field) => field.name)).toEqual(["Contour 2"]);
    });
  });

  describe("précision des positions", () => {
    it("ignore les positions du réseau mobile", () => {
      const result = computeCoverageArea([FIELD], [track(withAccuracy(PASS, 3, "Réseau"))]);
      expect(result.totalAreaM2).toBe(0);
      expect(result.warnings).toEqual([
        "tracteur : positions imprécises ignorées (51, réseau ou précision > 20 m)",
      ]);
    });

    it("ignore une position imprécise écartée de la trace", () => {
      // Au milieu du passage, une position à 10 m de la ligne : sans sa
      // précision, elle ajoute deux bandes obliques à la surface.
      const jump = (accuracy: number | null) =>
        PASS.map((point, i) => (i === 25 ? { ...at(100.5, 110.5, 25), accuracy } : point));
      expect(area([FIELD], [track(jump(null))])).toBeGreaterThan(1.1 * stadium(100, 3));
      const result = computeCoverageArea([FIELD], [track(jump(40))]);
      expectArea(result.totalAreaM2, stadium(100, 3));
      expect(result.warnings).toEqual([
        "tracteur : positions imprécises ignorées (1, réseau ou précision > 20 m)",
      ]);
    });

    it("prévient quand la précision est grossière pour la largeur d'outil", () => {
      const result = computeCoverageArea([FIELD], [track(withAccuracy(PASS, 9.94))]);
      expectArea(result.totalAreaM2, stadium(100, 3));
      expect(result.warnings).toEqual([
        "tracteur : précision GPS de 9.9 m (médiane) pour un outil de 3 m, surface indicative",
      ]);
    });

    it("ne prévient pas avec une précision RTK ou inconnue", () => {
      for (const accuracy of [0.02, null]) {
        const result = computeCoverageArea([FIELD], [track(withAccuracy(PASS, accuracy, "RTK RTK Fix"))]);
        expect(result.warnings).toEqual([]);
      }
    });
  });

  describe("entrées invalides", () => {
    it("exige au moins un champ d'au moins 3 sommets", () => {
      expect(() => computeCoverageArea([], [track(PASS)])).toThrow(/Aucun contour/);
      expect(() => computeCoverageArea([[at(0, 0), at(1, 1)]], [track(PASS)])).toThrow(/Aucun contour/);
    });

    it("exige au moins une trace", () => {
      expect(() => computeCoverageArea([FIELD], [])).toThrow(/Aucune trace GPS/);
    });

    it("refuse une taille de grille invalide", () => {
      expect(() => computeCoverageArea([FIELD], [track(PASS)], 0)).toThrow(/Taille de grille/);
    });

    it("refuse un champ trop grand pour la grille", () => {
      expect(() => area([rect(0, 0, 3000, 3000)], [track(PASS)])).toThrow(/taille de grille/);
    });
  });
});
