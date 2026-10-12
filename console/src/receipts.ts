import { z } from "zod";
import { decodeOutput } from "./acmo.js";

export const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const addressSchema = z.string().regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
const hexSchema = z.string().regex(/^(?:[0-9a-f]{2})*$/);
export const receiptSchema = z.object({
  charged_shells: decimalSchema,
  cumulative_fee_shells: decimalSchema,
  height: z.number().int().nonnegative(),
  message_id: hashSchema,
  account_state_root: hashSchema,
  registry_root: hashSchema,
});
const callSchema = z.object({
  status: z.literal("ok"), method: z.string().min(1),
  raw_state: hexSchema, raw_executor_output: hexSchema,
  events: z.array(hexSchema), receipt: receiptSchema,
});
export type Call = z.infer<typeof callSchema> & { statusCode: number };
export type Recipient = { address: string; methodId: string; reserve: string };
export type Vault = {
  owner: string; agent: string; expiresAt: number; cap: string; spent: string;
  remaining: string; revoked: boolean; recipients: Recipient[];
  ownerNonce: string | null; agentNonce: string | null;
};
export type Delivery = { received: string; count: string };

export class ReceiptError extends Error {
  constructor(message: string) { super(message); this.name = "ReceiptError"; }
}

function bytes(hex: string): Buffer {
  return Buffer.from(hexSchema.parse(hex), "hex");
}

function integer(buffer: Buffer, offset: number, length: number): bigint {
  const value = buffer.subarray(offset, offset + length);
  if (value.length !== length) throw new ReceiptError(`Truncated integer at byte ${offset}; need ${length} bytes`);
  return BigInt(`0x${Buffer.from(value).reverse().toString("hex")}`);
}

export function decodeCall(text: string): Call {
  const call = callSchema.parse(JSON.parse(text));
  const output = decodeOutput(bytes(call.raw_executor_output));
  if (output.state !== null && output.state !== call.raw_state) throw new ReceiptError("Executor replacement does not match receipt raw_state");
  if (output.statusCode !== 0 && call.events.length !== 0) throw new ReceiptError("Rejected executor receipt contains events");
  return { ...call, statusCode: output.statusCode };
}

export function decodeVault(hex: string): Vault {
  const state = bytes(hex);
  if (state.length !== 473) throw new ReceiptError(`Vault state must be 473 bytes; received ${state.length}`);
  if (state[0] !== 1) throw new ReceiptError(`Unsupported vault state version ${state[0]}`);
  const owner = hashSchema.parse(state.subarray(1, 33).toString("hex"));
  const agent = hashSchema.parse(state.subarray(33, 65).toString("hex"));
  const cap = integer(state, 69, 16);
  const spent = integer(state, 85, 16);
  const count = state[120];
  if (count === undefined || count < 1 || count > 4 || cap === 0n || spent > cap || state.readUInt32LE(65) === 0 ||
      /^0+$/.test(owner) || /^0+$/.test(agent) ||
      ![0, 1].includes(state[101]!) || ![0, 1].includes(state[102]!) || ![0, 1].includes(state[111]!)) {
    throw new ReceiptError("Vault state violates key, cap, flag or recipient-count invariants");
  }
  const recipients: Recipient[] = Array.from({ length: count }, (_, index: number): Recipient => {
    const offset = 121 + index * 88;
    const dapp = state.subarray(offset, offset + 32).toString("hex");
    const account = state.subarray(offset + 32, offset + 64).toString("hex");
    const method = integer(state, offset + 64, 8);
    if (/^0+$/.test(dapp) || /^0+$/.test(account) || method === 0n) throw new ReceiptError("Vault recipient has a zero address or method");
    return { address: `${dapp}:${account}`, methodId: method.toString(), reserve: integer(state, offset + 72, 16).toString() };
  });
  if (new Set(recipients.map((recipient: Recipient): string => recipient.address)).size !== count ||
      state.subarray(121 + count * 88).some((byte: number): boolean => byte !== 0) ||
      (state[102] === 0 && integer(state, 103, 8) !== 0n) ||
      (state[111] === 0 && integer(state, 112, 8) !== 0n)) {
    throw new ReceiptError("Vault state has duplicate recipients or noncanonical unused bytes");
  }
  return {
    owner, agent, expiresAt: state.readUInt32LE(65), cap: cap.toString(), spent: spent.toString(),
    remaining: (cap - spent).toString(), revoked: state[101] === 1, recipients,
    ownerNonce: state[102] === 1 ? integer(state, 103, 8).toString() : null,
    agentNonce: state[111] === 1 ? integer(state, 112, 8).toString() : null,
  };
}

