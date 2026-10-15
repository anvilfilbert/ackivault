# Private Console Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the existing test-only AVM console for one authenticated remote operator, without deploying it or adding DEX.DO inference routing.

**Architecture:** Keep the localhost/evidence entrypoints and add a separate hosted entrypoint. Cloudflare Access plus independent MFA protects a tunnel-only origin, which also verifies Access JWTs. One supervised stand session owns a private evidence directory; run/revision guards prevent duplicate or stale submissions, and restart always starts fresh.

**Tech Stack:** Existing Node.js 22 ESM/TypeScript/Zod console and pinned AVM distribution, `jose` 6.2.12 for JWT/JWKS, Node's test runner, `@playwright/test` 1.64.1 for browser acceptance, native Linux/systemd for lifecycle verification. These new dependency versions were checked against the public npm registry during planning; installation, lockfile changes and compatibility tests are implementation work.

**Spec:** [Approved private-console hosting design](../specs/2026-10-15-private-console-hosting-design.md).

**Status:** Written plan for review, not execution approval. No checklist item below is completed by writing this document. Baseline application source is `093b77971e1d28cb111229eba338abbcf27b64b9`; the reviewed specification was introduced by `cc4bd97b1b122194135f71b18ff0c86b3b858dff`.

## Global Constraints

- One permitted identity, Cloudflare Access with enforced independent MFA, an outbound tunnel and a `127.0.0.1` application listener. No public application port, bypass policy or application password database.
- Fresh run after service restart; previous state/receipts retained. Browser refresh does not reset a running session. No automatic restoration, pruning, migration or signed retry.
- Test identities and funds only. No DEX.DO client, wallet import, network endpoint, arbitrary recipient, inference API, real money or customer service.
- Preserve the existing grant, exact receipt validation, independent recipient checks and inspection/replay evidence. Contract source and grant semantics do not change.
- Node.js `>=22.18.0 <23`, Rust `1.93.0`, Linux x86-64-v3 and glibc `>=2.39`. SDK distribution `0.2.0`, guest SDK `0.1.1`, source `0748f4f0767a26da8bc363bcb6b5585539d6970e`, runtime `06e96ef71006cca020575cbf35e6b82cc82a324e`; retain the verification guide's exact archive/profile checks.
- Follow the user's explicit-parameter, strict-type, runtime-validation and structured-error rules. Classes are only external-system connectors/interfaces or established error types; no generic catch-and-ignore or anonymous fallback.
- Native Linux evidence is required for stand/process/supervisor claims. Synthetic signed JWT fixtures test the verifier, not Cloudflare MFA enforcement.
- No VPS, DNS, Access policy, login account, tunnel or shared-host mutation is authorized. Real identity, hostname, credentials, paths and host details stay out of public Git.

## Review Focus

1. Repeated or comma-joined authentication/Host headers must not be interpreted differently by the tunnel and Node; Task 1 rejects ambiguity before native work.
2. A lost HTTP response followed by a resend, a delayed old tab or authentication renewal must not pay twice or silently switch runs; Tasks 3 and 4 test this.
3. A full disk, failed evidence write or output-buffer overflow after execution must not become a successful response or free the session for retry; Task 2 tests this.
4. A server dying while a native child still writes must not allow a replacement writer or kill unrelated services; Task 5 exercises the real supervisor boundary.
5. JWKS rotation, cached-key expiry and a network outage must deny unverifiable requests without accepting an attacker-provided key URL; Task 1 tests the actual verification library and local HTTPS key server.

## Files and responsibility boundaries

