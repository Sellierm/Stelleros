const fetch = require("node-fetch");
const sencrop = require("./modules/sencropModule");
const forecast = require("./modules/forecastModule");

//Récupère un nouveau token Sencrop via client_credentials
const refreshSencropToken = async () => {
  try {
    const crypt = Buffer.from(
      sencrop.applicationId + ":" + sencrop.applicationSecret,
    ).toString("base64");

    const response = await fetch(`${sencrop.endPoint}/oauth2/token`, {
      method: "POST",
      body: JSON.stringify({ grant_type: "client_credentials", scope: "user" }),
      headers: {
        Authorization: `Basic ${crypt}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("[Sencrop] Échec refresh token — HTTP", response.status);
      return false;
    }

    const data = await response.json();
    sencrop.accessToken = data.access_token;

    const expiresIn = data.expires_in ?? 3600;
    sencrop.tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;

    console.log(
      `[Sencrop] Token renouvelé — expire dans ${Math.round(expiresIn / 60)} min`,
    );
    return true;
  } catch (err) {
    console.error("[Sencrop] Erreur refresh token:", err.message);
    return false;
  }
};

//Vérifie si le token est expiré ou absent
const ensureSencropToken = async () => {
  const now = Date.now();
  const isExpired =
    !sencrop.accessToken ||
    !sencrop.tokenExpiresAt ||
    now >= sencrop.tokenExpiresAt;

  if (isExpired) {
    console.log("[Sencrop] Token absent ou expiré — tentative de refresh");
    return refreshSencropToken();
  }
  return true;
};

//Appelle l'API Sencrop avec refresh automatique en cas de 401
const fetchSencropData = async (url) => {
  try {
    await ensureSencropToken();

    let r = await fetch(url, {
      headers: { Authorization: `Bearer ${sencrop.accessToken}` },
    });

    if (r.status === 401) {
      console.warn("[Sencrop] 401 reçu — refresh token et retry");
      const refreshed = await refreshSencropToken();
      if (!refreshed) return { success: false };

      r = await fetch(url, {
        headers: { Authorization: `Bearer ${sencrop.accessToken}` },
      });
    }

    if (!r.ok) {
      console.error("[Sencrop] Erreur HTTP", r.status, url);
      return { success: false };
    }

    return await r.json();
  } catch (err) {
    console.error("[Sencrop] Erreur réseau:", err.message);
    return { success: false };
  }
};

//Récupère les données météo OpenWeatherMap
const fetchForecastData = async () => {
  try {
    const r = await fetch(
      `https://api.openweathermap.org/data/3.0/onecall?lat=${forecast.latitude}&lon=${forecast.longitude}&exclude=current,minutely,alerts&appid=${forecast.key}&units=metric`,
    );
    return await r.json();
  } catch (error) {
    console.error("Error fetching weather data:", error.message);
    return {};
  }
};

module.exports = {
  refreshSencropToken,
  ensureSencropToken,
  fetchSencropData,
  fetchForecastData,
};
