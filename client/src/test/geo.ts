// Aides géométriques des tests de surface.
import type { LatLngPoint } from "../utils/coverageCalculator";

// Repère local : x mètres vers l'est, y mètres vers le nord d'un point de
// référence (premier sommet du premier champ, comme le calcul).
export const LAT0 = 50.4;
export const LNG0 = 3.0;
export const EARTH_RADIUS_M = 6371000;
export const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180;
export const T0 = 1_800_000_000_000;

export function at(x: number, y: number, tS?: number): LatLngPoint {
  return {
    lat: LAT0 + y / M_PER_DEG,
    lng: LNG0 + x / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)),
    t: tS === undefined ? undefined : T0 + tS * 1000,
  };
}

/** Rectangle parcouru dans le sens trigonométrique. */
export function rect(x0: number, y0: number, x1: number, y1: number) {
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
}

/** Passage rectiligne à `speed` m/s, un point toutes les `stepS` s. */
export function pass(
  from: [number, number],
  to: [number, number],
  { speed = 2, stepS = 1, startS = 0 } = {},
): LatLngPoint[] {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const duration = Math.hypot(x1 - x0, y1 - y0) / speed;
  const n = Math.max(1, Math.round(duration / stepS));
  return Array.from({ length: n + 1 }, (_, i) =>
    at(
      x0 + ((x1 - x0) * i) / n,
      y0 + ((y1 - y0) * i) / n,
      startS + (duration * i) / n,
    ),
  );
}

/** Surface d'une bande de `length` m et de largeur `width` m, bouts arrondis. */
export function stadium(length: number, width: number) {
  return length * width + Math.PI * (width / 2) ** 2;
}

/** Aire exacte, sur la sphère, d'un contour [lat, lng] rectangle. */
export function sphericalBoxArea(points: LatLngPoint[]) {
  const lats = points.map(({ lat }) => (lat * Math.PI) / 180);
  const lngs = points.map(({ lng }) => (lng * Math.PI) / 180);
  return (
    EARTH_RADIUS_M ** 2 *
    (Math.max(...lngs) - Math.min(...lngs)) *
    (Math.sin(Math.max(...lats)) - Math.sin(Math.min(...lats)))
  );
}
