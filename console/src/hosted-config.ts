import path from "node:path";
import { z } from "zod";

const positive = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalHttps = z.string().refine((value: string): boolean => {
  try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.origin === value; }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
}, "Must be a canonical HTTPS origin without a path, credentials, query or fragment");
const absolutePath = z.string().min(1).refine(path.isAbsolute, "Must be an absolute private filesystem path");
export const accessConfigSchema = z.object({
  issuer: canonicalHttps, audience: z.string().min(1), allowedEmail: z.email(),
  jwksTimeoutMs: positive.max(10_000), jwksAttempts: positive.max(3), jwksRetryDelayMs: positive.max(1000),
  jwksCacheMs: positive.max(600_000), jwksCooldownMs: positive.max(60_000),
});
export type AccessConfig = z.infer<typeof accessConfigSchema>;
export const executionLimitsSchema = z.object({ actionDeadlineMs: positive.max(90_000), terminationGraceMs: positive.max(5000), maxOutputBytes: positive.max(4_194_304) });
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export const evidenceLimitsSchema = z.object({ maxBytes: positive, minFreeBytes: positive });
export type EvidenceLimits = z.infer<typeof evidenceLimitsSchema>;
export const standPathsSchema = z.object({ sdkRoot: absolutePath, vaultArtifacts: absolutePath, receiptArtifacts: absolutePath, stateParent: absolutePath });
export type StandPaths = z.infer<typeof standPathsSchema>;
const hostedConfigSchema = z.object({
  origin: canonicalHttps, port: positive.max(65535), access: accessConfigSchema, execution: executionLimitsSchema,
  evidence: evidenceLimitsSchema, paths: standPathsSchema, releaseManifest: absolutePath,
});
export type HostedConfig = z.infer<typeof hostedConfigSchema>;

/** Requires explicit operator configuration; missing values never disable hosted controls. */
export function loadHostedConfig(environment: NodeJS.ProcessEnv): HostedConfig {
  return hostedConfigSchema.parse({
    origin: environment.ACKIVAULT_ORIGIN, port: environment.ACKIVAULT_PORT,
    access: { issuer: environment.ACKIVAULT_ACCESS_ISSUER, audience: environment.ACKIVAULT_ACCESS_AUDIENCE,
      allowedEmail: environment.ACKIVAULT_ALLOWED_EMAIL, jwksTimeoutMs: environment.ACKIVAULT_JWKS_TIMEOUT_MS,
      jwksAttempts: environment.ACKIVAULT_JWKS_ATTEMPTS, jwksRetryDelayMs: environment.ACKIVAULT_JWKS_RETRY_DELAY_MS,
      jwksCacheMs: environment.ACKIVAULT_JWKS_CACHE_MS, jwksCooldownMs: environment.ACKIVAULT_JWKS_COOLDOWN_MS },
    execution: { actionDeadlineMs: environment.ACKIVAULT_ACTION_DEADLINE_MS, terminationGraceMs: environment.ACKIVAULT_TERMINATION_GRACE_MS, maxOutputBytes: environment.ACKIVAULT_MAX_OUTPUT_BYTES },
    evidence: { maxBytes: environment.ACKIVAULT_EVIDENCE_MAX_BYTES, minFreeBytes: environment.ACKIVAULT_MIN_FREE_BYTES },
    paths: { sdkRoot: environment.ACKIVAULT_SDK_ROOT, vaultArtifacts: environment.ACKIVAULT_VAULT_ARTIFACTS,
      receiptArtifacts: environment.ACKIVAULT_RECEIPT_ARTIFACTS, stateParent: environment.ACKIVAULT_CONSOLE_STATE },
    releaseManifest: environment.ACKIVAULT_RELEASE_MANIFEST,
  });
}
