# Local console

The console runs only on `127.0.0.1`, using Node.js 22.18 or later in the 22.x line. Install the locked project dependencies and build from this directory:

```sh
npm ci
npm run build
```

## Live stand

On a Linux x86-64-v3 host, build both contracts as described in the repository README, then run from `console/`:

```sh
npm run live -- \
  /path/to/avm-sdk-linux-x86_64 \
  ../contract/target/avm \
  ../tests/stand/receipt/target/avm \
  ../.stand/console 4317
```

Open `http://127.0.0.1:4317`. Create deploys one grant with a 1,000-unit allowance, a one-hour expiry and a fixed receipt contract. Each deployment receives 100,000 local test units for execution; Fund transfers an additional 100 from the fixture. Amounts are raw stand SHELL units, not a displayed wallet denomination. No real money is involved.

Fund requires the pinned stand's acceptance event from the expected vault for exactly 100 units; missing or mismatched acceptance halts the session. Pay sends the entered amount plus a fixed 5-unit reserve. Revoke permanently disables agent payments. Withdraw is owner-only and sends recovery funds to the test recipient after revocation or expiry. Transfer delivery is confirmed by reading recipient state. Sample balance uses the owner-only `ackivault.inspect` method, which advances the owner nonce and emits the runtime-visible balance; execution fees may subsequently change it. Refresh reads only the cached view.

Every CLI invocation is preserved as JSON in the fresh session directory. Pay, Revoke and Withdraw rejections remain normal receipts with their specific executor status. An unexpected stand failure or unverified funding outcome halts the session; review its receipts before restarting. Signed operations are not automatically retried, and overlapping requests are rejected. The server owns only stand-generated test identities; it accepts no wallet import, arbitrary destination or network endpoint.

## Evidence viewer

Download `stand-diagnostics` from a successful workflow run. Its `native/` directory contains the fixed journey receipts. On any supported Node host, including an ARM Mac, run:

```sh
npm run evidence -- \
  /path/to/stand-diagnostics/native \
  SOURCE_COMMIT_SHA \
  https://github.com/anvilfilbert/ackivault/actions/runs/RUN_ID \
  4317
```

Supply the actual 40-character source commit and corresponding run URL. The viewer labels the data as saved CI evidence and has no mutation route. It shows the fixed journey's final state, not a live balance. No balance is invented when the journey did not capture one. The ledger uses the fixed journey's simulated block times, not wall-clock times or inferred receipt timestamps.

## Checks

The CI workflow runs both receipt/API checks and the live native console journey. For saved-evidence checks locally:

```sh
ACKIVAULT_EVIDENCE_DIR=/path/to/native npm test
```

Native integration additionally requires `ACKIVAULT_SDK_ROOT`, `ACKIVAULT_VAULT_ARTIFACTS`, `ACKIVAULT_RECEIPT_ARTIFACTS`, and `ACKIVAULT_CONSOLE_STATE`, then `npm run test:native`. Do not use an existing session as a new test: the connector always creates a fresh directory.
