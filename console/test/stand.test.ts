import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LocalStand } from "../src/stand.js";
import { createLiveServer, listen } from "../src/http.js";
import { RequestError, snapshotSchema } from "../src/model.js";
import { decodeCall, decodeRecipient, decodeVault, verifyFunding } from "../src/receipts.js";
import { hostStatus } from "./http-request.js";
import { nativeRecipientSnapshot, receiptLossSdk } from "./receipt-loss.js";

function required(name: string): string {
  const value: string = process.env[name] ?? "";
  assert.notEqual(value, "", `${name} must identify the actual native stand input`);
  return path.resolve(value);
}

test("a real executed payment with a lost receipt halts the console without repeating the transfer", async (): Promise<void> => {
  const sdkRoot = required("ACKIVAULT_SDK_ROOT");
  const stateParent = required("ACKIVAULT_CONSOLE_STATE");
  await mkdir(stateParent, { recursive: true });
  const faults = await mkdtemp(path.join(stateParent, "receipt-loss-"));
  const stand = new LocalStand({
    sdkRoot: await receiptLossSdk(sdkRoot, faults),
    vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"),
    stateParent,
  });
  const created = await stand.execute({ action: "create" });
  const receiver = created.vault!.recipients[0]!.address;
  await stand.execute({ action: "fund" });
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), SyntaxError);
  assert.deepEqual(stand.snapshot().availableActions, []);
  assert.notEqual(stand.snapshot().failure, null);
  const payment = decodeCall(await readFile(path.join(faults, "executed-payment.json"), "utf8"));
  assert.equal(payment.statusCode, 0);
  assert.equal(decodeVault(payment.raw_state).spent, "15");
  const stateFile = path.join(stand.evidenceDirectory, "developer.state");
  const beforeRetry = await readFile(stateFile);
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), (error: Error): boolean => error instanceof RequestError && error.status === 409);
  assert.deepEqual(await readFile(stateFile), beforeRetry);
  // Query actual recipient state with the original binary, not the fault proxy or UI.
  const time = Math.max(Math.floor(Date.now() / 1000), ...stand.snapshot().activity.map((entry): number => entry.time)) + 100;
  const recipientReceipt = await nativeRecipientSnapshot(sdkRoot, stateFile, receiver, time);
  await writeFile(path.join(faults, "verified-recipient.json"), recipientReceipt, { flag: "wx", mode: 0o600 });
  const delivered = decodeCall(recipientReceipt);
  assert.equal(delivered.statusCode, 0);
  assert.deepEqual(decodeRecipient(delivered.raw_state), { received: "10", count: "1" });
});

test("native console transfers, enforces its grant and rejects unsafe requests", async (): Promise<void> => {
  const stand = new LocalStand({
    sdkRoot: required("ACKIVAULT_SDK_ROOT"),
    vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"),
    stateParent: required("ACKIVAULT_CONSOLE_STATE"),
  });
  const server = createLiveServer(stand);
  const port = await listen(server, 0);
  const origin = `http://127.0.0.1:${port}`;
  async function action(body: string, requestOrigin: string): Promise<Response> {
    return fetch(`${origin}/api/action`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body });
  }
  try {
    assert.equal((await action('{"action":"create"}', "https://untrusted.invalid")).status, 403);
    assert.equal((await action('{"action":"pay","amount":"-1"}', origin)).status, 400);
    assert.equal((await action("x".repeat(4097), origin)).status, 413);
    assert.equal((await action("{", origin)).status, 400);
    const creation = action('{"action":"create"}', origin);
    assert.equal((await action('{"action":"create"}', origin)).status, 409);
    const created = await creation;
    assert.equal(created.status, 200, await created.clone().text());
    const funding = await action('{"action":"fund"}', origin);
    assert.equal(funding.status, 200, await funding.clone().text());
    const funded = snapshotSchema.parse(await funding.json());
    assert.notEqual(funded.vault, null);
    assert.equal(funded.failure, null);
    const fundingActivity = funded.activity.find((entry): boolean => entry.action === "stand.forward_deposit");
    assert.notEqual(fundingActivity, undefined);
    verifyFunding(decodeCall(await readFile(path.join(stand.evidenceDirectory, fundingActivity!.file), "utf8")), funded.vault!.address);
    const payment = await action('{"action":"pay","amount":"10"}', origin);
    assert.equal(payment.status, 200, await payment.clone().text());
    const paid = snapshotSchema.parse(await (await fetch(`${origin}/api/snapshot`)).json());
    assert.equal(paid.vault?.spent, "15");
    assert.equal(paid.delivery.received, "10");
    assert.equal(paid.delivery.count, "1");
    assert.notEqual(paid.balance?.shells, null);
    const rejection = await action('{"action":"pay","amount":"986"}', origin);
    assert.equal(rejection.status, 200);
    const rejected = snapshotSchema.parse(await rejection.json());
    assert.equal(rejected.activity.at(-2)?.statusCode, 1024);
    assert.equal(rejected.vault?.spent, "15");
    for (const body of ['{"action":"revoke"}', '{"action":"pay","amount":"1"}', '{"action":"withdraw","amount":"7"}']) {
      const response = await action(body, origin);
      assert.equal(response.status, 200, await response.clone().text());
    }
    const final = snapshotSchema.parse(await (await fetch(`${origin}/api/snapshot`)).json());
    assert.equal(final.vault?.revoked, true);
    assert.equal(final.vault?.spent, "15");
    assert.equal(final.delivery.received, "17");
    assert.equal(final.delivery.count, "2");
    assert.equal(final.activity.some((entry): boolean => entry.statusCode === 1018), true);
    assert.equal((await action('{"action":"create"}', origin)).status, 409);
    assert.equal(await hostStatus(`${origin}/api/snapshot`, "untrusted.invalid"), 403);
    console.log(JSON.stringify({ event: "native_console_verified", directory: stand.evidenceDirectory }));
  } finally {
    await new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); });
  }
});