| Files | Responsibility |
| --- | --- |
| `console/src/hosted-config.ts`, `console/src/access.ts` | Explicit hosted configuration and JWT/HTTP identity boundary. |
| `console/src/operations.ts`, `console/src/journal.ts`, existing `console/src/stand.ts` | Bounded child execution, private evidence and existing AVM actions. |
| `console/src/hosted-model.ts`, `console/src/hosted-http.ts`, `console/src/hosted.ts`, existing `console/src/http.ts` | Hosted run/revision protocol, safe responses, distinct bootstrap and shared fixed static/body handling. |
| `console/browser/render.ts`, `console/browser/hosted.ts`, existing `console/browser/app.ts`, `console/public/index.html` | Shared presentation and explicit hosted-session UX, without changing local/evidence wire formats. |
| `console/test/access-fixture.ts`, `console/test/hosted.test.ts`, `console/test/hosted-stand.test.ts`, `console/test/hosted-browser.spec.ts`, `console/playwright.config.ts`, `scripts/prepare-console-test-ca.sh` | Real signed-token/HTTPS, HTTP, native and browser integration evidence, using an ephemeral test CA prepared before Node starts. |
| `scripts/package-private-console.sh`, `scripts/verify-private-package.sh`, `scripts/test-private-service.sh`, `deploy/private-console/ackivault.service.in`, `deploy/private-console/hosted.env.example` | Reproducible operator package and isolated supervisor tests; no deployment automation against a real host. |
| Existing `console/package.json`, `console/package-lock.json`, `.github/workflows/stand-e2e.yml`, `console/README.md`, `docs/verification.md` | Locked tooling, complete checks and truthful current-state instructions. |

Use small cohesive files. Existing logic is moved or reused rather than copied. File paths below are repository-relative; no developer or deployment paths are embedded in the implementation.

## Shared interfaces and explicit settings

Define these types in the owning files before consumers use them; infer wire/config types from Zod schemas rather than maintaining duplicate descriptions:

- `hosted-config.ts`: `AccessConfig { issuer: string; audience: string; allowedEmail: string; jwksTimeoutMs: number; jwksAttempts: number; jwksRetryDelayMs: number; jwksCacheMs: number; jwksCooldownMs: number }`; `ExecutionLimits { actionDeadlineMs: number; terminationGraceMs: number; maxOutputBytes: number }`; `EvidenceLimits { maxBytes: number; minFreeBytes: number }`; `StandPaths { sdkRoot: string; vaultArtifacts: string; receiptArtifacts: string; stateParent: string }`; `HostedConfig { origin: string; port: number; access: AccessConfig; execution: ExecutionLimits; evidence: EvidenceLimits; paths: StandPaths; releaseManifest: string }`.
- `access.ts`: `VerifiedIdentity { email: string; subject: string }`; `AccessVerifier` is the HTTPS/JWKS connector with `constructor(config: AccessConfig)` and `verify(token: string): Promise<VerifiedIdentity>`.
- `operations.ts`: `NativeInvocation { command: string; args: readonly string[]; directory: string; deadlineAtMs: number }`; `CommandResult { code: number; stdout: string; stderr: string; file: string }`; `runNativeCommand(invocation: NativeInvocation, paths: StandPaths, limits: ExecutionLimits, journal: EvidenceJournal): Promise<CommandResult>`. `deadlineAtMs` is monotonic and shared by every command in one action.
- `journal.ts`: `StandProvenance { applicationCommit: string; sdkCommit: string; runtimeCommit: string; profileSha256: string; vaultArtifactSha256: readonly string[]; recipientArtifactSha256: readonly string[] }`; `EvidenceJournal` is the private-filesystem connector. Its `constructor(directory: string, limits: EvidenceLimits)` receives an existing private session directory; `recordSession(runId: string, provenance: StandProvenance): Promise<void>`, `recordIntent(sequence: number, command: string): Promise<void>`, `recordResult(sequence: number, command: string, stdout: string, stderr: string, code: number | null, signal: string | null): Promise<string>`, `checkCapacity(requiredBytes: number): Promise<void>` never overwrite prior records. `recordResult` returns the raw stdout receipt basename used by existing decoders and writes exit/signal/stderr metadata separately; it does not replace receipt contents with a wrapper object. Command/sequence names are validated, not accepted as paths.
- `hosted-model.ts`: `FaultCode` is a closed union of `AUTH_DENIED`, `AUTH_UNAVAILABLE`, `INVALID_REQUEST`, `STALE_RUN`, `STALE_REVISION`, `BUSY`, `ACTION_TIMEOUT`, `STORAGE_FAILURE`, `STAND_FAILURE`, `SESSION_HALTED`; `PublicFault { code: FaultCode; message: string; diagnosticId: string; outcome: "not-started" | "uncertain" | "verified" }`; `HostedAction { runId: string; revision: number; action: Action }`; `HostedSnapshot { runId: string; revision: number; state: "ready" | "busy" | "halted" | "closing"; snapshot: Snapshot; fault: PublicFault | null }`. Validate finite safe-integer revisions and nonempty run IDs. Shared `Action` and `Snapshot` remain in `model.ts`.
- `hosted-http.ts`: `createHostedServer(stand: LocalStand, config: HostedConfig, verifier: AccessVerifier, runId: string): Server`; it owns the in-memory revision/admission state. Keep `createLiveServer(stand: LocalStand)` and `createEvidenceServer(snapshot: Snapshot)` distinct.

