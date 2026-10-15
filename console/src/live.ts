import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalStand } from "./stand.js";
import { createLiveServer, listen } from "./http.js";
import { loadStandProvenance } from "./journal.js";

const args: string[] = process.argv.slice(2);
if (args.length !== 5) throw new Error("usage: live <sdk-root> <vault-artifacts> <receipt-artifacts> <state-parent> <port>");
const [sdk, vault, receipt, state, port] = args as [string, string, string, string, string];
const paths = { sdkRoot: path.resolve(sdk), vaultArtifacts: path.resolve(vault), receiptArtifacts: path.resolve(receipt), stateParent: path.resolve(state) };
const manifest = process.env.ACKIVAULT_RELEASE_MANIFEST;
if (manifest === undefined || manifest.length === 0) throw new Error("ACKIVAULT_RELEASE_MANIFEST must identify the verified runtime/artifact release manifest");
const stand = new LocalStand({ paths, provenance: await loadStandProvenance(manifest, paths), runId: randomUUID(),
  execution: { actionDeadlineMs: 60000, terminationGraceMs: 2000, maxOutputBytes: 4194304 }, evidence: { maxBytes: 1073741824, minFreeBytes: 268435456 } });
const bound = await listen(createLiveServer(stand), Number(port));
console.log(JSON.stringify({ event: "console_listening", source: "local-stand", url: `http://127.0.0.1:${bound}` }));
