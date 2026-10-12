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

**Status: active development and security testing ongoing.** This is a working local AVM demonstration, not an independently audited or network-deployed wallet. Deeper adversarial testing is in progress; passing tests are not approval for real funds. Neither console entrypoint connects to Shellnet or Mainnet. No real keys, funded network accounts or network deployment configuration belong in this repository. Do not deposit real funds.

## Start reviewing

- [Verification guide](docs/verification.md): reproduce the journey and inspect its receipts.
- [Native CI runs](https://github.com/anvilfilbert/ackivault/actions/workflows/stand-e2e.yml): Rust checks, clean rebuild comparison, recipient delivery and journal replay.
- [Contract source](contract/src) and [behavior tests](contract/tests).
- [Design and trust boundaries](docs/superpowers/specs/2026-10-12-ackivault-design.md).

## Verify

Use Linux x86-64-v3 with Rustup and `jq`. Install the [pinned AVM SDK release](https://github.com/gosh-sh/avm-sdk/releases/tag/avm-dev-335a0f09fdbc-sdk-0cbca40fad9a), and put its `bin/` directory on `PATH`. Do not mix the packaged stand with a different SDK revision. The Rust version is pinned in `rust-toolchain.toml`; Cargo pins the matching SDK source.

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