Every hosted setting is required: `ACKIVAULT_ORIGIN`, `ACKIVAULT_PORT`, `ACKIVAULT_ACCESS_ISSUER`, `ACKIVAULT_ACCESS_AUDIENCE`, `ACKIVAULT_ALLOWED_EMAIL`, `ACKIVAULT_JWKS_TIMEOUT_MS`, `ACKIVAULT_JWKS_ATTEMPTS`, `ACKIVAULT_JWKS_RETRY_DELAY_MS`, `ACKIVAULT_JWKS_CACHE_MS`, `ACKIVAULT_JWKS_COOLDOWN_MS`, `ACKIVAULT_ACTION_DEADLINE_MS`, `ACKIVAULT_TERMINATION_GRACE_MS`, `ACKIVAULT_MAX_OUTPUT_BYTES`, `ACKIVAULT_EVIDENCE_MAX_BYTES`, `ACKIVAULT_MIN_FREE_BYTES`, the four existing stand-path variables and `ACKIVAULT_RELEASE_MANIFEST`. No missing-value defaults or production authentication bypass are added.

For reproducible Linux acceptance use explicit timing values: action deadline 60,000 ms, termination grace 2,000 ms, output cap 4,194,304 bytes per stream; JWKS timeout 3,000 ms, two total attempts, 250 ms retry delay, 600,000 ms cache age and 30,000 ms unknown-key cooldown. Fixtures that exercise expiry use their own explicit shorter values. Require positive finite limits, at most 90,000 ms per action, at most 5,000 ms termination grace, at most three JWKS attempts and at most 4,194,304 bytes per output stream. Reserve both streams plus metadata for each permitted command; at most 16 native invocations are permitted within one action. Reject work before another invocation would exceed the output/evidence budget. Native measurement must validate the 60-second acceptance budget; if it cannot, stop and review the synchronous design instead of hiding a longer wait.

The private deployment's disk quotas and resource values are provisioning inputs after host preflight, not claims about the uninspected target. Package/lifecycle acceptance uses a 1 GiB evidence budget, 256 MiB free-space floor, 1 GiB service memory limit, 64 tasks and one CPU equivalent; verify the existing native journey actually fits these bounds.

---

### Task 1: Validate hosted requests and real signed Access tokens

**Files:** Create `console/src/hosted-config.ts`, `console/src/access.ts`, `console/test/access-fixture.ts`, `console/test/hosted.test.ts`, `scripts/prepare-console-test-ca.sh`; modify `console/package.json` and `console/package-lock.json`.

**Interfaces:** Consumes the approved spec and existing `RequestError`. Produces the config/types above, `loadHostedConfig(environment: NodeJS.ProcessEnv): HostedConfig`, `AccessVerifier.verify`, and `authorizeHostedRequest(request: IncomingMessage, origin: string, verifier: AccessVerifier): Promise<void>`. The fixture exports `startAccessFixture(directory: string): Promise<AccessFixture>`; `AccessFixture` provides its HTTPS `issuer`, CA file, public test user email/subject, `sign(payload: JWTPayload, keyId: string): Promise<string>`, `rotate(keyId: string): Promise<void>`, `requestCount(): number`, `close(): Promise<void>`. `JWTPayload` is the library's signing-boundary type, not the application's validated identity model.

