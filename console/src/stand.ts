import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { actionSchema, amountValue, RequestError, snapshotSchema, type Action, type Activity, type Snapshot } from "./model.js";
import { addressSchema, decodeCall, decodeInspection, decodeRecipient, decodeVault, hashSchema, receiptSchema, verifyDelivery, verifyFunding, type Call } from "./receipts.js";

type Config = { sdkRoot: string; vaultArtifacts: string; receiptArtifacts: string; stateParent: string };
type CommandResult = { code: number; stdout: string; stderr: string; file: string };
type Session = { state: string; receiver: string; vault: string; agent: string };
const DAPP = "11".repeat(32);
const DEPOSIT = 0xe940cf114abdd07an;

class StandCommandError extends Error {
  constructor(command: string, result: CommandResult) {
    super(`AVM ${command} failed with exit ${result.code}; stdout: ${result.stdout}; stderr: ${result.stderr}. Receipt retained as ${result.file}; do not retry an ambiguous signed operation.`);
    this.name = "StandCommandError";
  }
}

function le(value: bigint, length: number): Buffer {
  if (value < 0n || value >= (1n << BigInt(8 * length))) throw new RequestError(400, `Value does not fit in ${length} bytes`);
  return Buffer.from(value.toString(16).padStart(length * 2, "0").match(/../g)!.reverse().join(""), "hex");
}

function initArgs(agent: string, receiver: string, expiresAt: number): string {
  const args = Buffer.alloc(405);
  Buffer.from(hashSchema.parse(agent), "hex").copy(args, 0);
  args.writeUInt32LE(expiresAt, 32); le(1000n, 16).copy(args, 36); args[52] = 1;
  Buffer.from(addressSchema.parse(receiver).replace(":", ""), "hex").copy(args, 53);
  le(DEPOSIT, 8).copy(args, 117); le(5n, 16).copy(args, 125);
  return JSON.stringify(`0x${args.toString("hex")}`);
}

/** Owns one isolated local stand and its test identities. Signed mutations are never retried. */
export class LocalStand {
  private readonly config: Config;
  private session: Session | null = null;
  private view: Snapshot = { source: { kind: "live", commit: null, runUrl: null }, vault: null, balance: null, delivery: { received: "0", count: "0" }, activity: [], availableActions: ["create"], failure: null };
  private busy = false;
  private counter = 0;
  private blockTime = 0;
  private directory = "";

  constructor(config: Config) { this.config = { ...config }; }
  get evidenceDirectory(): string { return this.directory; }
  snapshot(): Snapshot { return snapshotSchema.parse(this.view); }

  async execute(request: Action): Promise<Snapshot> {
    const action = actionSchema.parse(request);
    if (action.action === "pay" || action.action === "withdraw") amountValue(action.amount);
    if (this.busy) throw new RequestError(409, "An AVM operation is already running; wait for its receipt");
    if (this.view.failure !== null) throw new RequestError(409, "Session halted after a stand failure; review saved receipts and start a fresh server");
    if (action.action === "create" && this.session !== null) throw new RequestError(409, "This console already owns a grant; start a fresh server for another isolated session");
    if (action.action !== "create" && this.session === null) throw new RequestError(409, "Create the local grant first");
    this.busy = true;
    try {
      if (action.action === "create") await this.create();
      else await this.apply(action);
      return this.snapshot();
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (!(error instanceof Error)) throw new TypeError("Stand failed with a non-Error value", { cause: error });
      this.view = { ...this.view, failure: error.message, availableActions: [] };
      throw error;
    } finally { this.busy = false; }
  }

  private tick(): number {
    this.blockTime = Math.max(Math.floor(Date.now() / 1000), this.blockTime + 1);
    return this.blockTime;
  }

