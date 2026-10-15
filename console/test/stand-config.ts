import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StandPaths } from "../src/hosted-config.js";
import { artifactHashes, sha256File } from "../src/journal.js";
import type { StandConfig } from "../src/stand.js";

/** Deliberately unusable paths for tests that must never initialize or execute a stand. */
export function unstartedStandConfig(paths: StandPaths): StandConfig {
  return { paths, runId: randomUUID(), execution: { actionDeadlineMs: 60000, terminationGraceMs: 2000, maxOutputBytes: 4194304 },
    evidence: { maxBytes: 1073741824, minFreeBytes: 1048576 }, provenance: {
      applicationCommit: "0".repeat(40), sdkCommit: "0748f4f0767a26da8bc363bcb6b5585539d6970e",
      runtimeCommit: "06e96ef71006cca020575cbf35e6b82cc82a324e", profileSha256: "eafd9ee1589b24c8fba8f5212c0571bd796bfc127aeae0edfb5697bd477b39d8",
      vaultArtifactSha256: ["0".repeat(64), "0".repeat(64), "0".repeat(64)], recipientArtifactSha256: ["0".repeat(64), "0".repeat(64), "0".repeat(64)],
    } };
}

/** Native test provenance describes actual built artifacts; wrappers are explicit fault injection. */
export async function nativeStandConfig(paths: StandPaths): Promise<StandConfig> {
  const source = process.env.ACKIVAULT_SOURCE_COMMIT;
  assert.ok(source && /^[0-9a-f]{40}$/.test(source), "ACKIVAULT_SOURCE_COMMIT must identify the actual native test checkout");
  const initial = unstartedStandConfig(paths);
  const profile = await sha256File(path.join(paths.sdkRoot, "profiles/wasmtime-release-profile.v1"));
  assert.equal(profile, initial.provenance.profileSha256);
  return { ...initial, provenance: { ...initial.provenance, applicationCommit: source,
    vaultArtifactSha256: await artifactHashes(paths.vaultArtifacts), recipientArtifactSha256: await artifactHashes(paths.receiptArtifacts) } };
}
