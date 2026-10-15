import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import type { AccessConfig, HostedConfig, StandPaths } from "../src/hosted-config.js";

export type AccessFixture = {
  issuer: string; caFile: string; email: string; subject: string;
  sign: (payload: JWTPayload, keyId: string) => Promise<string>;
  rotate: (keyId: string) => Promise<void>;
  setResponse: (status: number, location: string | null) => void;
  requestCount: () => number;
  close: () => Promise<void>;
};

export async function startAccessFixture(directory: string): Promise<AccessFixture> {
  const privateKeys = new Map<string, CryptoKey>();
  let published: JWK[] = [];
  let requests = 0;
  let status = 200;
  let location: string | null = null;
  async function rotate(keyId: string): Promise<void> {
    const pair = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    privateKeys.set(keyId, pair.privateKey);
    published = [{ ...await exportJWK(pair.publicKey), kid: keyId, alg: "RS256", use: "sig" }];
  }
  await rotate("first");
  const caFile = path.join(directory, "ca.pem");
  const server = createServer({ key: await readFile(path.join(directory, "server.key")), cert: await readFile(caFile) }, (request, response): void => {
    requests++;
    if (request.url !== "/cdn-cgi/access/certs") { response.writeHead(404); response.end(); return; }
    response.writeHead(status, { "content-type": "application/json", ...(location === null ? {} : { location }) });
    response.end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>((resolve, reject): void => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test Access issuer did not bind a TCP port");
  return {
    issuer: `https://127.0.0.1:${address.port}`, caFile, email: "tester@example.invalid", subject: "test-user",
    sign: async (payload: JWTPayload, keyId: string): Promise<string> => {
      const key = privateKeys.get(keyId);
      if (key === undefined) throw new Error("Test signing key is not available");
      return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: keyId }).sign(key);
    },
    rotate,
    setResponse: (next: number, target: string | null): void => { status = next; location = target; },
    requestCount: (): number => requests,
    close: async (): Promise<void> => { server.closeAllConnections(); await new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); }); },
  };
}

export function userClaims(fixture: AccessFixture): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return { iss: fixture.issuer, aud: ["test-audience"], email: fixture.email, sub: fixture.subject, type: "app", iat: now, exp: now + 300, nbf: now - 1 };
}

export function accessConfig(fixture: AccessFixture): AccessConfig {
  return { issuer: fixture.issuer, audience: "test-audience", allowedEmail: fixture.email,
    jwksTimeoutMs: 1000, jwksAttempts: 2, jwksRetryDelayMs: 10, jwksCacheMs: 100, jwksCooldownMs: 1 };
}
export function testHostedConfig(fixture: AccessFixture, paths: StandPaths): HostedConfig {
  return { origin: "https://console.example.invalid", port: 4317, access: accessConfig(fixture), paths,
    execution: { actionDeadlineMs: 60000, terminationGraceMs: 2000, maxOutputBytes: 4194304 },
    evidence: { maxBytes: 1073741824, minFreeBytes: 1048576 }, releaseManifest: path.join(paths.stateParent, "release.json") };
}
