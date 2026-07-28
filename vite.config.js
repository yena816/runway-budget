import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,                 // listen on the network, not just localhost
    allowedHosts: [".ts.net"],  // allow access via Tailscale MagicDNS names
    proxy: { "/api": "http://localhost:3000" }, // dev mode: forward API calls to server.js
  },
});
