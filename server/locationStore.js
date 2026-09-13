const { pool } = require("./config");

/*
 * Store partagé des positions GPS (persistance MariaDB).
 *
 * Extrait de routes/gps.js pour être utilisable à la fois par la route HTTP
 * POST /api/location (conservée pour compatibilité/tests) et par le handler
 * Socket.IO "location" (canal utilisé par la tablette RTK depuis le passage
 * du tracker Android au transport Socket.IO persistant).
 *
 * Module singleton : une seule instance de store par processus, ce qui
 * correspond à l'usage réel (un seul serveur Node par déploiement).
 */

/**
 * Construit et valide un point de position a partir d'un payload brut.
 * Retourne { error } ou { point }. Utilise a la fois par la route HTTP
 * historique et par le handler Socket.IO "location".
 */
function buildLocationPoint(deviceId, body) {
  const {
    latitude,
    longitude,
    timestamp,
    source,
    altitude,
    accuracy,
    speed,
    heading,
  } = body || {};

  if (latitude === undefined || longitude === undefined || !timestamp) {
    return { error: "Missing required fields" };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { error: "Invalid coordinates" };
  }

  return {
    point: {
      latitude,
      longitude,
      timestamp,
      device_id: deviceId,
      updated_at: new Date().toISOString(),
      source: source || "unknown",
      altitude: altitude !== undefined ? altitude : null,
      accuracy: accuracy !== undefined ? accuracy : null,
      speed: speed !== undefined ? speed : null,
      heading: heading !== undefined ? heading : null,
    },
  };
}

/**
 * Enregistre un point de position deja valide en base et diffuse la mise a
 * jour aux clients web via Socket.IO. `io` est passe en parametre plutot qu'importe directement
 * pour eviter une dependance circulaire avec socket.js.
 */
function ingestLocationPoint(io, newPoint) {
  const deviceId = newPoint.device_id;

  io.emit("location_update", newPoint);

  pool
    .execute(
      "INSERT INTO gps_latest (device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude), altitude=VALUES(altitude), accuracy=VALUES(accuracy), speed=VALUES(speed), heading=VALUES(heading), source=VALUES(source), timestamp=VALUES(timestamp)",
      [
        deviceId,
        newPoint.latitude,
        newPoint.longitude,
        newPoint.altitude,
        newPoint.accuracy,
        newPoint.speed,
        newPoint.heading,
        newPoint.source,
        newPoint.timestamp,
      ],
    )
    .catch((err) =>
      console.error("[GPS] Erreur écriture gps_latest:", err.message),
    );

  pool
    .execute(
      "INSERT INTO gps_track (device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        deviceId,
        newPoint.latitude,
        newPoint.longitude,
        newPoint.altitude,
        newPoint.accuracy,
        newPoint.speed,
        newPoint.heading,
        newPoint.source,
        newPoint.timestamp,
      ],
    )
    .catch((err) =>
      console.error("[GPS] Erreur écriture gps_track:", err.message),
    );
}

async function getPositions() {
  const [rows] = await pool.execute("SELECT * FROM gps_latest");
  const positions = {};
  for (const row of rows) positions[row.device_id] = row;
  return positions;
}

async function getHistory(dayStart, dayEnd) {
  const [rows] = await pool.execute(
    "SELECT device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp FROM gps_track WHERE timestamp >= ? AND timestamp < ? ORDER BY device_id, timestamp ASC",
    [dayStart, dayEnd],
  );
  const positions = {};
  for (const row of rows) {
    if (!positions[row.device_id]) positions[row.device_id] = [];
    positions[row.device_id].push(row);
  }
  return positions;
}

async function getHistoryDates() {
  const [rows] = await pool.execute(
    "SELECT DISTINCT DATE_FORMAT(FROM_UNIXTIME(timestamp / 1000), '%Y-%m-%d') AS date FROM gps_track ORDER BY date DESC",
  );
  return rows.map((row) => row.date);
}

module.exports = {
  buildLocationPoint,
  ingestLocationPoint,
  getPositions,
  getHistory,
  getHistoryDates,
};
