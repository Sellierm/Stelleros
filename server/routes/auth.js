const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const validator = require("validator");
const { pool, sessionMiddleware } = require("../config");
const {
  authLog,
  authMiddleware,
  authLimiter,
  ensureCsrfToken,
} = require("../middleware");
const { refreshSencropToken } = require("../helpers");

const router = express.Router();

router.get("/api/csrf-token", (req, res) => {
  res.json({ csrfToken: ensureCsrfToken(req) });
});

router.get("/api/check-auth", (req, res) => {
  if (req.session.username) {
    return res.json({
      authenticated: true,
      username: req.session.username,
      csrfToken: ensureCsrfToken(req),
    });
  }
  return res.json({ authenticated: false, csrfToken: ensureCsrfToken(req) });
});

router.post("/api/auth", authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";

  if (!username || !password) {
    authLog(clientIp, "FAIL", "Tentative de connexion sans identifiants");
    return res
      .status(400)
      .json({ success: false, message: "Missing credentials" });
  }

  if (
    !validator.isAlphanumeric(username) ||
    !validator.isLength(username, { min: 3, max: 10 })
  ) {
    authLog(clientIp, "FAIL", `Nom d'utilisateur invalide : "${username}"`);
    return res
      .status(401)
      .json({ success: false, message: "Invalid username" });
  }

  authLog(clientIp, "INFO", `Tentative de connexion : "${username}"`);

  try {
    const [results] = await pool.execute(
      "SELECT password FROM user WHERE name = ?",
      [username],
    );

    if (results.length !== 1) {
      authLog(clientIp, "FAIL", `Utilisateur inconnu : "${username}"`);
      return res
        .status(401)
        .json({ success: false, message: "Wrong credentials" });
    }

    let passwordValid = false;
    const storedHash = results[0].password;
    const isBcrypt =
      typeof storedHash === "string" && storedHash.startsWith("$2");

    if (isBcrypt) {
      passwordValid = await bcrypt.compare(password, storedHash);
    } else {
      const legacyHash = crypto
        .createHash("sha512")
        .update(password)
        .digest("hex");
      if (legacyHash === storedHash) {
        passwordValid = true;
        try {
          const newHash = await bcrypt.hash(password, 12);
          await pool.execute("UPDATE user SET password=? WHERE name=?", [
            newHash,
            username,
          ]);
          authLog(
            clientIp,
            "INFO",
            `Mot de passe migré bcrypt : "${username}"`,
          );
        } catch (hashErr) {
          console.error("bcrypt hash error:", hashErr);
        }
      }
    }

    if (!passwordValid) {
      authLog(clientIp, "FAIL", `Mot de passe incorrect pour : "${username}"`);
      return res
        .status(401)
        .json({ success: false, message: "Wrong credentials" });
    }

    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );

    req.session.username = username;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    authLog(clientIp, "OK", `Connexion réussie : "${username}"`);

    try {
      await refreshSencropToken();
    } catch (err) {
      console.error("Sencrop auth error at login:", err);
    }

    return res
      .status(200)
      .json({ success: true, csrfToken: req.session.csrfToken });
  } catch (error) {
    console.error("Auth error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
});

router.post("/api/logout", (req, res) => {
  if (!req.session) return res.json({ success: true });
  const logoutUser = req.session.username || "inconnu";
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
  req.session.destroy(() => {
    authLog(clientIp, "INFO", `Déconnexion : "${logoutUser}"`);
    res.clearCookie("sid");
    res.json({ success: true });
  });
});

module.exports = router;
