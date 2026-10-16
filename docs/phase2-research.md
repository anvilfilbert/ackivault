# Phase 2: one API service — untested research

**Status: paused research, not implemented or tested end to end.** This note
preserves a bounded source review dated 16 October 2026. It is not a supported
integration, security audit, deployment guide or commitment to launch a service.
No customer keys, live purchases or network transactions were used for this
review. Source observations do not establish what any live deployment runs.

Phase 1 is the separate local AVM learning example: bounded spending, revocation,
owner recovery and receipt verification. Its tests do not validate this Phase 2
concept or DEX.DO integration. The project is paused after the Phase 1 milestone;
future work requires a new decision to resume.

## Proposed experience and boundaries

The concept is one API address for an IDE or agent, routing each request to a
selected model through separately purchased DEX.DO access. DEX.DO would remain
the marketplace, matching and settlement system, not be replaced by another
exchange or by the experimental AckiVault contract.

The intended first scope is buyer-only. Each purchase or refill would need
explicit customer approval of model, capacity, price ceiling, fees and total
exposure, including locked funds. Inference within already purchased capacity
would not require another purchase approval. There would be no silent refill,
model substitution, answer splicing or reuse of an expected refund as spendable
funds. A customer-run helper is not an assumed requirement.

The essential security constraint is **no unrestricted customer trading keys on
the hosted service**. An approval button, encryption at rest or keeping the main
wallet key elsewhere does not by itself restrict a hosted trading-note key.

## Source-review findings, not live test results

The review examined official CLI v0.8.0 at
[`2053ece9323a408f38f8a163b11653b44a6d72c1`](https://github.com/gosh-sh/dexdo-cli/tree/2053ece9323a408f38f8a163b11653b44a6d72c1)
and backend development source at
[`7cef8cfa00666d8650b2fe4ed38ba55e68f28b72`](https://github.com/gosh-sh/dexdo/tree/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72).
These are different source snapshots, not a verified live compatibility pair.

| Question | Observation in the inspected source |
| --- | --- |
| Is inference authenticated with a separate limited key? | The buyer uses its `Note` to decrypt the seller handover and sign a gateway challenge. The seller verifies that signature against the matched buyer identity. No separate inference-only delegation was established in these paths. |
| Is keeping the master wallet key outside the server sufficient? | No. The inspected PrivateNote owner key also authorizes buying, ownership changes, lifecycle operations and withdrawal. Withdrawal has exit gates but accepts a supplied destination; this is broader than inference-only access. |
| Do REST API scopes solve it? | The inspected backend supports `USER_DATA` and `TRADE` for account/prediction routes. Registration submits the PN secret to that backend. This is not evidence of restricted inference delegation or a requirement for the CLI's direct gateway path. |
| Can a saved deal simply be exported as limited access? | The inspected `export --deal` is a secret-free audit export, not a demonstrated inference-access delegation package. |

Primary evidence:

- [Buyer identity and handover decryption](https://github.com/gosh-sh/dexdo-cli/blob/2053ece9323a408f38f8a163b11653b44a6d72c1/crates/dexdo/src/buyer/mod.rs#L41-L115),
  [gateway challenge signing](https://github.com/gosh-sh/dexdo-cli/blob/2053ece9323a408f38f8a163b11653b44a6d72c1/crates/dexdo/src/buyer/mod.rs#L490-L513)
  and [seller verification](https://github.com/gosh-sh/dexdo-cli/blob/2053ece9323a408f38f8a163b11653b44a6d72c1/crates/dexdo/src/seller/auth.rs#L96-L138).
- PrivateNote [ownership](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/contracts/dex/PrivateNote.sol#L499-L518),
  [purchase authorization](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/contracts/dex/PrivateNote.sol#L878-L896),
  [buyer lifecycle](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/contracts/dex/PrivateNote.sol#L1034-L1114)
  and [withdrawal](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/contracts/dex/PrivateNote.sol#L2641-L2683).
- [REST authentication and account model](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/docs/tech-specs/auth.md#L60-L96),
  [registered permissions](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/crates/infrastructure/src/account_registry.rs#L42-L45)
  and [secret storage](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/crates/infrastructure/src/account_registry.rs#L110-L154).
- [Audit export interface](https://github.com/gosh-sh/dexdo-cli/blob/2053ece9323a408f38f8a163b11653b44a6d72c1/crates/dexdo/src/cli/args.rs#L1381-L1393).

These are trust-boundary observations, not a claim of an upstream vulnerability.
The search was not exhaustive: absence of a supported external signer or limited
key in the inspected paths does not prove that every possible integration is
impossible. The [Note abstraction](https://github.com/gosh-sh/dexdo-cli/blob/2053ece9323a408f38f8a163b11653b44a6d72c1/crates/core/src/note.rs#L46-L59)
alone is not a working remote signer or an enforceable spending policy.

## DApp ID and deployment are separate questions

A hosted API using existing DEX.DO contracts does not automatically need its own
on-chain contract system. The inspected [DEX routing helper](https://github.com/gosh-sh/dexdo/blob/7cef8cfa00666d8650b2fe4ed38ba55e68f28b72/crates/chain/src/dapp.rs#L6-L30)
uses existing protocol routing. A DApp ID alone does not restrict key authority.

For a new TVM contract system, the [official deployment guide](https://dev.ackinacki.com/)
describes an externally deployed root whose DApp ID equals its account ID;
internally deployed children normally inherit the sending DApp. Compatible
tooling, signed deployment material and execution funding are required.
`DappConfig` is the separate shared execution-credit mechanism. Tutorial funding
amounts are not an AckiVault cost estimate.

The reviewed [Rust AVM SDK distribution](https://github.com/gosh-sh/avm-sdk/blob/36d1157f22504b39f77587f3ea325d36216f4ec3/README.md)
describes local-stand development. This review did not verify a supported public
Mainnet deployment route for the Phase 1 Rust contract. Also, [Bee Engine/AN
Wallet authorization](https://dev.ackinacki.com/bee-engine/bee-engine-sdk-integration-documentation)
must not be confused with general arbitrary-contract signing.

## What remains unproven

Before any future implementation or customer pilot, establish:

1. An enforceable authority boundary outside the hosted relay: a supported
   restricted credential, constrained signing interface or another explicitly
   reviewed design. Merely moving an unrestricted signer to another server is
   insufficient.
2. Separate authorization for funding, purchases, inference, usage accounting,
   disputes, close/recovery and withdrawals. Seller claims and refunds are not
   interchangeable with buyer signing authority.
3. Exact upstream/network compatibility and a real end-to-end journey, including
   rejection of unapproved purchases, exhausted capacity, interrupted delivery,
   revocation, settlement and owner recovery. No such Phase 2 journey was run.
4. Per-customer/model isolation and accurate distinction between usable capacity,
   spendable funds, locks, charges and pending refunds. Stopping HTTP requests
   must not be presented as cancelling or settling a deal.
5. Privacy and security verification. A conventional relay can see prompts and
   answers in transit; TLS on both legs does not hide them from the relay.
   Content retention/logging should be off by default. Independent review is
   needed before any wider customer launch.

**Conclusion:** one API address remains a plausible product concept, but a safe,
supported implementation without unrestricted hosted customer keys has not been
demonstrated. Phase 1 success does not establish Phase 2 feasibility. No launch,
live-funds safety or production-readiness claim is made.
