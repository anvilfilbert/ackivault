import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LocalStand } from "../src/stand.js";
import { createLiveServer, listen } from "../src/http.js";
import { RequestError, snapshotSchema } from "../src/model.js";
import { decodeCall, decodeInspection, decodeRecipient, decodeVault, ReceiptError, verifyFunding } from "../src/receipts.js";
import { hostStatus } from "./http-request.js";
import { nativeCommand, nativeRecipientSnapshot, receiptLossSdk } from "./receipt-loss.js";
import { zeroReserveSdk } from "./zero-reserve.js";
import { nativeExecutionCount, rejectedDeliverySdk } from "./rejected-delivery.js";
import { decodeOutput } from "../src/acmo.js";
import { nativeStandConfig } from "./stand-config.js";
import { z } from "zod";

function required(name: string): string {
  const value: string = process.env[name] ?? "";
  assert.notEqual(value, "", `${name} must identify the actual native stand input`);
  return path.resolve(value);
}

test("an internally rejected recipient cannot restore allowance or be reported as delivery", async (): Promise<void> => {
  const sdkRoot = required("ACKIVAULT_SDK_ROOT");
  const stateParent = required("ACKIVAULT_CONSOLE_STATE");
  await mkdir(stateParent, { recursive: true });
  const faults = await mkdtemp(path.join(stateParent, "rejected-delivery-"));
  const stand = new LocalStand(await nativeStandConfig({
    sdkRoot: await rejectedDeliverySdk(sdkRoot, faults),
    vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"),
    stateParent,
  }));
  const created = await stand.execute({ action: "create" });
  assert.equal(created.vault!.recipients[0]!.methodId, String(0x7a9236e99b7ae9ddn));
  const receiver = created.vault!.recipients[0]!.address;
  const funded = await stand.execute({ action: "fund" });
  const lastInspection = funded.activity.at(-1)!;
  assert.equal(lastInspection.action, "ackivault.inspect");
  await writeFile(path.join(faults, "before-vault.json"), await readFile(path.join(stand.evidenceDirectory, lastInspection.file)), { flag: "wx", mode: 0o600 });
  const stateFile = path.join(stand.evidenceDirectory, "developer.state");
  const executionsBefore = await nativeExecutionCount(sdkRoot, stateFile);
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), (error: Error): boolean => error instanceof ReceiptError && error.message.startsWith("Delivery mismatch:"));
  const executionsAfter = await nativeExecutionCount(sdkRoot, stateFile);
  await writeFile(path.join(faults, "execution-counts.json"), JSON.stringify({ before: executionsBefore, after: executionsAfter }), { flag: "wx", mode: 0o600 });
  assert.equal(executionsAfter - executionsBefore, 3, "payment, internal recipient and console snapshot must each execute");
  const halted = stand.snapshot();
  assert.deepEqual(halted.availableActions, []);
  assert.notEqual(halted.failure, null);
  assert.deepEqual(halted.delivery, { received: "0", count: "0" });
  const rawPayment = await readFile(path.join(faults, "dispatched-payment.json"), "utf8");
  const payment = decodeCall(rawPayment);
  assert.equal(payment.statusCode, 0);
  assert.equal(decodeOutput(Buffer.from(payment.raw_executor_output, "hex")).outboundCount, 1, "the payment must actually emit an outbound");
  assert.equal(decodeVault(payment.raw_state).spent, "15");
  assert.equal(payment.events.length, 1, "dispatch alone must not imply recipient acceptance");
  const queue = z.object({ queue: z.object({ after: z.number().int().nonnegative() }) }).parse(JSON.parse(rawPayment)).queue;
  assert.equal(queue.after, 0, "the stand must drain the failed delivery before reconciliation");
  const beforeRetry = await readFile(stateFile);
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), (error: Error): boolean => error instanceof RequestError && error.status === 409);
  assert.deepEqual(await readFile(stateFile), beforeRetry);
  const time = Math.max(Math.floor(Date.now() / 1000), ...halted.activity.map((entry): number => entry.time)) + 100;
  const verified = await nativeCommand(sdkRoot, ["call", "--state", stateFile,
    "--wasmtime-profile", path.join(sdkRoot, "profiles/wasmtime-release-profile.v1"),
    "--address", halted.vault!.address, "--method", "ackivault.inspect", "--args-json", "null", "--identity", "package-owner",
    "--value-main", "0", "--extra-currencies", "", "--block-time", String(time), "--created-at", String(time),
    "--expire-at", String(time + 3600), "--fuel-fee-shells", "1000"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  await writeFile(path.join(faults, "verified-vault.json"), verified.stdout, { flag: "wx", mode: 0o600 });
  const inspected = decodeCall(verified.stdout);
  assert.equal(inspected.statusCode, 0);
  const actual = decodeVault(inspected.raw_state);
  const dispatched = decodeVault(payment.raw_state);
  assert.deepEqual(actual, { ...dispatched, ownerNonce: actual.ownerNonce });
  const recipient = await nativeRecipientSnapshot(sdkRoot, stateFile, receiver, time + 1);
  await writeFile(path.join(faults, "verified-recipient.json"), recipient, { flag: "wx", mode: 0o600 });
  const delivered = decodeCall(recipient);
  assert.equal(delivered.statusCode, 0);
  assert.deepEqual(decodeRecipient(delivered.raw_state), { received: "0", count: "0" });
  console.log(JSON.stringify({ event: "rejected_delivery_accounting", balanceBeforeInspection: funded.balance!.shells,
    beforeInspectionFee: lastInspection.fee, paymentFee: payment.receipt.charged_shells,
    balanceAfterPayment: decodeInspection(inspected.raw_executor_output), spent: actual.spent }));
});