export function decodeRecipient(hex: string): Delivery {
  const state = bytes(hex);
  if (state.length !== 24) throw new ReceiptError(`Recipient state must be 24 bytes; received ${state.length}`);
  return { received: integer(state, 0, 16).toString(), count: integer(state, 16, 8).toString() };
}

export function verifyDelivery(before: Delivery, after: Delivery, amount: string): Delivery {
  const expectedAmount = BigInt(before.received) + BigInt(decimalSchema.parse(amount));
  const expectedCount = BigInt(before.count) + 1n;
  if (BigInt(after.received) !== expectedAmount || BigInt(after.count) !== expectedCount) {
    throw new ReceiptError(`Delivery mismatch: expected ${expectedAmount} received units / ${expectedCount} receipts, observed ${after.received} / ${after.count}. Transfer outcome is not reconciled; do not retry.`);
  }
  return { ...after };
}

/**
 * Verify the pinned stand's 100-SHELL deposit shape, not arbitrary Cap'n Proto events.
 * Offsets follow AvmEvent/EventValue in runtime 335a0f09fdbc's embedded schema
 * (SDK 0cbca40fad9a), checked against native receipts. The root has four data
 * words and six pointers; source IDs occupy bytes 88..152, then txHash, then
 * eventName and one amount_shells U128 field. Canonical U128(100) omits its zero
 * high word. Logical time, wall time, sequence and txHash remain opaque.
 */
export function verifyFunding(call: Call, vault: string): void {
  const expectedVault = addressSchema.parse(vault);
  const context = `Funding receipt ${call.receipt.message_id} for ${expectedVault}`;
  if (call.method !== "stand.forward_deposit" || call.statusCode !== 0 || call.events.length !== 1) {
    throw new ReceiptError(`${context}: expected stand.forward_deposit status 0 and one vault acceptance; observed ${call.method} status ${call.statusCode} and ${call.events.length} events. Funding outcome is not reconciled; do not retry.`);
  }
  const event = bytes(call.events[0]!);
  const metadata = "0000000000000000" + "6face8a8a6cdeb2a" +
    "150000000201000021000000020100002d00000002010000" +
    "39000000da00000045000000060000004100000017000000";
  const payload = "61636b697661756c742e6465706f7369745f6163636570746564000000000000" +
    "040000000000020005000000720000000800000001000100" +
    "616d6f756e745f7368656c6c73000000040000000000000000000000010000006400000000000000";
  if (event.length !== 280 || event.subarray(0, 8).toString("hex") !== "0000000004000600" ||
      event.subarray(24, 88).toString("hex") !== metadata || event.subarray(184).toString("hex") !== payload) {
    throw new ReceiptError(`${context}: expected the pinned 280-byte external ackivault.deposit_accepted event with exactly amount_shells U128(100); received ${event.length} bytes with a mismatched layout, class, name or amount. Funding outcome is not reconciled; do not retry.`);
  }
  const source = `${event.subarray(88, 120).toString("hex")}:${event.subarray(120, 152).toString("hex")}`;
  if (source !== expectedVault) {
    throw new ReceiptError(`${context}: deposit acceptance came from ${source}. Funding outcome is not reconciled; do not retry.`);
  }
}

/** Decode the pinned SDK's exact owner-inspection ACMO frame, not indexed event cells. */
export function decodeInspection(hex: string): string {
  const output = decodeOutput(bytes(hex));
  if (output.statusCode !== 0 || output.state === null || output.outboundCount !== 0 || output.events.length !== 1) throw new ReceiptError("Inspection must be accepted with one event and no transfers");
  decodeVault(output.state);
  const event = output.events[0]!;
  const field = event.fields[0];
  if (event.name !== "ackivault.status" || event.eventClass !== 0xd8b9dbeddc5209b2n ||
      event.fields.length !== 1 || field?.name !== "balance_shells" || field.kind !== 4) throw new ReceiptError("Inspection must contain one canonical balance_shells field");
  return integer(field.bytes, 0, 16).toString();
}
