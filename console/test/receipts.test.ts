import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { addressSchema, decodeCall, decodeVault, decodeRecipient, ReceiptError, verifyFunding } from "../src/receipts.js";
import * as receipts from "../src/receipts.js";

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

test("real funding receipt confirms 100 units accepted by the expected vault", async (): Promise<void> => {
  const funding = decodeCall(await receipt("deposit"));
  const deployment: { address: string } = JSON.parse(await receipt("main-funding-required"));
  assert.doesNotThrow(() => verifyFunding(funding, addressSchema.parse(deployment.address)));
});

test("sender success cannot confirm missing, mismatched or malformed vault acceptance", async (): Promise<void> => {
  const funding = decodeCall(await receipt("deposit"));
  const deployment: { address: string } = JSON.parse(await receipt("main-funding-required"));
  const recipient: { address: string } = JSON.parse(await receipt("receiver-funding-required"));
  const vault = addressSchema.parse(deployment.address);
  const event = funding.events[0]!;
  const cases: { name: string; events: string[]; vault: string }[] = [
    { name: "missing acceptance", events: [], vault },
    { name: "duplicate acceptance", events: [event, event], vault },
    { name: "another event class", events: [event.replace("6face8a8a6cdeb2a", "c3841027b8f21b57")], vault },
    { name: "another vault", events: [event], vault: addressSchema.parse(recipient.address) },
    { name: "101 instead of 100 units", events: [`${event.slice(0, -16)}6500000000000000`], vault },
    { name: "truncated acceptance", events: [event.slice(0, -2)], vault },
    { name: "trailing bytes", events: [`${event}00`], vault },
    { name: "incorrect source pointer", events: [event.replace("1500000002010000", "1900000002010000")], vault },
  ];
  for (const entry of cases) {
    assert.throws(() => verifyFunding({ ...funding, events: entry.events }, entry.vault), ReceiptError, entry.name);
  }
});

test("malformed external receipts fail explicitly", (): void => {
  assert.throws(() => decodeCall('{"status":"ok"}'), /raw_executor_output|raw_state|receipt/);
  assert.throws(() => decodeVault("01"), /473 bytes/);
});

test("an accepted header alone is not a complete executor receipt", async (): Promise<void> => {
  const payment: { raw_executor_output: string } = JSON.parse(await receipt("pay"));
  assert.throws(() => decodeCall(JSON.stringify({ ...payment, raw_executor_output: "41434d4f0000000000" })), /ACMO|Truncated/);
  assert.throws(() => decodeCall(JSON.stringify({ ...payment, raw_executor_output: `${payment.raw_executor_output}00` })), /trailing/);
});

test("delivery requires the exact amount and one new recipient receipt", async (): Promise<void> => {
  const paid = decodeRecipient(decodeCall(await receipt("recipient-after-pay")).raw_state);
  const withdrawn = decodeRecipient(decodeCall(await receipt("recipient-after-withdraw")).raw_state);
  assert.deepEqual(receipts.verifyDelivery(paid, withdrawn, "7"), { received: "17", count: "2" });
  assert.throws(() => receipts.verifyDelivery(paid, paid, "7"), /delivery.*expected|Delivery.*expected/);
});

test("a zero expiry cannot be presented as a canonical vault", async (): Promise<void> => {
  const payment = decodeCall(await receipt("pay"));
  const corrupted = Buffer.from(payment.raw_state, "hex");
  corrupted.fill(0, 65, 69);
  assert.throws(() => decodeVault(corrupted.toString("hex")), /expiry|invariants/);
});
