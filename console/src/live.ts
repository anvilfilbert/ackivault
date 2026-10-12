import path from "node:path";
import { LocalStand } from "./stand.js";
import { createLiveServer, listen } from "./http.js";

const args: string[] = process.argv.slice(2);
if (args.length !== 5) throw new Error("usage: live <sdk-root> <vault-artifacts> <receipt-artifacts> <state-parent> <port>");
const [sdk, vault, receipt, state, port] = args as [string, string, string, string, string];
const stand = new LocalStand({ sdkRoot: path.resolve(sdk), vaultArtifacts: path.resolve(vault), receiptArtifacts: path.resolve(receipt), stateParent: path.resolve(state) });
const bound = await listen(createLiveServer(stand), Number(port));
console.log(JSON.stringify({ event: "console_listening", source: "local-stand", url: `http://127.0.0.1:${bound}` }));
