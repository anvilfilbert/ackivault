import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { AccessVerifier, authorizeHostedRequest } from "../src/access.js";
import { loadHostedConfig, type AccessConfig } from "../src/hosted-config.js";
import { startAccessFixture, userClaims, type AccessFixture } from "./access-fixture.js";

function caDirectory(): string {
  const directory = process.env.ACKIVAULT_TEST_CA_DIR;
  assert.ok(directory, "ACKIVAULT_TEST_CA_DIR must identify the ephemeral TLS fixture");
  return directory;
}
export function accessConfig(fixture: AccessFixture): AccessConfig {
  return { issuer: fixture.issuer, audience: "test-audience", allowedEmail: fixture.email,
    jwksTimeoutMs: 1000, jwksAttempts: 2, jwksRetryDelayMs: 10, jwksCacheMs: 100, jwksCooldownMs: 1 };
}

test("rejects_invalid_access_tokens with real signatures and validates the permitted identity", async (): Promise<void> => {
  const fixture = await startAccessFixture(caDirectory());
  try {
    const verifier = new AccessVerifier(accessConfig(fixture));
    const claims = userClaims(fixture);
    const { exp: omittedExpiry, ...withoutExpiry } = claims;
    const { iat: omittedIssuedAt, ...withoutIssuedAt } = claims;
    assert.deepEqual(await verifier.verify(await fixture.sign(claims, "first")), { email: fixture.email, subject: fixture.subject });
    const invalid = [
      { ...claims, email: "someone@example.invalid" }, { ...claims, email: null }, { ...claims, sub: "" },
      { ...claims, type: "org" }, { ...claims, type: "app", email: undefined, common_name: "service" },
      { ...claims, aud: ["wrong-audience"] }, { ...claims, iss: "https://foreign.invalid" },
      { ...claims, exp: 1 }, withoutExpiry, withoutIssuedAt,
      { ...claims, nbf: Math.floor(Date.now() / 1000) + 100 },
    ];
    for (const payload of invalid) await assert.rejects(verifier.verify(await fixture.sign(payload, "first")));
    const token = await fixture.sign(claims, "first");
    const pieces = token.split(".");
    pieces[2] = Buffer.alloc(256).toString("base64url");
    await assert.rejects(verifier.verify(pieces.join(".")));
    await assert.rejects(verifier.verify("malformed"));
  } finally { await fixture.close(); }
});

test("rejects_ambiguous_headers and foreign Host/Origin before the protected HTTP handler", async (): Promise<void> => {
  const fixture = await startAccessFixture(caDirectory());
  const verifier = new AccessVerifier(accessConfig(fixture));
  let admitted = 0;
  const server = createServer((incoming, response): void => {
    void authorizeHostedRequest(incoming, "https://console.example.invalid", verifier).then((): void => {
      admitted++; response.writeHead(204); response.end();
    }).catch((): void => { response.writeHead(403); response.end(); });
  });
  await new Promise<void>((resolve): void => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  const token = await fixture.sign(userClaims(fixture), "first");
  async function status(headers: readonly string[], method: string): Promise<number> {
    return new Promise<number>((resolve, reject): void => {
      const call = request({ host: "127.0.0.1", port, method, path: "/", headers: [...headers] }, (response): void => {
        response.resume(); resolve(response.statusCode!);
      }); call.on("error", reject); call.end();
    });
  }
  const valid = ["Host", "console.example.invalid", "Cf-Access-Jwt-Assertion", token, "Origin", "https://console.example.invalid"];
  try {
    assert.equal(await status(valid, "POST"), 204);
    for (const headers of [
      ["Host", "console.example.invalid"],
      [...valid, "Cf-Access-Jwt-Assertion", token],
      ["Host", "console.example.invalid", "Cf-Access-Jwt-Assertion", `${token}, ${token}`],
      ["Host", "untrusted.invalid", "Cf-Access-Jwt-Assertion", token],
      ["Host", "console.example.invalid", "Cf-Access-Jwt-Assertion", token, "Origin", "null"],
      ["Host", "console.example.invalid", "Cf-Access-Jwt-Assertion", token],
      [...valid, "Origin", "https://console.example.invalid"],
    ]) assert.equal(await status(headers, "POST"), 403);
    assert.equal(admitted, 1);
    assert.equal(await status(valid.slice(0, 4), "GET"), 204);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve): void => { server.close((): void => resolve()); }); await fixture.close(); }
});

