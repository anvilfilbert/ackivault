import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Configure the real recipient's external-only method as the vault's internal payment destination. */
export async function rejectedDeliverySdk(sdkRoot: string, directory: string): Promise<string> {
  const proxyRoot = path.join(directory, "rejected-delivery-sdk");
  await mkdir(path.join(proxyRoot, "bin"), { recursive: true });
  await symlink(path.join(sdkRoot, "profiles"), path.join(proxyRoot, "profiles"));
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "deploy") {
  const index = args.indexOf("--init-json");
  if (index < 0) throw new Error("Deployment is missing --init-json");
  const value = JSON.parse(args[index + 1]);
  if (value !== null) {
    if (typeof value !== "string" || !/^0x[0-9a-f]{810}$/.test(value)) throw new Error("Expected canonical vault initialization bytes");
    const bytes = Buffer.from(value.slice(2), "hex");
    if (bytes[52] !== 1 || bytes.readBigUInt64LE(117) !== 0xe940cf114abdd07an) throw new Error("Expected exactly one deposit recipient before injection");
    bytes.writeBigUInt64LE(0x7a9236e99b7ae9ddn, 117);
    args[index + 1] = JSON.stringify("0x" + bytes.toString("hex"));
  }
}
const result = spawnSync(${JSON.stringify(path.join(sdkRoot, "bin/avm-local-stand"))}, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status === null) throw new Error("Native stand terminated without exit status: " + result.signal);
if (args[0] === "call" && args[args.indexOf("--method") + 1] === "ackivault.pay") {
  writeFileSync(${JSON.stringify(path.join(directory, "dispatched-payment.json"))}, result.stdout, { flag: "wx", mode: 0o600 });
}
process.stderr.write(result.stderr);
process.stdout.write(result.stdout);
process.exitCode = result.status;
`;
  await writeFile(path.join(proxyRoot, "bin/avm-local-stand"), script, { flag: "wx", mode: 0o700 });
  return proxyRoot;
}