test("a zero-budget native payment cannot alter a previously spent grant or silently retry", async (): Promise<void> => {
  const sdkRoot = required("ACKIVAULT_SDK_ROOT");
  const stateParent = required("ACKIVAULT_CONSOLE_STATE");
  await mkdir(stateParent, { recursive: true });
  const faults = await mkdtemp(path.join(stateParent, "zero-reserve-"));
  const stand = new LocalStand(await nativeStandConfig({
    sdkRoot: await zeroReserveSdk(sdkRoot, faults),
    vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"),
    stateParent,
  }));
  const created = await stand.execute({ action: "create" });
  const receiver = created.vault!.recipients[0]!.address;
  await stand.execute({ action: "fund" });
  const paid = await stand.execute({ action: "pay", amount: "10" });
  assert.equal(paid.vault!.spent, "15");
  assert.deepEqual(paid.delivery, { received: "10", count: "1" });
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), /RouteRequiresFee/);
  assert.deepEqual(stand.snapshot().availableActions, []);
  assert.notEqual(stand.snapshot().failure, null);
  const stateFile = path.join(stand.evidenceDirectory, "developer.state");
  const beforeRetry = await readFile(stateFile);
  await assert.rejects(stand.execute({ action: "pay", amount: "10" }), (error: Error): boolean => error instanceof RequestError && error.status === 409);
  assert.deepEqual(await readFile(stateFile), beforeRetry);
  const time = Math.max(Math.floor(Date.now() / 1000), ...stand.snapshot().activity.map((entry): number => entry.time)) + 100;
  const verified = await nativeCommand(sdkRoot, ["call", "--state", stateFile,
    "--wasmtime-profile", path.join(sdkRoot, "profiles/wasmtime-release-profile.v1"),
    "--address", paid.vault!.address, "--method", "ackivault.inspect", "--args-json", "null", "--identity", "package-owner",
    "--value-main", "0", "--extra-currencies", "", "--block-time", String(time), "--created-at", String(time),
    "--expire-at", String(time + 3600), "--fuel-fee-shells", "1000"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  await writeFile(path.join(faults, "verified-vault.json"), verified.stdout, { flag: "wx", mode: 0o600 });
  const inspected = decodeCall(verified.stdout);
  assert.equal(inspected.statusCode, 0);
  const actual = decodeVault(inspected.raw_state);
  // Independent inspection advances only its owner nonce, not the agent's authority or spend.
  const { address: _address, ...expected } = paid.vault!;
  assert.deepEqual(actual, { ...expected, ownerNonce: actual.ownerNonce });
  const recipient = await nativeRecipientSnapshot(sdkRoot, stateFile, receiver, time + 1);
  await writeFile(path.join(faults, "verified-recipient.json"), recipient, { flag: "wx", mode: 0o600 });
  const delivered = decodeCall(recipient);
  assert.equal(delivered.statusCode, 0);
  assert.deepEqual(decodeRecipient(delivered.raw_state), { received: "10", count: "1" });
});

test("a real executed payment with a lost receipt halts the console without repeating the transfer", async (): Promise<void> => {
  const sdkRoot = required("ACKIVAULT_SDK_ROOT");
  const stateParent = required("ACKIVAULT_CONSOLE_STATE");
  await mkdir(stateParent, { recursive: true });
  const faults = await mkdtemp(path.join(stateParent, "receipt-loss-"));
  const stand = new LocalStand(await nativeStandConfig({
    sdkRoot: await receiptLossSdk(sdkRoot, faults),
    vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"),
    stateParent,
  }));
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
  const stand = new LocalStand(await nativeStandConfig({
    sdkRoot: required("ACKIVAULT_SDK_ROOT"),
    vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"),
    stateParent: required("ACKIVAULT_CONSOLE_STATE"),
  }));
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
    const stateFile = path.join(stand.evidenceDirectory, "developer.state");
    const journal = z.object({
      status: z.literal("ok"),
      account_state_root: z.string().regex(/^[0-9a-f]{64}$/),
      registry_root: z.string().regex(/^[0-9a-f]{64}$/),
      cumulative_fee_shells: z.string().regex(/^[0-9]+$/),
      accepted_input_count: z.number().int().positive(),
    });
    const sdkRoot = required("ACKIVAULT_SDK_ROOT");
    const profile = path.join(sdkRoot, "profiles/wasmtime-release-profile.v1");
    const inspection = await nativeCommand(sdkRoot, ["inspect", "--state", stateFile, "--wasmtime-profile", profile]);
    assert.equal(inspection.code, 0, inspection.stdout + inspection.stderr);
    const replay = await nativeCommand(sdkRoot, ["replay", "--state", stateFile, "--wasmtime-profile", profile]);
    assert.equal(replay.code, 0, replay.stdout + replay.stderr);
    await writeFile(path.join(stand.evidenceDirectory, "console-inspect.json"), inspection.stdout, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(stand.evidenceDirectory, "console-replay.json"), replay.stdout, { flag: "wx", mode: 0o600 });
    assert.deepEqual(journal.parse(JSON.parse(replay.stdout)), journal.parse(JSON.parse(inspection.stdout)),
      "the HTTP-driven journey must replay the same populated account/registry roots, fees and accepted inputs");
    assert.equal((await action('{"action":"create"}', origin)).status, 409);
    assert.equal(await hostStatus(`${origin}/api/snapshot`, "untrusted.invalid"), 403);
    console.log(JSON.stringify({ event: "native_console_verified", directory: stand.evidenceDirectory }));
  } finally {
    await new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); });
  }
});
