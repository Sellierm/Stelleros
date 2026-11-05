import { EARTH_RADIUS_M, polygonAreaM2 } from "./geodesy";

export interface LatLngPoint {
  lat: number;
  lng: number;
  t?: number;
  // Précision (m) et source de la position, quand elles sont connues.
  accuracy?: number | null;
  source?: string | null;
}

export interface FieldRings {
  outer: LatLngPoint[];
  holes?: LatLngPoint[][];
  // Nom de la parcelle dans le détail du résultat (contours de même nom
  // regroupés).
  name?: string;
}

// Contour simple [{lat, lng}, ...] ou { outer, holes }.
export type FieldPolygon = LatLngPoint[] | FieldRings;

export interface CoverageTrack {
  deviceId: string;
  points: LatLngPoint[];
  // Valeur saisie dans le formulaire : chaîne possible, convertie au calcul.
  widthM: number | string;
}

export interface FieldCoverage {
  name: string;
  // Surface du contour, enclaves déduites.
  areaM2: number;
  coveredM2: number;
}

export interface CoverageResult {
  totalAreaM2: number;
  totalAreaHa: number;
  fieldsProcessed: number;
  devicesUsed: string[];
  warnings: string[];
  // Détail par parcelle, dans l'ordre du plan. Une zone commune à deux
  // contours n'est comptée que dans le premier.
  fields: FieldCoverage[];
}

export interface CoverageWorkerRequest {
  fieldPolygons: FieldPolygon[];
  tracks: CoverageTrack[];
}

export type CoverageWorkerResponse =
  { result: CoverageResult } | { error: string };

interface PointM {
  x: number;
  y: number;
  t?: number;
}

