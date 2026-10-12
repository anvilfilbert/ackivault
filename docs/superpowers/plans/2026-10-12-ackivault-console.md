# AckiVault Console Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Deliver a local console backed by the real AVM stand and a separate viewer for verified CI evidence.

**Architecture:** A typed Node.js connector owns a local stand session; pure decoders turn receipts and vault state into a browser snapshot. A localhost HTTP interface serves a small static frontend. A separate evidence server reads saved receipts and exposes no mutation routes.

**Tech Stack:** Node.js 22, TypeScript, runtime schema validation, native HTTP, browser JavaScript and CSS, pinned AVM release.

**Spec:** [Console design](../specs/2026-10-12-ackivault-console-design.md)

## Global constraints

- Bind only `127.0.0.1`; use no network endpoints or imported keys.
- Keep decimal amounts as strings or checked `bigint`, never floating point.
- Use explicit subprocess arguments and verify the contract executor result.
- Expose recorded CI evidence as evidence; never synthesize live balances.
- Preserve failed-call receipts and show their specific status.

## Review focus

- Reject unsafe origins, oversized/malformed bodies and invalid amounts before a call.
- Prevent overlapping state mutations and never retry an ambiguous signed call.
- Require an increasing owner nonce for inspection as well as recovery actions.
- Check actual recipient state after transfers, not only vault dispatch.
- Treat missing receipt fields and a failed SDK/runtime call as explicit errors.

### Task 1: Owner inspection and typed receipt decoding

**Files:** Contract ABI/adapter/grant/tests; `console/src/receipts.ts`, package and compiler config.

**Interfaces:** `inspect(state, owner, nonce) -> VaultState`; `decodeVault(hex) -> VaultView`; `decodeInspection(output) -> bigint`; runtime schemas require receipt state and executor output.

- [x] Add failing owner-inspection tests for authorization, nonce replay and effect-free errors.
- [x] Implement the query and derive/check ABI IDs from the builder.
- [x] Add receipt decoding checks using real stand output; run Rust and TypeScript checks.

### Task 2: Local stand connector and HTTP controls

**Files:** `console/src/stand.ts`, `console/src/http.ts`, `console/src/live.ts`, `console/test/stand.test.ts`.

**Interfaces:** `LocalStand.create(config)`, `snapshot()`, `fund()`, `pay(amount)`, `revoke()`, `withdraw(amount)`; JSON snapshot contains source, vault, recipient, activity and available actions.

- [x] Write a real native stand/API test with the grant, transfer, rejection and withdrawal expectations in the spec.
- [x] Implement local session setup and calls; retain each receipt and serialize mutation operations.
- [x] Verify API errors, origin checks and recipient delivery in CI.

### Task 3: Console and evidence viewer

**Files:** `console/public/`, `console/src/evidence.ts`; README and CI workflow.

- [x] Build the explicit source banner, allowance display, balance sample, recipient and activity views, and controls with stable test IDs.
- [x] Load actual CI evidence on the Mac; verify unavailable mutations and render the console in the browser.
- [x] Run the native API integration and existing stand journey, scan privacy, review all code/docs and push the verified source.
