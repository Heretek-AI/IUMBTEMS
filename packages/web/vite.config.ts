import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Web control plane (#129): no runtime CDN — every byte is bundled locally
// and served by the fleet daemon under its strict CSP (`script-src 'self'`).
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Local dev only: proxy the bus so the UI can run against a live daemon.
    proxy: {
      "/fleet": "http://127.0.0.1:0",
    },
  },
})
