import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { actionSchema, amountValue, RequestError, snapshotSchema, type Action, type Activity, type Snapshot } from "./model.js";
import { addressSchema, decodeCall, decodeInspection, decodeRecipient, decodeVault, hashSchema, receiptSchema, verifyDelivery, verifyFunding, type Call } from "./receipts.js";
import { executionLimitsSchema, evidenceLimitsSchema, standPathsSchema, type StandPaths, type ExecutionLimits, type EvidenceLimits } from "./hosted-config.js";
import { EvidenceJournal, provenanceSchema, type StandProvenance } from "./journal.js";
import { runNativeCommand, type CommandResult } from "./operations.js";

export type StandConfig = { paths: StandPaths; execution: ExecutionLimits; evidence: EvidenceLimits; provenance: StandProvenance; runId: string };
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
  private readonly config: StandConfig;
  private session: Session | null = null;
  private view: Snapshot = { source: { kind: "live", commit: null, runUrl: null }, vault: null, balance: null, delivery: { received: "0", count: "0" }, activity: [], availableActions: ["create"], failure: null };
  private busy = false;
  private counter = 0;
  private blockTime = 0;
  private directory = "";
  private journal: EvidenceJournal | null = null;
  private deadlineAtMs = 0;
  private actionCommands = 0;
  private closing = false;

  constructor(config: StandConfig) {
    this.config = { paths: standPathsSchema.parse(config.paths), execution: executionLimitsSchema.parse(config.execution),
      evidence: evidenceLimitsSchema.parse(config.evidence), provenance: provenanceSchema.parse(config.provenance), runId: config.runId };
  }
  get evidenceDirectory(): string { return this.directory; }
  snapshot(): Snapshot { return snapshotSchema.parse(this.view); }
  async shutdown(): Promise<void> { this.closing = true; while (this.busy) await setTimeout(25); }

  async execute(request: Action): Promise<Snapshot> {
    const action = actionSchema.parse(request);
    if (action.action === "pay" || action.action === "withdraw") amountValue(action.amount);
    if (this.closing) throw new RequestError(409, "This stand is shutting down; no new signed actions are accepted");
    if (this.busy) throw new RequestError(409, "An AVM operation is already running; wait for its receipt");
    if (this.view.failure !== null) throw new RequestError(409, "Session halted after a stand failure; review saved receipts and start a fresh server");
    if (action.action === "create" && this.session !== null) throw new RequestError(409, "This console already owns a grant; start a fresh server for another isolated session");
    if (action.action !== "create" && this.session === null) throw new RequestError(409, "Create the local grant first");
    this.busy = true;
    this.deadlineAtMs = performance.now() + this.config.execution.actionDeadlineMs;
    this.actionCommands = 0;
    try {
      if (action.action === "create") await this.create();
      else await this.apply(action);
      return this.snapshot();
    } catch (error) {
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
    if (this.journal === null) throw new Error("Native command has no private evidence journal");
    if (++this.actionCommands > 16) throw new Error("Native action exceeded its 16-command evidence budget");
    return runNativeCommand({ command, args, directory: this.directory, sequence: ++this.counter, deadlineAtMs: this.deadlineAtMs },
      this.config.paths, this.config.execution, this.journal);
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
    for (const file of [path.join(this.config.paths.sdkRoot, "bin/avm-local-stand"), path.join(this.config.paths.sdkRoot, "profiles/wasmtime-release-profile.v1"), ...[this.config.paths.vaultArtifacts, this.config.paths.receiptArtifacts].flatMap((directory: string): string[] => ["contract.wasm", "contract.acab", "contract.descriptor"].map((name: string): string => path.join(directory, name)))]) {
      if (!(await stat(file)).isFile()) throw new RequestError(400, `Required local artifact is not a file: ${file}`);
    }
    await mkdir(this.config.paths.stateParent, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(path.join(this.config.paths.stateParent, "session-"));
    this.journal = new EvidenceJournal(this.directory, this.config.evidence);
    await this.journal.recordSession(this.config.runId, this.config.provenance);
    const initialized = await this.accepted("init", ["--dapp-id", DAPP]);
    const identities = z.object({ identities: z.object({ user: hashSchema, package_owner: hashSchema }) }).parse(JSON.parse(initialized.stdout));
    const receiver = await this.deploy(this.config.paths.receiptArtifacts, "7265636569766572", "null");
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const vault = await this.deploy(this.config.paths.vaultArtifacts, "7661756c74", initArgs(identities.identities.user, receiver, expiresAt));
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
