# AckiVault

[![Local AVM verification](https://github.com/anvilfilbert/ackivault/actions/workflows/stand-e2e.yml/badge.svg?branch=main)](https://github.com/anvilfilbert/ackivault/actions/workflows/stand-e2e.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Give an agent spending authority without giving it unrestricted control.**

AckiVault is an experimental Rust smart contract for the [Acki Nacki AVM](https://github.com/gosh-sh/avm-sdk). The owner funds a vault and gives a separate agent a bounded SHELL-spending grant:

- **Capped spending:** one cumulative allowance, including each payment's fixed outbound reserve.
- **Fixed recipients:** up to four recipient contracts, selected at deployment.
- **An expiry:** agent payments stop at the configured block time.
- **Owner control:** permanent revocation and recovery after revocation or expiry.

The [local web console](console/README.md) exposes the test flow: create, fund, pay, inspect, revoke and withdraw. It shows allowance usage, expiry, recipients and accepted/rejected execution receipts. A separate read-only viewer displays saved CI evidence on hosts that cannot run the native stand.

This is an open-source learning and reference example for AVM contract authors and agent developers, not a hosted custody service or a DEX.DO connector. Use the source, tests and receipts to explore bounded spending and failure handling; the example does not purchase inference or manage a customer's network wallet.

**Status: Phase 1 learning milestone complete; project paused.** The local AVM demonstration and separate authenticated private-console laboratory have passed their bounded Linux CI checks; see the [verification scope](docs/verification.md#private-console-qualification). They are not independently audited or network-deployed wallets; passing tests are not approval for real funds. No console entrypoint connects to Shellnet or Mainnet. No real keys, funded network accounts or network deployment configuration belong in this repository. Do not deposit real funds.

## The bigger idea: several sellers, one API

Buying access to several AI models should not mean maintaining a separate application connection for every seller. The future integration concept is **one API address for an IDE or agent, with multiple purchased inference streams behind it**:

```text
Seller A / purchased model stream A ─┐
Seller B / purchased model stream B ─┼─ AckiVault routing API ─ IDE or agent
Seller C / purchased model stream C ─┘       selected per request
```

The user would connect their tool once, then choose the model or purchased stream through a request parameter or interface option. A request for stream A goes to its approved connection; a later request for stream B uses the same API address but a different connection. Responses remain separate—this does not blend models, merge answers or silently substitute another seller.

The intended benefit is less connection management: one place to see purchased capacity, usage, spending limits and connection status instead of juggling several seller endpoints. Sellers could reach buyers through the tools they already use. DEX.DO would remain the marketplace for model access, matching and settlement; AckiVault would be the convenience and control layer around it, not a second exchange.

**This routing API is an untested, paused concept, not implemented functionality or an active customer-service launch.** Today's repository demonstrates bounded spending and receipt verification only. The experimental AVM vault is not a verified replacement for DEX.DO's own wallet, escrow or PrivateNote flow. The [Phase 2 research checkpoint](docs/phase2-research.md) records source observations, unresolved key-authority questions and the missing end-to-end tests. No integration or launch is promised.

## Start reviewing

- [Verification guide](docs/verification.md): reproduce the journey and inspect its receipts.
- [Native CI runs](https://github.com/anvilfilbert/ackivault/actions/workflows/stand-e2e.yml): Rust checks, clean rebuild comparison, recipient delivery and journal replay.
- [Contract source](contract/src) and [behavior tests](contract/tests).
- [Design and trust boundaries](docs/superpowers/specs/2026-10-12-ackivault-design.md).

## Verify

Use Linux x86-64-v3 with glibc 2.39 or later, Rustup and `jq`. Install the [pinned AVM SDK 0.2.0 / guest SDK 0.1.1 release](https://github.com/gosh-sh/avm-sdk/releases/tag/avm-dev-06e96ef71006-sdk-0748f4f0767a), and put its `bin/` directory on `PATH`. Do not mix the packaged stand with a different SDK revision. The Rust version is pinned in `rust-toolchain.toml`; Cargo pins the matching SDK source.

SDK 0.2.0 changes local state/event commitments and does not migrate old stand state. Create fresh local test state and rebuild/redeploy both contracts; keep old state with its matching old binary/profile for historical replay. Rebuilt code hashes and FUEL usage may differ. These local checks do not establish Shellnet or Mainnet compatibility or readiness for an authenticated VPS installation.

```sh
cargo fmt --manifest-path contract/Cargo.toml --check
cargo test --manifest-path contract/Cargo.toml --locked
cargo clippy --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --locked -- -D warnings
avm-contract-build build --manifest-path contract/Cargo.toml
avm-contract-build build --manifest-path tests/stand/receipt/Cargo.toml
```

Then run the local journey using the command in the [verification guide](docs/verification.md), or start the [console](console/README.md). The [CI workflow](.github/workflows/stand-e2e.yml) is the complete automated recipe, including the SDK archive checksum and both contract builds. Node.js 22 is needed only for the console and its tests.

A translated amd64 container on an ARM Mac does not establish native-stand compatibility. The Mac can run the read-only evidence viewer; actual guest execution is verified on native Linux CI.

## Important boundaries

The cap covers payment amounts and configured outbound reserves, not every protocol fee. Dispatch is not delivery: the integration journey checks recipient state. The AVM host remains responsible for cryptographic signature verification; Rust adapter tests do not prove that host boundary. See the design and verification guide for the full scope.

## License and security

[MIT](LICENSE). Report vulnerabilities through [private security reporting](SECURITY.md); use GitHub issues for non-sensitive bugs and reproducibility questions.
