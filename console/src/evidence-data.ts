import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { snapshotSchema, type Activity, type Snapshot } from "./model.js";
import { addressSchema, decodeCall, decodeRecipient, decodeVault } from "./receipts.js";

export async function loadEvidence(directory: string, commit: string, runUrl: string): Promise<Snapshot> {
  const address = z.object({ address: addressSchema }).parse(JSON.parse(await readFile(path.join(directory, "main-funding-required.json"), "utf8"))).address;
  const latest = decodeCall(await readFile(path.join(directory, "withdraw.json"), "utf8"));
  const delivered = decodeCall(await readFile(path.join(directory, "recipient-after-withdraw.json"), "utf8"));
  const activity: Activity[] = [];
  for (const [file, identity, amount, time] of [
    ["deposit", "user", "100", 1800000005], ["pay", "user", "10", 1800000010],
    ["over-cap", "user", "986", 1800000020], ["wrong-key", "package-owner", "1", 1800000030],
    ["revoke", "package-owner", null, 1800000040], ["revoked-pay", "user", "1", 1800000050],
    ["withdraw", "package-owner", "7", 1800000060],
  ] as const) {
    const call = decodeCall(await readFile(path.join(directory, `${file}.json`), "utf8"));
    activity.push({ action: call.method, identity, amount, time, statusCode: call.statusCode, fee: call.receipt.charged_shells, messageId: call.receipt.message_id, file: `${file}.json` });
  }
  if (latest.statusCode !== 0 || delivered.statusCode !== 0) throw new Error("Evidence has a rejected final withdrawal or recipient read; cannot show successful delivery");
  return snapshotSchema.parse({ source: { kind: "evidence", commit, runUrl }, vault: { ...decodeVault(latest.raw_state), address }, balance: null, delivery: decodeRecipient(delivered.raw_state), activity, availableActions: [], failure: null });
}
