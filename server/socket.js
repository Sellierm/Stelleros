const require_socket_io = require("socket.io");
const crypto = require("crypto");
const {
  isOriginAllowed,
  GPS_INGEST_KEY,
  GPS_ALLOWED_IDS,
} = require("./config");
const { authLog } = require("./middleware");
const { getSession } = require("./lib/authBridge");
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

    getSession(socket.request)
      .then((session) => {
        if (session?.user) {
          socket.user = session.user;
          return next();
        }
        next(new Error("Unauthorized"));
      })
      .catch(() => next(new Error("Unauthorized")));
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
    const socketUser = socket.user?.username || "inconnu";
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

    // Résumé météo : chaque fenêtre [début, fin[ est calculée côté client en
    // minuits locaux (gère les changements d'heure), puis les valeurs horaires
    // sont filtrées sur cette fenêtre exacte.
    const DAY_MS = 24 * 60 * 60 * 1000;

    function sanitizeWindow(value) {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const [start, end] = value.map(sanitizeDate);
      if (!start || !end) return null;
      const startTime = Date.parse(start);
      const endTime = Date.parse(end);
      if (!(startTime < endTime) || endTime - startTime > 8 * DAY_MS) return null;
      return { startTime, endTime };
    }

    // L'API horaire refuse plus de 7 jours par requête (HTTP 400) : la fenêtre
    // est découpée en tranches de 7 jours en remontant depuis la fin. Chaque
    // ligne est horodatée par `key` (ms epoch), dédoublonnée entre tranches.
    const MAX_HOURLY_DAYS = 7;

    async function fetchHourlyValues(deviceId, measure, window) {
      const sencrop = require("./modules/sencropModule");
      const rowsByTime = new Map();

      for (
        let chunkEnd = window.endTime;
        chunkEnd > window.startTime;
        chunkEnd -= MAX_HOURLY_DAYS * DAY_MS
      ) {
        const days = Math.min(
          MAX_HOURLY_DAYS,
          Math.ceil((chunkEnd - window.startTime) / DAY_MS),
        );
        const beforeDate = new Date(chunkEnd).toISOString();
        const url = `${sencrop.endPoint}/users/${sencrop.userId}/devices/${deviceId}/data/hourly?beforeDate=${beforeDate}&days=${days}&measures=${measure}&patched=true`;
        const result = await fetchSencropData(url);
        if (!result?.measures) throw new Error(`Sencrop ${measure} indisponible`);

        for (const row of result.measures.data || []) {
          const timestamp = Number(row?.key ?? Date.parse(row?.date));
          if (timestamp >= window.startTime && timestamp < window.endTime) {
            rowsByTime.set(timestamp, row);
          }
        }
      }

      return [...rowsByTime.values()]
        .map((row) => Number(row?.[measure]?.value))
        .filter(Number.isFinite);
    }

    const average = (values) =>
      values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;

    socket.on("askWeatherSummary", (request) => {
      const requestId = request?.requestId;
      const rainWindow = sanitizeWindow(request?.rain);
      const temperatureWindow = sanitizeWindow(request?.temperature);
      const windWindow = sanitizeWindow(request?.wind);
      if (!rainWindow || !temperatureWindow || !windWindow) return;

      const sencrop = require("./modules/sencropModule");
      Promise.all([
        fetchHourlyValues(sencrop.raincropEarlId, "RAIN_FALL", rainWindow),
        fetchHourlyValues(sencrop.raincropEarlId, "TEMPERATURE", temperatureWindow),
        fetchHourlyValues(sencrop.windcropEarlId, "WIND_SPEED", windWindow),
      ])
        .then(([rainfall, temperatures, wind]) => {
          socket.emit("getWeatherSummary", {
            requestId,
            rainfallMm:
              rainfall.length > 0
                ? rainfall.reduce((sum, value) => sum + value, 0)
                : null,
            averageTemperature: average(temperatures),
            averageWind: average(wind),
          });
        })
        .catch((error) => {
          console.error("Erreur résumé météo Sencrop:", error);
          socket.emit("getWeatherSummary", { requestId });
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
