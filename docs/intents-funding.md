# Intents-Funded kernel2 — Design Notes

Status: DESIGN v3 — contract-baked funding. The contract itself moves the
deposit to Solana at job time; no operator float. Not yet implemented.
Native NEAR `deposit()` remains live until this lands.

## The model (v3)

Bake the funding INTO the contract: user deposits USDC into kernel2; when a
job runs, kernel2 itself moves that value across so the MPC-derived payer can
pay the merchant. No operator float, no manual tops. The contract is the
exchanger.

```
USER                    KERNEL2 (all on-chain, contract-baked)        SOLANA
────                    ──────────────────────────────────────        ──────
USDC ─ft_transfer_call─► credit_token:<user> (escrow)
                          │ callApi:
                          │ 1. gate: credit ≥ budget
                          │ 2. execute defuse intent:
                          │    deliver USDC to DERIVED PAYER
                          │    (solver fills cross-chain)
                          ▼
                          payer funded ◄─────────────── solver delivers
                          │
                          ├─► exec-a (fetch, 402, balance check)
                          ├─► MPC sign
                          └─► exec-b pays merchant FROM the payer
                                └─ merchant paid 1:1 by the user's own
                                   deposit, moved by the contract
```

## Why this beats operator-float (v2)

- Each job is backed 1:1 by its own deposit, moved at job time. The kernel
  never owes anyone a float; insolvency is impossible by construction.
- Refund: intent not fired → credit returns; fired but unfilled → job
  stalls in `funding` and refunds. Escrow-can't-leak preserved.

## Mechanics (grounded in defuse v0.2.10 source)

- defuse executes SIGNED intents on-chain immediately (`execute_intents`,
  state deltas, relayer.rs). There is NO on-contract cross-chain intent:
  `FtWithdraw` delivers NEP141 to NEAR accounts only (receiver_id is a NEAR
  AccountId).
- Cross-chain delivery = SOLVER fill. Solvers watch chain state and
  complete the Solana leg asynchronously. kernel2 can compose, sign, and pay
  for the intent on-chain, but the Solana landing is async — the kernel
  cannot verify it via its own promise chain. THIS IS THE ONE TRUST LEG.
  Accepted: solvers are the bridge. Bonded + competitive, zero custom
  bridge code on our side.
- Practical route: solver-quoted cross-chain (1Click-style pattern):
  USDC on NEAR → USDC at the derived payer on Solana. On-chain artifact =
  token escrow + claim inside the intents contract; kernel2 drives it via
  cross-contract calls as part of the job.

## Verifying the payer got funded — no indexer needed

Exec-a already runs in the TEE with HTTP. Add a step: before building the
payment, exec-a queries Solana RPC for the payer's USDC balance.
- Funded → proceed; amount gate additionally checks payer balance ≥ price.
- Not funded (solver lag/fail) → exec-a returns "payer unfunded"; kernel
  sets status `funding` — retry exec-a later, or refund. Escrow intact
  either way.
Verification stays inside the kernel's own execution path (TEE reads RPC),
consistent with the no-indexer rule.

## Order of operations in callApi (v3)

1. Gate: user `credit_token` ≥ budget.
2. Fire the cross-chain funding (defuse intent / solver escrow) delivering
   `amount` to the derived payer; `.then(onFunded)` acks the on-chain
   intent execution (the solver fill itself remains async).
3. onFunded → fire exec-a; exec-a re-checks payer balance via RPC.
4. Unfunded → status `funding` (retry or refund); funded → normal flow:
   gates → MPC sign → exec-b pays → settle (debit credit at signed time,
   as today).

## Trust ledger (v3, final)

- Escrow, gates, settle: kernel2's promise chain (unchanged).
- Payment signing: MPC network (unchanged).
- Cross-chain value movement: solver network (accepted; the only bridge).
- Funding verification: TEE reads Solana RPC (no indexer).
- Operator float: ELIMINATED.
- Watchers/indexers/custom relayers: none.

## Open items

- Which USDC pair: Solana native vs NEAR bridged twin — must share a
  canonical mint or the solver swaps inside the intent (defuse TokenDiff
  supports on-chain swaps; cross-chain quote is solver-side).
- Solver route wire format: defuse `execute_intents` + TokenDiff on NEAR,
  cross-chain quote via solver API — exact calls TBD.
- Gas: callApi closure is at 295/300 Tgas static cap; the funding
  cross-contract call needs literal room — likely split into
  `fundAndCall` (two user txs) or shave existing literals.
- Derived-payer USDC ATA creation (rent): kernel pays from credit, or the
  solver creates it during fill.
