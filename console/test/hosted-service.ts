import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cp, chmod, mkdir, readFile, readdir, stat, writeFile, readlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { startAccessFixture, userClaims } from "./access-fixture.js";
import { hostedRequest } from "./hosted-client.js";
import { hostedSnapshotSchema, type HostedSnapshot } from "../src/hosted-model.js";
import type { Action } from "../src/model.js";

type Command = { code: number; stdout: string; stderr: string };
async function command(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Command> {
  return new Promise<Command>((resolve, reject): void => {
    execFile(file, args, { env, encoding: "utf8", maxBuffer: 4194304, timeout: 120000 }, (error, stdout, stderr): void => {
      if (error !== null && typeof error.code !== "number") { reject(error); return; }
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
    });
  });
}
async function accepted(file: string, args: string[]): Promise<string> {
  const result = await command(file, args, process.env); assert.equal(result.code, 0, `${file} ${args.join(" ")}: ${result.stderr}`); return result.stdout;
}
async function hashes(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name); const info = await stat(file);
    if (info.isDirectory()) files.push(...(await hashes(file)).map((value: string): string => `${name}/${value}`));
    else files.push(`${name}:${createHash("sha256").update(await readFile(file)).digest("hex")}`);
  }
  return files;
}
const [packageInput, sdkInput, rootInput] = process.argv.slice(2);
assert.ok(packageInput && sdkInput && rootInput && process.env.CI === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted");
const pkg = path.resolve(packageInput); const sdk = path.resolve(sdkInput); const root = path.resolve(rootInput);
const unit = `ackivault-ci-${randomUUID()}.service`;
const access = await startAccessFixture(path.resolve(process.env.ACKIVAULT_TEST_CA_DIR!));
const token = await access.sign(userClaims(access), "first");
const reserve = createServer(); await new Promise<void>((resolve): void => { reserve.listen(0, "127.0.0.1", resolve); });
const address = reserve.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
await new Promise<void>((resolve): void => { reserve.close((): void => resolve()); });
const origin = "https://console.example.invalid";
const state = path.join(root, "state"); await mkdir(state, { mode: 0o700 });
const envFile = path.join(root, "hosted.env");
function environment(packageDirectory: string): NodeJS.ProcessEnv {
  return { ACKIVAULT_ORIGIN: origin, ACKIVAULT_PORT: String(port), ACKIVAULT_ACCESS_ISSUER: access.issuer,
    ACKIVAULT_ACCESS_AUDIENCE: "test-audience", ACKIVAULT_ALLOWED_EMAIL: access.email,
    ACKIVAULT_JWKS_TIMEOUT_MS: "3000", ACKIVAULT_JWKS_ATTEMPTS: "2", ACKIVAULT_JWKS_RETRY_DELAY_MS: "250",
    ACKIVAULT_JWKS_CACHE_MS: "600000", ACKIVAULT_JWKS_COOLDOWN_MS: "30000", ACKIVAULT_ACTION_DEADLINE_MS: "60000",
    ACKIVAULT_TERMINATION_GRACE_MS: "2000", ACKIVAULT_MAX_OUTPUT_BYTES: "4194304", ACKIVAULT_EVIDENCE_MAX_BYTES: "1073741824",
    ACKIVAULT_MIN_FREE_BYTES: "268435456", ACKIVAULT_SDK_ROOT: sdk, ACKIVAULT_VAULT_ARTIFACTS: path.join(packageDirectory, "vault"),
    ACKIVAULT_RECEIPT_ARTIFACTS: path.join(packageDirectory, "recipient"), ACKIVAULT_CONSOLE_STATE: state,
    ACKIVAULT_RELEASE_MANIFEST: path.join(packageDirectory, "release.json"), NODE_EXTRA_CA_CERTS: access.caFile };
}
async function installUnit(packageDirectory: string): Promise<void> {
  const env = environment(packageDirectory);
  await writeFile(envFile, Object.entries(env).map(([key, value]): string => `${key}=${JSON.stringify(value)}`).join("\n"), { mode: 0o600 });
  const values = new Map<string, string>([["USER", String(process.getuid!())], ["GROUP", String(process.getgid!())],
    ["PACKAGE", packageDirectory], ["SDK", sdk], ["STATE", state], ["ENV_FILE", envFile], ["NODE", process.execPath], ["NODE_DIR", path.dirname(process.execPath)]]);
  const template = await readFile(path.join(pkg, "deploy/ackivault.service.in"), "utf8");
  const rendered = template.replace(/@([A-Z_]+)@/g, (_match: string, key: string): string => {
    const value = values.get(key); assert.ok(value && /^[a-zA-Z0-9/_.-]+$/.test(value), `Invalid unit substitution: ${key}`); return value;
  });
  const candidate = path.join(root, unit); await writeFile(candidate, rendered, { mode: 0o600 });
  await accepted("sudo", ["install", "-m", "644", candidate, `/run/systemd/system/${unit}`]);
  await accepted("sudo", ["systemctl", "daemon-reload"]);
}
async function snapshot(): Promise<HostedSnapshot> {
  const result = await hostedRequest(port, token, origin, "GET", ""); assert.equal(result.status, 200, result.text);
  return hostedSnapshotSchema.parse(JSON.parse(result.text));
}
async function ready(): Promise<HostedSnapshot> {
  const end = performance.now() + 10000;
  while (performance.now() < end) {
    try { return await snapshot(); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ECONNREFUSED") throw error;
      await setTimeout(50);
    }
  }
  const log = await accepted("sudo", ["journalctl", "-u", unit, "--no-pager", "-n", "20"]);
  throw new Error(`Service did not become ready; private startup diagnostics: ${log}`);
}
async function action(value: Action): Promise<HostedSnapshot> {
  const before = await snapshot();
  const result = await hostedRequest(port, token, origin, "POST", JSON.stringify({ runId: before.runId, revision: before.revision, action: value }));
  assert.equal(result.status, 200, result.text); return hostedSnapshotSchema.parse(JSON.parse(result.text));
}
async function start(): Promise<HostedSnapshot> { await accepted("sudo", ["systemctl", "start", unit]); return ready(); }
async function stop(): Promise<void> { await accepted("sudo", ["systemctl", "stop", unit]); }
async function mainPid(): Promise<number> { return Number((await accepted("systemctl", ["show", unit, "-p", "MainPID", "--value"])).trim()); }
const sentinel = spawn("sleep", ["120"], { stdio: "ignore" }); assert.ok(sentinel.pid);
try {
  await accepted("bash", ["scripts/verify-private-package.sh", pkg, sdk]);
  await installUnit(pkg); const first = await start();
  assert.equal(first.revision, 0); assert.deepEqual(await readdir(state), ["writer.lock"]);
  assert.equal((await command("flock", ["--nonblock", "--no-fork", path.join(state, "writer.lock"), "true"], process.env)).code, 1);
  const bypass = await command(process.execPath, [path.join(pkg, "console/dist/src/hosted.js")], environment(pkg));
  assert.notEqual(bypass.code, 0, "Raw bootstrap must not bypass the OS writer lock");
  assert.match(bypass.stderr, /writer lock/i, "Port collision alone does not establish lock enforcement");
  await action({ action: "create" }); await action({ action: "fund" });
  const paid = await action({ action: "pay", amount: "10" }); assert.deepEqual(paid.snapshot.delivery, { received: "10", count: "1" });
  const session = (await readdir(state)).filter((name: string): boolean => name.startsWith("session-")); assert.equal(session.length, 1);
  const archive = path.join(state, session[0]!); const saved = await hashes(archive);
  for (const name of await readdir(archive)) assert.equal((await stat(path.join(archive, name))).mode & 0o077, 0);
  const processId = await mainPid(); assert.ok(processId > 1);
  const status = await readFile(`/proc/${processId}/status`, "utf8"); assert.match(status, new RegExp(`Uid:\\s+${process.getuid!()}\\s`));
  const writeCode = await command("sudo", ["nsenter", "--target", String(processId), "--mount", "--setuid", String(process.getuid!()), "--setgid", String(process.getgid!()), "touch", path.join(pkg, "forbidden-write")], process.env);
  assert.notEqual(writeCode.code, 0); assert.match(writeCode.stderr, /Read-only file system/);
  const limits = await accepted("systemctl", ["show", unit, "-p", "MemoryMax", "-p", "TasksMax", "-p", "CPUQuotaPerSecUSec", "-p", "KillMode", "-p", "Restart"]);
  assert.match(limits, /MemoryMax=1073741824/); assert.match(limits, /TasksMax=64/); assert.match(limits, /CPUQuotaPerSecUSec=1s/);
  assert.match(limits, /KillMode=control-group/); assert.match(limits, /Restart=no/);
  await stop(); const restarted = await start();
  assert.notEqual(restarted.runId, first.runId); assert.equal(restarted.snapshot.vault, null); assert.deepEqual(await hashes(archive), saved);
  const pid = await mainPid();
  const pending = hostedRequest(port, token, origin, "POST", JSON.stringify({ runId: restarted.runId, revision: 0, action: { action: "create" } }))
    .then((): string => "completed", (error: Error): string => error.name);
  let child = 0; const deadline = performance.now() + 5000;
  while (child === 0 && performance.now() < deadline) {
    for (const candidate of (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean)) {
      try {
        if (await readlink(`/proc/${candidate}/exe`) === path.join(sdk, "bin/avm-local-stand")) { process.kill(Number(candidate), "SIGSTOP"); child = Number(candidate); break; }
      } catch (error) { if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ESRCH"].includes(String(error.code))) throw error; }
    }
    if (child === 0) await setTimeout(2);
  }
  assert.ok(child > 1, "Must pause an actual owned AVM child during an admitted native action");
  const childLock = await readFile(`/proc/${child}/fdinfo/3`, "utf8");
  assert.match(childLock, /FLOCK\s+ADVISORY\s+WRITE/, "Every native writer must inherit the actual locked file description");
  assert.equal((await stat(`/proc/${child}/fd/3`)).ino, (await stat(path.join(state, "writer.lock"))).ino);
  const contender = command("flock", ["--exclusive", path.join(state, "writer.lock"), process.execPath, "--input-type=module", "-e",
    `import {readlinkSync} from "node:fs"; try { if(readlinkSync("/proc/${child}/exe")===${JSON.stringify(path.join(sdk, "bin/avm-local-stand"))}) process.exitCode=9; } catch(error) { if(error.code!=="ENOENT"&&error.code!=="ESRCH") throw error; }`], process.env);
  await accepted("sudo", ["systemctl", "kill", "--kill-whom=main", "--signal=KILL", unit]);
  const death = performance.now() + 15000; let exists = true;
  while (exists && performance.now() < death) {
    try { process.kill(child, 0); await setTimeout(25); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; exists = false; }
  }
  assert.equal(exists, false, "Supervisor must reap the old child before a new writer starts"); await pending;
  assert.equal((await contender).code, 0, "Contender may acquire only after the native writer exits");
  process.kill(sentinel.pid, 0); await stop();
  assert.deepEqual(await hashes(archive), saved);
  const allSaved = await hashes(state); const backup = path.join(root, "backup"); await cp(state, backup, { recursive: true, errorOnExist: true, force: false }); await chmod(backup, 0o700);
  const restored = path.join(root, "restore-drill"); await cp(backup, restored, { recursive: true, errorOnExist: true, force: false }); await chmod(restored, 0o700);
  assert.deepEqual(await hashes(restored), allSaved);
  // Reinstall the retained verified package, never an archived populated developer.state.
  const retained = path.join(root, "retained-package"); await cp(pkg, retained, { recursive: true, errorOnExist: true, force: false });
  await accepted("bash", ["scripts/verify-private-package.sh", retained, sdk]);
  await installUnit(retained); const rolled = await start();
  assert.equal(rolled.snapshot.vault, null); assert.notEqual(rolled.runId, restarted.runId); assert.deepEqual(await hashes(archive), saved);
  console.log(JSON.stringify({ event: "private_service_acceptance", singleWriter: true, orphanReaped: true, sentinelAlive: true,
    freshRestart: true, retainedArchives: true, backupRestore: true, retainedPackageReactivation: true, distinctVersionRollback: "not-qualified", resourceBudget: "1GiB/64tasks/1CPU" }));
} finally {
  await command("sudo", ["systemctl", "stop", unit], process.env);
  await command("sudo", ["rm", "-f", `/run/systemd/system/${unit}`], process.env);
  await accepted("sudo", ["systemctl", "daemon-reload"]);
  sentinel.kill("SIGTERM"); await access.close();
}
