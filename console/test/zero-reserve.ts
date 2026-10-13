import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Pass the first real payment unchanged; give the second real payment zero FUEL reserve. */
export async function zeroReserveSdk(sdkRoot: string, directory: string): Promise<string> {
  const proxyRoot = path.join(directory, "zero-reserve-sdk");
  await mkdir(path.join(proxyRoot, "bin"), { recursive: true });
  await symlink(path.join(sdkRoot, "profiles"), path.join(proxyRoot, "profiles"));
  const firstPayment = path.join(directory, "first-payment.json");
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const payment = args[0] === "call" && args[args.indexOf("--method") + 1] === "ackivault.pay";
const exhausted = payment && existsSync(${JSON.stringify(firstPayment)});
if (exhausted) {
  const fee = args.indexOf("--fuel-fee-shells");
  if (fee < 0) throw new Error("Payment command is missing its FUEL reserve argument");
  args[fee + 1] = "0";
}
const result = spawnSync(${JSON.stringify(path.join(sdkRoot, "bin/avm-local-stand"))}, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status === null) throw new Error("Native stand terminated without exit status: " + result.signal);
if (payment) {
  const receipt = exhausted ? ${JSON.stringify(path.join(directory, "rejected-payment.json"))} : ${JSON.stringify(firstPayment)};
  writeFileSync(receipt, result.stdout, { flag: "wx", mode: 0o600 });
}
process.stderr.write(result.stderr);
process.stdout.write(result.stdout);
process.exitCode = result.status;
`;
  await writeFile(path.join(proxyRoot, "bin/avm-local-stand"), script, { flag: "wx", mode: 0o700 });
  return proxyRoot;
}
