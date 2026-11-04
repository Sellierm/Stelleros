// Lecture du plan de l'exploitation (KML) : parcelles, cultures, surfaces
// déclarées et contours utilisés par le calcul de couverture.
import type { FieldRings, LatLngPoint } from "./coverageCalculator";

export interface PlanPolygon {
  outer: LatLngPoint[];
  holes: LatLngPoint[][];
}

export interface PlanField {
  // Indice du Placemark dans le plan (identifiant de sélection sur la carte).
  index: number;
  name: string;
  // Culture normalisée (clé des couleurs de la légende), « N/A » si inconnue.
  culture: string;
  // Surface déclarée dans la description (« Surface (Ha) : 12,34 »), 0 sinon.
  surfaceHa: number;
  // Texte brut de la description (HTML possible), affiché au clic.
  description: string;
  // Contours d'au moins 3 sommets ; un Placemark peut en avoir plusieurs.
  polygons: PlanPolygon[];
}

export interface FarmPlan {
  fields: PlanField[];
  // Somme des surfaces déclarées, parcelles sans contour comprises.
  totalHa: number;
  cropTotals: Record<string, number>;
  // Contours pour le calcul de couverture, nommés « 12 · Blé ».
  fieldPolygons: FieldRings[];
}

export const normalizeCultureName = (str: string) => {
  if (!str) return "N/A";
  str = str.toLowerCase();
  // Remove angle brackets if any HTML slipped through
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

  let surfaceHa = 0;
  let cultureStr = "";
  const desc: Element | undefined =
    placemark.getElementsByTagName("description")[0];
  if (desc) {
    const m = desc.textContent?.match(/Surface\s*\(Ha\)\s*:\s*([\d.,]+)/i);
    if (m) {
      surfaceHa = Number.parseFloat(m[1].replace(",", "."));
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

  return {
    index,
    name,
    culture: normalizeCultureName(cultureStr),
    surfaceHa,
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

    // Nom du détail par parcelle : « 12 · Blé ».
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
