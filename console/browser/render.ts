import { statusLabel, type Snapshot } from "../src/model.js";

export function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.querySelector(`[data-testid="${id}"]`);
  if (!(found instanceof type)) throw new Error(`Required console element is missing: ${id}`);
  return found;
}
export function text(id: string, value: string): void { element(id, HTMLElement).textContent = value; }
function short(value: string): string { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function units(value: string): string { return BigInt(value).toLocaleString("en-US"); }
function time(value: number): string { return new Date(value * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC"); }

export function render(snapshot: Snapshot): void {
  const evidence = snapshot.source.kind === "evidence";
  text("source-label", evidence ? "Saved CI evidence · read-only" : "Live local AVM stand · test funds only");
  text("source-detail", evidence ? `Source ${snapshot.source.commit} · native Linux receipts, not a connected wallet.` : "Isolated test identities. The console has no network endpoint or imported wallet.");
  const link = element("run-link", HTMLAnchorElement);
  link.hidden = snapshot.source.runUrl === null;
  if (snapshot.source.runUrl !== null) link.href = snapshot.source.runUrl;
  text("controls-note", evidence ? "Controls are unavailable in evidence mode. Run the native stand console to exercise a fresh grant." : "All actions run against this local test stand. Revocation is permanent for this grant.");
  const vault = snapshot.vault;
  text("balance", snapshot.balance === null ? "Not captured" : units(snapshot.balance.shells));
  text("balance-detail", snapshot.balance === null ? "No runtime balance sample in these receipts. Not inferred from transfers." : `Sampled at ${time(snapshot.balance.time)}. Protocol fees may apply afterwards.`);
  text("spent", vault === null ? "—" : units(vault.spent)); text("cap", vault === null ? "—" : units(vault.cap));
  text("remaining", vault === null ? "—" : units(vault.remaining)); text("expiry", vault === null ? "—" : time(vault.expiresAt));
  text("vault-address", vault?.address ?? "Not created"); text("owner-key", vault?.owner ?? "—"); text("agent-key", vault?.agent ?? "—");
  const status = element("grant-status", HTMLElement);
  status.textContent = vault === null ? "Not created" : vault.revoked ? "Revoked" : "Expiry-bound grant";
  status.classList.toggle("revoked", vault?.revoked === true);
  element("allowance", HTMLProgressElement).value = vault === null ? 0 : Number(BigInt(vault.spent) * 1000n / BigInt(vault.cap));
  const recipients = element("recipients", HTMLElement);
  recipients.replaceChildren();
  for (const recipient of vault?.recipients ?? []) {
    const row = document.createElement("div"); row.className = "recipient";
    const address = document.createElement("p"); address.textContent = recipient.address;
    const detail = document.createElement("p"); detail.className = "caption"; detail.textContent = `METHOD ${recipient.methodId} · FIXED RESERVE ${recipient.reserve} TEST UNITS`;
    row.append(address, detail); recipients.append(row);
  }
  text("received", units(snapshot.delivery.received)); text("receipt-count", units(snapshot.delivery.count));
  const activity = element("activity", HTMLElement); activity.replaceChildren();
  for (const entry of [...snapshot.activity].reverse()) {
    const row = document.createElement("tr");
    for (const [value, style, detail] of [
      [entry.action, "", `${entry.identity} · ${time(entry.time)}`],
      [entry.amount === null ? "—" : units(entry.amount), "", ""],
      [statusLabel(entry.statusCode), entry.statusCode === 0 ? "accepted" : "rejected", ""],
      [units(entry.fee), "", ""], [short(entry.messageId), "receipt-id", entry.file],
    ]) {
      const cell = document.createElement("td"); cell.className = style!; cell.textContent = value!;
      if (detail !== "") { const note = document.createElement("small"); note.textContent = detail!; cell.append(note); }
      row.append(cell);
    }
    activity.append(row);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) button.disabled = !snapshot.availableActions.some((action: string): boolean => action === button.dataset.action);
  element("pay-amount", HTMLInputElement).disabled = evidence; element("withdraw-amount", HTMLInputElement).disabled = evidence;
  if (snapshot.failure !== null) showError(snapshot.failure);
}

export function showError(message: string): void { const notice = element("error", HTMLElement); notice.hidden = false; notice.textContent = message; }
