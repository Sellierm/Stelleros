import { describe, expect, it } from "vitest";
import {
  computeCoverageArea,
  type CoverageTrack,
  type FieldPolygon,
  type LatLngPoint,
} from "./coverageCalculator";
import { at, pass, rect, sphericalBoxArea, stadium } from "../test/geo";

function track(points: LatLngPoint[], widthM: number | string = 3, deviceId = "tracteur"): CoverageTrack {
  return { deviceId, points, widthM };
}

function area(fields: FieldPolygon[], tracks: CoverageTrack[]) {
  return computeCoverageArea(fields, tracks).totalAreaM2;
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
      { name: "Contour 1", areaM2: expect.closeTo(sphericalBoxArea(FIELD), 4), coveredM2: result.totalAreaM2 },
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
      expect(a.areaM2).toBeCloseTo(sphericalBoxArea(rect(0, 0, 100, 200)), 4);
      expect(b.areaM2).toBeCloseTo(sphericalBoxArea(rect(100, 0, 200, 200)), 4);
      expectArea(a.coveredM2, 49.5 * 3 + stadium(0, 3) / 2);
      expectArea(b.coveredM2, 50.5 * 3 + stadium(0, 3) / 2);
      expect(a.coveredM2 + b.coveredM2).toBe(result.totalAreaM2);
    });

    it("déduit les enclaves de la surface de la parcelle", () => {
      const field = { outer: FIELD, holes: [rect(80, 80, 120, 120)], name: "P" };
      const [detail] = computeCoverageArea([field], [track(PASS)]).fields;
      expect(detail.areaM2).toBeCloseTo(sphericalBoxArea(FIELD) - sphericalBoxArea(rect(80, 80, 120, 120)), 4);
    });

    it("regroupe les contours d'une même parcelle", () => {
      const fields = [
        { outer: rect(0, 0, 100, 200), name: "P" },
        { outer: rect(100, 0, 200, 200), name: "P" },
      ];
      const result = computeCoverageArea(fields, [track(PASS)]);
      expect(result.fieldsProcessed).toBe(2);
      expect(result.fields).toHaveLength(1);
      expect(result.fields[0].areaM2).toBeCloseTo(sphericalBoxArea(FIELD), 4);
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

  describe("surface des parcelles", () => {
    const fieldArea = (field: FieldPolygon) =>
      computeCoverageArea([field], [track(PASS)]).fields[0].areaM2;

    it("ne dépend ni du sens de parcours ni du premier sommet du contour", () => {
      expect(fieldArea([...FIELD].reverse())).toBeCloseTo(sphericalBoxArea(FIELD), 4);
      expect(fieldArea([...FIELD.slice(2), ...FIELD.slice(0, 2)])).toBeCloseTo(sphericalBoxArea(FIELD), 4);
    });

    it("accepte un contour fermé comme en KML (premier sommet répété)", () => {
      const closed = [...FIELD, FIELD[0]];
      const result = computeCoverageArea([closed], [track(PASS)]);
      expect(result.fields[0].areaM2).toBeCloseTo(sphericalBoxArea(FIELD), 4);
      expectArea(result.totalAreaM2, stadium(100, 3));
    });

    it("mesure et découpe une parcelle non convexe (en L)", () => {
      const lShape = [at(0, 0), at(200, 0), at(200, 100), at(100, 100), at(100, 200), at(0, 200)];
      const upper = pass([50.5, 150.5], [150.5, 150.5]);
      const result = computeCoverageArea([lShape], [track(upper)]);
      const expected = sphericalBoxArea(rect(0, 0, 200, 100)) + sphericalBoxArea(rect(0, 100, 100, 200));
      expect(result.fields[0].areaM2).toBeCloseTo(expected, 4);
      // Seule la moitié ouest du passage est dans la parcelle.
      expectArea(result.totalAreaM2, 49.5 * 3 + stadium(0, 3) / 2);
    });

    it("mesure une parcelle éloignée sur la sphère, sans erreur de projection", () => {
      const far = rect(3500, 3500, 3800, 3900);
      const result = computeCoverageArea([FIELD, { outer: far, name: "loin" }], [track(PASS)]);
      const exact = sphericalBoxArea(far);
      expect(Math.abs(result.fields[1].areaM2 - exact) / exact).toBeLessThan(1e-9);
    });

    it("compte entièrement une parcelle éloignée entièrement travaillée", () => {
      // La grille est projetée depuis le premier sommet du plan, à 5 km.
      const points: LatLngPoint[] = [];
      for (let k = 0; k < 20; k++) {
        const y = 3501.5 + 3 * k;
        const [from, to]: [number, number][] = k % 2 ? [[3570, y], [3490, y]] : [[3490, y], [3570, y]];
        points.push(...pass(from, to, { startS: k * 42 }));
      }
      const far = { outer: rect(3500, 3500, 3560, 3560), name: "loin" };
      const [, detail] = computeCoverageArea([FIELD, far], [track(points)]).fields;
      expect(Math.abs(detail.coveredM2 / detail.areaM2 - 1)).toBeLessThan(0.002);
    });
  });

  describe("passages réalistes", () => {
    it("ne dépend pas de l'orientation du passage", () => {
      // Angles quelconques : à 0°, 45° ou 90°, la grille de 1 m crée des
      // effets de bord selon la position exacte de la ligne.
      for (const degrees of [7, 23, 38, 52, 67, 81, 113, 158]) {
        const angle = (degrees * Math.PI) / 180;
        const [dx, dy] = [50 * Math.cos(angle), 50 * Math.sin(angle)];
        const oblique = pass([100 - dx, 100 - dy], [100 + dx, 100 + dy]);
        expectArea(area([FIELD], [track(oblique)]), stadium(100, 3));
      }
    });

    it("suit une trajectoire courbe (cercle de 30 m de rayon)", () => {
      const steps = Math.round((2 * Math.PI * 30) / 2);
      const circle = Array.from({ length: steps + 1 }, (_, i) => {
        const angle = (2 * Math.PI * i) / steps;
        return at(100 + 30 * Math.cos(angle), 100 + 30 * Math.sin(angle), i);
      });
      expectArea(area([FIELD], [track(circle)]), 2 * Math.PI * 30 * 3);
    });

    it("compte une seule fois le recouvrement entre passages voisins", () => {
      const points: LatLngPoint[] = [];
      for (let k = 0; k < 24; k++) {
        const y = 1.25 + 2.5 * k;
        const [from, to]: [number, number][] = k % 2 ? [[60, y], [0, y]] : [[0, y], [60, y]];
        points.push(...pass(from, to, { startS: k * 32 }));
      }
      expect(area([rect(0, 0, 60, 60)], [track(points)])).toBe(3600);
    });

    it("laisse des manques entre passages trop espacés", () => {
      // Demi-tours hors de la parcelle : dedans, ils compteraient.
      const points: LatLngPoint[] = [];
      for (let k = 0; k < 15; k++) {
        const y = 2.25 + 4 * k;
        const [from, to]: [number, number][] = k % 2 ? [[70, y], [-10, y]] : [[-10, y], [70, y]];
        points.push(...pass(from, to, { startS: k * 42 }));
      }
      expect(area([rect(0, 0, 60, 60)], [track(points)])).toBe(2700);
    });

    it("compte comme travaillés les demi-tours dans la parcelle (limite connue)", () => {
      const points: LatLngPoint[] = [];
      for (let k = 0; k < 15; k++) {
        const y = 2.25 + 4 * k;
        const [from, to]: [number, number][] = k % 2 ? [[60, y], [0, y]] : [[0, y], [60, y]];
        points.push(...pass(from, to, { startS: k * 32 }));
      }
      expect(area([rect(0, 0, 60, 60)], [track(points)])).toBeGreaterThan(2700);
    });

    it("combine deux engins de largeurs différentes", () => {
      // y = 100,25 : pas de centre de cellule en limite à 1,5 m ni à 3 m.
      const line = (y: number) => pass([50, y], [150, y]);
      const sameLine = [track(line(100.25), 3, "semoir"), track(line(100.25), 6, "pulvé")];
      expectArea(area([FIELD], sameLine), stadium(100, 6));
      const apart = [track(line(100.25), 3, "semoir"), track(line(120.25), 6, "pulvé")];
      expectArea(area([FIELD], apart), stadium(100, 3) + stadium(100, 6));
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
