const EARTH_RADIUS_M = 6371000;
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

function projectToMeters(lat, lon, refLat, refLon) {
  const x =
    EARTH_RADIUS_M * (lon - refLon) * DEG2RAD * Math.cos(refLat * DEG2RAD);
  const y = EARTH_RADIUS_M * (lat - refLat) * DEG2RAD;
  return { x, y };
}

function pointInRing(point, ring) {
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

function pointInField(point, field) {
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

function squaredDistanceToSegment(px, py, start, end) {
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

function isWorkingSegment(start, end) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!Number.isFinite(start.t) || !Number.isFinite(end.t)) {
    return length <= MAX_SEGMENT_LENGTH_M;
  }
  const durationMs = end.t - start.t;
  if (durationMs <= 0 || durationMs > MAX_SEGMENT_GAP_MS) return false;
  const speed = length / (durationMs / 1000);
  return speed >= MIN_WORKING_SPEED_MS && speed <= MAX_WORKING_SPEED_MS;
}

function computeFieldCoverage(field, previousFields, tracks, cellSizeM) {
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
          if (squaredDistanceToSegment(cellX, cellY, start, end) <= halfWidthSq) {
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

function toFieldRings(fieldPolygon) {
  // Accepte un contour simple [{lat, lng}, ...] ou { outer, holes }.
  if (Array.isArray(fieldPolygon)) return { outer: fieldPolygon, holes: [] };
  return {
    outer: fieldPolygon?.outer,
    holes: Array.isArray(fieldPolygon?.holes) ? fieldPolygon.holes : [],
  };
}

export function computeCoverageArea(
  fieldPolygonsLatLng,
  tracksWithWidth,
  cellSizeM = 1,
) {
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
    .map(toFieldRings)
    .filter(({ outer }) => Array.isArray(outer) && outer.length >= 3);
  if (rawFields.length === 0) {
    throw new Error("Aucun contour de champ disponible");
  }

  // Projection unique pour toute l'exploitation : les champs partagent le même
  // repère, ce qui permet de détecter leurs chevauchements.
  const ref = rawFields[0].outer[0];
  const project = (point) => ({
    ...projectToMeters(point.lat, point.lng, ref.lat, ref.lng),
    t: point.t,
  });

  const fields = rawFields.map(({ outer, holes }) => {
    const outerM = outer.map(project);
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
      outer: outerM,
      holes: holes
        .filter((hole) => Array.isArray(hole) && hole.length >= 3)
        .map((hole) => hole.map(project)),
      minX,
      minY,
      maxX,
      maxY,
    };
  });

  const warnings = [];
  const validTracks = [];
  for (const track of tracksWithWidth) {
    const width = Number(track.widthM);
    if (!Number.isFinite(width) || width <= 0 || width > 30) {
      warnings.push(`Largeur ignorée pour ${track.deviceId} : valeur invalide`);
      continue;
    }
    if (!Array.isArray(track.points) || track.points.length < 2) continue;

    const pointsM = track.points.map(project);
    const segments = [];
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
  for (let i = 0; i < fields.length; i++) {
    totalAreaM2 += computeFieldCoverage(
      fields[i],
      fields.slice(0, i),
      validTracks,
      cellSizeM,
    );
  }

  return {
    totalAreaM2,
    totalAreaHa: totalAreaM2 / 10000,
    fieldsProcessed: fields.length,
    devicesUsed: validTracks.map((track) => track.deviceId),
    warnings,
  };
}
