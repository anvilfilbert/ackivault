# AckiVault Design

Date: 2026-10-12
Status: Approved for implementation

## Purpose

AckiVault is a small Rust AVM contract demonstrating bounded, delegated
spending. An owner funds one vault and grants one agent permission to dispatch
SHELL to a fixed set of recipient contracts until a fixed expiry. The grant has
one cumulative cap and can be revoked permanently. The contract is intended as
a useful, adversarially tested AVM SDK example for the developer challenge, not
as an audited wallet, DEX.DO integration, or Mainnet deployment.

Success means a reproducible AVM build and a Linux x86-64 local-stand journey
that proves an authorized payment and the defined rejection cases. A source
commit, a successful Rust unit suite, or a green CI badge alone is not proof of
Mainnet safety.

## Version And Trust Boundary

- Build and stand tests use the matching public SDK release
  `avm-dev-335a0f09fdbc-sdk-0cbca40fad9a`, SDK commit `0cbca40fad9a`,
  Rust `1.93.0`, and the Linux x86-64 release asset whose published SHA-256 is
  `2171ee865bc9fc2e1a1274dfdd0f4330dc362b1f49d38c0a35c4de41aa61d6f3`.
- The later public SDK `main` commit `72ee42dbf923f081bf29b4a1a1b6ea012b6af54f`
  is reviewed for API drift but is not mixed with the older packaged stand.
- The AVM host is responsible for cryptographic verification of signed
  external messages. AckiVault checks the caller key provided in the canonical
  input; its own guest code cannot establish that the host verified a
  signature. Local tests do not close that trust boundary.
- No wallet keys, real funds, network deployment, DEX.DO account, or Mainnet
  endpoint are used in development or tests.

## Contract Shape

Use the SDK's `MessageIsolated` `Contract` interface. The implementation has
one contract crate, a compact fixed-version state codec, and a test recipient
and funder fixture used only for the local-stand journey. No application
server, indexer, oracle, scheduler, or upgrade contract is part of version one.

Initialization requires a signed external caller. That caller's public key
becomes the owner key. The initialization arguments contain one nonzero agent
key, a future expiry expressed as AVM block time, a positive `u128` cap in
SHELL units, and one to four distinct recipient entries. Each entry fixes an
exact `(dapp_id, account_id)`, recipient method ID, and outbound
`fuel_fee_shells` reserve. Invalid or duplicate entries reject initialization.

State records a schema version, owner and agent keys, expiry, cap, cumulative
spent amount, permanent revocation flag, the recipient entries, and the last
accepted owner and agent external nonces with presence flags. All state and
amount arithmetic is checked; malformed state fails without effects.

## Currency And Cap Semantics

SHELL is AVM extra currency `currency_id = 2`, **not** `value_main`. A payment
outbound transfers the requested SHELL amount through `extra` and uses the
recipient entry's fixed `fuel_fee_shells` reserve. It sets `value_main = 0` and
transfers no other extra currency.

For each accepted agent payment, the contract adds the full
`payment_amount + configured_outbound_reserve` to `spent` before emitting the
outbound intent. It accepts only if the checked sum is at most `cap` and the
visible SHELL balance covers the payment and reserve. The agent cannot set or
increase the reserve. Counting the full reserve is deliberately conservative:
unused reserve is **not** credited back to allowance, even if delivery fails
or the runtime later charges less. There is no callback-based allowance
restoration in version one.

The cap is a limit on these contract-controlled payment and reserve intents,
not a guarantee about the vault's total balance loss. External execution,
fixed delivery fees, storage rent, and other protocol charges are outside the
guest contract's exact accounting. The README and emitted event names must not
describe a dispatched message as proven receipt or successful service delivery.

## Methods And State Transitions

| Method | Caller and preconditions | Successful effect |
| --- | --- | --- |
| `deposit` | Internal message with positive SHELL value, zero `value_main`, and no other extra currency. Anyone may fund. | Accept the incoming funds and emit `DepositAccepted`; cap and `spent` do not change. |
| `pay` | Signed external agent key; strictly increasing agent nonce; not revoked; `block_time < expiry`; positive amount; exact configured recipient; checked cap and visible SHELL balance. | Increase `spent` by amount plus fixed reserve, record nonce, emit one outbound SHELL payment and `PaymentDispatched`. |
| `revoke` | Signed external owner key and strictly increasing owner nonce. | Permanently set revoked, record nonce, and emit `GrantRevoked`. Repeating it returns a specific failure. |
| `withdraw` | Signed external owner key and strictly increasing owner nonce; grant revoked or `block_time >= expiry`; positive amount; explicit nonzero destination and owner-selected method/reserve; visible SHELL balance covers requested amount and reserve. | Send the specified SHELL amount, record nonce, and emit `OwnerWithdrawalDispatched`. Owner withdrawals do not change the agent cap ledger. |

Unknown methods, internal calls to owner/agent methods, external calls to
`deposit`, wrong keys, replayed nonces, zero values, malformed arguments,
non-allowlisted destinations, expired or revoked grants, over-cap amounts,
arithmetic overflow, and known insufficient balance return distinct documented
nonzero status codes. A rejected call emits no state update, outbound intent,
or event. Protocol-level fees for processing a rejected external message may
still apply independently of this contract output.

Recipient selection is an index into the immutable initialization list; the
agent cannot supply a free-form destination or method ID. `pay` sends an empty
body in version one. The contract never assumes that outbound dispatch proves
the recipient executed successfully. There is no cap reset, grant renewal,
recipient-list edit, pause/resume, callback reconciliation, or code-upgrade
path in this version.

## Verification

First write behavior tests against the Rust contract and observe expected
failures before adding implementation. Cover initialization validation,
deposit validation, authorized dispatch, exact cap boundary, nonce replay,
wrong role, wrong recipient, expiry boundary, revocation, checked overflow,
insufficient visible SHELL, owner withdrawal, and effect-free rejection. Test
the state codec with malformed and truncated bytes.

Then run formatter and Clippy, compile the WASM/ACAB/descriptor twice through
the pinned `avm-contract-build`, and use the pinned `avm-local-stand` to deploy,
fund, accept an internal deposit, pay a real local recipient contract, inspect
state and events, revoke, withdraw, and replay the accepted journal. The stand
assertions distinguish a dispatched outbound from a recipient's observed
receipt. A failing test or missing stand proof leaves the project explicitly
incomplete.

Use a compatible Linux x86-64 runner for the packaged AVM stand. A local
container or hosted runner may be used after checking its architecture and
resource allowance. No CI step uses real keys or chain funds.

## Publication And Deployment Boundary

Publishing, replying to the challenge, changing repository visibility,
deploying to a network, or funding a vault each requires a separate owner
decision. Even after local tests pass, mark AckiVault experimental and
local-test-only until an independent security review and target-network
verification are completed.

## Primary Sources

- [AVM SDK examples](https://github.com/gosh-sh/avm-sdk/blob/0cbca40fad9a/examples/README.md)
- [AVM SDK getting started](https://github.com/gosh-sh/avm-sdk/blob/0cbca40fad9a/docs/getting-started.md)
- [FUEL and SHELL rules](https://github.com/gosh-sh/avm-sdk/blob/0cbca40fad9a/docs/fuel-and-fees.md)
- [SDK guest interface](https://github.com/gosh-sh/avm-sdk/blob/0cbca40fad9a/crates/avm-contract-sdk/src/lib.rs)
