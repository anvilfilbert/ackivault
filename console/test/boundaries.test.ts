import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { decodeOutput, FrameError } from "../src/acmo.js";
import { decodeCall, ReceiptError } from "../src/receipts.js";
import { LocalStand } from "../src/stand.js";
import { createLiveServer, listen } from "../src/http.js";
import { hostStatus } from "./http-request.js";
import { unstartedStandConfig } from "./stand-config.js";

const evidenceDirectory: string = process.env.ACKIVAULT_EVIDENCE_DIR ?? "";
if (evidenceDirectory.length === 0) throw new Error("ACKIVAULT_EVIDENCE_DIR must point to native stand receipts");

test("every single-byte header corruption rejects real success and rejection receipts", async (): Promise<void> => {
  for (const name of ["pay", "over-cap"]) {
    const call = decodeCall(await readFile(path.join(evidenceDirectory, `${name}.json`), "utf8"));
    const frame = Buffer.from(call.raw_executor_output, "hex");
    assert.equal(frame.subarray(0, 4).toString("hex"), "41434d4f");
    for (let offset = 0; offset < 4; offset++) {
      for (let byte = 0; byte <= 255; byte++) {
        if (byte === frame[offset]) continue;
        const corrupted = Buffer.from(frame);
        corrupted[offset] = byte;
        assert.throws(
          () => decodeCall(JSON.stringify({ ...call, raw_executor_output: corrupted.toString("hex") })),
          FrameError,
          `${name}: header byte ${offset} replaced by ${byte}`,
        );
      }
    }
  }
});

test("every truncated real frame and appended byte is rejected, not accepted as success", async (): Promise<void> => {
  for (const name of ["pay", "over-cap", "revoke", "withdraw", "revoked-pay", "recipient-after-withdraw"]) {
    const call = decodeCall(await readFile(path.join(evidenceDirectory, `${name}.json`), "utf8"));
    const frame = Buffer.from(call.raw_executor_output, "hex");
    for (let length = 0; length < frame.length; length++) {
      assert.throws(() => decodeOutput(frame.subarray(0, length)), FrameError, `${name}: prefix ${length}`);
    }
    for (let byte = 0; byte <= 255; byte++) {
      assert.throws(() => decodeOutput(Buffer.concat([frame, Buffer.from([byte])])), FrameError, `${name}: trailing ${byte}`);
    }
  }
});

test("receipt state mismatch and rejected-call events cannot masquerade as accepted evidence", async (): Promise<void> => {
  const payment = decodeCall(await readFile(path.join(evidenceDirectory, "pay.json"), "utf8"));
  const rejection = decodeCall(await readFile(path.join(evidenceDirectory, "over-cap.json"), "utf8"));
  assert.throws(() => decodeCall(JSON.stringify({ ...payment, raw_state: "00" })), ReceiptError);
  assert.throws(() => decodeCall(JSON.stringify({ ...rejection, events: ["00"] })), ReceiptError);
  for (const offset of [9, 13, 490]) {
    const frame = Buffer.from(payment.raw_executor_output, "hex");
    // Corrupt the state mode, state length or returned-body length, respectively.
    frame.writeUInt32LE(0xffffffff, offset);
    assert.throws(() => decodeOutput(frame), FrameError);
  }
});

test("unsafe HTTP requests are rejected before starting a real local connector", async (): Promise<void> => {
  // No fake connector: these requests must be rejected before any filesystem/stand work.
  const unused = path.join(evidenceDirectory, "runtime-must-not-be-invoked");
  const stand = new LocalStand(unstartedStandConfig({ sdkRoot: unused, vaultArtifacts: unused, receiptArtifacts: unused, stateParent: unused }));
  const server = createLiveServer(stand);
  const port = await listen(server, 0);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { origin, "content-type": "application/json" };
  const cases: { name: string; headers: Record<string, string>; body: string; status: number }[] = [
    { name: "foreign origin", headers: { ...headers, origin: "https://untrusted.invalid" }, body: '{"action":"create"}', status: 403 },
    { name: "missing origin", headers: { "content-type": "application/json" }, body: '{"action":"create"}', status: 403 },
    { name: "opaque origin", headers: { ...headers, origin: "null" }, body: '{"action":"create"}', status: 403 },
    { name: "non-JSON type", headers: { ...headers, "content-type": "text/plain" }, body: '{"action":"create"}', status: 415 },
    { name: "malformed JSON", headers, body: "{", status: 400 },
    { name: "oversized body", headers, body: "x".repeat(4097), status: 413 },
    { name: "negative amount", headers, body: '{"action":"pay","amount":"-1"}', status: 400 },
    { name: "zero amount", headers, body: '{"action":"pay","amount":"0"}', status: 400 },
    { name: "u128 overflow", headers, body: JSON.stringify({ action: "pay", amount: (1n << 128n).toString() }), status: 400 },
    { name: "destination injection", headers, body: '{"action":"pay","amount":"1","destination":"other"}', status: 400 },
    { name: "unknown action", headers, body: '{"action":"exec"}', status: 400 },
  ];
  try {
    for (const entry of cases) {
      const response = await fetch(`${origin}/api/action`, { method: "POST", headers: entry.headers, body: entry.body });
      await response.text();
      assert.equal(response.status, entry.status, entry.name);
    }
    assert.equal(await hostStatus(`${origin}/api/snapshot`, "untrusted.invalid"), 403);
    const response = await fetch(`${origin}/api/snapshot`);
    await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(stand.evidenceDirectory, "");
    assert.equal(stand.snapshot().failure, null);
    assert.deepEqual(stand.snapshot().availableActions, ["create"]);
  } finally {
    await new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); });
  }
});
