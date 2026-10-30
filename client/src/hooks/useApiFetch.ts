import { useCallback } from "react";

type ApiFetchOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

export function useApiFetch() {
  const apiFetch = useCallback(
    async <T = unknown>(
      url: string,
      options: ApiFetchOptions = {},
    ): Promise<T> => {
      const requestOptions: RequestInit = {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      };
      const res = await fetch(url, requestOptions);

      if (!res.ok) {
        const errorData: { message?: string } = await res
          .json()
          .catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${res.status}`);
      }

      return res.json();
    },
    [],
  );

  return apiFetch;
}
