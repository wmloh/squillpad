import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5273", viewport: { width: 1600, height: 1100 } },
  webServer: [
    {
      command: "pnpm --filter @squillpad/server exec tsx e2e/host.ts",
      url: "http://127.0.0.1:4273/health",
    },
    {
      command: "pnpm dev --port 5273",
      env: { SQUILLPAD_API_TARGET: "http://127.0.0.1:4273" },
      url: "http://127.0.0.1:5273",
    },
  ],
});