interface FieldM {
  name: string;
  areaM2: number;
  outer: PointM[];
  holes: PointM[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface TrackM {
  deviceId: string;
  widthM: number;
  segments: [PointM, PointM][];
}

const DEG2RAD = Math.PI / 180;
const MAX_GRID_CELLS_PER_FIELD = 4_000_000;
// Sans horodatage, on ne relie pas deux points trop éloignés (perte de signal).
const MAX_SEGMENT_LENGTH_M = 50;
// Avec horodatage : au-delà de cet écart, la trace est considérée interrompue.
const MAX_SEGMENT_GAP_MS = 30_000;
// Segments plus lents ignorés (tracteur à l'arrêt, dérive GPS).
const MIN_WORKING_SPEED_MS = 0.2;
// Segments plus rapides ignorés (saut GPS aberrant).
const MAX_WORKING_SPEED_MS = 15;
// Positions trop imprécises pour situer l'outil (réseau mobile ou Wi-Fi, GPS
// interne dégradé) : ignorées.
const MAX_POINT_ACCURACY_M = 20;
const UNUSABLE_SOURCES = new Set(["Réseau"]);

function projectToMeters(
  lat: number,
  lon: number,
  refLat: number,
  refLon: number,
) {
  const x =
    EARTH_RADIUS_M * (lon - refLon) * DEG2RAD * Math.cos(refLat * DEG2RAD);
  const y = EARTH_RADIUS_M * (lat - refLat) * DEG2RAD;
  return { x, y };
}

function pointInRing(point: PointM, ring: PointM[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInField(point: PointM, field: FieldM) {
  if (
    point.x < field.minX ||
    point.x > field.maxX ||
    point.y < field.minY ||
    point.y > field.maxY
  ) {
    return false;
  }
  return (
    pointInRing(point, field.outer) &&
    !field.holes.some((hole) => pointInRing(point, hole))
  );
}

function squaredDistanceToSegment(
  px: number,
  py: number,
  start: PointM,
  end: PointM,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  let t = 0;
  if (lengthSq > 0) {
    t = ((px - start.x) * dx + (py - start.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = start.x + t * dx - px;
  const cy = start.y + t * dy - py;
  return cx * cx + cy * cy;
}

const isTimestamp = (t: number | undefined): t is number => Number.isFinite(t);

// Précision inconnue : la position est gardée.
function isUsablePoint({ accuracy, source }: LatLngPoint) {
  if (source != null && UNUSABLE_SOURCES.has(source)) return false;
  return !(typeof accuracy === "number" && accuracy > MAX_POINT_ACCURACY_M);
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isWorkingSegment(start: PointM, end: PointM) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!isTimestamp(start.t) || !isTimestamp(end.t)) {
    return length <= MAX_SEGMENT_LENGTH_M;
  }
  const durationMs = end.t - start.t;
  if (durationMs <= 0 || durationMs > MAX_SEGMENT_GAP_MS) return false;
  const speed = length / (durationMs / 1000);
  return speed >= MIN_WORKING_SPEED_MS && speed <= MAX_WORKING_SPEED_MS;
}

function computeFieldCoverage(
  field: FieldM,
  previousFields: FieldM[],
  tracks: TrackM[],
  cellSizeM: number,
) {
  const { minX, minY, maxX, maxY } = field;
  const columns = Math.ceil((maxX - minX) / cellSizeM);
  const rows = Math.ceil((maxY - minY) / cellSizeM);
  if (columns <= 0 || rows <= 0) return 0;
  if (columns * rows > MAX_GRID_CELLS_PER_FIELD) {
    throw new Error("Un des champs depasse la taille de grille autorisee");
  }

  const covered = new Uint8Array(columns * rows);

  for (const track of tracks) {
    const halfWidth = track.widthM / 2;
    const halfWidthSq = halfWidth * halfWidth;
    const margin = Math.ceil(halfWidth / cellSizeM) + 1;

    for (const [start, end] of track.segments) {
      const minColumn = Math.max(
        0,
        Math.floor((Math.min(start.x, end.x) - minX) / cellSizeM) - margin,
      );
      const maxColumn = Math.min(
        columns - 1,
        Math.ceil((Math.max(start.x, end.x) - minX) / cellSizeM) + margin,
      );
      const minRow = Math.max(
        0,
        Math.floor((Math.min(start.y, end.y) - minY) / cellSizeM) - margin,
      );
      const maxRow = Math.min(
        rows - 1,
        Math.ceil((Math.max(start.y, end.y) - minY) / cellSizeM) + margin,
      );

      // Une cellule est couverte si son centre est à moins d'une demi-largeur
      // d'outil du segment : bande perpendiculaire à la trajectoire, sans biais
      // lié à l'orientation des passages.
      for (let row = minRow; row <= maxRow; row++) {
        const cellY = minY + (row + 0.5) * cellSizeM;
        for (let column = minColumn; column <= maxColumn; column++) {
          const index = row * columns + column;
          if (covered[index]) continue;
          const cellX = minX + (column + 0.5) * cellSizeM;
          if (
            squaredDistanceToSegment(cellX, cellY, start, end) <= halfWidthSq
          ) {
            covered[index] = 1;
          }
        }
      }
    }
  }

  // Les champs qui se chevauchent ne sont comptés qu'une fois.
  const overlapping = previousFields.filter(
    (other) =>
      other.minX <= maxX &&
      other.maxX >= minX &&
      other.minY <= maxY &&
      other.maxY >= minY,
  );

  let clippedCells = 0;
  for (let row = 0; row < rows; row++) {
    const cellY = minY + (row + 0.5) * cellSizeM;
    for (let column = 0; column < columns; column++) {
      if (!covered[row * columns + column]) continue;
      const cell = { x: minX + (column + 0.5) * cellSizeM, y: cellY };
      if (!pointInField(cell, field)) continue;
      if (overlapping.some((other) => pointInField(cell, other))) continue;
      clippedCells++;
    }
  }

  return clippedCells * cellSizeM * cellSizeM;
}

function toFieldRings(fieldPolygon: FieldPolygon) {
  // Accepte un contour simple [{lat, lng}, ...] ou { outer, holes, name }.
  if (Array.isArray(fieldPolygon)) {
    return { outer: fieldPolygon, holes: [], name: undefined };
  }
  return {
    outer: fieldPolygon?.outer,
    holes: Array.isArray(fieldPolygon?.holes) ? fieldPolygon.holes : [],
    name:
      typeof fieldPolygon?.name === "string" ? fieldPolygon.name : undefined,
  };
}

export function computeCoverageArea(
  fieldPolygonsLatLng: FieldPolygon[],
  tracksWithWidth: CoverageTrack[],
  cellSizeM = 1,
): CoverageResult {
  if (!Array.isArray(fieldPolygonsLatLng) || fieldPolygonsLatLng.length === 0) {
    throw new Error("Aucun contour de champ disponible");
  }
  if (!Array.isArray(tracksWithWidth) || tracksWithWidth.length === 0) {
    throw new Error("Aucune trace GPS disponible");
  }
  if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) {
    throw new Error("Taille de grille invalide");
  }

  const rawFields = fieldPolygonsLatLng
    .map((fieldPolygon, index) => ({ ...toFieldRings(fieldPolygon), index }))
    .filter(({ outer }) => Array.isArray(outer) && outer.length >= 3);
  if (rawFields.length === 0) {
    throw new Error("Aucun contour de champ disponible");
  }

  // Projection unique pour toute l'exploitation : les champs partagent le même
  // repère, ce qui permet de détecter leurs chevauchements.
  const ref = rawFields[0].outer[0];
  const project = (point: LatLngPoint): PointM => ({
    ...projectToMeters(point.lat, point.lng, ref.lat, ref.lng),
    t: point.t,
  });

  const fields = rawFields.map(({ outer, holes, name, index }): FieldM => {
    const validHoles = holes.filter(
      (hole) => Array.isArray(hole) && hole.length >= 3,
    );
    const outerM = outer.map(project);
    const holesM = validHoles.map((hole) => hole.map(project));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of outerM) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return {
      name: name?.trim() || `Contour ${index + 1}`,
      // Sur la sphère, comme la surface des parcelles du plan (kmlPlan.ts) :
      // sans l'erreur de la projection, qui croît avec la distance à `ref`.
      areaM2: polygonAreaM2(outer, validHoles),
      outer: outerM,
      holes: holesM,
      minX,
      minY,
      maxX,
      maxY,
    };
  });

  const warnings: string[] = [];
  const validTracks: TrackM[] = [];
  for (const track of tracksWithWidth) {
    const width = Number(track.widthM);
    if (!Number.isFinite(width) || width <= 0 || width > 30) {
      warnings.push(`Largeur ignorée pour ${track.deviceId} : valeur invalide`);
      continue;
    }

    const points = Array.isArray(track.points) ? track.points : [];
    const usable = points.filter(isUsablePoint);
    const ignored = points.length - usable.length;
    if (ignored > 0) {
      warnings.push(
        `${track.deviceId} : positions imprécises ignorées (${ignored}, réseau ou précision > ${MAX_POINT_ACCURACY_M} m)`,
      );
    }
    const accuracy = median(
      usable.flatMap(({ accuracy }) =>
        typeof accuracy === "number" && Number.isFinite(accuracy)
          ? [accuracy]
          : [],
      ),
    );
    if (accuracy !== null && accuracy > width / 2) {
      warnings.push(
        `${track.deviceId} : précision GPS de ${accuracy.toFixed(1)} m (médiane) pour un outil de ${width} m, surface indicative`,
      );
    }

    const pointsM = usable.map(project);
    const segments: TrackM["segments"] = [];
    for (let i = 0; i < pointsM.length - 1; i++) {
      if (isWorkingSegment(pointsM[i], pointsM[i + 1])) {
        segments.push([pointsM[i], pointsM[i + 1]]);
      }
    }
    validTracks.push({ deviceId: track.deviceId, widthM: width, segments });
  }
  if (validTracks.length === 0) {
    throw new Error("Aucune trace valide (largeurs toutes invalides)");
  }

  let totalAreaM2 = 0;
  const byName = new Map<string, FieldCoverage>();
  for (let i = 0; i < fields.length; i++) {
    const { name, areaM2 } = fields[i];
    const coveredM2 = computeFieldCoverage(
      fields[i],
      fields.slice(0, i),
      validTracks,
      cellSizeM,
    );
    totalAreaM2 += coveredM2;
    const entry = byName.get(name);
    if (entry) {
      entry.areaM2 += areaM2;
      entry.coveredM2 += coveredM2;
    } else {
      byName.set(name, { name, areaM2, coveredM2 });
    }
  }

  return {
    totalAreaM2,
    totalAreaHa: totalAreaM2 / 10000,
    fieldsProcessed: fields.length,
    devicesUsed: validTracks.map((track) => track.deviceId),
    warnings,
    fields: [...byName.values()],
  };
}