- [ ] **Step 1: Write failing integration cases** in `hosted.test.ts`: `rejects_invalid_access_tokens`, `rejects_ambiguous_headers`, `rotates_jwks_and_denies_expired_cache_outage`, `rejects_incomplete_hosted_config`. Exercise missing expiry/email/subject, service/global tokens, wrong issuer/audience/signature/algorithm, future not-before, expired token, repeated raw headers, comma-joined headers and forged email headers. Use a real temporary HTTPS JWKS server with ephemeral certificate/signing keys, trusted only in the test subprocess through `NODE_EXTRA_CA_CERTS`; never disable TLS verification. For HTTP policy cases a small real Node server invokes `authorizeHostedRequest` and responds with 204 only after authorization. Representative assertions:

  ```ts
  assert.equal(deniedResponse.status, 403);
  assert.equal(allowedResponse.status, 204);
  await assert.rejects(verifier.verify(wrongAudienceToken));
  assert.deepEqual(await verifier.verify(validToken), { email: fixture.email, subject: fixture.subject });
  ```

  This focused server verifies the authentication policy, not chain execution. Task 3 must establish that the production hosted server invokes this policy before native work. Node may reject structurally invalid duplicate Host headers itself with HTTP400; ambiguous authentication values reaching the policy must return HTTP403.
- [ ] **Step 2: Run red:** prepare an ephemeral CA using `bash scripts/prepare-console-test-ca.sh .tools/console-test-ca` from the root, then set `ACKIVAULT_TEST_CA_DIR` and `NODE_EXTRA_CA_CERTS` to that directory and its `ca.pem` before launching Node. The helper uses OpenSSL, refuses an existing destination and writes owner-only temporary material, never repository keys. Run `npm run build`, then `node --test --test-name-pattern='access|headers|jwks|config' dist/test/hosted.test.js` in `console/`. Expected: missing production modules/exports or failed assertions, never a missing external secret. Fixture startup must complete before exercising the verifier.
- [ ] **Step 3: Implement** the named config and identity interfaces. Pin `jose@6.2.12` in project dependencies/lockfile; use `jwtVerify` and a single remote key set per configured verifier. Require RS256, `type: app`, the exact signed email and a nonempty subject. Reject ambiguous `rawHeaders` before the verification call. The configured issuer alone determines the JWKS URL; redirects to a different origin and token `jku`/`x5u` values cannot change it. Retry only bounded JWKS transport failures, with redacted structured warnings; do not retry signature or claims rejection. Validate canonical HTTPS origin/issuer with no userinfo, query or fragment and enforce the exact Host/POST Origin.
- [ ] **Step 4: Run green:** rebuild and run the same integration cases. Check the actual fixture request count, successful key rotation, cache-age boundary, retry exhaustion and no native invocation on every denial. Typecheck with `npx --no-install tsc --noEmit`. No production Cloudflare policy is changed.
- [ ] **Step 5: Commit** only the named production/test/package files: `feat: validate hosted Access identity and request boundary`.

### Task 2: Bound native execution and retain private evidence on failure

**Files:** Create `console/src/operations.ts`, `console/src/journal.ts`, `console/test/hosted-stand.test.ts`; modify `console/src/stand.ts`, `console/src/live.ts`, `console/README.md` and existing native test constructors/helpers.

**Interfaces:** Consumes Task 1's path/limit types. Produces the runner/journal interfaces above. Export `StandConfig { paths: StandPaths; execution: ExecutionLimits; evidence: EvidenceLimits; provenance: StandProvenance; runId: string }`; `LocalStand.constructor(config: StandConfig)` is explicit at every call site. Preserve `execute(request: Action): Promise<Snapshot>`, `snapshot(): Snapshot`, `evidenceDirectory: string`, and add `shutdown(): Promise<void>` to stop admission and join/terminate an owned child. `loadStandProvenance(manifest: string, paths: StandPaths): Promise<StandProvenance>` verifies the package manifest and actual files before any hosted listener starts.

- [ ] **Step 1: Write failing native cases** `native_timeout_preserves_partial_evidence_and_blocks_retry`, `evidence_failure_after_execution_cannot_report_success`, `output_overflow_halts_without_retry`, `capacity_gate_refuses_before_native_work`. Extend existing real-binary fault wrappers to delay/truncate or withhold output after a real payment; do not synthesize success. Test exclusive file creation and permissions against the actual temporary filesystem. Independent original-binary recipient inspection must establish the executed outcome where available:

  ```ts
  assert.deepEqual(stand.snapshot().availableActions, []);
  assert.equal(await recipientPaymentCount(originalSdk, savedState), 1);
  assert.deepEqual(await readFile(savedState), stateBeforeBlockedRetry);
  assert.equal(await childStillRunning(childPid), false);
  ```

  Define `recipientPaymentCount(sdkRoot: string, stateFile: string): Promise<number>` using existing native receipt helpers, and `childStillRunning(pid: number): Promise<boolean>` using the OS process probe; neither returns a fabricated outcome. Use an actual failed evidence destination or an isolated filesystem quota for write failure, not an in-memory pretend success.
