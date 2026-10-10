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
    // Local dev only: point ES_FLEET_PROXY at a live daemon (e.g.
    // http://127.0.0.1:8471) so the UI can run against it. Unset by
    // default: there is no dead proxy to 127.0.0.1:0.
    proxy: process.env.ES_FLEET_PROXY ? { "/fleet": process.env.ES_FLEET_PROXY } : undefined,
  },
})
