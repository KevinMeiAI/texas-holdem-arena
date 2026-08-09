import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  build: {
    outDir: "../../dist-web",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4100",
      "/health": "http://127.0.0.1:4100",
      "/ready": "http://127.0.0.1:4100",
    },
  },
});
