import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Execute the actual stand, preserving the real payment receipt but corrupting its stdout. */
export async function receiptLossSdk(sdkRoot: string, directory: string): Promise<string> {
  const proxyRoot = path.join(directory, "receipt-loss-sdk");
  await mkdir(path.join(proxyRoot, "bin"), { recursive: true });
  await symlink(path.join(sdkRoot, "profiles"), path.join(proxyRoot, "profiles"));
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(path.join(sdkRoot, "bin/avm-local-stand"))}, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status === null) throw new Error("Native stand terminated without an exit status: " + result.signal);
process.stderr.write(result.stderr);
if (args[0] === "call" && args[args.indexOf("--method") + 1] === "ackivault.pay" && result.status === 0) {
  writeFileSync(${JSON.stringify(path.join(directory, "executed-payment.json"))}, result.stdout, { flag: "wx", mode: 0o600 });
  process.stdout.write("{");
} else {
  process.stdout.write(result.stdout);
}
process.exitCode = result.status;
`;
  await writeFile(path.join(proxyRoot, "bin/avm-local-stand"), script, { flag: "wx", mode: 0o700 });
  return proxyRoot;
}

/** Obtain a recipient receipt through the unmodified native binary after the fault. */
export async function nativeRecipientSnapshot(sdkRoot: string, state: string, address: string, blockTime: number): Promise<string> {
  const args = ["call", "--state", state, "--wasmtime-profile", path.join(sdkRoot, "profiles/wasmtime-release-profile.v1"),
    "--address", address, "--method", "stand.snapshot", "--args-json", "null", "--identity", "user",
    "--value-main", "0", "--extra-currencies", "", "--block-time", String(blockTime),
    "--created-at", String(blockTime), "--expire-at", String(blockTime + 3600), "--fuel-fee-shells", "1000"];
  return new Promise<string>((resolve, reject): void => {
    execFile(path.join(sdkRoot, "bin/avm-local-stand"), args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr): void => {
      if (error) reject(new Error(`Native recipient verification failed: ${error.message}; stdout: ${stdout}; stderr: ${stderr}`, { cause: error }));
      else resolve(stdout);
    });
  });
}
