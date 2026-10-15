import { randomUUID } from "node:crypto";
import { AccessVerifier } from "./access.js";
import { loadHostedConfig } from "./hosted-config.js";
import { createHostedServer } from "./hosted-http.js";
import { listen } from "./http.js";
import { loadStandProvenance } from "./journal.js";
import { LocalStand } from "./stand.js";

const config = loadHostedConfig(process.env);
const provenance = await loadStandProvenance(config.releaseManifest, config.paths);
const runId = randomUUID();
const stand = new LocalStand({ paths: config.paths, execution: config.execution, evidence: config.evidence, provenance, runId });
const server = createHostedServer(stand, config, new AccessVerifier(config.access), runId);
await listen(server, config.port);
console.log(JSON.stringify({ event: "hosted_console_listening", runId, applicationCommit: provenance.applicationCommit, testFundsOnly: true }));
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const stopped = new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); });
  await stand.shutdown(); server.closeAllConnections(); await stopped;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, (): void => {
  void shutdown().catch((error: Error): void => { console.error(JSON.stringify({ event: "hosted_shutdown_failed", errorType: error.name })); process.exitCode = 1; });
});