test("rotates_jwks_and_denies_expired_cache_outage with bounded retries and no redirect", async (): Promise<void> => {
  const fixture = await startAccessFixture(caDirectory());
  const verifier = new AccessVerifier(accessConfig(fixture));
  try {
    await verifier.verify(await fixture.sign(userClaims(fixture), "first"));
    await setTimeout(15);
    await fixture.rotate("second");
    await verifier.verify(await fixture.sign(userClaims(fixture), "second"));
    const count = fixture.requestCount();
    fixture.setResponse(503, null);
    await setTimeout(150);
    await assert.rejects(verifier.verify(await fixture.sign(userClaims(fixture), "second")));
    assert.equal(fixture.requestCount() - count, 2);
    fixture.setResponse(302, "https://untrusted.invalid/keys");
    const beforeRedirect = fixture.requestCount();
    await assert.rejects(verifier.verify(await fixture.sign(userClaims(fixture), "second")));
    assert.equal(fixture.requestCount() - beforeRedirect, 1);
  } finally { await fixture.close(); }
});

test("rejects_incomplete_hosted_config before opening a listener", (): void => {
  assert.throws(() => loadHostedConfig({}));
  const environment: NodeJS.ProcessEnv = {
    ACKIVAULT_ORIGIN: "https://console.example.invalid", ACKIVAULT_PORT: "4317", ACKIVAULT_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
    ACKIVAULT_ACCESS_AUDIENCE: "audience", ACKIVAULT_ALLOWED_EMAIL: "tester@example.invalid", ACKIVAULT_JWKS_TIMEOUT_MS: "3000",
    ACKIVAULT_JWKS_ATTEMPTS: "2", ACKIVAULT_JWKS_RETRY_DELAY_MS: "250", ACKIVAULT_JWKS_CACHE_MS: "600000", ACKIVAULT_JWKS_COOLDOWN_MS: "30000",
    ACKIVAULT_ACTION_DEADLINE_MS: "60000", ACKIVAULT_TERMINATION_GRACE_MS: "2000", ACKIVAULT_MAX_OUTPUT_BYTES: "4194304",
    ACKIVAULT_EVIDENCE_MAX_BYTES: "1073741824", ACKIVAULT_MIN_FREE_BYTES: "268435456", ACKIVAULT_SDK_ROOT: "/sdk",
    ACKIVAULT_VAULT_ARTIFACTS: "/vault", ACKIVAULT_RECEIPT_ARTIFACTS: "/recipient", ACKIVAULT_CONSOLE_STATE: "/state", ACKIVAULT_RELEASE_MANIFEST: "/release.json",
  };
  assert.equal(loadHostedConfig(environment).port, 4317);
  for (const [key, value] of [["ACKIVAULT_ORIGIN", "http://public.invalid"], ["ACKIVAULT_ORIGIN", "https://user:secret@public.invalid"],
    ["ACKIVAULT_ACCESS_ISSUER", "https://issuer.invalid/path"], ["ACKIVAULT_ACTION_DEADLINE_MS", "Infinity"],
    ["ACKIVAULT_ACTION_DEADLINE_MS", "90001"], ["ACKIVAULT_JWKS_ATTEMPTS", "0"], ["ACKIVAULT_PORT", "0"]]) {
    assert.throws(() => loadHostedConfig({ ...environment, [key!]: value! }));
  }
});
