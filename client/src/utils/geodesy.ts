interface LatLng {
  lat: number;
  lng: number;
}

// Rayon de Google Maps (google.maps.geometry.spherical) : surfaces identiques
// à celles de l'outil de mesure de My Maps, où le plan est dessiné.
export const EARTH_RADIUS_M = 6378137;

const DEG2RAD = Math.PI / 180;

// Formule de Chamberlain et Duquette, comme Google Maps.
export function ringAreaM2(ring: LatLng[]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum +=
      (b.lng - a.lng) *
      DEG2RAD *
      (2 + Math.sin(a.lat * DEG2RAD) + Math.sin(b.lat * DEG2RAD));
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function polygonAreaM2(outer: LatLng[], holes: LatLng[][] = []) {
  const holesArea = holes.reduce((sum, hole) => sum + ringAreaM2(hole), 0);
  return Math.max(0, ringAreaM2(outer) - holesArea);
}
