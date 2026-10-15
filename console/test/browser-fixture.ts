import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import { AccessVerifier } from "../src/access.js";
import { createHostedServer } from "../src/hosted-http.js";
import { hostedSnapshotSchema, type HostedSnapshot } from "../src/hosted-model.js";
import { listen } from "../src/http.js";
import { LocalStand } from "../src/stand.js";
import { startAccessFixture, testHostedConfig, userClaims } from "./access-fixture.js";
import { closeServer, hostedRequest } from "./hosted-client.js";
import { nativeStandConfig } from "./stand-config.js";

export function browserInput(name: string): string {
  const value = process.env[name]; assert.ok(value, `${name} is required for real browser tests`); return path.resolve(value);
}
export async function testCertificatePin(): Promise<string> {
  const cert = new X509Certificate(await readFile(path.join(browserInput("ACKIVAULT_TEST_CA_DIR"), "ca.pem")));
  return createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
}
export type BrowserFixture = {
  origin: string; snapshot: () => Promise<HostedSnapshot>; restart: () => Promise<void>;
  expireLogin: () => Promise<void>; renewLogin: () => Promise<void>; losePaymentResponse: () => void; losePaymentConnection: () => void;
  paymentSubmissions: () => number; stateFile: () => string; close: () => Promise<void>;
  expireOnPaymentRetry: () => void; challengePayment: () => void; disconnectBeforeAdmission: () => void; restoreTransport: () => void;
};

/** Real HTTPS edge protocol fixture, not Cloudflare/MFA evidence; all receipts come from the native stand. */
export async function startBrowserFixture(): Promise<BrowserFixture> {
  const ca = browserInput("ACKIVAULT_TEST_CA_DIR");
  const access = await startAccessFixture(ca);
  let token = await access.sign(userClaims(access), "first");
  let backend: Server | null = null;
  let stand: LocalStand | null = null;
  let port = 0;
  let submissions = 0;
  let lose = false;
  let loseConnection = false;
  let expireOnRetry = false;
  let challenge = false;
  let disconnected = false;
  const edge = createServer({ key: await readFile(path.join(ca, "server.key")), cert: await readFile(access.caFile) }, (incoming, outgoing): void => {
    async function forward(): Promise<void> {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body = Buffer.concat(chunks);
      const payment = incoming.method === "POST" && body.toString("utf8").includes('"action":"pay"');
      if (payment) submissions++;
      if (payment && challenge) { challenge = false; outgoing.writeHead(200, { "content-type": "text/html" }); outgoing.end("<!doctype html><title>Test login challenge</title>"); return; }
      if (payment && disconnected) { outgoing.destroy(); return; }
      const drop = payment && lose; if (drop) lose = false;
      const disconnect = payment && loseConnection; if (disconnect) loseConnection = false;
      const retryWithExpiredIdentity = payment && expireOnRetry; if (retryWithExpiredIdentity) expireOnRetry = false;
      await new Promise<void>((resolve, reject): void => {
        const call = request({ hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method,
          headers: { host: incoming.headers.host!, "cf-access-jwt-assertion": token,
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
            ...(incoming.headers["content-type"] === undefined ? {} : { "content-type": incoming.headers["content-type"] }) } }, (result): void => {
          result.on("error", reject);
          if (retryWithExpiredIdentity) {
            // A real edge retry hides the first successful response behind a real authentication denial.
            result.resume(); result.on("end", (): void => {
              async function retry(): Promise<void> {
                token = await access.sign({ ...userClaims(access), exp: Math.floor(Date.now() / 1000) - 1 }, "first");
                const denied = await hostedRequest(port, token, `https://${incoming.headers.host}`, "POST", body.toString("utf8"));
                assert.equal(denied.status, 403); outgoing.writeHead(denied.status, { "content-type": "application/json" }); outgoing.end(denied.text);
              }
              void retry().then(resolve, reject);
            });
            return;
          }
          if (drop || disconnect) { result.resume(); result.on("end", (): void => {
            if (drop) { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.write('{"'); }
            setImmediate((): void => { outgoing.destroy(); resolve(); });
          }); }
          else { outgoing.writeHead(result.statusCode!, result.headers); result.pipe(outgoing); result.on("end", resolve); }
        });
        call.on("error", reject); call.end(body);
      });
    }
    void forward().catch((error: Error): void => { outgoing.destroy(error); });
  });
  await new Promise<void>((resolve, reject): void => { edge.once("error", reject); edge.listen(0, "127.0.0.1", resolve); });
  const address = edge.address(); assert.ok(address !== null && typeof address !== "string");
  const origin = `https://127.0.0.1:${address.port}`;
  const parent = browserInput("ACKIVAULT_CONSOLE_STATE"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const stateParent = await mkdtemp(path.join(parent, "browser-"));
  const paths = { sdkRoot: browserInput("ACKIVAULT_SDK_ROOT"), vaultArtifacts: browserInput("ACKIVAULT_VAULT_ARTIFACTS"),
    receiptArtifacts: browserInput("ACKIVAULT_RECEIPT_ARTIFACTS"), stateParent };
  const config = { ...testHostedConfig(access, paths), origin };
  async function restart(): Promise<void> {
    if (stand !== null) await stand.shutdown();
    if (backend !== null) await closeServer(backend);
    stand = new LocalStand({ ...await nativeStandConfig(paths), runId: randomUUID() });
    backend = createHostedServer(stand, config, new AccessVerifier(config.access), stand.runId);
    port = await listen(backend, 0);
  }
  await restart();
  return {
    origin, restart,
    snapshot: async (): Promise<HostedSnapshot> => {
      const valid = await access.sign(userClaims(access), "first");
      const response = await hostedRequest(port, valid, origin, "GET", "");
      assert.equal(response.status, 200); return hostedSnapshotSchema.parse(JSON.parse(response.text));
    },
    expireLogin: async (): Promise<void> => { token = await access.sign({ ...userClaims(access), exp: Math.floor(Date.now() / 1000) - 1 }, "first"); },
    renewLogin: async (): Promise<void> => { token = await access.sign(userClaims(access), "first"); },
    losePaymentResponse: (): void => { lose = true; }, paymentSubmissions: (): number => submissions,
    losePaymentConnection: (): void => { loseConnection = true; },
    expireOnPaymentRetry: (): void => { expireOnRetry = true; }, challengePayment: (): void => { challenge = true; },
    disconnectBeforeAdmission: (): void => { disconnected = true; }, restoreTransport: (): void => { disconnected = false; },
    stateFile: (): string => { assert.ok(stand !== null && stand.evidenceDirectory !== ""); return path.join(stand.evidenceDirectory, "developer.state"); },
    close: async (): Promise<void> => { if (stand !== null) await stand.shutdown(); if (backend !== null) await closeServer(backend); edge.closeAllConnections(); await new Promise<void>((resolve, reject): void => { edge.close((error): void => { if (error) reject(error); else resolve(); }); }); await access.close(); },
  };
}
