const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");

const {
  IS_PROD,
  PORT,
  HOST,
  configureApp,
  sessionMiddleware,
} = require("./config");
const { authMiddleware, csrfProtection } = require("./middleware");
const { fetchForecastData } = require("./helpers");
const { initSocket } = require("./socket");

const authRouter = require("./routes/auth");
const createGpsRoutes = require("./routes/gps");
const phytoRouter = require("./routes/phyto");

const map = require("./modules/mapModule");

const app = express();
const server = http.Server(app);

//Configuration de l'application
configureApp(app);
app.use(csrfProtection);

//Routes statiques
const distPath = path.join(__dirname, "../client/dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

//Socket.IO
const io = initSocket(server);

//Routes

//Config
app.get("/api/config", authMiddleware, (req, res) => {
  res.json({ googleMapsApiKey: map.key });
});

//Forecast
app.get("/api/forecast", authMiddleware, async (req, res) => {
  try {
    const result = await fetchForecastData();
    res.json(result);
  } catch (error) {
    console.error("Error fetching forecast data:", error);
    res.status(500).json({ error: "Error fetching forecast data" });
  }
});

//Auth
app.use(authRouter);

//GPS
app.use(createGpsRoutes(io));

//Phyto
app.use(phytoRouter);

//SPA fallback
app.get("*", (req, res) => {
  const indexPath = path.join(__dirname, "../client/dist", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res
      .status(404)
      .send("Build the React client first: cd client && npm run build");
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Server running on ${HOST}:${PORT} (${IS_PROD ? "prod" : "dev"})`,
  );
});

server.on("error", (error) => {
  console.error("Server failed to start:", error);
});
