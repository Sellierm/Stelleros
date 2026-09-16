const EARTH_RADIUS_M = 6371000;
const DEG2RAD = Math.PI / 180;
const MAX_GRID_CELLS_PER_FIELD = 4_000_000;
const MAX_SEGMENT_LENGTH_M = 50;

function projectToMeters(lat, lon, refLat, refLon) {
  const x =
    EARTH_RADIUS_M * (lon - refLon) * DEG2RAD * Math.cos(refLat * DEG2RAD);
  const y = EARTH_RADIUS_M * (lat - refLat) * DEG2RAD;
  return { x, y };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distancePointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  let ratio =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  ratio = Math.max(0, Math.min(1, ratio));
  const projectedX = start.x + ratio * dx;
  const projectedY = start.y + ratio * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function computeFieldCoverage(fieldPolygonLatLng, tracksWithWidth, cellSizeM) {
  const refPoint = fieldPolygonLatLng[0];
  const polygonM = fieldPolygonLatLng.map((point) =>
    projectToMeters(point.lat, point.lng, refPoint.lat, refPoint.lng),
  );

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygonM) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const columns = Math.ceil((maxX - minX) / cellSizeM);
  const rows = Math.ceil((maxY - minY) / cellSizeM);
  if (columns <= 0 || rows <= 0) return { areaM2: 0 };
  if (columns * rows > MAX_GRID_CELLS_PER_FIELD) {
    throw new Error("Un des champs depasse la taille de grille autorisee");
  }

  const covered = new Uint8Array(columns * rows);

  for (const track of tracksWithWidth) {
    const halfWidth = track.widthM / 2;
    const margin = Math.ceil(halfWidth / cellSizeM) + 1;
    const trackM = track.points.map((point) =>
      projectToMeters(point.lat, point.lng, refPoint.lat, refPoint.lng),
    );

    for (let i = 0; i < trackM.length - 1; i++) {
      const start = trackM[i];
      const end = trackM[i + 1];
      if (Math.hypot(end.x - start.x, end.y - start.y) > MAX_SEGMENT_LENGTH_M) {
        continue;
      }

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

      for (let row = minRow; row <= maxRow; row++) {
        const cellY = minY + (row + 0.5) * cellSizeM;
        for (let column = minColumn; column <= maxColumn; column++) {
          const index = row * columns + column;
          if (covered[index]) continue;
          const cellX = minX + (column + 0.5) * cellSizeM;
          if (
            distancePointToSegment({ x: cellX, y: cellY }, start, end) <=
            halfWidth
          ) {
            covered[index] = 1;
          }
        }
      }
    }
  }

  let clippedCells = 0;
  for (let row = 0; row < rows; row++) {
    const cellY = minY + (row + 0.5) * cellSizeM;
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (!covered[index]) continue;
      const cellX = minX + (column + 0.5) * cellSizeM;
      if (pointInPolygon({ x: cellX, y: cellY }, polygonM)) clippedCells++;
    }
  }

  return { areaM2: clippedCells * cellSizeM * cellSizeM };
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

  const warnings = [];
  const validTracks = [];
  for (const track of tracksWithWidth) {
    const width = Number(track.widthM);
    if (!Number.isFinite(width) || width <= 0 || width > 30) {
      warnings.push(`Largeur ignorée pour ${track.deviceId} : valeur invalide`);
      continue;
    }
    if (!Array.isArray(track.points) || track.points.length < 2) continue;
    validTracks.push({ ...track, widthM: width });
  }
  if (validTracks.length === 0) {
    throw new Error("Aucune trace valide (largeurs toutes invalides)");
  }

  let totalAreaM2 = 0;
  let fieldsProcessed = 0;
  for (const fieldPolygon of fieldPolygonsLatLng) {
    if (!Array.isArray(fieldPolygon) || fieldPolygon.length < 3) continue;
    totalAreaM2 += computeFieldCoverage(
      fieldPolygon,
      validTracks,
      cellSizeM,
    ).areaM2;
    fieldsProcessed++;
  }

  return {
    totalAreaM2,
    totalAreaHa: totalAreaM2 / 10000,
    fieldsProcessed,
    devicesUsed: validTracks.map((track) => track.deviceId),
    warnings,
  };
}
