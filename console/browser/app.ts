import { snapshotSchema, statusLabel, type Action, type Snapshot } from "../src/model.js";
import { z } from "zod";
import { element, text, render, showError } from "./render.js";

async function request(url: string, options: RequestInit): Promise<Snapshot> {
  const response = await fetch(url, options);
  const json: string = await response.text();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(JSON.parse(json)).error);
  return snapshotSchema.parse(JSON.parse(json));
}

async function refresh(): Promise<void> { render(await request("/api/snapshot", { method: "GET" })); }

async function execute(action: Action): Promise<void> {
  element("error", HTMLElement).hidden = true;
  text("action-result", `Running ${action.action}… wait for the actual receipt.`);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  try {
    const snapshot = await request("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
    render(snapshot);
    const relevant = snapshot.activity.filter((entry): boolean => entry.action === `ackivault.${action.action}` || (action.action === "fund" && entry.action === "stand.forward_deposit")).at(-1);
    text("action-result", relevant === undefined ? "Local test grant created. Owner inspection recorded." : statusLabel(relevant.statusCode));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    showError(error.message); text("action-result", "Action failed. Review the error and retained receipts before continuing.");
    await refresh();
  } finally { element("refresh", HTMLButtonElement).disabled = false; }
}

for (const action of ["create", "fund", "inspect", "revoke"] as const) {
  element(action, HTMLButtonElement).addEventListener("click", (): void => {
    if (action === "revoke" && !window.confirm("Permanently revoke this local test grant? This cannot be undone.")) return;
    void execute({ action }).catch((error: Error): void => showError(error.message));
  });
}
for (const action of ["pay", "withdraw"] as const) {
  element(`${action}-form`, HTMLFormElement).addEventListener("submit", (event: SubmitEvent): void => {
    event.preventDefault();
    void execute({ action, amount: element(`${action}-amount`, HTMLInputElement).value }).catch((error: Error): void => showError(error.message));
  });
}
element("refresh", HTMLButtonElement).addEventListener("click", (): void => { void refresh().catch((error: Error): void => showError(error.message)); });
void refresh().catch((error: Error): void => showError(error.message));
