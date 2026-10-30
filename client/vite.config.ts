import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Quand le navigateur ferme brutalement le WebSocket socket.io (rechargement,
// HMR, double montage StrictMode), Windows renvoie ECONNABORTED/ECONNRESET et
// Vite logue une stack inutile. On filtre uniquement ces cas-là.
const logger = createLogger();
const logError = logger.error;
logger.error = (msg, options) => {
  if (
    msg.includes("ws proxy") &&
    ["ECONNABORTED", "ECONNRESET", "EPIPE"].includes(
      (options?.error as NodeJS.ErrnoException | undefined)?.code ?? "",
    )
  ) {
    return;
  }
  logError(msg, options);
};

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api calls and /socket.io to the Rust server on :4200
      "/api": {
        target: "http://localhost:4200",
        changeOrigin: true,
        secure: false,
      },
      "/socket.io": {
        target: "http://localhost:4200",
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
