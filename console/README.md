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

The live entrypoint additionally requires `ACKIVAULT_RELEASE_MANIFEST`, identifying the verified source/runtime/profile and contract artifact checksums. Startup rejects a mismatch. Native tests derive their manifest fields from actual build inputs and require `ACKIVAULT_SOURCE_COMMIT` for that checkout; those test fixtures are not release packages.

Fund requires the pinned stand's acceptance event from the expected vault for exactly 100 units; missing or mismatched acceptance halts the session. Pay sends the entered amount plus a fixed 5-unit reserve. Revoke permanently disables agent payments. Withdraw is owner-only and sends recovery funds to the test recipient after revocation or expiry. Transfer delivery is confirmed by reading recipient state. Sample balance uses the owner-only `ackivault.inspect` method, which advances the owner nonce and emits the runtime-visible balance; execution fees may subsequently change it. Refresh reads only the cached view.

Every CLI invocation is preserved as JSON in the fresh session directory. Pay, Revoke and Withdraw rejections remain normal receipts with their specific executor status. An unexpected stand failure or unverified funding outcome halts the session; review its receipts before restarting. Signed operations are not automatically retried, and overlapping requests are rejected. The server owns only stand-generated test identities; it accepts no wallet import, arbitrary destination or network endpoint.

## Evidence viewer

Download `stand-diagnostics` from a successful workflow run. Its `.stand/native/` directory contains the fixed journey receipts; this parent directory is hidden on many hosts. On any supported Node host, including an ARM Mac, run:

```sh
npm run evidence -- \
  /path/to/stand-diagnostics/.stand/native \
  SOURCE_COMMIT_SHA \
  https://github.com/anvilfilbert/ackivault/actions/runs/RUN_ID \
  4317
```

Supply the actual 40-character source commit and corresponding run URL. The viewer labels the data as saved CI evidence and has no mutation route. It shows the fixed journey's final state, not a live balance. No balance is invented when the journey did not capture one. The ledger uses the fixed journey's simulated block times, not wall-clock times or inferred receipt timestamps.

## Private hosted laboratory

The separate `hosted` entrypoint implements the [private-console design](../docs/superpowers/specs/2026-10-15-private-console-hosting-design.md). It is still a test-only native stand, **not a network wallet, DEX.DO inference gateway or customer service**. It requires the approved Cloudflare Access identity/application token, exact HTTPS Host/Origin and explicit configuration from [the operator template](../deploy/private-console/hosted.env.example). Never expose the unauthenticated local/evidence entrypoints through a tunnel.

Hosted startup requires the reviewed Linux service unit and a real inherited writer lock; `npm run hosted` alone deliberately fails. The bootstrap validates descriptor 3 against the actual kernel lock, inode, device and process ownership, then deliberately passes it to each native writer. Exclusion survives the server's death until its last child exits. A launcher with another descriptor layout is unsupported and must not bypass this check. The service has no automatic restart. A restart starts a new, uncreated grant and retains the previous private state/receipts without restoring them. Refresh only reads the current cached snapshot. A lost response is not proof of failure: do not repeat a payment. The UI can reconcile a matching recorded result through a read-only refresh; a ready view with the same revision can instead establish that nothing has been admitted in that view. No action is resent. Even an authentication denial or stale-revision response can describe an invisible transport retry after the original executed, so neither response alone clears the pending intent.

On native Linux with the pinned SDK and clean source, prepare an **operator-local** package from the repository root:

```sh
ACKIVAULT_SDK_ROOT=/path/to/verified-sdk \
  bash scripts/package-private-console.sh "$PWD" .tools/private-package
bash scripts/verify-private-package.sh .tools/private-package /path/to/verified-sdk
```

The package builds from a fresh archive of the exact Git commit, not ignored working-tree outputs. It includes built application code, locked production dependencies, the explicit public assets and contract artifact triples, source/component digests and a unit template. Ignored private inputs and stale compiler outputs are excluded. The SDK binary is retrieved separately under its own license; no SDK, wallet, test state or credentials are bundled. Verification requires Node 22.18–22.x, native Linux x86-64-v3, glibc 2.39+, the exact file inventory and matched runtime/profile/artifacts. It rejects incompatible platforms instead of substituting an SDK.

A successful native CI run retains `application-package-SOURCE_COMMIT_SHA` for seven days. It contains `ackivault-application.tar.gz` and its SHA256 file, not the SDK or Node runtime. Publication checks reject package members outside the explicit application/dependency allowlist. CI unpacks and reverifies this archive, then runs the existing non-root service lifecycle against that unpacked copy before uploading it. Failed qualification does not publish an application archive; `stand-diagnostics` remains separate test evidence.

Download the artifact belonging to the exact reviewed commit. On the compatible Linux host, verify the archive before extracting into a **new** directory, then verify the extracted application against the separately obtained matching SDK:

```sh
sha256sum --check ackivault-application.tar.gz.sha256
mkdir verified-application
tar -xzf ackivault-application.tar.gz -C verified-application
bash verified-application/scripts/verify-private-package.sh verified-application /path/to/verified-sdk
```

These commands verify material, not install or activate a service. The artifact expires; retain a verified operator-local copy and its source/run provenance if needed. Its checksum detects byte changes but does not replace trust in the source workflow or an independent signature. No personal configuration or Cloudflare credential belongs in the archive.

Installation is **not automated here**. A separate approved host preflight must validate resources/co-hosts. The dedicated non-root service needs a pre-created owned 0700 state directory, immutable code/runtime, privately held operator configuration, the explicit Node path and the template's resource/supervision settings. Cloudflare policy must enforce the exact identity and independent MFA, and tunnel ingress must preserve the canonical Host, expose only that hostname to loopback and reject unmatched ingress. Cloudflare configuration, MFA, public-origin bypass resistance and actual host compatibility are unverified until separately approved staging.

The isolated CI service test checks retained-package reactivation with a fresh run, not rollback across two distinct application versions. A future version change needs that additional drill. A larger test-only initial execution budget isolates the expiry fixture from the stand's storage charges; it does not qualify an unattended one-hour session on the default 100,000-unit budget.

## Checks

The CI workflow runs both receipt/API checks and the live native console journey. For saved-evidence checks locally:

```sh
ACKIVAULT_EVIDENCE_DIR=/path/to/native npm test
```

Native integration additionally requires `ACKIVAULT_SDK_ROOT`, `ACKIVAULT_VAULT_ARTIFACTS`, `ACKIVAULT_RECEIPT_ARTIFACTS`, and `ACKIVAULT_CONSOLE_STATE`, then `npm run test:native`. Do not use an existing session as a new test: the connector always creates a fresh directory.

Hosted checks also require `ACKIVAULT_SOURCE_COMMIT`, `ACKIVAULT_TEST_CA_DIR` and `NODE_EXTRA_CA_CERTS`. Prepare a new ephemeral test CA with `bash scripts/prepare-console-test-ca.sh <new-private-directory>` **before Node starts**, then point the latter two settings to that directory and its `ca.pem`. Run `npm run test:hosted`, `npm run test:hosted-native`, and `npm run test:browser` after building; install Chromium with the pinned project-local Playwright tool. The fixtures use actual locally signed tokens, TLS, HTTP, Chromium and native execution; they do not establish Cloudflare/MFA behaviour. Browser traces and authentication/state files are not published. `test-private-service.sh` refuses to operate outside the isolated GitHub-hosted Linux CI environment.