  private async command(command: string, args: string[]): Promise<CommandResult> {
    const file = `${String(++this.counter).padStart(4, "0")}-${command}.json`;
    const state = path.join(this.directory, "developer.state");
    const argv = [command, "--state", state, "--wasmtime-profile", path.join(this.config.sdkRoot, "profiles/wasmtime-release-profile.v1"), ...args];
    const result = await new Promise<CommandResult>((resolve, reject): void => {
      execFile(path.join(this.config.sdkRoot, "bin/avm-local-stand"), argv, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr): void => {
        if (error !== null && typeof error.code !== "number") { reject(error); return; }
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr, file });
      });
    });
    await writeFile(path.join(this.directory, file), result.stdout, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (result.stderr.length > 0) console.warn(JSON.stringify({ event: "stand_diagnostic", command, receipt: file, stderr: result.stderr }));
    return result;
  }

  private async accepted(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.command(command, args);
    if (result.code !== 0) throw new StandCommandError(command, result);
    z.object({ status: z.literal("ok") }).parse(JSON.parse(result.stdout));
    return result;
  }

  private timestamps(): string[] {
    const time = this.tick();
    return ["--block-time", String(time), "--created-at", String(time), "--expire-at", String(time + 3600), "--fuel-fee-shells", "1000"];
  }

  private async deploy(artifacts: string, salt: string, args: string): Promise<string> {
    const time = this.timestamps();
    const argv = ["--wasm", path.join(artifacts, "contract.wasm"), "--acab", path.join(artifacts, "contract.acab"), "--descriptor", path.join(artifacts, "contract.descriptor"), "--salt-hex", salt, "--init-json", args, ...time];
    const quote = await this.command("deploy", argv);
    if (quote.code !== 2) throw new StandCommandError("deploy funding quote", quote);
    const funding = z.object({ error: z.literal("funding_required"), address: addressSchema }).parse(JSON.parse(quote.stdout));
    await this.accepted("fund-user", ["--address", funding.address, "--shells", "100000"]);
    const deployed = await this.accepted("deploy", argv);
    receiptSchema.parse(z.object({ receipt: receiptSchema }).parse(JSON.parse(deployed.stdout)).receipt);
    return funding.address;
  }

  private async create(): Promise<void> {
    for (const file of [path.join(this.config.sdkRoot, "bin/avm-local-stand"), path.join(this.config.sdkRoot, "profiles/wasmtime-release-profile.v1"), ...[this.config.vaultArtifacts, this.config.receiptArtifacts].flatMap((directory: string): string[] => ["contract.wasm", "contract.acab", "contract.descriptor"].map((name: string): string => path.join(directory, name)))]) {
      if (!(await stat(file)).isFile()) throw new RequestError(400, `Required local artifact is not a file: ${file}`);
    }
    await mkdir(this.config.stateParent, { recursive: true });
    this.directory = await mkdtemp(path.join(this.config.stateParent, "session-"));
    const initialized = await this.accepted("init", ["--dapp-id", DAPP]);
    const identities = z.object({ identities: z.object({ user: hashSchema, package_owner: hashSchema }) }).parse(JSON.parse(initialized.stdout));
    const receiver = await this.deploy(this.config.receiptArtifacts, "7265636569766572", "null");
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const vault = await this.deploy(this.config.vaultArtifacts, "7661756c74", initArgs(identities.identities.user, receiver, expiresAt));
    this.session = { state: path.join(this.directory, "developer.state"), receiver, vault, agent: identities.identities.user };
    this.view = { ...this.view, availableActions: ["fund", "pay", "revoke", "withdraw", "inspect"] };
    await this.inspect();
  }

  private current(): Session {
    if (this.session === null) throw new RequestError(409, "Local stand session is not initialized");
    return this.session;
  }

  private async call(address: string, method: string, args: string, identity: string, amount: string | null): Promise<Call> {
    const result = await this.accepted("call", ["--address", address, "--method", method, "--args-json", args, "--identity", identity, "--value-main", "0", "--extra-currencies", "", ...this.timestamps()]);
    const call = decodeCall(result.stdout);
    const entry: Activity = { action: method, identity, statusCode: call.statusCode, amount, fee: call.receipt.charged_shells, messageId: call.receipt.message_id, time: this.blockTime, file: result.file };
    this.view = { ...this.view, activity: [...this.view.activity, entry] };
    if (address === this.current().vault) this.view = { ...this.view, vault: { ...decodeVault(call.raw_state), address } };
    return call;
  }

  private async inspect(): Promise<void> {
    const call = await this.call(this.current().vault, "ackivault.inspect", "null", "package-owner", null);
    if (call.statusCode !== 0) throw new RequestError(502, `Owner inspection rejected with status ${call.statusCode}; cannot claim a current balance`);
    this.view = { ...this.view, balance: { shells: decodeInspection(call.raw_executor_output), time: this.blockTime } };
  }

  private async delivery(amount: string): Promise<void> {
    const call = await this.call(this.current().receiver, "stand.snapshot", "null", "user", null);
    if (call.statusCode !== 0) throw new Error(`Recipient snapshot rejected with status ${call.statusCode}; delivery remains unverified`);
    this.view = { ...this.view, delivery: verifyDelivery(this.view.delivery, decodeRecipient(call.raw_state), amount) };
  }

  private async apply(action: Exclude<Action, { action: "create" }>): Promise<void> {
    const session = this.current();
    if (action.action === "inspect") { await this.inspect(); return; }
    if (action.action === "fund") {
      const call = await this.call(session.receiver, "stand.forward_deposit", JSON.stringify(session.vault), "user", "100");
      verifyFunding(call, session.vault);
    } else if (action.action === "revoke") {
      await this.call(session.vault, "ackivault.revoke", "null", "package-owner", null);
    } else {
      const value = amountValue(action.amount);
      const body = action.action === "pay" ? Buffer.concat([Buffer.from([0]), le(value, 16)]) : Buffer.concat([Buffer.from(session.receiver.replace(":", ""), "hex"), le(DEPOSIT, 8), le(5n, 16), le(value, 16)]);
      const call = await this.call(session.vault, `ackivault.${action.action}`, JSON.stringify(`0x${body.toString("hex")}`), action.action === "pay" ? "user" : "package-owner", action.amount);
      if (call.statusCode === 0) await this.delivery(action.amount);
    }
    await this.inspect();
  }
}
