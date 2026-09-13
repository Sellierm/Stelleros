require("dotenv").config({ path: `${__dirname}/.env` });

const mysql = require("mysql2/promise");
const crypto = require("crypto");
const helmet = require("helmet");
const cors = require("cors");
const session = require("express-session");
const express = require("express");
const cookieParser = require("cookie-parser");

const bd = require("./modules/bdModule");

//Configuration environnement
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 4200);
const HOST = process.env.IP || process.env.HOST || "0.0.0.0";

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4200"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const CORS_ALLOWED_SUFFIX = (
  process.env.CORS_ALLOWED_SUFFIX || ".alwaysdata.net"
).trim();

const GPS_INGEST_KEY = process.env.GPS_INGEST_KEY;
const GPS_ALLOWED_IDS = (process.env.GPS_ALLOWED_IDS || "6290,7724")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("[WARN] SESSION_SECRET manquant. Secret temporaire généré.");
}

//Pool MySQL
const pool = mysql.createPool({
  host: bd.host,
  user: bd.user,
  password: bd.password,
  database: bd.database,
  waitForConnections: true,
  connectionLimit: 10,
});

//Session middleware
const sessionMiddleware = session({
  name: "sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 2 * 60 * 60 * 1000,
    secure: IS_PROD,
    sameSite: IS_PROD ? "strict" : "lax",
    httpOnly: true,
  },
});

//Vérification origine CORS
function isOriginAllowed(origin, requestHost = "") {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    if (requestHost) {
      const normalizedHost = requestHost.split(":")[0];
      if (originUrl.hostname === normalizedHost) return true;
    }
    if (CORS_ALLOWED_SUFFIX && originUrl.hostname.endsWith(CORS_ALLOWED_SUFFIX))
      return true;
  } catch {
    return false;
  }
  return false;
}

//Configuration des middlewares pour Express
function configureApp(app) {
  if (IS_PROD) app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "maps.googleapis.com", "maps.gstatic.com"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
            "https://use.fontawesome.com",
            "https://www.google.com/maps/d",
            "https://api.sencrop.com/v1",
          ],
          imgSrc: [
            "'self'",
            "data:",
            "blob:",
            "*.googleapis.com",
            "*.gstatic.com",
            "*.google.com",
            "https://openweathermap.org",
          ],
          connectSrc: [
            "'self'",
            "*.googleapis.com",
            "wss:",
            "ws:",
            "https://www.google.com",
            "https://api.sencrop.com",
          ],
          fontSrc: [
            "'self'",
            "fonts.gstatic.com",
            "https://use.fontawesome.com",
          ],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
          workerSrc: ["blob:"],
        },
      },
    }),
  );

  app.use((req, res, next) => {
    const requestHost = req.get("x-forwarded-host") || req.get("host") || "";
    return cors({
      origin: (origin, callback) =>
        callback(null, isOriginAllowed(origin, requestHost)),
      credentials: true,
    })(req, res, next);
  });

  app.use((req, res, next) => {
    res.set("Cache-Control", "no-cache, private, no-store, must-revalidate");
    next();
  });

  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(sessionMiddleware);
}

module.exports = {
  IS_PROD,
  PORT,
  HOST,
  ALLOWED_ORIGINS,
  CORS_ALLOWED_SUFFIX,
  GPS_INGEST_KEY,
  GPS_ALLOWED_IDS,
  sessionSecret,
  pool,
  sessionMiddleware,
  isOriginAllowed,
  configureApp,
};
