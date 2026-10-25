import { computeCoverageArea } from "./coverageCalculator.js";

// Calcul exécuté hors du thread principal pour ne pas figer la page.
self.onmessage = ({ data }) => {
  try {
    const result = computeCoverageArea(data.fieldPolygons, data.tracks);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message || "Erreur de calcul" });
  }
};
