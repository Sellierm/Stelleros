const express = require("express");
const crypto = require("crypto");
const { GPS_INGEST_KEY, GPS_ALLOWED_IDS } = require("../config");
const { authMiddleware, locationLimiter, authLog } = require("../middleware");
const {
  buildLocationPoint,
  ingestLocationPoint,
  getPositions,
  getHistory,
  getHistoryDates,
} = require("../locationStore");

const PARIS_TIME_ZONE = "Europe/Paris";
const parisDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PARIS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function getParisOffsetMs(timestamp) {
  const parts = Object.fromEntries(
    parisDateFormatter
      .formatToParts(new Date(timestamp))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  const parisAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return parisAsUtc - timestamp;
}

function parisDateToTimestamp(dateParam) {
  const [year, month, day] = dateParam.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  const firstOffset = getParisOffsetMs(utcGuess);
  const timestamp = utcGuess - firstOffset;
  return timestamp - (getParisOffsetMs(timestamp) - firstOffset);
}

function fmtPoint(point) {
  return `device=${point.device_id} lat=${Number(point.latitude).toFixed(6)} lon=${Number(point.longitude).toFixed(6)} source=${point.source}`;
}

function createGpsRouter(io) {
  const router = express.Router();

  // Route HTTP historique — conservée pour compatibilité/tests, mais le
  // tracker Android envoie désormais ses positions via le canal Socket.IO
  // "location" (voir socket.js), qui évite le coût d'un handshake TCP/TLS
  // répété à chaque position et bénéficie de la reconnexion automatique.
  router.post("/api/location", locationLimiter, (req, res) => {
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    try {
      const { id, key } = req.body;

      if (!GPS_INGEST_KEY) {
        return res.status(500).json({
          success: false,
          message: "GPS_INGEST_KEY is not configured",
        });
      }

      const keyStr = typeof key === "string" ? key : "";
      const keyBuf = Buffer.from(keyStr, "utf8");
      const expectedBuf = Buffer.from(GPS_INGEST_KEY, "utf8");
      const keyValid =
        keyBuf.length === expectedBuf.length &&
        keyBuf.length > 0 &&
        crypto.timingSafeEqual(keyBuf, expectedBuf);

      if (!keyValid || !GPS_ALLOWED_IDS.includes(String(id))) {
        authLog(
          clientIp,
          "FAIL",
          `Position rejetée (HTTP) : device=${id} non autorisé ou clé invalide`,
        );
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized: invalid payload" });
      }

      const deviceId = String(id || "0");
      const { error, point } = buildLocationPoint(deviceId, req.body);
      if (error) {
        authLog(
          clientIp,
          "FAIL",
          `Position rejetée (HTTP) : device=${deviceId} — ${error}`,
        );
        return res.status(400).json({ success: false, message: error });
      }

      // Réponse HTTP immédiate — avant toute écriture en base
      res.status(200).json({ success: true });
      authLog(clientIp, "OK", `Position reçue (HTTP) : ${fmtPoint(point)}`);
      ingestLocationPoint(io, point);
    } catch (error) {
      console.error("[LOCATION] Erreur interne:", error);
      authLog(
        clientIp,
        "FAIL",
        `Erreur interne réception position (HTTP): ${error.message}`,
      );
      if (!res.headersSent) {
        res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  });

  router.get("/api/latest-positions", authMiddleware, async (req, res) => {
    try {
      const positions = await getPositions();
      res.status(200).json({ success: true, positions });
    } catch (error) {
      console.error("[GPS] Erreur lecture positions:", error.message);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/api/positions-history", authMiddleware, async (req, res) => {
    const dateParam = req.query.date;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam || "")) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }

    const dayStart = parisDateToTimestamp(dateParam);
    if (!Number.isFinite(dayStart)) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }
    const nextDate = new Date(`${dateParam}T00:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const dayEnd = parisDateToTimestamp(nextDate.toISOString().slice(0, 10));

    try {
      const positions = await getHistory(dayStart, dayEnd);
      res.status(200).json({ success: true, positions, date: dateParam });
    } catch (error) {
      console.error("[GPS] Erreur lecture historique:", error.message);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/api/positions-dates", authMiddleware, async (req, res) => {
    try {
      const dates = await getHistoryDates();
      res.status(200).json({ success: true, dates });
    } catch (error) {
      console.error("[GPS] Erreur lecture dates historiques:", error.message);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = createGpsRouter;
