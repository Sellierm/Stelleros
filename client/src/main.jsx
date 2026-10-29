import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./theme.css";
import "./index.css";

// Applique le thème avant le premier rendu (page de connexion comprise, qui
// n'affiche pas la barre de navigation).
try {
  const savedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (savedTheme === "dark" || (!savedTheme && prefersDark)) {
    document.documentElement.classList.add("dark-theme");
  }
} catch {
  // Stockage indisponible : thème clair par défaut.
}

// Préprod : VITE_ENV_LABEL (client/.env.production.local, non versionné)
// affiche un bandeau permanent ; usePageMeta préfixe le titre de l'onglet.
const envLabel = import.meta.env.VITE_ENV_LABEL;
if (envLabel) {
  const banner = document.createElement("div");
  banner.className = "env-banner";
  banner.textContent = envLabel;
  document.body.appendChild(banner);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
