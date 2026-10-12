# AckiVault local console

## Purpose

Provide a usable demonstration and review surface for the bounded-agent vault. Show funding, runtime-visible SHELL balance, allowance used, expiry, fixed recipients and payment history. The user can exercise the test vault through Fund, Pay, Revoke and Withdraw controls and use the resulting receipts as evidence for SDK inclusion.

## Runtime boundary

Use a Node.js 22 server bound to `127.0.0.1` and a small browser interface. A connector invokes only the pinned official local stand, using fixed local identities and explicit subprocess arguments. The console accepts no imported wallet keys or network endpoint. All mutable actions operate on a fresh local stand session and a deployed test recipient.

The ARM Mac cannot execute the packaged x86-64-v3 stand. A separate evidence-server entrypoint reads actual CI receipts, identifies the run and source commit, and disables mutation controls. It never silently switches from a live session to saved evidence. Both servers present the same typed snapshot schema with explicit available actions.

## Contract query

Add an owner-only signed `ackivault.inspect` call that consumes a strictly increasing owner nonce and reports the visible SHELL balance in a status event. It changes only owner nonce bookkeeping; it cannot transfer value, revoke, reset the allowance or alter recipients. The balance is labeled as a sample from that execution, since later protocol fees may apply. Browser refresh reads a cached snapshot and does not repeatedly generate chargeable calls.

## Demo flow

Start with a grant of 1,000 test SHELL, one fixed recipient and a one-hour expiry. Deployment funding is separate from the grant cap. Fund sends exactly 100 test SHELL through the fixture's internal deposit. Pay accepts a positive unsigned decimal amount and targets only the configured recipient. Revoke is permanent. Withdraw sends a user-selected amount to that test recipient after revocation or expiry. Every action checks executor status and preserves its JSON receipt. No action may be retried automatically after an ambiguous mutation outcome.

Show accepted and rejected calls distinctly, with timestamps and explicit contract errors. The console renders escaped text, uses accessible labels and stable test IDs, and disables conflicting operations while one request is active. Server mutation routes require the expected local host, JSON content type and a same-origin request; commands use no shell interpolation. Configuration paths and amounts are validated before execution.

## Verification

Test the API through a real native stand session in CI: create, fund, pay, over-cap rejection, revoke, revoked-pay rejection, withdraw and recipient receipt. Verify malformed request rejection and arbitrary-origin rejection. Test evidence loading with the actual journey output. Inspect the browser on the Mac for rendering, source labeling, keyboard controls and honest unavailable actions. Keep source, lockfiles and generic instructions in Git; exclude state, keys, receipts and local host paths.
