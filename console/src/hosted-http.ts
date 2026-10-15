import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { AccessDeniedError, AccessUnavailableError, authorizeHostedRequest, type AccessVerifier } from "./access.js";
import type { HostedConfig } from "./hosted-config.js";
import { body, securityHeaders, serveConsoleAsset } from "./http.js";
import { hostedActionSchema, hostedSnapshotSchema, sanitizeHostedSnapshot, type FaultCode, type HostedSnapshot, type PublicFault } from "./hosted-model.js";
import { amountValue, RequestError, type Action } from "./model.js";
import { NativeOperationError } from "./operations.js";
import { StorageError } from "./journal.js";
import type { LocalStand } from "./stand.js";

class HostedRequestError extends RequestError {
  readonly code: FaultCode;
  constructor(status: number, code: FaultCode, message: string) { super(status, message); this.name = "HostedRequestError"; this.code = code; }
}

export function publicFailure(error: Error, diagnosticId: string): PublicFault {
  if (error instanceof AccessDeniedError) return { code: "AUTH_DENIED", diagnosticId, outcome: "not-started", message: "Access denied. Sign in with the permitted identity." };
  if (error instanceof AccessUnavailableError) return { code: "AUTH_UNAVAILABLE", diagnosticId, outcome: "not-started", message: "Login verification is unavailable. No new action was admitted." };
  if (error instanceof HostedRequestError) return { code: error.code, diagnosticId, outcome: "not-started", message: error.message };
  if (error instanceof RequestError && error.status >= 400 && error.status < 500) return { code: "INVALID_REQUEST", diagnosticId, outcome: "not-started", message: "The requested action is invalid or unavailable. Refresh the current session before continuing." };
  if (error instanceof NativeOperationError && error.reason === "ACTION_TIMEOUT") return { code: "ACTION_TIMEOUT", diagnosticId, outcome: "uncertain", message: "The action deadline expired. This session is halted; do not repeat the payment. Review private operator evidence." };
  if (error instanceof StorageError) return { code: "STORAGE_FAILURE", diagnosticId, outcome: "uncertain", message: "Evidence storage failed or is full. This session is halted. Preserve receipts and review private operator evidence." };
  return { code: "STAND_FAILURE", diagnosticId, outcome: "uncertain", message: "The native operation could not be verified. This session is halted; do not retry. Review private operator evidence." };
}

function respond(response: ServerResponse, status: number, data: HostedSnapshot | { error: PublicFault }): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(data));
}

function reportFailure(error: Error, diagnosticId: string, runId: string, directory: string): void {
  const cause = error.cause instanceof Error ? error.cause : error;
  const code = "code" in cause && typeof cause.code === "string" && /^[A-Z0-9_]{1,60}$/.test(cause.code) ? cause.code : null;
  // Arbitrary exception text may contain request bodies or raw native stdout; evidence stays private.
  console.error(JSON.stringify({ event: "hosted_request_failed", diagnosticId, runId, errorType: error.name,
    causeType: cause.name, causeCode: code, evidenceSession: directory === "" ? null : path.basename(directory) }));
}

/** A separate authenticated protocol; local/evidence servers never inherit a hosted bypass flag. */
export function createHostedServer(stand: LocalStand, config: HostedConfig, verifier: AccessVerifier, runId: string): Server {
  if (stand.runId !== runId) throw new Error("Hosted run ID must match its private stand evidence");
  let revision = 0;
  let busy = false;
  let fault: PublicFault | null = null;
  function snapshot(): HostedSnapshot {
    const view = sanitizeHostedSnapshot(stand.snapshot(), fault);
    return hostedSnapshotSchema.parse({ runId, revision, state: !server.listening ? "closing" : view.failure !== null ? "halted" : busy ? "busy" : "ready",
      snapshot: busy ? { ...view, availableActions: [] } : view, fault });
  }
  const server = createServer((request, response): void => {
    securityHeaders(response);
    async function serve(): Promise<void> {
      await authorizeHostedRequest(request, config.origin, verifier);
      if (request.method === "GET" && request.url === "/api/snapshot") { respond(response, 200, snapshot()); return; }
      if (request.method !== "POST" || request.url !== "/api/action") {
        await serveConsoleAsset(request, response, new URL("../browser/hosted.js", import.meta.url)); return;
      }
      let submitted: z.infer<typeof hostedActionSchema>;
      try {
        submitted = hostedActionSchema.parse(JSON.parse(await body(request)));
        if (submitted.action.action === "pay" || submitted.action.action === "withdraw") amountValue(submitted.action.amount);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) throw new HostedRequestError(400, "INVALID_REQUEST", "Invalid action request. Check its amount and session identifiers.");
        throw error;
      }
      if (submitted.runId !== runId) throw new HostedRequestError(409, "STALE_RUN", "Server restarted — reload to begin a fresh test session.");
      if (submitted.revision !== revision) throw new HostedRequestError(409, "STALE_REVISION", "This request was already admitted or uses an old revision. Refresh without repeating the action.");
      if (busy) throw new HostedRequestError(409, "BUSY", "An operation is running. Wait for its recorded outcome.");
      if (stand.snapshot().failure !== null || !server.listening) throw new HostedRequestError(409, "SESSION_HALTED", "Session halted or closing. Review private evidence; do not repeat the action.");
      const action: Action = submitted.action;
      if (!stand.snapshot().availableActions.includes(action.action)) throw new HostedRequestError(409, "INVALID_REQUEST", "This action is not available in the current grant state.");
      if (revision === Number.MAX_SAFE_INTEGER) throw new HostedRequestError(409, "SESSION_HALTED", "Session revision limit reached. Review evidence and start a fresh session.");
      revision++; busy = true;
      try { await stand.execute(action); }
      catch (error) {
        if (!(error instanceof Error)) throw new TypeError("Native action threw a non-Error value", { cause: error });
        fault = publicFailure(error, randomUUID()); throw error;
      } finally { busy = false; }
      respond(response, 200, snapshot());
    }
    void serve().catch((error): void => {
      if (!(error instanceof Error)) { response.destroy(new TypeError("Hosted request threw a non-Error value", { cause: error })); return; }
      const diagnosticId = fault !== null && stand.snapshot().failure !== null ? fault.diagnosticId : randomUUID();
      const safe = publicFailure(error, diagnosticId);
      if (!(error instanceof AccessDeniedError)) reportFailure(error, diagnosticId, runId, stand.evidenceDirectory);
      respond(response, error instanceof RequestError ? error.status : 502, { error: safe });
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxConnections = 32;
  return server;
}
