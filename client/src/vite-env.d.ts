interface ImportMetaEnv {
  readonly VITE_SOCKET_POLLING_ONLY?: string;
}

interface Window {
  google?: typeof google;
  // Callbacks du script Google Maps (paramètre `callback` de l'URL).
  __farmMapsLoaded?: () => void;
  __farmGpsLoaded?: () => void;
}
