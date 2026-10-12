# AckiVault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally verify a bounded, revocable SHELL-spending AVM vault.

**Architecture:** A single Rust `MessageIsolated` contract uses a versioned fixed-size state codec and pure transition functions. A thin AVM adapter translates canonical inputs into those transitions and emits state, outbound, and event intents only after validation. A reproducible Linux x86-64 local-stand journey proves delivery to a test recipient and replay.

**Tech Stack:** Rust 1.93.0, `avm-contract-sdk` commit `0cbca40fad9a`, `wasm32-unknown-unknown`, packaged `avm-contract-build` and `avm-local-stand` release `avm-dev-335a0f09fdbc-sdk-0cbca40fad9a`, Linux x86-64 container.

**Spec:** [AckiVault design](../specs/2026-10-12-ackivault-design.md)

## Global Constraints

- SHELL is extra currency ID `2`; `value_main` is always `0` on a vault payment.
- Cap use is `payment_amount + fixed_outbound_reserve`, checked before any effect.
- One nonzero agent key; one to four distinct, immutable `(dapp_id, account_id)` recipients with fixed method and reserve.
- Only canonical signed external owner/agent calls may change grant or spending state; the AVM host verifies signatures.
- No callback-based allowance restoration, grant renewal, upgrade, network deployment, real keys, or funds.
- No personal names, machine names, local paths, credentials, or account-specific details in tracked files.
- Do not infer chain safety from unit tests; the real local-stand journey and replay are required.

## Review Focus

- An all-zero owner or agent key must reject initialization, not create an unowned vault (Task 2).
- A duplicate recipient with a different method or reserve must still reject initialization (Task 2).
- An external message carrying unexpected value or an internal callback to an owner/agent method must reject without effects (Task 4).
- At the exact expiry second, agent payment must reject while owner withdrawal may proceed (Task 3).
- A visible balance exactly equal to payment plus reserve must pass; one unit below must reject (Task 3).

---

### Task 1: Pin the toolchain and prove ABI compatibility

**Files:** Create `.gitignore`, `rust-toolchain.toml`, `contract/Cargo.toml`, `contract/avm-contract.toml`, `contract/src/lib.rs`; test with the packaged build command.

**Interfaces:** The contract exports `init` and `process_message` through `export_message_contract!`. ABI names are `ackivault.deposit`, `ackivault.pay`, `ackivault.revoke`, and `ackivault.withdraw`; the descriptor fixes the state root and argument byte lengths. Method IDs used by the adapter must be derived from the resulting ACAB, not guessed.

- [x] Write a minimal AVM guest that rejects every message and an ABI descriptor with the four methods and explicit errors.
- [x] Run the pinned builder in an amd64 Linux container; record the generated method IDs and inspect the descriptor/ACAB. A failed build is not a passed compatibility check.
- [x] Add a build check that compares the contract constants against generated ACAB IDs, then run it to prove the constants match.
- [x] Commit only source/config, never downloaded SDK binaries, build outputs, or runner state.

### Task 2: Versioned state and initialization

**Files:** Create `contract/src/state.rs`, `contract/src/initialization.rs`, `contract/tests/initialization.rs`; modify `contract/src/lib.rs` and the ABI descriptor.

**Interfaces:** `VaultState { owner_key, agent_key, expires_at, cap, spent, revoked, owner_nonce, agent_nonce, recipients }`; `Recipient { address, method_id, reserve_shells }`; `decode_state(bytes: &[u8]) -> Result<VaultState, VaultError>`; `encode_state(state: &VaultState) -> Result<Vec<u8>, VaultError>`; `initialize(owner_key: [u8; 32], args: &[u8], block_time: u32) -> Result<VaultState, VaultError>`.

- [x] Write failing tests for valid initialization and state round trip; zero keys, past/current expiry, zero cap, zero or five recipients, duplicate addresses, zero destination or method, malformed/truncated/noncanonical state and arguments.
- [x] Run `cargo test --manifest-path contract/Cargo.toml` and confirm the new tests fail for missing behavior.
- [x] Implement a fixed-version codec and pure initialization validation; allow unrelated ABI metadata only where the SDK does.
- [x] Rerun tests and commit the independently checked initialization/codec slice.

### Task 3: Pure grant transitions

**Files:** Create `contract/src/grant.rs`, `contract/tests/grant.rs`.

**Interfaces:** `pay(state: &VaultState, caller: [u8; 32], nonce: u64, index: u8, amount: u128, balance_shells: u128, block_time: u32) -> Result<(VaultState, Payment), VaultError>`; `revoke(state: &VaultState, caller: [u8; 32], nonce: u64) -> Result<VaultState, VaultError>`; `withdraw(state: &VaultState, caller: [u8; 32], nonce: u64, payment: Payment, balance_shells: u128, block_time: u32) -> Result<(VaultState, Payment), VaultError>`.

- [x] Write failing tests for authorized pay, exact cap, cap+1, overflow, wrong role, replay, invalid index, expiry edge, revoke/repeat revoke, pre/post-expiry withdrawal, nonzero destination, and exact/short balance.
- [x] Run the tests and confirm behavioral failures.
- [x] Implement pure, checked transitions with immutable returned state and an explicit `Payment` intent; no state mutation or output side effects on error.
- [x] Rerun tests and commit this slice.

### Task 4: Canonical AVM adapter and events

**Files:** Modify `contract/src/lib.rs`, `contract/avm-contract.toml`; create `contract/tests/contract.rs`.

**Interfaces:** `AckiVault::init(MessageInput<'_>) -> MessageOutput`; `AckiVault::process_message(MessageInput<'_>) -> MessageOutput`. The adapter calls Tasks 2–3, checks exact canonical argument lengths/caller/value/currency, and creates one `StateUpdate::FullReplace` plus the intended event/outbound only on success.

- [ ] Write failing adapter tests for canonical external initialization, internal SHELL-only deposit, authorized pay, revoke, withdraw, wrong source types, unexpected incoming currencies/value, and effect-free rejection.
- [ ] Run the tests and confirm the failures.
- [ ] Implement precise status codes and ABI errors; `pay` and `withdraw` emit `value_main = 0`, only extra currency ID `2`, and the fixed/selected reserve. Events must say dispatched, not delivered.
- [ ] Rerun tests, `cargo fmt --check`, Clippy, and pinned reproducible AVM build; commit this slice only when green.

### Task 5: Real local-stand journey

**Files:** Create `tests/stand/` fixtures and a narrow `scripts/stand-e2e.sh`; modify `README.md` only for run instructions and safety limits.

**Interfaces:** The runner accepts explicit paths to the packaged build and stand binaries and Wasmtime profile; it writes all state and logs under an ignored local output directory. It uses deterministic local identities and timestamps, no secret keys or network endpoints.

- [ ] Write stand assertions before the runner passes: deploy and fund, internal SHELL deposit, accepted payment observed by a test recipient, over-cap/replay/wrong-key/revoked rejection, owner withdrawal, events and state, journal replay, and no real-network calls.
- [ ] Run the runner to establish the failing end-to-end baseline.
- [ ] Add only the fixture/runner behavior needed to satisfy those assertions; inspect receipt fields rather than trusting exit status alone.
- [ ] Run the complete Rust suite, format, Clippy, two reproducible AVM builds, stand journey, and replay. Save a concise evidence summary outside tracked files if it includes local metadata.
- [ ] Scan tracked files and commit metadata for personal/private data, review the final diff, then push the verified commit(s) to the repository.
