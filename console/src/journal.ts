import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { evidenceLimitsSchema, type EvidenceLimits, type StandPaths } from "./hosted-config.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const provenanceSchema = z.object({
  applicationCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sdkCommit: z.literal("0748f4f0767a26da8bc363bcb6b5585539d6970e"),
  runtimeCommit: z.literal("06e96ef71006cca020575cbf35e6b82cc82a324e"),
  profileSha256: z.literal("eafd9ee1589b24c8fba8f5212c0571bd796bfc127aeae0edfb5697bd477b39d8"),
  vaultArtifactSha256: z.array(digestSchema).length(3), recipientArtifactSha256: z.array(digestSchema).length(3),
});
export type StandProvenance = z.infer<typeof provenanceSchema>;
export class StorageError extends Error {
  constructor(message: string, cause: Error | null) { super(message, { cause }); this.name = "StorageError"; }
}
export async function sha256File(file: string): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new StorageError(`Expected a regular provenance file: ${file}`, null);
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
export async function artifactHashes(directory: string): Promise<string[]> {
  return Promise.all(["contract.wasm", "contract.acab", "contract.descriptor"].map((name: string): Promise<string> => sha256File(path.join(directory, name))));
}

/** Validate actual runtime/profile/artifacts against an operator release manifest before listening. */
export async function loadStandProvenance(manifest: string, paths: StandPaths): Promise<StandProvenance> {
  const expected = provenanceSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
  const sdk = z.object({ sdk_commit: z.literal(expected.sdkCommit), ackinacki_commit: z.literal(expected.runtimeCommit),
    bundle_version: z.literal("0.2.0"), guest_version: z.literal("0.1.1"), wasmtime_profile_sha256: z.literal(expected.profileSha256) })
    .parse(JSON.parse(await readFile(path.join(paths.sdkRoot, "BUILD-MANIFEST.json"), "utf8")));
  const binary = await sha256File(path.join(paths.sdkRoot, "bin/avm-local-stand"));
  if (binary !== "2599204d32a8100847a086c95e16f589589644bf6072496cc19c1e172fb7f586") throw new StorageError("Pinned native runtime checksum mismatch", null);
  if (await sha256File(path.join(paths.sdkRoot, "profiles/wasmtime-release-profile.v1")) !== sdk.wasmtime_profile_sha256) throw new StorageError("Pinned AVM profile checksum mismatch", null);
  const actual = { ...expected, vaultArtifactSha256: await artifactHashes(paths.vaultArtifacts), recipientArtifactSha256: await artifactHashes(paths.receiptArtifacts) };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new StorageError("Contract artifact checksums do not match the release manifest", null);
  return expected;
}

async function directoryBytes(directory: string): Promise<bigint> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry): Promise<bigint> => {
    const file = path.join(directory, entry.name);
    const metadata = await lstat(file, { bigint: true });
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? directoryBytes(file) : metadata.size;
  }));
  return sizes.reduce((sum: bigint, value: bigint): bigint => sum + value, 0n);
}

/** Owns append-only private evidence, including partial native outputs and termination metadata. */
export class EvidenceJournal {
  private readonly directory: string;
  private readonly limits: EvidenceLimits;
  constructor(directory: string, limits: EvidenceLimits) { this.directory = directory; this.limits = evidenceLimitsSchema.parse(limits); }
  async checkCapacity(requiredBytes: number): Promise<void> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new StorageError("Invalid evidence reservation size", null);
    const parent = path.dirname(this.directory);
    const used = await directoryBytes(parent);
    const filesystem = await statfs(parent, { bigint: true });
    if (used + BigInt(requiredBytes) > BigInt(this.limits.maxBytes) || filesystem.bavail * filesystem.bsize - BigInt(requiredBytes) < BigInt(this.limits.minFreeBytes)) {
      throw new StorageError("Evidence storage capacity is insufficient; preserve old sessions and resolve storage pressure before starting another session", null);
    }
  }
  private async append(name: string, content: string): Promise<void> {
    try { await writeFile(path.join(this.directory, name), content, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error)) throw new TypeError("Evidence write failed with a non-Error value", { cause: error }); throw new StorageError(`Evidence persistence failed for ${name}; session cannot continue`, error); }
  }
  async recordSession(runId: string, provenance: StandProvenance): Promise<void> {
    const checked = provenanceSchema.parse(provenance);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new StorageError("Invalid private session run identifier", null);
    const data = JSON.stringify({ schema: "ackivault.session.v1", runId, createdAt: new Date().toISOString(), provenance: checked });
    await this.checkCapacity(Buffer.byteLength(data) + 4096);
    await this.append("session.json", data);
  }
  private basename(sequence: number, command: string): string {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 9999 || !/^[a-z-]+$/.test(command)) throw new StorageError("Invalid native evidence sequence or command", null);
    return `${String(sequence).padStart(4, "0")}-${command}`;
  }
  async recordIntent(sequence: number, command: string): Promise<void> {
    await this.append(`${this.basename(sequence, command)}.intent.json`, JSON.stringify({ command, sequence, startedAt: new Date().toISOString() }));
  }
  async recordResult(sequence: number, command: string, stdout: string, stderr: string, code: number | null, signal: string | null): Promise<string> {
    const basename = this.basename(sequence, command);
    // Metadata is independent of receipt persistence; a failed receipt write must still halt.
    await this.append(`${basename}.result.json`, JSON.stringify({ command, sequence, finishedAt: new Date().toISOString(), code, signal, stderr }));
    await this.append(`${basename}.json`, stdout);
    const state = path.join(this.directory, "developer.state");
    try { await chmod(state, 0o600); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || code === 0) throw error;
      // Failed launches may not have created any developer state; no state is restored or invented.
    }
    return `${basename}.json`;
  }
}
