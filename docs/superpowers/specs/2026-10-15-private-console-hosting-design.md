# Private AVM console hosting

## Status and purpose

Written specification for review. The conversational design is approved; this document is not yet approved for implementation. Nothing in this specification authorizes server access, account configuration, DNS changes, installation or deployment.

Make the existing AckiVault AVM demonstration available to one permitted person through a private browser console. Success means exercising the existing test grant remotely, with authenticated access, bounded native processes, honest results and retained evidence. It does not mean operating a customer service or connecting to a live blockchain.

Source baseline: `093b77971e1d28cb111229eba338abbcf27b64b9`. The [local console design](2026-10-12-ackivault-console-design.md) defines the grant and test actions. The [verification guide](../../verification.md) remains authoritative for the pinned SDK, reproduction instructions and limitations. This specification adds hosting requirements; it does not replace those documents or claim that these controls already exist.

## Scope

Included:

- One existing login identity, Cloudflare Access with enforced MFA, and an outbound Cloudflare Tunnel.
- The existing Create, Fund, Pay, Inspect, Revoke and Withdraw test actions, fixed test recipient, and stand-generated test identities.
- Hosted request validation, process supervision, safe browser errors, fresh sessions after restart, protected evidence retention and deployment acceptance checks.
- A reproducible native Linux service package for the exact reviewed source and matching AVM runtime.

Excluded:

- Mainnet or Shellnet deployment, imported wallets, real funds, custody, customer accounts, arbitrary recipients or network endpoints.
- DEX.DO trading, inference routing, IDE API credentials, OpenCode integration, billing, fees, supporter rewards or token issuance.
- Automatic restoration, migration or continued execution of an old stand session; an archive browser or receipt-download API.
- High availability, additional application replicas, a new password database or changes to other services on the eventual host.

An IDE consuming one or two DEX.DO inference streams is a later feasibility and integration milestone, after this milestone passes. The AVM console does not currently implement that API, and its tests cannot establish DEX.DO compatibility.

## Selected architecture

The browser reaches Cloudflare Access over HTTPS. Access permits only the configured identity after MFA. A dedicated tunnel forwards that hostname to the AckiVault server's loopback listener. The server independently verifies the Access application token before serving console assets, snapshots or actions. An admitted action invokes the pinned local AVM binary; it never invokes a network wallet or DEX client.

This is preferred over exposing a public origin port, which would require another inbound perimeter and TLS configuration. A VPN-only console is another possible deployment, but adds a client requirement and is not the selected browser access flow. Building an application password system adds unnecessary credential handling.

