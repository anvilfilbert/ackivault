import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceInput, outputInput] = process.argv.slice(2);
assert.ok(sourceInput && outputInput && process.env.GITHUB_WORKSPACE && process.env.RUNNER_ENVIRONMENT === "github-hosted");
const source = path.resolve(sourceInput); const output = path.resolve(outputInput);
assert.equal(source, process.env.GITHUB_WORKSPACE);
const candidates = ["console/dist/src/stale-private-module.js", "console/public/.env", "contract/target/avm/unrelated-private-output"];
const created: string[] = [];
try {
  for (const relative of candidates) {
    const file = path.join(source, relative); await writeFile(file, "SYNTHETIC_UNTRACKED_PRIVATE_SENTINEL", { flag: "wx", mode: 0o600 }); created.push(file);
  }
  await new Promise<void>((resolve, reject): void => {
    execFile("bash", [path.join(source, "scripts/package-private-console.sh"), source, output], { encoding: "utf8", maxBuffer: 4194304, timeout: 180000 }, (error, stdout, stderr): void => {
      if (error) { reject(new Error(`Package build failed: ${stdout}; ${stderr}`, { cause: error })); return; }
      resolve();
    });
  });
  const inventory = await readFile(path.join(output, "FILES.sha256"), "utf8");
  assert.equal(inventory.includes("stale-private-module"), false, "Stale compiler output is not part of the claimed source commit");
  assert.equal(inventory.includes("/public/.env"), false, "Ignored private inputs must not enter the package");
  assert.equal(inventory.includes("unrelated-private-output"), false, "Only the contract artifact triple is packaged");
  console.log(JSON.stringify({ event: "clean_source_package_acceptance", staleOutputExcluded: true, ignoredPrivateInputExcluded: true }));
} finally { for (const file of created) await unlink(file); }
