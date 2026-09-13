import { useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";

export function useApiFetch() {
  const { csrfToken, refreshCsrfToken } = useAuth();

  const apiFetch = useCallback(
    async (url, options = {}) => {
      const method = (options.method || "GET").toUpperCase();
      const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

      let token = csrfToken;
      if (unsafe && !token) token = await refreshCsrfToken();

      let body = options.body;
      if (unsafe && token && typeof options.body === "string") {
        try {
          body = JSON.stringify({ ...JSON.parse(options.body), _csrf: token });
        } catch {
          body = options.body;
        }
      }

      const buildOptions = (tok) => ({
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": tok || "",
          ...options.headers,
        },
        body:
          unsafe && tok && typeof options.body === "string"
            ? (() => {
                try {
                  return JSON.stringify({
                    ...JSON.parse(options.body),
                    _csrf: tok,
                  });
                } catch {
                  return options.body;
                }
              })()
            : body,
      });

      const res = await fetch(url, buildOptions(token));

      if (res.status === 403 && unsafe) {
        const fresh = await refreshCsrfToken();
        const retryRes = await fetch(url, buildOptions(fresh));
        if (!retryRes.ok) {
          const errorData = await retryRes.json().catch(() => ({}));
          throw new Error(errorData.message || `HTTP ${retryRes.status}`);
        }
        return retryRes.json();
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${res.status}`);
      }

      return res.json();
    },
    [csrfToken, refreshCsrfToken],
  );

  return apiFetch;
}
