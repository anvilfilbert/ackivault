import assert from "node:assert/strict";
import { request, type IncomingMessage } from "node:http";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { z } from "zod";
import { AccessVerifier } from "../src/access.js";
import { createHostedServer } from "../src/hosted-http.js";
import { hostedSnapshotSchema, type HostedSnapshot } from "../src/hosted-model.js";
import { listen } from "../src/http.js";
import { LocalStand } from "../src/stand.js";
import type { Action, Activity } from "../src/model.js";
import { startAccessFixture, testHostedConfig, userClaims } from "./access-fixture.js";
import { closeServer, hostedRequest } from "./hosted-client.js";
import { nativeStandConfig } from "./stand-config.js";
import { decodeCall, decodeRecipient } from "../src/receipts.js";
import { nativeCommand, nativeRecipientSnapshot } from "./receipt-loss.js";
import { expiredGrantSdk } from "./expired-grant.js";

function required(name: string): string {
  const value = process.env[name]; assert.ok(value, `${name} is required for native hosted tests`); return path.resolve(value);
}

test("one_admitted_action_consumes_one_revision and lost_response_does_not_allow_resubmission", async (): Promise<void> => {
  const paths = { sdkRoot: required("ACKIVAULT_SDK_ROOT"), vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"), stateParent: required("ACKIVAULT_CONSOLE_STATE") };
  const stand = new LocalStand({ ...await nativeStandConfig(paths), runId: "native-http-run" });
  const fixture = await startAccessFixture(required("ACKIVAULT_TEST_CA_DIR"));
  const config = testHostedConfig(fixture, paths);
  const server = createHostedServer(stand, config, new AccessVerifier(config.access), "native-http-run");
  const port = await listen(server, 0);
  const token = await fixture.sign(userClaims(fixture), "first");
  let revision = 0;
  async function action(value: Action): Promise<HostedSnapshot> {
    const response = await hostedRequest(port, token, config.origin, "POST", JSON.stringify({ runId: "native-http-run", revision, action: value }));
    assert.equal(response.status, 200, response.text);
    const snapshot = hostedSnapshotSchema.parse(JSON.parse(response.text)); revision = snapshot.revision; return snapshot;
  }
  async function snapshot(): Promise<HostedSnapshot> {
    const response = await hostedRequest(port, token, config.origin, "GET", "");
    assert.equal(response.status, 200, response.text); return hostedSnapshotSchema.parse(JSON.parse(response.text));
  }
  try {
    await action({ action: "create" }); await action({ action: "fund" });
    assert.equal(revision, 2);
    const lostBody = JSON.stringify({ runId: "native-http-run", revision, action: { action: "pay", amount: "10" } });
    await new Promise<void>((resolve, reject): void => {
      const call = request({ host: "127.0.0.1", port, method: "POST", path: "/api/action", headers: {
        host: new URL(config.origin).host, origin: config.origin, "cf-access-jwt-assertion": token, "content-type": "application/json",
      } });
      call.on("error", (error: NodeJS.ErrnoException): void => { if (error.code !== "ECONNRESET") reject(error); });
      server.once("request", (incoming: IncomingMessage): void => { incoming.once("end", (): void => { call.destroy(); resolve(); }); });
      call.end(lostBody);
    });
    let paid = await snapshot();
    const deadline = performance.now() + 10000;
    while (paid.state === "busy" && performance.now() < deadline) { await setTimeout(20); paid = await snapshot(); }
    assert.equal(paid.state, "ready"); assert.equal(paid.revision, 3);
    assert.deepEqual(paid.snapshot.delivery, { received: "10", count: "1" });
    revision = paid.revision;
    const state = path.join(stand.evidenceDirectory, "developer.state");
    const beforeReplay = await readFile(state);
    assert.equal((await hostedRequest(port, token, config.origin, "POST", lostBody)).status, 409);
    assert.deepEqual(await readFile(state), beforeReplay);
    const rejected = await action({ action: "pay", amount: "986" });
    assert.equal(rejected.snapshot.vault!.spent, "15");
    assert.ok(rejected.snapshot.activity.some((entry: Activity): boolean => entry.statusCode === 1024));
    await action({ action: "revoke" }); await action({ action: "pay", amount: "1" });
    const final = await action({ action: "withdraw", amount: "7" });
    assert.deepEqual(final.snapshot.delivery, { received: "17", count: "2" });
    assert.equal(final.snapshot.vault!.revoked, true);
    assert.ok(final.snapshot.activity.some((entry: Activity): boolean => entry.statusCode === 1018));
    const verified = decodeCall(await nativeRecipientSnapshot(paths.sdkRoot, state, final.snapshot.vault!.recipients[0]!.address, Math.floor(Date.now() / 1000) + 100));
    assert.deepEqual(decodeRecipient(verified.raw_state), { received: "17", count: "2" });
    const args = ["--state", state, "--wasmtime-profile", path.join(paths.sdkRoot, "profiles/wasmtime-release-profile.v1")];
    const inspected = await nativeCommand(paths.sdkRoot, ["inspect", ...args]);
    const replayed = await nativeCommand(paths.sdkRoot, ["replay", ...args]);
    assert.equal(inspected.code, 0); assert.equal(replayed.code, 0);
    const journal = z.object({ status: z.literal("ok"), account_state_root: z.string().regex(/^[0-9a-f]{64}$/),
      registry_root: z.string().regex(/^[0-9a-f]{64}$/), cumulative_fee_shells: z.string().regex(/^[0-9]+$/), accepted_input_count: z.number().int().positive() });
    assert.deepEqual(journal.parse(JSON.parse(replayed.stdout)), journal.parse(JSON.parse(inspected.stdout)));
  } finally { await stand.shutdown(); await closeServer(server); await fixture.close(); }
});

test("an expired grant rejects hosted payment without spending allowance or delivering value", async (): Promise<void> => {
  const parent = required("ACKIVAULT_CONSOLE_STATE"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "hosted-expiry-"));
  const paths = { sdkRoot: await expiredGrantSdk(required("ACKIVAULT_SDK_ROOT"), directory), vaultArtifacts: required("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: required("ACKIVAULT_RECEIPT_ARTIFACTS"), stateParent: directory };
  const stand = new LocalStand({ ...await nativeStandConfig(paths), runId: "expired-native-run" });
  const fixture = await startAccessFixture(required("ACKIVAULT_TEST_CA_DIR"));
  const config = testHostedConfig(fixture, paths);
  const server = createHostedServer(stand, config, new AccessVerifier(config.access), "expired-native-run");
  const port = await listen(server, 0); const token = await fixture.sign(userClaims(fixture), "first");
  try {
    let revision = 0;
    for (const action of [{ action: "create" }, { action: "fund" }, { action: "pay", amount: "10" }] as const) {
      const response = await hostedRequest(port, token, config.origin, "POST", JSON.stringify({ runId: "expired-native-run", revision, action }));
      assert.equal(response.status, 200, response.text);
      const snapshot = hostedSnapshotSchema.parse(JSON.parse(response.text)); revision = snapshot.revision;
      if (action.action === "fund") {
        // Isolate expiry from the separate storage-rent precheck after a two-hour clock advance.
        const gas = await nativeCommand(required("ACKIVAULT_SDK_ROOT"), ["fund-user", "--state", path.join(stand.evidenceDirectory, "developer.state"),
          "--wasmtime-profile", path.join(paths.sdkRoot, "profiles/wasmtime-release-profile.v1"), "--address", snapshot.snapshot.vault!.address, "--shells", "1000000000"]);
        assert.equal(gas.code, 0, gas.stderr);
        await writeFile(path.join(directory, "expiry-gas-topup.json"), gas.stdout, { flag: "wx", mode: 0o600 });
      }
      if (action.action === "pay") {
        assert.equal(snapshot.snapshot.vault!.spent, "0");
        assert.ok(snapshot.snapshot.activity.some((entry: Activity): boolean => entry.action === "ackivault.pay" && entry.statusCode === 1017));
        assert.deepEqual(snapshot.snapshot.delivery, { received: "0", count: "0" });
      }
    }
  } finally { await stand.shutdown(); await closeServer(server); await fixture.close(); }
});
