import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { decodeCall, decodeVault, decodeRecipient } from "../src/receipts.js";

const evidenceDirectory: string = process.env.ACKIVAULT_EVIDENCE_DIR ?? "";
if (evidenceDirectory.length === 0) {
  throw new Error("ACKIVAULT_EVIDENCE_DIR must point to actual stand journey receipts");
}

async function receipt(name: string): Promise<string> {
  return readFile(path.join(evidenceDirectory, `${name}.json`), "utf8");
}

test("real payment receipt exposes cap usage and unchanged state on rejection", async (): Promise<void> => {
  const payment = decodeCall(await receipt("pay"));
  const rejection = decodeCall(await receipt("over-cap"));
  const vault = decodeVault(payment.raw_state);
  assert.equal(payment.statusCode, 0);
  assert.equal(vault.cap, "1000");
  assert.equal(vault.spent, "15");
  assert.equal(vault.remaining, "985");
  assert.equal(vault.revoked, false);
  assert.equal(rejection.statusCode, 1024);
  assert.equal(rejection.raw_state, payment.raw_state);
  assert.equal(rejection.events.length, 0);
});

test("real recipient receipts distinguish payment delivery from owner withdrawal", async (): Promise<void> => {
  const paid = decodeRecipient(decodeCall(await receipt("recipient-after-pay")).raw_state);
  const withdrawn = decodeRecipient(decodeCall(await receipt("recipient-after-withdraw")).raw_state);
  assert.deepEqual(paid, { received: "10", count: "1" });
  assert.deepEqual(withdrawn, { received: "17", count: "2" });
});

test("malformed external receipts fail explicitly", (): void => {
  assert.throws(() => decodeCall('{"status":"ok"}'), /raw_executor_output|raw_state|receipt/);
  assert.throws(() => decodeVault("01"), /473 bytes/);
});
