import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api calls and /socket.io to Express on :4200
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
