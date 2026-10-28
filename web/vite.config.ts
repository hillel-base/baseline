import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

declare const process: { env: Record<string, string | undefined> }; // Node's, while Vite reads this file (the tsconfig has no Node types)

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  // the engine's page, and picker.html for the hosted page's frame; the hosted build (VITE_HOSTED=1) has no picker
  build: { rolldownOptions: { input: ["index.html", ...(process.env.VITE_HOSTED === "1" ? [] : ["picker.html"])] } },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
