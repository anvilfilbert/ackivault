# Reviewer verification guide

AckiVault demonstrates a bounded SHELL allowance for a separate agent key. The owner fixes the recipient contracts, expiry and cumulative cap, then can permanently revoke the grant and recover funds. The cap includes the payment and fixed outbound reserve; other protocol fees are not part of that allowance.

## Reproduce the evidence

Use the source commit recorded by a successful `AckiVault local stand` workflow run. Its native Linux runner installs the pinned Rust toolchain, verifies the SDK archive and file checksums plus source/profile identities, runs the Rust tests and Clippy, checks both builds for byte identity, then executes the local AVM stand journey. SDK 0.2.0 and guest SDK 0.1.1 are pinned together; never substitute an older profile or reuse populated historical stand state.

For a native reproduction, use Linux x86-64-v3 with glibc 2.39 or later, Bash, Git, Rustup, `curl`, `tar`, `sha256sum` and `jq` installed. Node.js 22.18 or later in the 22.x line is needed for the console checks. Start from the repository root at the source commit being reviewed. Fetch the matching SDK distribution:

```sh
rustup toolchain install 1.93.0 --profile minimal \
  --component clippy --component rustfmt --target wasm32-unknown-unknown
mkdir -p .tools/release
curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 \
  --output .tools/release/avm-sdk-linux-x86_64.tar.gz \
  https://github.com/gosh-sh/avm-sdk/releases/download/avm-dev-06e96ef71006-sdk-0748f4f0767a/avm-sdk-linux-x86_64.tar.gz
printf '%s  %s\n' \
  '8728497cf1e476d3d770a09b19929f7c196f2637654642727432b4c285c85143' \
  '.tools/release/avm-sdk-linux-x86_64.tar.gz' | sha256sum --check
```

Only continue after the checksum passes:

```sh
tar -xzf .tools/release/avm-sdk-linux-x86_64.tar.gz -C .tools/release
.tools/release/avm-sdk-linux-x86_64/bin/avm-contract-build build --manifest-path contract/Cargo.toml
.tools/release/avm-sdk-linux-x86_64/bin/avm-contract-build build --manifest-path tests/stand/receipt/Cargo.toml
```

Run the native journey:

```sh
bash scripts/stand-e2e.sh \
  .tools/release/avm-sdk-linux-x86_64 \
  contract/target/avm \
  tests/stand/receipt/target/avm \
  .stand/reviewer-run
```

The output directory must not already contain a stand state file. All identities and funds belong to the local stand. Download `stand-diagnostics` from the workflow run to inspect the JSON receipts, SDK manifest/profile and compiler provenance for that exact commit. Historical state stays paired with its historical binary/profile; there is no supported populated-state migration. New roots/FUEL need not equal historical observations.

The [CI workflow](../.github/workflows/stand-e2e.yml) is the complete automated test recipe, including formatting, Clippy and the clean rebuild comparison. Follow the [console instructions](../console/README.md) for the interactive local test or read-only evidence viewer.

## What the receipts prove

| Scenario | Evidence file | Required observation |
| --- | --- | --- |
| Internal funding | `deposit.json` | Vault emits its deposit acceptance event. |
| Agent pays 10 SHELL | `pay.json` | Vault records 15 units of cap use: 10 payment plus 5 fixed reserve. |
| Recipient executes payment | `recipient-after-pay.json` | Recipient state records 10 SHELL received and one receipt. |
| Payment exceeds cap | `over-cap.json` | Executor status 1024, unchanged vault state, no events. |
| Owner key used as agent | `wrong-key.json` | Executor status 1012, unchanged vault state, no events. |
| Owner revokes | `revoke.json` | Revoked flag becomes true. |
| Agent pays after revocation | `revoked-pay.json` | Executor status 1018, unchanged vault state, no events. |
| Owner withdraws 7 SHELL | `withdraw.json`, `recipient-after-withdraw.json` | Recipient records 17 SHELL cumulatively and two receipts. |
| Journal replay | `inspect.json`, `replay.json` | Account and registry roots, cumulative fees and accepted input count agree. |

A stand transport receipt can report `status: ok` while the contract rejects a call. The runner checks the status encoded in `raw_executor_output`, together with state and events. Receipt state is checked immediately after each transfer; a dispatch event alone is not used as proof of delivery.

## Scope of the proof

### Development and security testing ongoing

This is a local demonstration under active adversarial testing, not an independent security audit. The additional checks use test identities only and do not authorize real funds or network deployment.

The contract suite includes generated payment sequences with independently budgeted allowances, interleaved owner inspections, replay attempts and fixed-recipient checks. It also covers revocation/recovery, expiry equality, both arithmetic overflow boundaries, maximum nonces, and state-codec invariants. `proptest` is a pinned development-only dependency. CI runs 1,024 cases per property with a recorded seed; a larger repeatable local run is:

