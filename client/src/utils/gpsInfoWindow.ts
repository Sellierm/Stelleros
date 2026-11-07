import type { GpsPoint } from "../types/api";

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Échappe un texte avant de l'insérer dans du HTML écrit à la main. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);

/**
 * Contenu HTML de l'infobulle d'un engin sur la carte. L'identifiant et la
 * source viennent de l'appareil (route d'ingestion GPS) : ils sont échappés.
 * Les autres valeurs sont des nombres mis en forme.
 */
export const buildInfoWindowContent = (deviceId: string, pos: GpsPoint) => {
  const speedKmh = pos.speed != null ? (pos.speed * 3.6).toFixed(1) : null;
  const headingStr =
    pos.heading != null ? `${Number(pos.heading).toFixed(0)}°` : null;
  const sourceStr = pos.source || "unknown";
  const accuracyStr =
    pos.accuracy != null ? `${Number(pos.accuracy).toFixed(2)}m` : null;

  return `
    <div class="tractor-info-window">
      <strong>Device ID:</strong> ${escapeHtml(deviceId)}<br/>
      <strong>Position:</strong> ${pos.latitude.toFixed(6)}, ${pos.longitude.toFixed(6)}<br/>
      ${pos.altitude != null ? `<strong>Altitude:</strong> ${Number(pos.altitude).toFixed(1)}m<br/>` : ""}
      ${accuracyStr ? `<strong>Précision:</strong> ${accuracyStr}<br/>` : ""}
      ${speedKmh ? `<strong>Vitesse:</strong> ${speedKmh} km/h<br/>` : ""}
      ${headingStr ? `<strong>Cap:</strong> ${headingStr}<br/>` : ""}
      <strong>Source:</strong> ${escapeHtml(sourceStr)}<br/>
      <strong>Mise à jour:</strong> ${new Date(pos.timestamp).toLocaleString("fr-FR")}
    </div>`;
};
