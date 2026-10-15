import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Fund the expiry fixture before deployment, then shift signed time; never change contract output. */
export async function expiredGrantSdk(sdkRoot: string, directory: string): Promise<string> {
  const proxy = path.join(directory, "expiry-sdk");
  await mkdir(path.join(proxy, "bin"), { recursive: true });
  await symlink(path.join(sdkRoot, "profiles"), path.join(proxy, "profiles"));
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "fund-user") args[args.indexOf("--shells") + 1] = "1000000000";
const marker = ${JSON.stringify(path.join(directory, "expiry-clock"))};
const payment = args[0] === "call" && args[args.indexOf("--method") + 1] === "ackivault.pay";
if (payment && !fs.existsSync(marker)) fs.writeFileSync(marker, "local test clock advanced", { flag: "wx", mode: 0o600 });
if (fs.existsSync(marker)) {
  for (const flag of ["--block-time", "--created-at", "--expire-at"]) {
    const offset = args.indexOf(flag);
    if (offset >= 0) args[offset + 1] = String(Number(args[offset + 1]) + 7200);
  }
}
const result = spawnSync(${JSON.stringify(path.join(sdkRoot, "bin/avm-local-stand"))}, args, { encoding: "utf8", maxBuffer: 4194304 });
if (result.error) throw result.error;
if (result.status === null) throw new Error("Original stand was terminated");
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;
`;
  await writeFile(path.join(proxy, "bin/avm-local-stand"), script, { flag: "wx", mode: 0o700 });
  return proxy;
}
