import { readFile } from "node:fs/promises";
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { startBrowserFixture, testCertificatePin, type BrowserFixture } from "./browser-fixture.js";

let browser: Browser;
let fixture: BrowserFixture;
let page: Page;
test.beforeAll(async (): Promise<void> => { browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${await testCertificatePin()}`] }); });
test.afterAll(async (): Promise<void> => { await browser.close(); });
test.beforeEach(async (): Promise<void> => { fixture = await startBrowserFixture(); page = await browser.newPage(); await page.goto(fixture.origin); });
test.afterEach(async (): Promise<void> => { await page.close(); await fixture.close(); });

async function fund(): Promise<void> {
  await expect(page.getByTestId("create")).toBeEnabled(); await page.getByTestId("create").click();
  await expect(page.getByTestId("fund")).toBeEnabled(); await page.getByTestId("fund").click();
  await expect(page.getByTestId("pay")).toBeEnabled();
}
test("refresh_keeps_running_grant", async (): Promise<void> => {
  await fund(); const before = await fixture.snapshot(); const state = await readFile(fixture.stateFile());
  await page.reload(); await expect(page.getByTestId("hosted-run")).toHaveText(before.runId);
  await page.getByTestId("refresh").click(); await expect(page.getByTestId("pay")).toBeEnabled();
  expect((await fixture.snapshot()).revision).toBe(2); expect(await readFile(fixture.stateFile())).toEqual(state);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate((): boolean => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId("pay-amount").focus(); await page.keyboard.press("Tab"); await expect(page.getByTestId("pay")).toBeFocused();
});
test("restart_requires_explicit_reload", async (): Promise<void> => {
  await fund(); const before = await fixture.snapshot(); const file = fixture.stateFile(); const saved = await readFile(file);
  await fixture.restart(); await page.getByTestId("refresh").click();
  await expect(page.getByTestId("hosted-state")).toHaveText("Server restarted — reload to begin a fresh test session.");
  await expect(page.getByTestId("pay")).toBeDisabled(); expect(await readFile(file)).toEqual(saved);
  await page.reload(); await expect(page.getByTestId("create")).toBeEnabled();
  expect((await fixture.snapshot()).runId).not.toBe(before.runId); expect((await fixture.snapshot()).snapshot.vault).toBeNull();
});
test("uncertain_payment_is_not_resent", async (): Promise<void> => {
  await fund(); fixture.losePaymentResponse(); await page.getByTestId("pay").click();
  await expect(page.getByTestId("hosted-outcome")).toContainText("unknown"); await expect(page.getByTestId("pay")).toBeDisabled();
  await page.getByTestId("refresh").click(); await expect(page.getByTestId("received")).toHaveText("10");
  expect(fixture.paymentSubmissions()).toBe(1); expect((await fixture.snapshot()).snapshot.delivery).toEqual({ received: "10", count: "1" });
  await expect(page.getByTestId("hosted-outcome")).toContainText("recorded");
});
test("expired_login_never_replays_action", async (): Promise<void> => {
  await fund(); await fixture.expireLogin(); await page.getByTestId("pay").click();
  await expect(page.getByTestId("error")).toContainText("Sign in"); await expect(page.getByTestId("pay")).toBeDisabled();
  await fixture.renewLogin(); await page.getByTestId("refresh").click(); await expect(page.getByTestId("pay")).toBeEnabled();
  expect(fixture.paymentSubmissions()).toBe(1); expect((await fixture.snapshot()).snapshot.delivery).toEqual({ received: "0", count: "0" });
});
test("transport_retry_still_requires_recorded_reconciliation", async (): Promise<void> => {
  await fund(); fixture.losePaymentConnection(); await page.getByTestId("pay").click();
  await expect(page.getByTestId("hosted-outcome")).toContainText("unknown"); await expect(page.getByTestId("pay")).toBeDisabled();
  await page.getByTestId("refresh").click(); await expect(page.getByTestId("received")).toHaveText("10");
  expect((await fixture.snapshot()).snapshot.delivery).toEqual({ received: "10", count: "1" });
  expect(fixture.paymentSubmissions()).toBeGreaterThanOrEqual(1); expect(fixture.paymentSubmissions()).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("hosted-outcome")).toContainText("recorded");
});
