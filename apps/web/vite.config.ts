import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@squillpad/core-model": fileURLToPath(
        new URL("../../packages/core-model/src/index.ts", import.meta.url),
      ),
      "@squillpad/ui": fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
      "@squillpad/synchronization": fileURLToPath(
        new URL("../../packages/synchronization/src/index.ts", import.meta.url),
      ),
    },
    dedupe: [
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/lang-markdown",
      "@codemirror/lint",
      "@codemirror/search",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": process.env.SQUILLPAD_API_TARGET ?? "http://127.0.0.1:4173",
      "/sync": {
        target: process.env.SQUILLPAD_API_TARGET ?? "http://127.0.0.1:4173",
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
