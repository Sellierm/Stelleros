const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

//Logging authentification
function authLog(ip, level, message) {
  const ts = new Date().toISOString();
  const tag =
    level === "OK"
      ? "\x1b[32m[OK]\x1b[0m"
      : level === "FAIL"
        ? "\x1b[31m[FAIL]\x1b[0m"
        : "\x1b[33m[INFO]\x1b[0m";
  console.log(`${ts} ${tag} [${ip}] ${message}`);
}

//Middleware d'authentification
const authMiddleware = (req, res, next) => {
  if (req.session.username) return next();
  res.status(401).json({ success: false, message: "Unauthorized" });
};

//Rate limiter pour l'authentification
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again later.",
});

//Rate limiter pour les positions GPS
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many location updates from this IP, please slow down.",
});

//Token CSRF
function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

//Comparaison sécurisée de tokens
function safeTokenEquals(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

//Vérification same-origin
function isSameOriginRequest(req) {
  const origin = req.get("origin");
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.hostname === host.split(":")[0];
  } catch {
    return false;
  }
}

//Protection CSRF
function csrfProtection(req, res, next) {
  const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (!unsafeMethods.has(req.method)) return next();
  if (req.path === "/api/location") return next();
  if (!req.session?.username) return next();

  const requestToken =
    req.get("x-csrf-token") ||
    req.get("x-xsrf-token") ||
    req.get("csrf-token") ||
    req.body?._csrf ||
    req.body?.csrfToken;
  const sessionToken = req.session?.csrfToken;

  if (!safeTokenEquals(requestToken, sessionToken)) {
    if (isSameOriginRequest(req)) return next();
    return res.status(403).json({
      success: false,
      message: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
  }
  return next();
}

module.exports = {
  authLog,
  authMiddleware,
  authLimiter,
  locationLimiter,
  ensureCsrfToken,
  safeTokenEquals,
  isSameOriginRequest,
  csrfProtection,
};
