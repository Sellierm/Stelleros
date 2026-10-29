import { useEffect } from "react";

/**
 * Sets document title and favicon to match the original farm app per-page behaviour.
 * @param {string} title - Page title (e.g. "Forecast")
 * @param {string} favicon - Path to the favicon in /assets (e.g. "/assets/icons8-weather-forecast-32.png")
 */
export default function usePageMeta(title, favicon) {
  useEffect(() => {
    const envLabel = import.meta.env.VITE_ENV_LABEL;
    document.title = envLabel ? `[${envLabel}] ${title}` : title;

    let link = document.querySelector("link[rel~='icon']");
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
