import { useCallback } from "react";

export function useApiFetch() {
  const apiFetch = useCallback(
    async (url, options = {}) => {
      const requestOptions = {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      };
      const res = await fetch(url, requestOptions);

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${res.status}`);
      }

      return res.json();
    },
    [],
  );

  return apiFetch;
}
