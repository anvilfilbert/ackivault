# AckiVault

AckiVault is an experimental AVM Rust contract for a bounded SHELL-spending grant. The deployment signer owns the vault. A separate agent may send SHELL only to one of up to four immutable recipients, before expiry and within a cap that includes each recipient's fixed outbound reserve. The owner may revoke the grant and withdraw after revocation or expiry.

This repository is local-test-only. It contains no real keys, deployed addresses, mainnet configuration, or network deployment procedure. A passing test run is not a security audit or authorization to deposit real funds.

## Verify

The pinned Rust version is in `rust-toolchain.toml`; the pinned AVM SDK revision is in `contract/Cargo.toml`. On a compatible Linux x86-64 host with the [AVM SDK](https://github.com/gosh-sh/avm-sdk) tools installed:

```sh
cargo fmt --manifest-path contract/Cargo.toml --check
cargo test --manifest-path contract/Cargo.toml --locked
cargo clippy --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --locked -- -D warnings
avm-contract-build build --manifest-path contract/Cargo.toml
```

The [CI workflow](.github/workflows/stand-e2e.yml) also builds the test recipient and runs `scripts/stand-e2e.sh` against the native Linux AVM stand. It checks local deployment, an internal SHELL deposit, recipient delivery, rejected payments, revocation, owner withdrawal, and deterministic replay. The stand profile requires x86-64-v3; a translated amd64 container on an ARM Mac does not establish this integration result.

The contract behavior and security boundaries are defined in the [design spec](docs/superpowers/specs/2026-10-12-ackivault-design.md). The Rust tests check replay nonces and malformed input that the stand CLI cannot directly submit as duplicate signed messages.

For independent reproduction and the receipt checklist, use the [reviewer verification guide](docs/verification.md).

The [local web console](console/README.md) shows allowance, expiry, fixed recipients and actual execution receipts. Its native-stand controls create, fund, pay, revoke and withdraw using test funds only. A separate read-only evidence viewer runs on an ARM Mac. Neither entrypoint connects to Shellnet or Mainnet.