```sh
PROPTEST_CASES=4096 PROPTEST_RNG_SEED=20261013 \
  cargo test --manifest-path contract/Cargo.toml --locked
```

Change the seed for additional exploration; retain a failing seed and minimized input. Generated failure seeds are saved beside the property tests as `*.proptest-regressions` and included in CI diagnostics when present. The codec also has an independent literal wire vector; roundtrip tests alone cannot detect matching layout mistakes in both encoder and decoder. These are bounded generated tests, not exhaustive verification or coverage-guided fuzzing. The adapter suite separately checks that truncated state emits no effects and that funding an exhausted grant does not restore allowance.

The console suite rejects every truncated prefix and every one-byte extension of six real native receipt frames, mismatched receipt state, unexpected rejection events and unsafe HTTP requests. It also rejects all 2,040 single-byte substitutions of the four-byte ACMO header across a real accepted receipt and a real rejected receipt, including high-bit variants that lossy ASCII decoding would otherwise accept. These are deterministic boundary checks, not general receipt-parser fuzzing. Use the actual receipts and environment described above; no fabricated successful chain responses substitute for them.

The native console suite also injects receipt loss **after the real stand executes a payment**. A test-only process wrapper preserves the complete response, then truncates stdout. The test requires the console to halt, a retry to leave the stand state file unchanged, and an independent call through the original binary to observe exactly one recipient payment. The `receipt-loss-*` evidence contains the executed payment and independent recipient receipt; stand state files and identities are not uploaded.

A separate native scenario first pays successfully, then submits another payment with zero execution reserve through the real binary. The pinned host rejects it with `RouteRequiresFee` before execution. The console must halt and block retries; new processes independently inspect the saved vault and recipient, requiring unchanged agent nonce, spent amount and delivery count. The `zero-reserve-*` receipts retain that evidence. This tests a pre-execution fee gate, **not** mid-execution FUEL exhaustion, process-crash atomicity or automatic restart recovery.

A failed-delivery scenario configures the existing recipient's external-only `stand.snapshot` method as the grant's internal payment destination. The test wrapper changes only that initialization field and otherwise forwards unmodified native calls and responses. The recipient code rejects internal calls to this method. The test requires exactly one outbound in the payment output and a native executor-counter increase of three: payment, internal recipient and console snapshot. The native stand accepts the vault's dispatch, drains its queue, records 15 units of allowance use and emits no recipient acceptance. Fresh processes observe unchanged spent/agent state and zero recipient receipts. The console must halt on the delivery mismatch and reject a retry without changing the saved stand state. The `rejected-delivery-*` artifacts contain the pre-payment vault inspection, dispatch, independent vault/recipient receipts, and before/after counts sampled from the original stand's read-only inspection. The pinned CLI does not expose the internal recipient's status code; the exact rejection branch is inferred from recipient source, not independently proven by an internal receipt.

