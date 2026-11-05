// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { computeCoverageArea, type LatLngPoint } from "./coverageCalculator";
import { fieldInfoLines, normalizeCultureName, parseKmlPlan } from "./kmlPlan";
import { at, pass, rect, sphericalBoxArea, stadium } from "../test/geo";

const boxHa = (...corners: [number, number, number, number]) =>
  sphericalBoxArea(rect(...corners)) / 10000;

const kml = (...placemarks: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Plan 2026</name>
${placemarks.join("\n")}
</Document></kml>`;

const ring = (points: LatLngPoint[]) =>
  `<LinearRing><coordinates>${[...points, points[0]]
    .map(({ lat, lng }) => `${lng},${lat},0`)
    .join(" ")}</coordinates></LinearRing>`;

const polygon = (outer: LatLngPoint[], holes: LatLngPoint[][] = []) =>
  `<Polygon><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${holes
    .map((hole) => `<innerBoundaryIs>${ring(hole)}</innerBoundaryIs>`)
    .join("")}</Polygon>`;

function placemark({
  name,
  description,
  culture,
  geometry = polygon(rect(0, 0, 100, 100)),
}: {
  name?: string;
  description?: string;
  culture?: string;
  geometry?: string;
}) {
  return `<Placemark>${name === undefined ? "" : `<name>${name}</name>`}${
    description === undefined
      ? ""
      : `<description><![CDATA[${description}]]></description>`
  }${
    culture === undefined
      ? ""
      : `<ExtendedData><Data name="Culture"><value>${culture}</value></Data></ExtendedData>`
  }${geometry}</Placemark>`;
}

describe("parseKmlPlan", () => {
  it("lit le nom, la culture, la surface saisie et mesure le contour", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          name: "12",
          culture: "Blé tendre",
          description: "Culture : Blé tendre<br>Surface (Ha) : 12,34",
        }),
      ),
    );
    expect(plan.fields).toHaveLength(1);
    const [field] = plan.fields;
    expect(field).toMatchObject({
      index: 0,
      name: "12",
      culture: "Blé",
      declaredHa: 12.34,
    });
    expect(field.surfaceHa).toBeCloseTo(boxHa(0, 0, 100, 100), 9);
    expect(field.surfaceHa).toBeCloseTo(1, 4);
    // Anneau KML fermé : 4 sommets + le premier répété.
    expect(field.polygons).toHaveLength(1);
    expect(field.polygons[0].outer).toHaveLength(5);
    expect(field.polygons[0].outer[2].lat).toBeCloseTo(at(100, 100).lat, 9);
    expect(field.polygons[0].outer[2].lng).toBeCloseTo(at(100, 100).lng, 9);
  });

  it("lit la surface saisie avec un point ou une virgule décimale", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({ description: "Surface (Ha) : 3.5" }),
        placemark({ description: "surface (ha):0,75" }),
        placemark({ description: "Surface (Ha) : 10" }),
      ),
    );
    expect(plan.fields.map((field) => field.declaredHa)).toEqual([
      3.5, 0.75, 10,
    ]);
  });

  it("lit la culture dans la description à défaut d'ExtendedData", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          description:
            "<b>Culture</b> : Maïs grain<br/><b>Surface (Ha)</b> : 4",
        }),
      ),
    );
    expect(plan.fields[0].culture).toBe("Maïs");
  });

  it("préfère la culture d'ExtendedData à celle de la description", () => {
    const plan = parseKmlPlan(
      kml(placemark({ culture: "Colza", description: "Culture : Blé" })),
    );
    expect(plan.fields[0].culture).toBe("Colza");
  });

  it("additionne les surfaces des contours, au total et par culture", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          name: "1",
          culture: "Blé",
          description: "Surface (Ha) : 10",
          geometry: polygon(rect(0, 0, 100, 100)),
        }),
        placemark({
          name: "2",
          culture: "Blé tendre",
          geometry: polygon(rect(200, 0, 450, 100)),
        }),
        placemark({
          name: "3",
          culture: "Colza",
          geometry: polygon(rect(0, 200, 200, 400)),
        }),
        placemark({
          name: "4",
          culture: "Orge",
          geometry: polygon(rect(500, 0, 600, 100)),
        }),
      ),
    );
    const ble = boxHa(0, 0, 100, 100) + boxHa(200, 0, 450, 100);
    const colza = boxHa(0, 200, 200, 400);
    const autre = boxHa(500, 0, 600, 100);
    expect(plan.cropTotals.Blé).toBeCloseTo(ble, 9);
    expect(plan.cropTotals.Colza).toBeCloseTo(colza, 9);
    expect(plan.cropTotals["N/A"]).toBeCloseTo(autre, 9);
    expect(plan.totalHa).toBeCloseTo(ble + colza + autre, 9);
    expect(plan.totalHa).toBeCloseTo(8.5, 3);
  });

  it("déduit les enclaves et additionne les contours d'une parcelle", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          geometry: `<MultiGeometry>${polygon(rect(0, 0, 200, 200), [
            rect(80, 80, 120, 120),
          ])}${polygon(rect(300, 0, 400, 100))}</MultiGeometry>`,
        }),
      ),
    );
    expect(plan.fields[0].surfaceHa).toBeCloseTo(
      boxHa(0, 0, 200, 200) - boxHa(80, 80, 120, 120) + boxHa(300, 0, 400, 100),
      9,
    );
  });

  it("garde la surface saisie d'une parcelle sans contour", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          culture: "Blé",
          description: "Surface (Ha) : 2",
          geometry: "",
        }),
        placemark({ culture: "Blé", description: "Surface (Ha) : 3" }),
      ),
    );
    expect(plan.fields[0].surfaceHa).toBe(2);
    expect(plan.totalHa).toBeCloseTo(2 + boxHa(0, 0, 100, 100), 9);
    expect(plan.fields[0].polygons).toEqual([]);
    expect(plan.fieldPolygons).toHaveLength(1);
  });

  it("garde les enclaves et les contours multiples d'une parcelle", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          name: "7",
          culture: "Colza",
          geometry: `<MultiGeometry>${polygon(rect(0, 0, 100, 100), [
            rect(40, 40, 60, 60),
          ])}${polygon(rect(200, 0, 300, 100))}</MultiGeometry>`,
        }),
      ),
    );
    const [field] = plan.fields;
    expect(field.polygons).toHaveLength(2);
    expect(field.polygons[0].holes).toHaveLength(1);
    expect(field.polygons[1].holes).toEqual([]);
    expect(plan.fieldPolygons.map((polygon) => polygon.name)).toEqual([
      "7 · Colza",
      "7 · Colza",
    ]);
  });

  it("accepte un Polygon sans outerBoundaryIs", () => {
    const coordinates = [...rect(0, 0, 50, 50), at(0, 0)]
      .map(({ lat, lng }) => `${lng},${lat}`)
      .join("\n        ");
    const plan = parseKmlPlan(
      kml(
        placemark({
          geometry: `<Polygon><coordinates>
        ${coordinates}
      </coordinates></Polygon>`,
        }),
      ),
    );
    expect(plan.fields[0].polygons[0].outer).toHaveLength(5);
  });

  it("écarte les sommets illisibles et les contours de moins de 3 sommets", () => {
    const [a, b, c] = rect(0, 0, 100, 100);
    const plan = parseKmlPlan(
      kml(
        placemark({
          name: "ok",
          geometry: `<Polygon><outerBoundaryIs><LinearRing><coordinates>${a.lng},${a.lat},0 abc,def ${b.lng},${b.lat},0 ${c.lng} ${c.lng},${c.lat},0</coordinates></LinearRing></outerBoundaryIs></Polygon>`,
        }),
        placemark({
          name: "trop petit",
          geometry: polygon([a]),
        }),
      ),
    );
    expect(plan.fields[0].polygons[0].outer).toHaveLength(3);
    expect(plan.fields[1].polygons).toEqual([]);
    expect(plan.fieldPolygons).toHaveLength(1);
  });

  it("ignore les enclaves de moins de 3 sommets", () => {
    const [a] = rect(40, 40, 60, 60);
    const plan = parseKmlPlan(
      kml(
        placemark({
          geometry: polygon(rect(0, 0, 100, 100), [[a]]),
        }),
      ),
    );
    expect(plan.fields[0].polygons[0].holes).toEqual([]);
  });

  it("nomme les contours « nom · culture », sinon nom seul ou sans nom", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({ name: " 12 ", culture: "Blé" }),
        placemark({ name: "13", culture: "Orge" }),
        placemark({ culture: "Blé" }),
      ),
    );
    expect(plan.fieldPolygons.map((polygon) => polygon.name)).toEqual([
      "12 · Blé",
      "13",
      undefined,
    ]);
  });

  it("garde la description brute pour l'affichage au clic", () => {
    const description = "<b>Culture</b> : Pdt<br>Surface (Ha) : 1";
    const plan = parseKmlPlan(kml(placemark({ description })));
    expect(plan.fields[0].description).toBe(description);
  });

  it("refuse un document illisible", () => {
    expect(() => parseKmlPlan("<kml><Document>")).toThrow(/Invalid KML/);
  });

  it("donne un plan vide sans Placemark", () => {
    expect(parseKmlPlan(kml())).toEqual({
      fields: [],
      totalHa: 0,
      cropTotals: {},
      fieldPolygons: [],
    });
  });
});

describe("plan KML et calcul de couverture", () => {
  it("donne la même surface de parcelle au plan et au détail de couverture", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          name: "12",
          culture: "Blé",
          description: "Surface (Ha) : 10,00",
          geometry: polygon(rect(0, 0, 250, 400)),
        }),
      ),
    );
    const passage = pass([50.5, 100.5], [150.5, 100.5]);
    const result = computeCoverageArea(plan.fieldPolygons, [
      { deviceId: "tracteur", points: passage, widthM: 3 },
    ]);
    const [detail] = result.fields;
    expect(detail.name).toBe("12 · Blé");
    expect(detail.areaM2 / 10000).toBeCloseTo(plan.fields[0].surfaceHa, 9);
    expect(plan.fields[0].surfaceHa).toBeCloseTo(10, 2);
    expect(
      Math.abs(detail.coveredM2 - stadium(100, 3)) / stadium(100, 3),
    ).toBeLessThan(0.02);
  });

  it("déduit les enclaves du KML de la surface et du travail", () => {
    const plan = parseKmlPlan(
      kml(
        placemark({
          name: "8",
          culture: "Betteraves",
          geometry: polygon(rect(0, 0, 200, 200), [rect(80, 80, 120, 120)]),
        }),
      ),
    );
    const passage = pass([50.5, 100.5], [150.5, 100.5]);
    const result = computeCoverageArea(plan.fieldPolygons, [
      { deviceId: "tracteur", points: passage, widthM: 3 },
    ]);
    expect(result.fields[0].areaM2 / 10000).toBeCloseTo(
      plan.fields[0].surfaceHa,
      9,
    );
    const expected = stadium(100, 3) - 40 * 3;
    expect(Math.abs(result.totalAreaM2 - expected) / expected).toBeLessThan(
      0.02,
    );
  });
});

// Descriptions au format des plans réels : « Clé: valeur » séparés par <br>.
describe("fieldInfoLines", () => {
  const field = (description: string, geometry?: string) =>
    parseKmlPlan(kml(placemark({ description, geometry }))).fields[0];

  it("remplace la surface saisie par celle du contour", () => {
    expect(
      fieldInfoLines(field("Surface (Ha): 17.56<br>Culture: pdt")),
    ).toEqual(["Surface (Ha) : 1.00", "Culture : pdt"]);
  });

  it("ajoute la surface en tête si la description n'en a pas", () => {
    expect(fieldInfoLines(field("Culture: Blé<br>Remarque: drainée"))).toEqual([
      "Surface (Ha) : 1.00",
      "Culture : Blé",
    ]);
    expect(fieldInfoLines(field(""))).toEqual(["Surface (Ha) : 1.00", ""]);
  });

  it("affiche la surface saisie d'une parcelle sans contour", () => {
    expect(
      fieldInfoLines(field("Surface (Ha): 2,5<br>Culture: Colza", "")),
    ).toEqual(["Surface (Ha) : 2.50", "Culture : Colza"]);
  });
});

describe("normalizeCultureName", () => {
  it.each([
    ["PDT chair", "Pdt"],
    ["Blé tendre", "Blé"],
    ["BLE", "Blé"],
    ["Seigle", "Seigle/Maïs"],
    ["Maïs grain", "Maïs"],
    ["Betteraves sucrières", "Betteraves"],
    ["Colza d'hiver", "Colza"],
    ["Herbe", "Herbe"],
    ["Prairie temporaire", "Herbe"],
    ["<Colza>", "Colza"],
    ["Orge", "N/A"],
    ["", "N/A"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeCultureName(raw)).toBe(expected);
  });
});
