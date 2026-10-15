import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./dist/test", testMatch: "hosted-browser.spec.js", workers: 1, retries: 0, timeout: 60000,
  expect: { timeout: 10000 }, outputDir: "../.tools/playwright-results", reporter: "line", use: { trace: "off", screenshot: "off", video: "off" } });
