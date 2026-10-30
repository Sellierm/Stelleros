import { useEffect } from "react";
import { withEnvLabel } from "../lib/envLabel";

/**
 * Sets document title and favicon to match the original farm app per-page behaviour.
 * @param title - Page title (e.g. "Forecast")
 * @param favicon - Path to the favicon in /assets (e.g. "/assets/icons8-weather-forecast-32.png")
 */
export default function usePageMeta(title: string, favicon?: string) {
  useEffect(() => {
    document.title = withEnvLabel(title);

    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/png";
      link.sizes = "32x32";
      document.head.appendChild(link);
    }
    if (favicon) {
      link.href = favicon;
    }
  }, [title, favicon]);
}
