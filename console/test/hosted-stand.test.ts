import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LocalStand } from "../src/stand.js";
import { decodeCall, decodeRecipient } from "../src/receipts.js";
import { nativeRecipientSnapshot } from "./receipt-loss.js";
import { delayedPaymentSdk, overflowPaymentSdk, unwritableReceiptSdk } from "./native-faults.js";
import { nativeStandConfig } from "./stand-config.js";
import type { StandConfig } from "../src/stand.js";

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} is required for real native tests`);
  return path.resolve(value);
}
async function config(sdkRoot: string, stateParent: string, maxBytes: number): Promise<StandConfig> {
  const paths = { sdkRoot, stateParent, vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"), receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS") };
  return { ...await nativeStandConfig(paths), execution: { actionDeadlineMs: 2000, terminationGraceMs: 100, maxOutputBytes: 4194304 },
    evidence: { maxBytes, minFreeBytes: 1048576 } };
}

async function parentDirectory(): Promise<string> {
  const parent = required("ACKIVAULT_CONSOLE_STATE");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "hosted-fault-"));
}

test("native_timeout_preserves_partial_evidence_and_blocks_retry", async (): Promise<void> => {
  const sdk = required("ACKIVAULT_SDK_ROOT");
  const faults = await parentDirectory();
  const stand = new LocalStand(await config(await delayedPaymentSdk(sdk, faults), faults, 1073741824));
  const created = await stand.execute({ action: "create" });
  await stand.execute({ action: "fund" });
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), /deadline|timeout/i);
  assert.deepEqual(stand.snapshot().availableActions, []);
  const state = path.join(stand.evidenceDirectory, "developer.state");
  const before = await readFile(state);
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }));
  assert.deepEqual(await readFile(state), before);
  const pid = Number(await readFile(path.join(faults, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const recipient = decodeCall(await nativeRecipientSnapshot(sdk, state, created.vault!.recipients[0]!.address, Math.floor(Date.now() / 1000) + 100));
  assert.deepEqual(decodeRecipient(recipient.raw_state), { received: "10", count: "1" });
  assert.ok((await readdir(stand.evidenceDirectory)).some((name): boolean => name.endsWith(".result.json")));
});

test("evidence_failure_after_execution_cannot_report_success", async (): Promise<void> => {
  const sdk = required("ACKIVAULT_SDK_ROOT");
  const faults = await parentDirectory();
  const stand = new LocalStand(await config(await unwritableReceiptSdk(sdk, faults), faults, 1073741824));
  const created = await stand.execute({ action: "create" });
  await stand.execute({ action: "fund" });
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }));
  assert.deepEqual(stand.snapshot().availableActions, []);
  const state = path.join(stand.evidenceDirectory, "developer.state");
  const before = await readFile(state);
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }));
  assert.deepEqual(await readFile(state), before);
  const recipient = decodeCall(await nativeRecipientSnapshot(sdk, state, created.vault!.recipients[0]!.address, Math.floor(Date.now() / 1000) + 100));
  assert.deepEqual(decodeRecipient(recipient.raw_state), { received: "10", count: "1" });
});

test("output_overflow_halts_without_retry", async (): Promise<void> => {
  const sdk = required("ACKIVAULT_SDK_ROOT");
  const faults = await parentDirectory();
  const stand = new LocalStand(await config(await overflowPaymentSdk(sdk, faults), faults, 1073741824));
  await stand.execute({ action: "create" }); await stand.execute({ action: "fund" });
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }));
  assert.deepEqual(stand.snapshot().availableActions, []);
  const results = (await readdir(stand.evidenceDirectory)).filter((name): boolean => name.endsWith(".result.json"));
  assert.ok(results.length > 0, "termination metadata must survive bounded-output failure");
});

test("capacity_gate_refuses_before_native_work", async (): Promise<void> => {
  const faults = await parentDirectory();
  const stand = new LocalStand(await config(required("ACKIVAULT_SDK_ROOT"), faults, 1));
  await assert.rejects(stand.execute({ action: "create" }), /capacity|storage|evidence/i);
  assert.deepEqual(stand.snapshot().availableActions, []);
  assert.equal((await readdir(stand.evidenceDirectory)).includes("developer.state"), false);
});
