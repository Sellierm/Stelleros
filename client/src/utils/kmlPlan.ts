import type { FieldRings, LatLngPoint } from "./coverageCalculator";
import { polygonAreaM2 } from "./geodesy";

export interface PlanPolygon {
  outer: LatLngPoint[];
  holes: LatLngPoint[][];
}

export interface PlanField {
  // Identifiant de sélection sur la carte.
  index: number;
  name: string;
  // Clé des couleurs de la légende, « N/A » si inconnue.
  culture: string;
  // Surface des contours ; à défaut de contour, la surface saisie.
  surfaceHa: number;
  // « Surface (Ha) : 12,34 » de la description, 0 sinon.
  declaredHa: number;
  description: string;
  polygons: PlanPolygon[];
}

export interface FarmPlan {
  fields: PlanField[];
  totalHa: number;
  cropTotals: Record<string, number>;
  // Contours pour le calcul de couverture, nommés « 12 · Blé ».
  fieldPolygons: FieldRings[];
}

export const normalizeCultureName = (str: string) => {
  if (!str) return "N/A";
  str = str.toLowerCase();
  str = str.replace(/[<>]/g, "");

  if (str.includes("pdt")) return "Pdt";
  if (str.includes("bl")) return "Blé";
  if (str.includes("seigle")) return "Seigle/Maïs";
  if (str.includes("ma")) return "Maïs";
  if (str.includes("bett")) return "Betteraves";
  if (str.includes("colz")) return "Colza";
  if (str.includes("herb") || str.includes("prairie")) return "Herbe";
  return "N/A";
};

// « lng,lat[,alt] lng,lat[,alt] … » ; les sommets illisibles sont écartés.
export const parseKmlCoordinates = (
  coordinatesNode: Element | undefined,
): LatLngPoint[] => {
  if (!coordinatesNode) return [];
  return (coordinatesNode.textContent ?? "")
    .trim()
    .split(/\s+/)
    .map((tuple) => {
      const [lng, lat] = tuple.split(",").map(Number);
      return { lat, lng };
    })
    .filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
    );
};

function parsePlacemark(placemark: Element, index: number): PlanField {
  const name =
    Array.from(placemark.children)
      .find((child) => child.localName === "name")
      ?.textContent?.trim() ?? "";

  let declaredHa = 0;
  let cultureStr = "";
  const desc: Element | undefined =
    placemark.getElementsByTagName("description")[0];
  if (desc) {
    const m = desc.textContent?.match(/Surface\s*\(Ha\)\s*:\s*([\d.,]+)/i);
    if (m) {
      declaredHa = Number.parseFloat(m[1].replace(",", "."));
    }
  }

  const extendedData = placemark.getElementsByTagName("Data");
  for (let j = 0; j < extendedData.length; j++) {
    if (extendedData[j].getAttribute("name") === "Culture") {
      const valueTag = extendedData[j].getElementsByTagName("value")[0];
      if (valueTag) cultureStr = valueTag.textContent ?? "";
    }
  }

  if (!cultureStr && desc) {
    const plainDesc = (desc.textContent ?? "").replace(/<[^>]+>/g, "\n");
    const mC = plainDesc.match(/Culture\s*:\s*([^\n]+)/i);
    if (mC) cultureStr = mC[1].trim();
  }

  const polygons: PlanPolygon[] = [];
  const polygonNodes = placemark.getElementsByTagName("Polygon");
  for (let p = 0; p < polygonNodes.length; p++) {
    const outerBoundary =
      polygonNodes[p].getElementsByTagName("outerBoundaryIs")[0];
    const coordinatesNode = (
      outerBoundary || polygonNodes[p]
    ).getElementsByTagName("coordinates")[0];
    if (!coordinatesNode) continue;

    const outer = parseKmlCoordinates(coordinatesNode);
    const holes = Array.from(
      polygonNodes[p].getElementsByTagName("innerBoundaryIs"),
    )
      .map((inner) =>
        parseKmlCoordinates(inner.getElementsByTagName("coordinates")[0]),
      )
      .filter((hole) => hole.length >= 3);
    if (outer.length >= 3) polygons.push({ outer, holes });
  }

  const surfaceHa =
    polygons.length > 0
      ? polygons.reduce(
          (sum, { outer, holes }) => sum + polygonAreaM2(outer, holes),
          0,
        ) / 10000
      : declaredHa;

  return {
    index,
    name,
    culture: normalizeCultureName(cultureStr),
    surfaceHa,
    declaredHa,
    description: desc?.textContent || "",
    polygons,
  };
}

export function parseKmlPlan(kmlText: string): FarmPlan {
  const kmlDoc = new DOMParser().parseFromString(kmlText, "text/xml");
  if (kmlDoc.querySelector("parsererror")) {
    throw new Error("Invalid KML document");
  }

  const placemarks = kmlDoc.getElementsByTagName("Placemark");
  const fields: PlanField[] = [];
  let totalHa = 0;
  const cropTotals: Record<string, number> = {};
  const fieldPolygons: FieldRings[] = [];

  for (let i = 0; i < placemarks.length; i++) {
    const field = parsePlacemark(placemarks[i], i);
    fields.push(field);
    cropTotals[field.culture] =
      (cropTotals[field.culture] || 0) + field.surfaceHa;
    totalHa += field.surfaceHa;

    const fieldName =
      field.name && field.culture !== "N/A"
        ? `${field.name} · ${field.culture}`
        : field.name;
    for (const { outer, holes } of field.polygons) {
      fieldPolygons.push({ outer, holes, name: fieldName || undefined });
    }
  }

  return { fields, totalHa, cropTotals, fieldPolygons };
}

const SURFACE_LINE = /^Surface\s*\(Ha\)/i;

// Infobulle : deux premières lignes « clé : valeur » de la description, avec
// la surface des contours à la place de la surface saisie.
export function fieldInfoLines(field: PlanField): [string, string] {
  const surface = `Surface (Ha) : ${field.surfaceHa.toFixed(2)}`;
  const lines = field.description
    .replace(/<[^>]+>/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(":"))
    .map((line) => {
      if (SURFACE_LINE.test(line)) return surface;
      const index = line.indexOf(":");
      return `${line.slice(0, index)} ${line.slice(index)}`;
    });
  if (!lines.includes(surface)) lines.unshift(surface);
  return [lines[0], lines[1] ?? ""];
}
