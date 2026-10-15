import type { IncomingMessage } from "node:http";
import { setTimeout } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod";
import { accessConfigSchema, type AccessConfig } from "./hosted-config.js";
import { RequestError } from "./model.js";

export class AccessDeniedError extends RequestError {
  constructor() { super(403, "Access denied. Sign in with the permitted identity."); this.name = "AccessDeniedError"; }
}
export class AccessUnavailableError extends RequestError {
  constructor(cause: Error) { super(503, "Access verification is unavailable. Try signing in later."); this.name = "AccessUnavailableError"; this.cause = cause; }
}
class KeyRetrievalError extends Error {
  constructor(status: number, cause: Error | null) { super(`Access JWKS retrieval failed; HTTP status ${status}`, { cause }); this.name = "KeyRetrievalError"; }
}
const identitySchema = z.object({
  email: z.email(), sub: z.string().min(1).refine((value: string): boolean => value.trim() === value),
  type: z.literal("app"), exp: z.number().int().nonnegative(), iat: z.number().int().nonnegative(),
});
export type VerifiedIdentity = { email: string; subject: string };

function transientTransport(error: Error): boolean {
  return error instanceof TypeError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name));
}

/** Retrieves keys only from the configured issuer and never follows redirects. */
async function retrieveKeys(config: AccessConfig, input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<Response> {
  const expected = `${config.issuer}/cdn-cgi/access/certs`;
  if (String(input) !== expected) throw new KeyRetrievalError(0, new Error("Unexpected JWKS request destination"));
  for (let attempt = 1; attempt <= config.jwksAttempts; attempt++) {
    let response: Response;
    try { response = await fetch(expected, { ...init, redirect: "manual" }); }
    catch (error) {
      if (!(error instanceof Error)) throw new TypeError("JWKS transport threw a non-Error value", { cause: error });
      if (!transientTransport(error)) throw error;
      if (attempt === config.jwksAttempts || init?.signal?.aborted) throw new KeyRetrievalError(0, error);
      console.warn(JSON.stringify({ event: "access_jwks_retry", attempt, cause: error.name, status: 0 }));
      await setTimeout(config.jwksRetryDelayMs);
      continue;
    }
    if (response.status === 200) return response;
    const status = response.status;
    await response.body?.cancel();
    if ((status !== 429 && status < 500) || attempt === config.jwksAttempts) throw new KeyRetrievalError(status, null);
    console.warn(JSON.stringify({ event: "access_jwks_retry", attempt, status }));
    await setTimeout(config.jwksRetryDelayMs);
  }
  throw new Error("JWKS attempt loop ended without a result");
}

/** Owns a bounded, cached remote JWKS verifier; decoded token fields are never trusted first. */
export class AccessVerifier {
  private readonly config: AccessConfig;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(config: AccessConfig) {
    this.config = accessConfigSchema.parse(config);
    this.keys = createRemoteJWKSet(new URL(`${this.config.issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: this.config.jwksTimeoutMs, cooldownDuration: this.config.jwksCooldownMs, cacheMaxAge: this.config.jwksCacheMs,
      [customFetch]: (input, init): Promise<Response> => retrieveKeys(this.config, input, init),
    });
  }
  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ["RS256"], issuer: this.config.issuer, audience: this.config.audience,
        requiredClaims: ["exp", "iat", "sub", "email", "type"],
      });
      const identity = identitySchema.parse(payload);
      if (identity.email !== this.config.allowedEmail || identity.iat > Math.floor(Date.now() / 1000)) throw new AccessDeniedError();
      return { email: identity.email, subject: identity.sub };
    } catch (error) {
      if (error instanceof KeyRetrievalError || error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid || error instanceof errors.JWKInvalid || (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC")) throw new AccessUnavailableError(error);
      if (error instanceof errors.JOSEError || error instanceof z.ZodError || error instanceof AccessDeniedError) throw new AccessDeniedError();
      throw error;
    }
  }
}

function singleHeader(request: IncomingMessage, name: string): string {
  const values = request.rawHeaders.filter((_value: string, index: number): boolean => index % 2 === 1 && request.rawHeaders[index - 1]?.toLowerCase() === name);
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0 || values[0].includes(",") || values[0].trim() !== values[0]) throw new AccessDeniedError();
  return values[0];
}

export async function authorizeHostedRequest(request: IncomingMessage, origin: string, verifier: AccessVerifier): Promise<void> {
  if (singleHeader(request, "host") !== new URL(origin).host) throw new AccessDeniedError();
  if (request.method === "POST" && singleHeader(request, "origin") !== origin) throw new AccessDeniedError();
  await verifier.verify(singleHeader(request, "cf-access-jwt-assertion"));
}
