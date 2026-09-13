const require_socket_io = require("socket.io");
const crypto = require("crypto");
const {
  sessionMiddleware,
  isOriginAllowed,
  GPS_INGEST_KEY,
  GPS_ALLOWED_IDS,
} = require("./config");
const { authLog } = require("./middleware");
const { fetchSencropData } = require("./helpers");
const { buildLocationPoint, ingestLocationPoint } = require("./locationStore");
const map = require("./modules/mapModule");

let io;

function fmtPoint(point) {
  return `device=${point.device_id} lat=${Number(point.latitude).toFixed(6)} lon=${Number(point.longitude).toFixed(6)} source=${point.source}`;
}

function initSocket(server) {
  io = require_socket_io(server, {
    cors: {
      origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Authentification double :
  //  - Devices GPS (tablette RTK) : identifies par deviceId + cle statique
  //    fournis dans l'objet `auth` du handshake (pas de session/cookie).
  //  - Clients web (React) : authentifies par la session cookie existante,
  //    comportement inchange.
  io.use((socket, next) => {
    console.log("[DEBUG] handshake.auth:", socket.handshake.auth);
    const { deviceId, key } = socket.handshake.auth || {};

    if (deviceId !== undefined || key !== undefined) {
      if (!GPS_INGEST_KEY) {
        return next(new Error("GPS ingest not configured"));
      }

      const keyStr = typeof key === "string" ? key : "";
      const keyBuf = Buffer.from(keyStr, "utf8");
      const expectedBuf = Buffer.from(GPS_INGEST_KEY, "utf8");
      const keyValid =
        keyBuf.length === expectedBuf.length &&
        keyBuf.length > 0 &&
        crypto.timingSafeEqual(keyBuf, expectedBuf);

      if (!keyValid || !GPS_ALLOWED_IDS.includes(String(deviceId))) {
        authLog(
          socket.handshake.address || "unknown",
          "FAIL",
          `Connexion device GPS refusée : device=${deviceId} non autorisé ou clé invalide`,
        );
        return next(new Error("Unauthorized device"));
      }

      socket.isGpsDevice = true;
      socket.deviceId = String(deviceId);
      return next();
    }

    sessionMiddleware(socket.request, {}, () => {
      if (socket.request.session?.username) return next();
      return next(new Error("Unauthorized"));
    });
  });

  io.on("connection", (socket) => {
    const socketIp = socket.handshake.address || "unknown";

    // ── Connexion device GPS : uniquement l'event "location", pas d'accès
    // aux handlers web (askPlan, askDataR1...) ──────────────────────────
    if (socket.isGpsDevice) {
      authLog(
        socketIp,
        "INFO",
        `Device GPS connecté : ${socket.deviceId} (id: ${socket.id})`,
      );

      socket.on("location", (payload, ack) => {
        try {
          const { error, point } = buildLocationPoint(socket.deviceId, payload);
          if (error) {
            authLog(
              socketIp,
              "FAIL",
              `Position rejetée (socket) : device=${socket.deviceId} — ${error}`,
            );
            if (typeof ack === "function")
              ack({ success: false, message: error });
            return;
          }

          // Ack immediat avant l'I/O disque — le device n'a besoin de
          // savoir que la position a ete acceptee, pas qu'elle est deja
          // persistee sur disque.
          if (typeof ack === "function") ack({ success: true });
          authLog(
            socketIp,
            "OK",
            `Position reçue (socket) : ${fmtPoint(point)}`,
          );
          ingestLocationPoint(io, point);
        } catch (err) {
          console.error("[LOCATION][socket] Erreur interne:", err);
          authLog(
            socketIp,
            "FAIL",
            `Erreur interne réception position (socket) device=${socket.deviceId}: ${err.message}`,
          );
          if (typeof ack === "function") {
            ack({ success: false, message: "Internal server error" });
          }
        }
      });

      socket.on("disconnect", (reason) => {
        authLog(
          socketIp,
          "INFO",
          `Device GPS déconnecté : ${socket.deviceId} (raison: ${reason})`,
        );
      });

      return;
    }

    // ── Connexion client web (session utilisateur) — comportement inchangé ──
    const socketUser = socket.request.session?.username || "inconnu";
    authLog(
      socketIp,
      "INFO",
      `Socket connecté : "${socketUser}" (id: ${socket.id})`,
    );

    socket.on("disconnect", (reason) => {
      authLog(
        socketIp,
        "INFO",
        `Socket déconnecté : "${socketUser}" (raison: ${reason})`,
      );
    });

    const VALID_MEASURES = new Set([
      "TEMPERATURE",
      "TEMPERATURE_MIN",
      "TEMPERATURE_MAX",
      "RAIN_FALL",
      "RELATIVE_HUMIDITY",
      "WET_TEMPERATURE",
      "WIND_SPEED",
      "WIND_GUST",
      "WIND_DIRECTION",
    ]);
    const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    function sanitizeDate(value) {
      return typeof value === "string" && VALID_DATE_RE.test(value)
        ? value
        : null;
    }

    function sanitizeMeasures(value) {
      if (typeof value !== "string") return null;
      const parts = value.split(",").map((p) => p.trim());
      return parts.every((p) => VALID_MEASURES.has(p)) ? parts.join(",") : null;
    }

    socket.on("askPlan", (value) => {
      const year = Number(value);
      const idx = Math.max(0, Math.min(map.table.length - 1, year - 2022));
      socket.emit("getPlan", map.table[idx]);
    });

    socket.on("askDataR1", (startDate, measures) => {
      const date = sanitizeDate(startDate);
      const meas = sanitizeMeasures(measures);
      if (!date || !meas) return;
      const url = `${require("./modules/sencropModule").endPoint}/users/${require("./modules/sencropModule").userId}/devices/${require("./modules/sencropModule").raincropEarlId}/data/hourly?beforeDate=${date}&days=1&measures=${meas}`;
      fetchSencropData(url).then((result) => {
        if (result?.measures)
          socket.emit("getDataR1", result.measures.data, meas);
      });
    });

    socket.on("askDataR2", (startDate, measures) => {
      const date = sanitizeDate(startDate);
      const meas = sanitizeMeasures(measures);
      if (!date || !meas) return;
      const url = `${require("./modules/sencropModule").endPoint}/users/${require("./modules/sencropModule").userId}/devices/${require("./modules/sencropModule").raincropEarlId}/data/raw?size=100&beforeDate=${date}&days=1&measures=${meas}`;
      fetchSencropData(url).then((result) => {
        if (result) socket.emit("getDataR2", result, meas);
      });
    });

    socket.on("askDataW1", (startDate, measures) => {
      const date = sanitizeDate(startDate);
      const meas = sanitizeMeasures(measures);
      if (!date || !meas) return;
      const url = `${require("./modules/sencropModule").endPoint}/users/${require("./modules/sencropModule").userId}/devices/${require("./modules/sencropModule").windcropEarlId}/data/hourly?beforeDate=${date}&days=1&measures=${meas}&patched=true`;
      fetchSencropData(url).then((result) => {
        if (result?.measures)
          socket.emit("getDataW1", result.measures.data, meas);
      });
    });

    socket.on("askDataW2", (startDate, measures) => {
      const date = sanitizeDate(startDate);
      const meas = sanitizeMeasures(measures);
      if (!date || !meas) return;
      const url = `${require("./modules/sencropModule").endPoint}/users/${require("./modules/sencropModule").userId}/devices/${require("./modules/sencropModule").windcropEarlId}/data/raw?size=500&beforeDate=${date}&days=1&measures=${meas}`;
      fetchSencropData(url).then((result) => {
        if (result) socket.emit("getDataW2", result, meas);
      });
    });

    socket.on("askRain", (startDate, duration) => {
      const date = sanitizeDate(startDate);
      const days = Math.max(1, Math.min(365, Number(duration)));
      if (!date || !Number.isFinite(days)) return;
      const url = `${require("./modules/sencropModule").endPoint}/users/${require("./modules/sencropModule").userId}/devices/${require("./modules/sencropModule").raincropEarlId}/data/daily?beforeDate=${date}&days=${days}&measures=RAIN_FALL&patched=true`;
      fetchSencropData(url).then((result) => {
        if (result?.measures) {
          let sum = 0;
          for (const i in result.measures.data)
            sum += result.measures.data[i].RAIN_FALL;
          socket.emit("getRain", sum);
        }
      });
    });

    socket.on("forceDisconnect", () => socket.disconnect(true));
  });

  return io;
}

module.exports = {
  initSocket,
  get io() {
    if (!io)
      throw new Error(
        "Socket.IO not initialized. Call initSocket(server) first.",
      );
    return io;
  },
};
