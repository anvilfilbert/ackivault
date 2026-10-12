import path from "node:path";
import { loadEvidence } from "./evidence-data.js";
import { createEvidenceServer, listen } from "./http.js";

const args: string[] = process.argv.slice(2);
if (args.length !== 4) throw new Error("usage: evidence <evidence-dir> <source-commit> <run-url> <port>");
const [directory, commit, runUrl, port] = args as [string, string, string, string];
const snapshot = await loadEvidence(path.resolve(directory), commit, runUrl);
const bound = await listen(createEvidenceServer(snapshot), Number(port));
console.log(JSON.stringify({ event: "console_listening", source: "saved-ci-evidence", url: `http://127.0.0.1:${bound}` }));
