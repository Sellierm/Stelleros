import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { loadEnvLabel } from "./lib/envLabel.js";
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

// Préprod : bandeau permanent et titre d'onglet préfixé (cf. lib/envLabel.js).
loadEnvLabel();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
