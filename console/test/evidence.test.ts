import assert from "node:assert/strict";
import test from "node:test";
import { loadEvidence } from "../src/evidence-data.js";
import { createEvidenceServer, listen } from "../src/http.js";

test("saved native evidence has recipient delivery but no inferred balance or mutable routes", async (): Promise<void> => {
  const directory: string = process.env.ACKIVAULT_EVIDENCE_DIR ?? "";
  assert.notEqual(directory, "", "ACKIVAULT_EVIDENCE_DIR must identify actual CI receipts");
  const snapshot = await loadEvidence(directory, "3c48efcfb940b67bdbab12341e39d270359e0d3c", "https://github.com/anvilfilbert/ackivault/actions/runs/38255694080");
  assert.equal(snapshot.source.kind, "evidence");
  assert.equal(snapshot.vault?.spent, "15");
  assert.equal(snapshot.vault?.revoked, true);
  assert.deepEqual(snapshot.delivery, { received: "17", count: "2" });
  assert.equal(snapshot.balance, null);
  assert.deepEqual(snapshot.availableActions, []);
  const server = createEvidenceServer(snapshot);
  const port = await listen(server, 0);
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 200);
    assert.equal((await fetch(`${origin}/api/action`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"action":"fund"}' })).status, 404);
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/app.js`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); });
  }
});
