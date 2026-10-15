import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

async function faultSdk(sdkRoot: string, directory: string, effect: string): Promise<string> {
  const proxy = path.join(directory, "fault-sdk");
  await mkdir(path.join(proxy, "bin"), { recursive: true });
  await symlink(path.join(sdkRoot, "profiles"), path.join(proxy, "profiles"));
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(path.join(sdkRoot, "bin/avm-local-stand"))}, args, { encoding: "utf8", maxBuffer: 4194304 });
if (result.error) throw result.error;
if (result.status === null) throw new Error("Original native command was terminated");
if (args[0] === "call" && args[args.indexOf("--method") + 1] === "ackivault.pay" && result.status === 0) {
  fs.writeFileSync(${JSON.stringify(path.join(directory, "executed-payment.json"))}, result.stdout, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(${JSON.stringify(path.join(directory, "child.pid"))}, String(process.pid), { flag: "wx", mode: 0o600 });
  ${effect}
} else {
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;
}
`;
  await writeFile(path.join(proxy, "bin/avm-local-stand"), script, { flag: "wx", mode: 0o700 });
  return proxy;
}
export async function delayedPaymentSdk(sdkRoot: string, directory: string): Promise<string> {
  return faultSdk(sdkRoot, directory, 'process.stdout.write("{"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
}
export async function overflowPaymentSdk(sdkRoot: string, directory: string): Promise<string> {
  return faultSdk(sdkRoot, directory, 'process.stdout.write("x".repeat(4194305));');
}
export async function unwritableReceiptSdk(sdkRoot: string, directory: string): Promise<string> {
  return faultSdk(sdkRoot, directory, `
  const stateDirectory = path.dirname(args[args.indexOf("--state") + 1]);
  const files = fs.readdirSync(stateDirectory).filter(name => /^\\d{4}-[a-z-]+\\.json$/.test(name));
  const sequence = String(files.length + 1).padStart(4, "0");
  fs.mkdirSync(path.join(stateDirectory, sequence + "-call.json"));
  process.stdout.write(result.stdout);`);
}
