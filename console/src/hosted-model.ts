import { z } from "zod";
import { actionSchema, snapshotSchema, type Snapshot } from "./model.js";

export const faultCodeSchema = z.enum(["AUTH_DENIED", "AUTH_UNAVAILABLE", "INVALID_REQUEST", "STALE_RUN", "STALE_REVISION", "BUSY", "ACTION_TIMEOUT", "STORAGE_FAILURE", "STAND_FAILURE", "SESSION_HALTED"]);
export type FaultCode = z.infer<typeof faultCodeSchema>;
export const publicFaultSchema = z.object({ code: faultCodeSchema, message: z.string().min(1).max(300), diagnosticId: z.uuid(), outcome: z.enum(["not-started", "uncertain", "verified"]) });
export type PublicFault = z.infer<typeof publicFaultSchema>;
const runIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/);
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hostedActionSchema = z.object({ runId: runIdSchema, revision: revisionSchema, action: actionSchema }).strict();
export type HostedAction = z.infer<typeof hostedActionSchema>;
export const hostedSnapshotSchema = z.object({
  runId: runIdSchema, revision: revisionSchema, state: z.enum(["ready", "busy", "halted", "closing"]), snapshot: snapshotSchema, fault: publicFaultSchema.nullable(),
});
export type HostedSnapshot = z.infer<typeof hostedSnapshotSchema>;

/** Raw connector failures remain server-side even when a cached snapshot is returned. */
export function sanitizeHostedSnapshot(snapshot: Snapshot, fault: PublicFault | null): Snapshot {
  return snapshotSchema.parse({ ...snapshot, failure: snapshot.failure === null ? null : fault === null ? "Session halted; review private operator evidence before starting another session." : fault.message });
}
