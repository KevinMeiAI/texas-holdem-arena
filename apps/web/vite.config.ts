import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  build: {
    outDir: "../../dist-web",
    // Keep prior content-hashed bundles available for tabs that reload while a
    // new build is being written. The new index replaces their references once
    // every new asset exists, so an in-flight page never loses its stylesheet.
    emptyOutDir: false,
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