- [ ] **Step 2: Run red on native Linux:** `npm run build`, then `node --test dist/test/hosted-stand.test.js` with the existing native input variables and explicit new limits/provenance. Expected: the new timeout/storage assertions fail against the old unbounded runner. Retain the first failing evidence privately.
- [ ] **Step 3: Implement** finite monotonic whole-action budgeting, remaining-budget child invocation, bounded stdout/stderr capture, SIGTERM then SIGKILL escalation, and waiting for exit before releasing exclusivity. Record intent before execution and outcome/partial output afterwards with owner-only permissions and exclusive filenames. Create fresh session manifests and verify capacity before each invocation; a write/parse/delivery uncertainty halts. Thread the same deadline through deployment, funding, calls and inspections. Update local CLI/test call sites with explicit settings; keep its five path/port arguments and label it localhost-only. The local CLI also requires `ACKIVAULT_RELEASE_MANIFEST` for provenance, with its new requirement documented in `console/README.md`; native test setup generates the same manifest shape from its actual checked source/build inputs without claiming a release package. Preserve ordinary complete contract rejections as rejected receipts. Only validation errors before execution may leave admission available: do not treat every `RequestError` as harmless when it represents a failed signed inspection. Do not catch a persistence error and continue.
- [ ] **Step 4: Run green on native Linux:** build, existing `npm test`, existing `npm run test:native` and the new native file. Verify unchanged contract sources/semantics and independently inspect/replay the populated HTTP journey. Classify an unobservable interrupted command as uncertain rather than inventing its result; the exactly-one assertion above applies only to the deliberate after-execution fault.
- [ ] **Step 5: Commit:** `feat: supervise native actions and retain private session evidence`.

### Task 3: Add the distinct hosted entrypoint and run/revision guards

**Files:** Create `console/src/hosted-model.ts`, `console/src/hosted-http.ts`, `console/src/hosted.ts`; modify `console/src/http.ts`, `console/test/hosted.test.ts`, `console/test/hosted-stand.test.ts` and package scripts.

**Interfaces:** Consumes Tasks 1–2 and the shared `Action`/`Snapshot`. Produces the hosted wire types and `createHostedServer` above. Export `sanitizeHostedSnapshot(snapshot: Snapshot, fault: PublicFault | null): Snapshot` and `publicFailure(error: Error, diagnosticId: string): PublicFault`. The hosted bootstrap loads explicit config/provenance and generates the unpredictable run ID before constructing its stand/server. `GET /api/snapshot` returns `HostedSnapshot`; `POST /api/action` accepts `HostedAction`. Local/evidence routes keep their existing wire formats.

- [ ] **Step 1: Write failing real-HTTP tests** `guards_run_and_revision_before_native_work`, `one_admitted_action_consumes_one_revision`, `lost_response_does_not_allow_resubmission`, `safe_errors_cover_http_and_snapshot`. Use real signed fixture tokens and the original native stand. Admit only a current run/revision; deliberately close a client connection after submitting one real payment, then resend its exact body and independently inspect delivery:

  ```ts
  assert.equal(replayedResponse.status, 409);
  assert.equal(nextSnapshot.revision, submittedRevision + 1);
  assert.equal(nextSnapshot.runId, originalRunId);
  assert.deepEqual(nextSnapshot.snapshot.delivery, { received: "10", count: "1" });
  assert.equal(serializedBrowserResult.includes(privateStatePath), false);
  ```

  Also inspect unchanged state after an invalid token, stale revision, wrong run, concurrent action and expired grant rejection. An authenticated GET must not execute a signed Inspect. The disclosure case must cause a real filesystem/stand error whose private cause is known to the test.
