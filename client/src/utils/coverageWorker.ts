import {
  computeCoverageArea,
  type CoverageWorkerRequest,
  type CoverageWorkerResponse,
} from "./coverageCalculator";

// Calcul exécuté hors du thread principal pour ne pas figer la page.
self.onmessage = ({ data }: MessageEvent<CoverageWorkerRequest>) => {
  try {
    const result = computeCoverageArea(data.fieldPolygons, data.tracks);
    self.postMessage({ result } satisfies CoverageWorkerResponse);
  } catch (error) {
    self.postMessage({
      error: (error instanceof Error && error.message) || "Erreur de calcul",
    } satisfies CoverageWorkerResponse);
  }
};
