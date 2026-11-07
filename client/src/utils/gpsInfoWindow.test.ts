import { describe, expect, it } from "vitest";
import type { GpsPoint } from "../types/api";
import { buildInfoWindowContent, escapeHtml } from "./gpsInfoWindow";

const point = (overrides: Partial<GpsPoint> = {}): GpsPoint => ({
  device_id: "7724",
  latitude: 45.123456,
  longitude: 4.654321,
  altitude: null,
  accuracy: null,
  speed: null,
  heading: null,
  source: "gps",
  timestamp: Date.UTC(2026, 10, 6, 12),
  ...overrides,
});

describe("escapeHtml", () => {
  it("échappe les caractères spéciaux du HTML", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("laisse le texte ordinaire intact", () => {
    expect(escapeHtml("Tracteur 7724 (rtk)")).toBe("Tracteur 7724 (rtk)");
  });
});

describe("buildInfoWindowContent", () => {
  it("n'insère pas de HTML venu de l'appareil", () => {
    const html = buildInfoWindowContent(
      '<img src=x onerror="alert(1)">',
      point({ source: "<script>alert(2)</script>" }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("affiche les mesures disponibles", () => {
    const html = buildInfoWindowContent(
      "7724",
      point({ speed: 2, heading: 90.4, accuracy: 0.0123 }),
    );
    expect(html).toContain("<strong>Device ID:</strong> 7724<br/>");
    expect(html).toContain("<strong>Position:</strong> 45.123456, 4.654321");
    expect(html).toContain("<strong>Vitesse:</strong> 7.2 km/h");
    expect(html).toContain("<strong>Cap:</strong> 90°");
    expect(html).toContain("<strong>Précision:</strong> 0.01m");
    expect(html).toContain("<strong>Source:</strong> gps<br/>");
    expect(html).not.toContain("Altitude");
  });
});
