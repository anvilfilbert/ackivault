# Reviewer verification guide

AckiVault demonstrates a bounded SHELL allowance for a separate agent key. The owner fixes the recipient contracts, expiry and cumulative cap, then can permanently revoke the grant and recover funds. The cap includes the payment and fixed outbound reserve; other protocol fees are not part of that allowance.

## Reproduce the evidence

Use the source commit recorded by a successful `AckiVault local stand` workflow run. Its native Linux runner installs the pinned Rust toolchain, verifies the SDK archive checksum, runs the Rust tests and Clippy, checks both builds for byte identity, then executes the local AVM stand journey. The workflow can be rerun through GitHub Actions or followed on a Linux x86-64-v3 machine.

After building both contracts with the matching `avm-contract-build`, run:

```sh
bash scripts/stand-e2e.sh \
  /path/to/avm-sdk-linux-x86_64 \
  contract/target/avm \
  tests/stand/receipt/target/avm \
  .stand/reviewer-run
```

The output directory must not already contain a stand state file. All identities and funds belong to the local stand. Download `stand-diagnostics` from the workflow run to inspect the JSON receipts for that exact commit.

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

The canonical adapter tests also exercise duplicate nonces, wrong caller types, malformed inputs and deployment envelope boundaries. The stand CLI generates fresh signed calls and has no raw-message or chosen-nonce submission option, so duplicate-nonce rejection is proven at the adapter boundary rather than by a native resubmission.

These results establish local guest behavior against the pinned AVM distribution. Network compatibility and the host's cryptographic signature verification are separate claims. The repository has no network deployment procedure or real wallet credentials.