The application remains bound to `127.0.0.1`. There is no public port mapping, alternate proxy route or unauthenticated hostname. Tunnel ingress accepts only the canonical hostname and rejects unmatched routes. Existing websites, firewall rules and routing are not globally replaced. Cloudflare Tunnel uses outbound connections; that is a transport choice, not a substitute for Access policy or application authentication. See [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

Keep the existing localhost live and evidence entrypoints distinct from a new authenticated hosted entrypoint. Do not use a flag that silently switches hosted authentication off. Share the existing validated actions, receipt decoders and stand connector rather than creating a second vault implementation. Contract source and grant semantics do not change for hosting.

## Identity and request boundary

The Access application covers the entire hostname, including static assets and API paths, with no bypass or service-token policy. Its allow rule names the exact permitted existing identity, not an entire email domain. Require independent MFA for this application; a provider login or email code alone is not treated as proof of MFA. Access enrollment and recovery remain operator-controlled. Existing Cloudflare DNS or dashboard access does not establish that this policy is configured. See [independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/).

Hosted startup requires explicit canonical HTTPS origin, Access issuer, application audience and permitted identity. Missing or invalid configuration prevents listening. Deployment-specific values remain private and are not placed in this public specification or checked-in examples.

For every application request:

1. Require the canonical Host header, with no wildcard or unapproved port. Configure the tunnel to preserve that Host; never turn an arbitrary incoming Host or Origin into a trusted one.
2. Require exactly one `Cf-Access-Jwt-Assertion` header. Verify the token signature using the configured issuer's HTTPS JWKS endpoint, a maintained verification library and only RS256. Validate issuer, application audience, required finite expiry/issued-at values and any not-before constraint. Require `type: app`, a nonempty user subject and a signed email exactly matching the configured permitted identity. Reject service tokens and global session tokens. Do not authorize using an unverified email header, token-supplied key URL or decoded-but-unverified payload. These token fields are described in [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
3. Use bounded key retrieval from that fixed endpoint. A cached verification key may be used within its defined cache lifetime; unknown keys or failed verification never enable anonymous access. Read-only key retrieval can have bounded retries with structured warnings, then return an explicit unavailable error if verification cannot be completed. Never log the token.
4. For actions, additionally require the exact configured HTTPS Origin, JSON content type, the existing small body limit, a valid action and the current run/revision identifiers. Reject missing or foreign Origin; do not enable cross-origin API access.

Cloudflare documents origin-side signature, issuer and application-audience verification in [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). MFA enforcement is an Access-policy deployment check, not a guarantee inferred from an arbitrary signed email claim.

Retain no-store responses, the existing restrictive CSP and text-only rendering of external values. Bound header/body parsing and authentication work. Authentication failure occurs before any native invocation. No application request can choose a binary, filesystem path, recipient or upstream endpoint.

## Fresh sessions and retained evidence

Every service start generates a new unpredictable run identifier. The initial page says that no grant has been created. Only the authenticated Create action initializes a new private stand directory. Browser reload, login renewal and snapshot refresh do not reset a running grant.

Each action includes the run identifier and the snapshot's mutation revision. Admission requires the current values and no running operation. Consume the revision before invoking the stand, including for Inspect because it is a signed call. An already consumed revision cannot execute again, even if the first response was lost. Authentication/validation failures do not consume the revision. A new server process has a new run identifier, so delayed requests from an earlier process cannot act on its replacement.

The browser must not silently adopt a changed run identifier after an action failure. It reports that the server restarted and requires an explicit page reload before enabling new-session controls. A stale run/revision returns a conflict without invoking the stand. There is at most one grant per service run; creating another requires an intentional service restart, not a browser reset button.

Use an exclusive service-lifetime operating-system lock on the configured state parent to prevent two processes from owning it. New session directories never overwrite earlier directories. No existing state is opened for continued signing, even if its runtime version matches. Earlier session files and receipts remain on protected persistent storage; there is no automatic deletion, pruning or migration.

Each session records the run identifier, creation time, exact application revision, SDK/runtime/profile identities and contract artifact digests. Record an action intent before launching a native command and its exit, termination or incomplete-result outcome afterwards. Preserve stdout receipts and bounded diagnostics when available, including partial output on timeout. An incomplete output is labelled incomplete, never promoted to a successful receipt.

Hosted developer state, test signing material, raw command output and internal paths are never served by the HTTP application or uploaded as public CI artifacts. Existing synthetic native-CI receipts and public provenance may remain CI artifacts only after checking that they contain no private keys, hosted data or personal infrastructure. The browser receives only the validated snapshot, public test addresses, receipt basenames and safe errors. Operator-only archives retain the matching runtime/profile/artifact provenance needed for investigation; retaining files alone is not a claim of crash atomicity or supported state recovery.

Private state directories use owner-only access and private files. Both receipts and state survive service/package replacement. Storage limits and minimum free-space checks are explicit startup settings: refuse new native work when its bounded evidence cannot be retained. If a write fails despite those checks, halt rather than discard evidence, delete old sessions or claim success. An operator must resolve storage pressure separately.

## Native operation lifecycle

Continue using explicit executable paths and argument arrays, never shell interpolation. Only the verified SDK binary and verified contract artifacts are executable inputs. One operation owns the stand at a time; other actions fail with a conflict rather than queueing or being silently retried.

Configure a required finite whole-action deadline and finite child-termination grace period. The action budget includes its sequence of native commands, output capture and evidence writes; starting another command does not reset that budget. Reject invalid timing configuration at startup. Select concrete deployment values using measured native test timings, not the speed of the development laptop. The configured action/termination envelope must fit within the tested HTTP/tunnel response budget.

On deadline expiry, stop admitting new work, terminate the owned child, escalate to a forced termination after the grace period and wait for its exit. Do not release exclusivity while a child could still write state. The service supervisor must kill the unit's remaining children if the server itself dies; no replacement process may start signing while an earlier child survives. Never terminate unrelated host processes.

A native launch failure, nonzero unexpected exit, invalid/truncated receipt, failed receipt persistence, unverified funding or unverified delivery halts the session. The snapshot explicitly reports the failure, unavailable actions and any last verified balance as an older sample, not current truth. Contract rejections with complete valid receipts remain normal rejected results under the existing semantics.

Never automatically repeat a signed operation, including Inspect. A browser/tunnel disconnect is not cancellation or proof that execution failed. The browser reports an unknown result and may fetch a read-only snapshot, but cannot replay the request. If the server finishes and verifies the result, the current snapshot can show that result; otherwise the session remains halted or running until resolved. Consumed revisions block duplicate transport submissions. A fresh test session does not resolve the previous session's uncertain outcome.

On operator shutdown, stop admitting actions, allow an in-progress operation only within its remaining deadline, then apply the same termination and evidence rules. Do not manufacture a rollback or continue an old session after restarting.

## Browser errors and operator diagnostics

Use specific safe error codes and messages for authentication denial/unavailability, invalid request, stale run/revision, operation busy, action timeout, storage failure and halted session. The browser receives an opaque diagnostic identifier, whether the outcome is uncertain and what the user should do. It does not receive arbitrary exception messages, stack traces, stdout, stderr, secrets or absolute paths. Sanitize both HTTP errors and the snapshot failure field.

Protected structured operator logs correlate diagnostic, run and action identifiers with command name, exit/termination information and retained evidence names. Preserve actionable root causes after redaction; never log Access tokens, cookies or signing material. Parsing failures do not reflect untrusted bodies back to the browser. Authentication outages deny access rather than disabling verification. Cached snapshots remain read-only observations and are not a fallback for failed mutations.

## Runtime packaging and operational boundary

Package the built Node console, locked dependencies, verified contract artifacts and the exact matched SDK/profile as a versioned native Linux installation. The initial service target is a dedicated non-root systemd unit, with a separate tunnel connector. Install-time retrieval verifies SDK provenance and license scope; this example does not relicense or publicly redistribute the host binary. A runtime package must identify its source commit and component digests and fail if verification fails.

Use the repository's current Node and AVM platform requirements. A later read-only host preflight must prove CPU instruction support, architecture, libc, disk, RAM and available resource budget. An incompatible host stops this deployment path: do not silently substitute an older SDK, emulate the runtime or upgrade the shared host OS. Any alternative packaging requires a reviewed change to this design.

Keep executable code and runtime/profile files read-only for the service user. Grant write access only to its private state/evidence area and required temporary storage. Apply explicit CPU, memory, process and storage bounds. The service receives no Docker socket, privileged mode, host administrator credentials, Cloudflare management API token or real wallet keys. The separately managed connector alone receives its tunnel credential. State is not part of a public web directory or source checkout.

A supervisor health check observes process/listener readiness without issuing signed calls. Network failure, unhealthy status or a failed action must not trigger an automatic session-reset loop. Session-affecting application restart is an explicit operator action; a host reboot starts a fresh run as defined above. No second application replica shares the stand state.

Backups are operator-controlled, private and checked by a restore drill in a separate directory. A verified backup preserves historical evidence, not a resumable live session. Deployment retains the previous verified package and never overwrites its runtime/profile or the shared evidence directory. An explicitly approved rollback stops the new unit and starts the older verified package with a fresh run; it does not open the newer package's populated state.

## Acceptance evidence

Implementation tests must use the real HTTP server, real verification library and pinned native stand where applicable. Locally generated signed authentication tokens are explicit protocol fixtures, not evidence that the Cloudflare policy works. A test-only child wrapper may delay, terminate or truncate a real native invocation to exercise failure handling; it must not fabricate successful receipts. Stable test IDs identify browser controls.

| Boundary | Required observation |
| --- | --- |
| Startup | Missing/invalid auth, timing, artifact or storage configuration fails before listening. A second process using the same state parent cannot start. |
| Authentication | Missing, malformed, expired, wrong-signature, wrong-type, wrong-issuer, wrong-audience and disallowed-identity tokens cause no native invocation. Signed claims are checked even if an email header is forged. |
| Key retrieval | Unknown signing key, unavailable JWKS and bounded retrieval exhaustion deny access; verified key rotation works without accepting attacker-selected key URLs. |
| Host/Origin | Foreign or missing Host/Origin, duplicate auth headers, invalid content type/body/action and cross-origin requests cannot mutate state. Arbitrary forwarded headers confer no trust. |
| Native journey | Through the authenticated HTTP boundary: create, fund, pay, cap rejection, revoke, revoked-payment rejection, withdraw and recipient confirmation, retaining the existing independent inspection/replay checks. |
| Concurrency/replay | Overlapping actions, repeated consumed revisions, delayed requests and old browser tabs after restart execute no duplicate native mutation. |
| Timeout/receipt loss | A real operation with delayed or lost output halts safely, retains available evidence, terminates its owned child and rejects signed retries. Independently inspect the original state/recipient before drawing an outcome conclusion. |
| Restart/shutdown | New run identity and initially uncreated grant; old state/receipt hashes remain unchanged; browser refresh alone preserves the active run. A stopped/restarted unit has no surviving old child writer. |
| Disclosure/storage | Browser error bodies and snapshots contain no internal paths, raw diagnostics or secrets. Private file permissions and insufficient-space handling are verified; no cleanup is triggered. |
| Package/lifecycle | Clean native installation from the exact package, non-root execution, health without signing, resource limits, retained archives, isolated backup restore and explicit rollback to a fresh run. |

Keep the existing guest tests, fuzzing and receipt validation. This is a console-hosting change, not authority to weaken contract assertions or claim a new audit. Tests that require native Linux must run there; a read-only evidence viewer on another architecture is not native-runtime proof.

Before public-hostname activation, separately approved infrastructure work must also demonstrate real Access login/MFA for the allowed identity, rejection of an unapproved identity, no bypass through the server IP or alternate route, correct tunnel Host handling, and unchanged co-hosted services. Record the exact deployed commit and private configuration references without publishing credentials or personal infrastructure. These live checks cannot be marked complete by a local token fixture or a successful existing CI run.

## Delivery gates

1. Review and approve this written specification.
2. Write and review the implementation plan; select execution method before changing product code.
3. Implement and verify application/package controls in isolation, then review and publish the tested code changes.
4. Obtain separate approval for read-only host/Cloudflare preflight and for the exact provisioning and activation plan. No resource creation or shared configuration change is implied by code approval.
5. Deploy only an approved exact revision, complete real-origin acceptance and preserve rollback/evidence. Do not call the installation ready before those results exist.

Personal hosting values stay in private operator configuration. Keep public documentation generic, author attribution under the requested public pseudonym, and all remaining network/host assurance gaps explicit in the existing verification guide.
