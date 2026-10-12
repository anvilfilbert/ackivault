import { z } from "zod";

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
  const output = bytes(call.raw_executor_output);
  if (output.length < 9 || output.subarray(0, 4).toString("ascii") !== "ACMO") {
    throw new ReceiptError("Executor output must have a complete ACMO header");
  }
  return { ...call, statusCode: output.readUInt32LE(4) };
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
  if (count === undefined || count < 1 || count > 4 || cap === 0n || spent > cap ||
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

/** Decode the pinned SDK's exact owner-inspection ACMO frame, not indexed event cells. */
export function decodeInspection(hex: string): string {
  const output = bytes(hex);
  if (output.length < 506 || output.subarray(0, 4).toString("ascii") !== "ACMO" ||
      output.readUInt32LE(4) !== 0 || output[8] !== 1 || output.readUInt32LE(9) !== 0 ||
      output.readUInt32LE(13) !== 473) throw new ReceiptError("Inspection must contain an accepted full-state ACMO result");
  decodeVault(output.subarray(17, 490).toString("hex"));
  if (output.readUInt32LE(490) !== 0 || output.readUInt32LE(494) !== 0 ||
      output.readUInt32LE(498) !== 0 || output.readUInt32LE(502) !== 1 ||
      output.length < 539 || output.readUInt32LE(506) !== 0 || output[510] !== 0 ||
      output.readBigUInt64LE(511) !== 0xd8b9dbeddc5209b2n || output.readUInt16LE(519) !== 16 ||
      output.subarray(521, 537).toString("ascii") !== "ackivault.status" || output.readUInt16LE(537) !== 0) {
    throw new ReceiptError("Inspection must emit exactly one external ackivault.status event without transfers or callbacks");
  }
  if (output.length !== 582 || output.readUInt32LE(539) !== 39 ||
      output.subarray(543, 566).toString("hex") !== "010000000e0004100062616c616e63655f7368656c6c73") {
    throw new ReceiptError("Inspection balance_shells field is malformed or has trailing bytes");
  }
  return integer(output, 566, 16).toString();
}
