import { z } from "zod";
import { hostedSnapshotSchema, publicFaultSchema, type HostedAction, type HostedSnapshot, type PublicFault } from "../src/hosted-model.js";
import { statusLabel, type Action, type Activity } from "../src/model.js";
import { element, text, render, showError } from "./render.js";

type Pending = { request: HostedAction; previousIds: readonly string[] };
let current: HostedSnapshot | null = null;
let pending: Pending | null = null;
let changedRun = false;
let locked = true;
let requesting = false;
class ResponseFailure extends Error {
  readonly fault: PublicFault | null;
  constructor(message: string, fault: PublicFault | null) { super(message); this.name = "ResponseFailure"; this.fault = fault; }
}
async function request(url: string, options: RequestInit): Promise<HostedSnapshot> {
  let response: Response;
  try { response = await fetch(url, { ...options, redirect: "error", cache: "no-store" }); }
  catch (error) { if (!(error instanceof Error)) throw error; throw new ResponseFailure("Connection lost. The action result is unknown; refresh the recorded view without repeating it.", null); }
  if (!(response.headers.get("content-type") ?? "").startsWith("application/json")) throw new ResponseFailure("Sign in again, then refresh the recorded view. The action result is unknown; do not repeat it.", null);
  try {
    const value: string = await response.text();
    if (!response.ok) { const fault = z.object({ error: publicFaultSchema }).parse(JSON.parse(value)).error; throw new ResponseFailure(`${fault.message} Reference ${fault.diagnosticId}`, fault); }
    return hostedSnapshotSchema.parse(JSON.parse(value));
  } catch (error) {
    if (error instanceof ResponseFailure) throw error;
    if (!(error instanceof Error)) throw error;
    throw new ResponseFailure("The response could not be verified. The action result is unknown; refresh without repeating it.", null);
  }
}
function disableActions(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) button.disabled = true;
}
function matchesRecorded(view: HostedSnapshot, submitted: Pending): boolean {
  if (view.state !== "ready" || view.fault !== null || view.revision !== submitted.request.revision + 1) return false;
  const action = submitted.request.action;
  if (action.action === "create") return current?.snapshot.vault === null && view.snapshot.vault !== null;
  const method = action.action === "fund" ? "stand.forward_deposit" : `ackivault.${action.action}`;
  const entries = view.snapshot.activity.filter((entry: Activity): boolean => !submitted.previousIds.includes(entry.messageId) && entry.action === method);
  return entries.length === 1 && (action.action !== "pay" && action.action !== "withdraw" || entries[0]!.amount === action.amount);
}
function display(view: HostedSnapshot): void {
  render(view.snapshot);
  element("hosted-session", HTMLElement).hidden = false;
  text("hosted-run", view.runId);
  text("source-label", "Private hosted AVM laboratory · test funds only");
  text("source-detail", "Authenticated local stand. No connected wallet, DEX.DO trade or inference API.");
  text("hosted-state", changedRun ? "Server restarted — reload to begin a fresh test session." : view.state === "ready" ? "Current test session" : `Session ${view.state}`);
  if (locked || requesting || pending !== null || changedRun || view.state !== "ready") disableActions();
}
async function refresh(): Promise<void> {
  if (requesting) return;
  const view = await request("/api/snapshot", { method: "GET" });
  if (current !== null && current.runId !== view.runId) changedRun = true;
  if (!changedRun && pending !== null && matchesRecorded(view, pending)) {
    pending = null; text("hosted-outcome", "A matching outcome is recorded. No action was resent.");
  }
  locked = false;
  current = view; display(view);
  if (pending === null && !changedRun && view.state === "ready") element("error", HTMLElement).hidden = true;
}
async function execute(action: Action): Promise<void> {
  if (current === null || changedRun || pending !== null || locked || requesting || current.state !== "ready") return;
  const submitted: HostedAction = { runId: current.runId, revision: current.revision, action };
  pending = { request: submitted, previousIds: current.snapshot.activity.map((entry: Activity): string => entry.messageId) };
  requesting = true; disableActions(); element("refresh", HTMLButtonElement).disabled = true;
  element("error", HTMLElement).hidden = true; text("hosted-outcome", `Running ${action.action}; waiting for a verified recorded outcome.`);
  try {
    const view = await request("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submitted) });
    if (view.runId !== submitted.runId || view.revision !== submitted.revision + 1) throw new ResponseFailure("Unexpected session response. The result is unknown; refresh without repeating it.", null);
    pending = null; current = view;
    const result = view.snapshot.activity.filter((entry: Activity): boolean => entry.action === `ackivault.${action.action}` || action.action === "fund" && entry.action === "stand.forward_deposit").at(-1);
    text("hosted-outcome", result === undefined ? "Test grant creation recorded." : `Outcome recorded: ${statusLabel(result.statusCode)}.`);
  } catch (error) {
    if (!(error instanceof ResponseFailure)) throw error;
    locked = true;
    // A transport may retry a POST itself; a stale revision can describe its second submission.
    const notStarted = error.fault?.outcome === "not-started" && error.fault.code !== "STALE_REVISION";
    if (notStarted) pending = null;
    if (error.fault?.code === "STALE_RUN") changedRun = true;
    showError(error.message);
    text("hosted-outcome", notStarted ? "This request was not admitted. Sign in if needed, then refresh; nothing will be resent." : "Action result unknown. Do not repeat it. Refresh only the recorded view.");
  } finally {
    requesting = false; element("refresh", HTMLButtonElement).disabled = false;
    if (current !== null) display(current);
  }
}
for (const action of ["create", "fund", "inspect", "revoke"] as const) {
  element(action, HTMLButtonElement).addEventListener("click", (): void => {
    if (action === "revoke" && !window.confirm("Permanently revoke this test grant? This cannot be undone.")) return;
    void execute({ action }).catch(showUnexpected);
  });
}
for (const action of ["pay", "withdraw"] as const) {
  element(`${action}-form`, HTMLFormElement).addEventListener("submit", (event: SubmitEvent): void => {
    event.preventDefault(); void execute({ action, amount: element(`${action}-amount`, HTMLInputElement).value }).catch(showUnexpected);
  });
}
function showUnexpected(error: Error): void {
  locked = true; disableActions();
  showError(error instanceof ResponseFailure ? error.message : "The console response could not be verified. Refresh without repeating an action.");
}
disableActions();
element("refresh", HTMLButtonElement).addEventListener("click", (): void => { void refresh().catch(showUnexpected); });
void refresh().catch(showUnexpected);
