import { spawn } from "node:child_process";
import path from "node:path";
import type { ExecutionLimits, StandPaths } from "./hosted-config.js";
import type { EvidenceJournal } from "./journal.js";

export type NativeInvocation = { command: string; args: readonly string[]; directory: string; deadlineAtMs: number; sequence: number };
export type CommandResult = { code: number; stdout: string; stderr: string; file: string };
export class NativeOperationError extends Error {
  readonly reason: "ACTION_TIMEOUT" | "OUTPUT_LIMIT" | "PROCESS_LAUNCH";
  constructor(reason: "ACTION_TIMEOUT" | "OUTPUT_LIMIT" | "PROCESS_LAUNCH", command: string, cause: Error | null) {
    super(`Native ${command} ${reason === "ACTION_TIMEOUT" ? "action deadline expired" : reason === "OUTPUT_LIMIT" ? "output limit exceeded" : "process launch failed"}; preserve evidence and do not retry`, { cause });
    this.name = "NativeOperationError"; this.reason = reason;
  }
}
type Observed = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; problem: NativeOperationError | null };

/** Wait for owned-child exit before returning, including deadline and output-limit termination. */
export async function runNativeCommand(invocation: NativeInvocation, paths: StandPaths, limits: ExecutionLimits, journal: EvidenceJournal): Promise<CommandResult> {
  // UTF-8 replacement can triple stdout bytes; JSON escaping can sextuple stderr bytes.
  await journal.checkCapacity(limits.maxOutputBytes * 9 + 8192);
  await journal.recordIntent(invocation.sequence, invocation.command);
  const remaining = Math.ceil(invocation.deadlineAtMs - performance.now());
  if (remaining <= 0) throw new NativeOperationError("ACTION_TIMEOUT", invocation.command, null);
  const state = path.join(invocation.directory, "developer.state");
  const args = [invocation.command, "--state", state, "--wasmtime-profile", path.join(paths.sdkRoot, "profiles/wasmtime-release-profile.v1"), ...invocation.args];
  const observed = await new Promise<Observed>((resolve): void => {
    const child = spawn(path.join(paths.sdkRoot, "bin/avm-local-stand"), args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0);
    let problem: NativeOperationError | null = null;
    let forced: NodeJS.Timeout | null = null;
    function terminate(reason: "ACTION_TIMEOUT" | "OUTPUT_LIMIT"): void {
      if (problem !== null) return;
      problem = new NativeOperationError(reason, invocation.command, null);
      child.kill("SIGTERM");
      forced = setTimeout((): void => { child.kill("SIGKILL"); }, limits.terminationGraceMs);
    }
    const deadline = setTimeout((): void => terminate("ACTION_TIMEOUT"), remaining);
    child.stdout.on("data", (chunk: Buffer): void => {
      const available = limits.maxOutputBytes - stdout.length;
      stdout = Buffer.concat([stdout, chunk.subarray(0, Math.max(available, 0))]);
      if (chunk.length > available) terminate("OUTPUT_LIMIT");
    });
    child.stderr.on("data", (chunk: Buffer): void => {
      const available = limits.maxOutputBytes - stderr.length;
      stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(available, 0))]);
      if (chunk.length > available) terminate("OUTPUT_LIMIT");
    });
    child.on("error", (error: Error): void => { problem = new NativeOperationError("PROCESS_LAUNCH", invocation.command, error); });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(deadline); if (forced !== null) clearTimeout(forced);
      resolve({ code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), problem });
    });
  });
  const file = await journal.recordResult(invocation.sequence, invocation.command, observed.stdout, observed.stderr, observed.code, observed.signal);
  if (observed.problem !== null) throw observed.problem;
  if (performance.now() > invocation.deadlineAtMs) throw new NativeOperationError("ACTION_TIMEOUT", invocation.command, null);
  if (observed.code === null) throw new NativeOperationError("PROCESS_LAUNCH", invocation.command, new Error(`Native process exited through signal ${observed.signal}`));
  return { code: observed.code, stdout: observed.stdout, stderr: observed.stderr, file };
}
