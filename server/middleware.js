const rateLimit = require("express-rate-limit");
const { getSession } = require("./lib/authBridge");

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
const authMiddleware = async (req, res, next) => {
  try {
    const session = await getSession(req);
    if (session?.user) {
      req.user = session.user;
      return next();
    }
  } catch (err) {
    console.error("[AUTH] Erreur lecture session:", err.message);
  }
  res.status(401).json({ success: false, message: "Unauthorized" });
};

//Rate limiter pour les positions GPS
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many location updates from this IP, please slow down.",
});

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
  if (req.path.startsWith("/api/auth/")) return next();
  if (isSameOriginRequest(req)) return next();
  return res.status(403).json({
    success: false,
    message: "Invalid origin",
    code: "CSRF_INVALID",
  });
}

module.exports = {
  authLog,
  authMiddleware,
  locationLimiter,
  isSameOriginRequest,
  csrfProtection,
};
