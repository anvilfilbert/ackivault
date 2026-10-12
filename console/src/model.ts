import { z } from "zod";
import { addressSchema, decimalSchema, hashSchema } from "./receipts.js";

const recipientSchema = z.object({ address: addressSchema, methodId: decimalSchema, reserve: decimalSchema });
const vaultSchema = z.object({
  address: addressSchema, owner: hashSchema, agent: hashSchema,
  expiresAt: z.number().int().nonnegative(), cap: decimalSchema, spent: decimalSchema,
  remaining: decimalSchema, revoked: z.boolean(), recipients: z.array(recipientSchema),
  ownerNonce: decimalSchema.nullable(), agentNonce: decimalSchema.nullable(),
});
export const activitySchema = z.object({
  action: z.string(), identity: z.string(), statusCode: z.number().int().nonnegative(),
  amount: decimalSchema.nullable(), fee: decimalSchema, messageId: hashSchema,
  time: z.number().int().nonnegative(), file: z.string().regex(/^[a-z0-9-]+\.json$/),
});
export type Activity = z.infer<typeof activitySchema>;
const actionName = z.enum(["create", "fund", "pay", "revoke", "withdraw", "inspect"]);
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("fund") }).strict(),
  z.object({ action: z.literal("inspect") }).strict(),
  z.object({ action: z.literal("revoke") }).strict(),
  z.object({ action: z.literal("pay"), amount: decimalSchema }).strict(),
  z.object({ action: z.literal("withdraw"), amount: decimalSchema }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const snapshotSchema = z.object({
  source: z.object({ kind: z.enum(["live", "evidence"]), commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(), runUrl: z.string().url().nullable() }),
  vault: vaultSchema.nullable(),
  balance: z.object({ shells: decimalSchema, time: z.number().int().nonnegative() }).nullable(),
  delivery: z.object({ received: decimalSchema, count: decimalSchema }),
  activity: z.array(activitySchema), availableActions: z.array(actionName),
  failure: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function amountValue(amount: string): bigint {
  const value = BigInt(decimalSchema.parse(amount));
  if (value === 0n || value > (1n << 128n) - 1n) throw new RequestError(400, "Amount must be a positive decimal integer no greater than u128::MAX");
  return value;
}

export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "RequestError"; this.status = status; }
}

export function statusLabel(code: number): string {
  const names: readonly string[] = [
    "Invalid arguments", "Unsupported message", "Invalid owner key", "Invalid agent key",
    "Invalid expiry", "Invalid cap", "Invalid recipient count", "Invalid recipient", "Duplicate recipient",
    "Invalid state length", "Unsupported state version", "Invalid state encoding", "Unauthorized agent",
    "Unauthorized owner", "Agent nonce replay", "Owner nonce replay", "Recipient not allowed",
    "Grant expired", "Grant revoked", "Grant still active", "Already revoked", "Invalid amount",
    "Invalid destination", "Amount overflow", "Cap exceeded", "Insufficient SHELL balance",
    "Wrong message type", "Invalid incoming value", "Invalid signature", "Event encoding failed",
  ];
  if (code === 0) return "Accepted";
  const name = names[code - 1000];
  return name === undefined ? `Contract rejected: status ${code}` : `${name} · ${code}`;
}