These observations prove neither a refund nor loss of the transferred value: the recipient's receipt counter is application state, not its account balance. The test also records the vault's before/after balance observations and charged fees, but calls and elapsed block time can incur additional costs. They are not a per-message refund ledger. This scenario covers a same-DApp local recipient rejection, not chargeable cross-DApp delivery or callbacks. The [pinned fee rules](https://github.com/gosh-sh/avm-sdk/blob/0748f4f0767a26da8bc363bcb6b5585539d6970e/docs/fuel-and-fees.md) distinguish those routes: local-free reserves are not debited; on chargeable routes unused reserve returns through a requested callback, otherwise it is burned. AckiVault requests no callbacks and never restores allowance automatically. Transfer-value refunds and chargeable-route settlement remain unverified.

The HTTP-driven native console journey independently invokes stand inspection and journal replay after funding, payments, rejection, revocation and withdrawal. It requires identical populated account/registry roots, cumulative fees and accepted input count, retaining `console-inspect.json` and `console-replay.json` in the session artifacts. This complements the scripted journey's replay check; it does not prove arbitrary crash recovery or independent recomputation of the roots.

### Coverage-guided guest fuzzing

The separate [fuzz package](../fuzz/Cargo.toml) uses pinned `libfuzzer-sys` and the same SDK revision as the contract. It does not add production dependencies. `state_init` mutates state bytes, initialization arguments and deployment envelopes; `canonical_message` mutates complete ACMI inputs through the SDK decoder and real contract entrypoints. The oracles check canonical state, effect-free rejections, immutable grant fields, role/nonce checks and exact payment-plus-reserve accounting. Accepted initialization must preserve the exact cap, expiry, recipient count and every recipient address, method and reserve byte from the input, for both raw arguments and deployment envelopes. These expectations do not use the production decoder. Seeds include all four distinct recipient slots and varied reserves, including zero and `u128::MAX`. Canonical seed builders are shared with adapter tests, not production code.

The [guest fuzz workflow](../.github/workflows/guest-fuzz.yml) installs `cargo-fuzz 0.13.2` into a project-local directory and uses `nightly-2026-01-30` only for fuzzing. The deployed WASM build remains on Rust 1.93.0. It retains the synthetic corpus, crash inputs, logs and LLVM source-coverage data. CI bounds each target to 60 seconds with 4,096-byte inputs, a 10-second per-input timeout and a 2 GiB fuzzer RSS limit. A green run is a bounded search, not proof of correctness; execution counts include repeated/similar mutations and are not independent test cases.

For a fresh Linux x86-64 run, from the repository root:

```sh
rustup toolchain install nightly-2026-01-30 --profile minimal --component llvm-tools-preview --component rustfmt
cargo +nightly-2026-01-30 install cargo-fuzz --version 0.13.2 --locked --root .tools/fuzz
export PATH="$PWD/.tools/fuzz/bin:$PATH"
cargo +nightly-2026-01-30 fetch --manifest-path fuzz/Cargo.toml --locked
cargo +nightly-2026-01-30 run --manifest-path fuzz/Cargo.toml --locked --example seed -- fuzz/corpus
cd contract
CARGO_NET_OFFLINE=true cargo +nightly-2026-01-30 fuzz run --fuzz-dir ../fuzz state_init -- \
  -max_total_time=120 -max_len=4096 -timeout=10 -rss_limit_mb=2048 -seed=20261013 -print_final_stats=1
CARGO_NET_OFFLINE=true cargo +nightly-2026-01-30 fuzz run --fuzz-dir ../fuzz canonical_message -- \
  -max_total_time=120 -max_len=4096 -timeout=10 -rss_limit_mb=2048 -seed=20261013 -print_final_stats=1
```

The seed command refuses an existing corpus directory. To extend a retained corpus, omit that command and rerun the targets; vary the seed for further exploration. Follow the workflow's `cargo fuzz coverage` and `llvm-cov report` commands after the campaign finishes. Coverage replay executes the retained corpus once; it is not another fuzz campaign. The [Rust Fuzz Book](https://rust-fuzz.github.io/book/cargo-fuzz/coverage.html) explains the source-coverage distinction.

These targets exercise native-compiled guest/SDK code, not the WASM host, live chain, console receipt parser, signature cryptography or arbitrary multi-message lifecycle sequences. Existing generated lifecycle and native console tests remain separate evidence. Reproduce any failure against the exact source and lockfiles before classifying it as a contract defect.

Oracle sensitivity was checked in disposable copies: an incorrect but still valid cap passed the previous initialization oracle and failed the exact-byte oracle; altered expiry and recipient method also failed. Restored production code passes the same four-recipient input. These selected mutations establish that those checks can detect their intended faults, not that every initialization defect is covered.

### Remaining release gates

- Host cryptographic verification and signature binding to the intended vault/network; the pinned CLI cannot submit raw forged or chosen-nonce messages.
- Host-level atomicity, mid-execution fuel exhaustion, transfer-value refunds/chargeable-route settlement and crash/restart behavior beyond the tested receipt-loss, local recipient rejection and pre-execution fee boundaries.
- Longer and broader fuzz campaigns, console receipt-parser fuzzing, arbitrary action sequences and an independent AVM-aware review.
- Actual hosted deployment: the separate authenticated entrypoint, bounded runner, fresh-session protocol and private package are implemented; reproduce and inspect the exact candidate's hosted/native/browser/service checks before treating them as qualified. [Console instructions](../console/README.md#private-hosted-laboratory) distinguish these fixtures from unverified real Cloudflare Access/MFA, tunnel/origin-bypass, host compatibility and co-host checks. No VPS deployment is authorized by a passing CI run. Distinct-version rollback and a long-running session on the default execution balance remain separate qualification gaps.
- Target-network compatibility and a separately approved deployment procedure before any network use.

The [pinned SDK release notes](https://github.com/gosh-sh/avm-sdk/blob/0748f4f0767a26da8bc363bcb6b5585539d6970e/docs/release-notes.md) state that the runtime binaries come from private sources. Public guest tests and SDK source inspection cannot replace review of that host implementation. Guest MIT licensing and the separate host-binary license are distinct; the example does not redistribute the SDK bundle or grant additional host rights. Record an unavailable check as a gap, not a passing result.

The canonical adapter tests also exercise duplicate nonces, wrong caller types, malformed inputs and deployment envelope boundaries. The stand CLI generates fresh signed calls and has no raw-message or chosen-nonce submission option, so duplicate-nonce rejection is proven at the adapter boundary rather than by a native resubmission.

These results establish local guest behavior against the pinned AVM distribution. Network compatibility and the host's cryptographic signature verification are separate claims. The repository has no network deployment procedure or real wallet credentials.