- [ ] **Step 2: Run red:** build and run `node --test dist/test/hosted.test.js dist/test/hosted-stand.test.js`. Expected: absent hosted entrypoint/guards or failed replay/disclosure assertions.
- [ ] **Step 3: Implement** hosted admission as a synchronous revision check/consume before awaiting native work, with explicit busy/halted/closing state. Sanitization applies to both HTTP errors and snapshots; structured private diagnostics correlate opaque IDs without tokens, cookies or signing material. Export only the minimal fixed-file/body helpers needed from `http.ts`; do not remove the existing localhost restrictions, rewrite untrusted Host/Origin or turn auth off with a mode flag. Add `npm run hosted` as the separate bootstrap. Graceful signal handling calls `stand.shutdown()` and closes admission/listener without resuming old state.
- [ ] **Step 4: Run green:** both new integration files plus all existing console tests/native scenarios. Require exactly one recipient payment after response loss, no duplicate revision execution and no raw private data in error/snapshot responses. Review raw logs separately for actionable redacted diagnostics.
- [ ] **Step 5: Commit:** `feat: add authenticated hosted console with replay-safe session guards`.

### Task 4: Explain hosted test sessions and recover browser control safely

**Files:** Create `console/browser/render.ts`, `console/browser/hosted.ts`, `console/test/hosted-browser.spec.ts`, `console/playwright.config.ts`; modify `console/browser/app.ts`, `console/public/index.html`, `console/src/hosted-http.ts`, package scripts and lockfile.

**Interfaces:** Consumes `HostedSnapshot`/`HostedAction`. Move existing presentation only into `render.ts`, exporting `render(snapshot: Snapshot): void` and `showError(message: string): void`; keep local/evidence request handlers in `app.ts`. The separate `hosted.ts` browser bundle performs hosted-envelope parsing and emits only current-run/revision actions. Serve that bundle as the hosted page's fixed `/app.js`; never choose a bundle from request input. The shared HTML adds stable IDs `hosted-session`, `hosted-run`, `hosted-state`, `hosted-outcome` with no secret configuration.

- [ ] **Step 1: Write failing browser acceptance** `refresh_keeps_running_grant`, `restart_requires_explicit_reload`, `uncertain_payment_is_not_resent`, `expired_login_never_replays_action`. Run a real hosted server/native stand with signed test headers and an actual HTTPS JWKS fixture. Use only stable test IDs. For the restart scenario preserve the old page, stop/start the server and test:

  ```ts
  await expect(page.getByTestId("pay")).toBeDisabled();
  await expect(page.getByTestId("hosted-state")).toHaveText("Server restarted — reload to begin a fresh test session.");
  assert.equal(await observedPaymentSubmissions(), 1);
  ```

  `observedPaymentSubmissions(): Promise<number>` is the harness's count of real received payment requests. After explicit reload require a new run ID and an uncreated grant; preserve old receipt hashes. Before restart, refreshing the page must retain the same run/grant and must not send Create or Inspect. Authentication renewal after a failed request cannot resubmit it.
- [ ] **Step 2: Run red:** build and `npm run test:browser` on native Linux. Expected: missing hosted UI/disabled controls or failing restart assertions, not a fake mocked network response.
- [ ] **Step 3: Implement** the separate hosted browser adapter and minimal shared render extraction. Disable conflicting actions immediately; on a changed run show the exact restart message above and require explicit reload. On non-JSON login/expiry responses report that authentication needs renewal, without reflecting HTML or retrying the action. Refresh only reads snapshots; uncertain results remain labelled. Pin project-local `@playwright/test@1.64.1`, build both browser bundles, and configure its browser test without changing existing Node test discovery. No seller/model UI, wallet connection or inference endpoint is added.
- [ ] **Step 4: Run green:** build, typecheck, existing local/evidence tests, new hosted/native tests and Chromium browser acceptance. Inspect desktop/mobile widths and keyboard controls using the actual page; automated locators use IDs, not fallback text clicks. Recheck local/evidence rendering after extraction.
- [ ] **Step 5: Commit:** `feat: show hosted session boundaries and uncertain action outcomes`.

### Task 5: Verify a non-root package and supervisor lifecycle in isolated CI

**Files:** Create the three package/service scripts and two `deploy/private-console/` templates listed above; modify `.github/workflows/stand-e2e.yml`, `console/README.md`, `docs/verification.md`.

**Interfaces:** `package-private-console.sh <source-root> <output-directory>` builds the console/dependencies/artifacts using the explicitly supplied `ACKIVAULT_SDK_ROOT` and writes a manifest with exact source and component digests. The builder rejects dirty source and pre-existing output destinations. `verify-private-package.sh <package-directory> <sdk-directory>` checks the already-created package and matched SDK/profile before startup, without requiring a Git checkout or rewriting the package. Both reject mismatched provenance. The package records the SDK retrieval/verification requirements but does not publish the SDK binary or private state. `test-private-service.sh <package-directory> <sdk-directory> <private-test-root>` performs native lifecycle acceptance only on an isolated disposable CI Linux runner, refusing a non-CI environment. No install/start/DNS command targets a real host.

