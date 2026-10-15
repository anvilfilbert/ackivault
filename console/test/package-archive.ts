import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const [packageInput, outputInput] = process.argv.slice(2);
assert.ok(packageInput && outputInput && process.env.ACKIVAULT_SDK_ROOT);
const source = process.cwd();
const pkg = path.resolve(packageInput); const output = path.resolve(outputInput);

async function archive(directory: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    execFile("bash", [path.join(source, "scripts/archive-private-package.sh"), directory, process.env.ACKIVAULT_SDK_ROOT!, destination],
      { encoding: "utf8", maxBuffer: 4194304, timeout: 120000 }, (error, stdout, stderr): void => {
        if (error) { reject(new Error(`Application archive failed: ${stdout}; ${stderr}`, { cause: error })); return; }
        resolve();
      });
  });
}

async function writableDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writableDirectories(path.join(directory, entry.name));
  }
}

async function archiveMembers(file: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject): void => {
    execFile("tar", ["-tzf", file], { encoding: "utf8", maxBuffer: 4194304, timeout: 30000 }, (error, stdout): void => {
      if (error) { reject(error); return; }
      resolve(stdout.trimEnd().split("\n"));
    });
  });
}

// Removing archive creation or adding an extra package member must break this real roundtrip.
await archive(pkg, output);
const archiveBytes = await readFile(path.join(output, "ackivault-application.tar.gz"));
const digest = createHash("sha256").update(archiveBytes).digest("hex");
assert.equal(await readFile(path.join(output, "ackivault-application.tar.gz.sha256"), "utf8"), `${digest}  ackivault-application.tar.gz\n`);
const members = await archiveMembers(path.join(output, "ackivault-application.tar.gz"));
const expectedFiles = (await readFile(path.join(pkg, "FILES.sha256"), "utf8")).trimEnd().split("\n").map((line: string): string => line.slice(66));
assert.deepEqual(members.filter((member: string): boolean => !member.endsWith("/")).sort(), ["./FILES.sha256", ...expectedFiles].sort());
for (const directory of members.filter((member: string): boolean => member.endsWith("/"))) {
  assert.ok(expectedFiles.some((file: string): boolean => file.startsWith(directory)), "Every archived directory must contain an inventoried file");
}
for (const name of ["FILES.sha256", "release.json"]) {
  assert.equal(await readFile(path.join(output, "verified-package", name), "utf8"), await readFile(path.join(pkg, name), "utf8"));
}

// Even a checksum-consistent addition outside the publication allowlist must not be archived.
const temporary = await mkdtemp(path.join(path.dirname(output), "archive-rejection-"));
try {
  for (const name of [".env", "avm-local-stand"]) {
    const contaminated = path.join(temporary, name === ".env" ? "private-config" : "host-tool");
    await cp(pkg, contaminated, { recursive: true }); await chmod(contaminated, 0o700);
    const bytes = "SYNTHETIC_PUBLICATION_SENTINEL\n";
    await writeFile(path.join(contaminated, name), bytes, { flag: "wx", mode: 0o600 });
    const inventory = path.join(contaminated, "FILES.sha256"); await chmod(inventory, 0o600);
    await writeFile(inventory, `${await readFile(inventory, "utf8")}${createHash("sha256").update(bytes).digest("hex")}  ./${name}\n`);
    await assert.rejects(archive(contaminated, path.join(temporary, `output-${name}`)), /Package member is not approved for publication/);
  }
  for (const [index, name] of [".PRIVATE_DIRECTORY_SENTINEL", "console/.PRIVATE_DIRECTORY_SENTINEL"].entries()) {
    const contaminated = path.join(temporary, `directory-${index}`);
    await cp(pkg, contaminated, { recursive: true });
    await chmod(path.dirname(path.join(contaminated, name)), 0o700);
    await mkdir(path.join(contaminated, name), { mode: 0o700 });
    await assert.rejects(archive(contaminated, path.join(temporary, `output-directory-${index}`)), /Package directory is not approved for publication/);
  }
} finally {
  await writableDirectories(temporary);
  await rm(temporary, { recursive: true });
}
console.log(JSON.stringify({ event: "application_archive_acceptance", checksumVerified: true,
  roundtripInventoryExact: true, privateConfigurationRejected: true, hostToolRejected: true, unlistedDirectoriesRejected: true }));
