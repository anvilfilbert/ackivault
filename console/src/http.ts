import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { actionSchema, RequestError, snapshotSchema, type Snapshot } from "./model.js";
import type { LocalStand } from "./stand.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
const staticFiles = new Map<string, { url: URL; contentType: string }>([
  ["/", { url: new URL("../../public/index.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/styles.css", { url: new URL("../../public/styles.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/app.js", { url: new URL("../browser/app.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
]);

function json(response: ServerResponse, status: number, data: Snapshot | { error: string }): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

export function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

export async function serveConsoleAsset(request: IncomingMessage, response: ServerResponse, browserScript: URL): Promise<void> {
  const file = request.method === "GET" ? staticFiles.get(request.url ?? "") : undefined;
  if (file === undefined) throw new RequestError(404, "Route is not available on this console");
  const content = await readFile(request.url === "/app.js" ? browserScript : file.url);
  response.writeHead(200, { "content-type": file.contentType }); response.end(content);
}

function serverWithRoutes(routes: Map<string, Handler>): Server {
  const server = createServer((request: IncomingMessage, response: ServerResponse): void => {
    securityHeaders(response);
    async function serve(): Promise<void> {
      const address = server.address();
      if (address === null || typeof address === "string") throw new RequestError(500, "Server has no local TCP address");
      const host = `127.0.0.1:${address.port}`;
      if (request.headers.host !== host) throw new RequestError(403, "Host must match the bound local console");
      if (request.method === "POST" && request.headers.origin !== `http://${host}`) throw new RequestError(403, "Mutation requests must come from this local console origin");
      const route = routes.get(`${request.method} ${request.url}`);
      if (route !== undefined) { await route(request, response); return; }
      await serveConsoleAsset(request, response, new URL("../browser/app.js", import.meta.url));
    }
    void serve().catch((error: Error): void => {
      if (error instanceof RequestError) json(response, error.status, { error: error.message });
      else if (error instanceof ZodError || error instanceof SyntaxError) json(response, 400, { error: `Invalid request: ${error.message}` });
      else { console.error(JSON.stringify({ event: "console_request_failed", name: error.name, message: error.message })); json(response, 500, { error: error.message }); }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

export async function body(request: IncomingMessage): Promise<string> {
  if (request.headers["content-type"] !== "application/json") throw new RequestError(415, "Action requests require Content-Type: application/json");
  return new Promise<string>((resolve, reject): void => {
    let chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer): void => { length += chunk.length; if (length <= 4096) chunks = [...chunks, chunk]; });
    request.on("end", (): void => { if (length > 4096) reject(new RequestError(413, "Action request exceeds the 4096-byte limit")); else resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", reject);
  });
}

export function createLiveServer(stand: LocalStand): Server {
  return serverWithRoutes(new Map<string, Handler>([
    ["GET /api/snapshot", async (_request, response): Promise<void> => { json(response, 200, stand.snapshot()); }],
    ["POST /api/action", async (request, response): Promise<void> => { const action = actionSchema.parse(JSON.parse(await body(request))); json(response, 200, await stand.execute(action)); }],
  ]));
}

export function createEvidenceServer(snapshot: Snapshot): Server {
  const checked = snapshotSchema.parse(snapshot);
  if (checked.source.kind !== "evidence" || checked.availableActions.length !== 0) throw new RequestError(500, "Evidence server requires a read-only evidence snapshot");
  return serverWithRoutes(new Map<string, Handler>([
    ["GET /api/snapshot", async (_request, response): Promise<void> => { json(response, 200, checked); }],
  ]));
}

export async function listen(server: Server, port: number): Promise<number> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RequestError(400, "Port must be an integer from 0 to 65535");
  await new Promise<void>((resolve, reject): void => { server.once("error", reject); server.listen(port, "127.0.0.1", (): void => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new RequestError(500, "Console failed to bind a local TCP port");
  return address.port;
}