- [ ] **Step 1: Write failing lifecycle acceptance** inside `test-private-service.sh`: `single_writer_and_orphan_cleanup`, `restart_retains_archives_and_changes_run`, `package_permissions_backup_and_rollback`. Use a real non-root systemd unit whose name and temporary paths come from the validated CI test root. Start a deliberately delayed real native action, kill only that unit's main process, and require zero surviving owned child writers before a replacement can hold the lock. An unrelated sentinel process must survive. Compare old receipt/state hashes, restore a private backup into a separate directory, and start the previous verified package only with a fresh run. Verify ready checks produce no native receipts.
- [ ] **Step 2: Run red on isolated native CI:** `bash scripts/test-private-service.sh .tools/private-package .tools/release/avm-sdk-linux-x86_64 .stand/private-service`. Expected: missing package/unit or an explicitly failed lifecycle assertion. Never run this script on the intended shared server as a substitute for CI.
- [ ] **Step 3: Implement** a reproducible package/manifest and explicit service template. Use a dedicated non-root identity, service-lifetime `flock --nonblock --no-fork` on the state-parent lock, `KillMode=control-group`, finite stop timeout greater than the configured action-plus-grace envelope, `SendSIGKILL=yes`, `Restart=no`, private umask and read-only code/runtime paths. Permit writes only to private state and required temporary storage. Configure explicit memory/task/CPU limits and no privileged capabilities, Docker socket or host API credentials. The tunnel remains a separate narrowly scoped connector; deployment configuration must route only the canonical hostname to loopback with a reject catch-all. Templates contain generic required operator inputs, never real values. Native package verification covers architecture/instruction support, libc and component hashes; unsupported targets fail rather than substituting another SDK.
- [ ] **Step 4: Run green in native CI:** existing Rust/clean-build/stand/console checks, all hosted/native/browser tests, package verification and lifecycle script. Prepare the ephemeral test CA before Node starts and set the two fixture variables for every hosted test process. Install Chromium only in the test environment with the pinned project tool. Require finite job deadlines long enough for native builds on a slow runner; retain timing evidence. Upload only screened synthetic receipts, public provenance and secret-safe diagnostics—not `developer.state`, keys, ephemeral authentication material, private service configuration or raw hosted archives. Run the existing guest-fuzz workflow unchanged. Update the existing console/verification documents with the implemented entrypoint, required settings, package recipe, passed checks and remaining real-Access/host gates; reference the spec instead of duplicating it.
- [ ] **Step 5: Commit:** `build: verify private console package and service lifecycle`. Review the whole diff for personal data and dependency/provenance changes, then obtain independent code review before merging. Publishing tested source is not deployment approval.

## Final verification and deployment boundary

After the five task commits, the exact candidate must pass `npm run build`, `npx --no-install tsc --noEmit`, `npm test`, `npm run test:native`, `npm run test:hosted`, `npm run test:hosted-native` and `npm run test:browser` in the pinned native environment, plus package/supervisor acceptance and unchanged Rust/fuzz workflows. Add the three new test scripts in their owning task; none may skip silently when an input is missing. Retain the exact source SHA and screened evidence for review. No current CI success proves these not-yet-written checks.

Stop before host access. With separate approval, a later read-only preflight checks the selected host's platform/resources and existing services, Cloudflare Access/identity/MFA availability and absence of origin bypass. A subsequent exact provisioning/activation plan requires approval before making changes. Real allowed/disallowed login, MFA, public-origin bypass rejection, tunnel Host handling, co-host verification and rollback acceptance remain mandatory after separately approved staging. Local signed-token tests are not those live checks.

## Execution handoff

Await plan review and execution-method selection. **Native execution is recommended:** the five tasks share a tightly coupled request/session/runner protocol, so one implementer can keep interfaces consistent, followed by an independent whole-branch review. **Subagent-driven execution** is the alternative, with a fresh implementation/review gate per task and a final whole-branch review. Neither method permits VPS deployment or inference integration under this plan.
