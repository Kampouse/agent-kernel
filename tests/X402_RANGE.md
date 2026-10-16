# x402 Adversarial Range (near-mock battlefield)

Drives the full mock lane (kernel2 + outlayer + FT + fake MPC) against mutated
x402 challenges. Everything is local: fake challenges are inline fixtures inside
`wasms/exec-a-range-fixture.ts` (URL path = scenario id) — no network needed.

## Run

    python3 tests/run_x402_range.py            # all scenarios
    python3 tests/run_x402_range.py payto_swap # one
    python3 tests/build_range_wasms.py         # rebuild range wasms from sources

Prereqs: `near-mock` built (lisp-rlm), `inlayer` daemon built (near-inlayer),
`/tmp/fake_mpc.wasm` present. No serve/daemon may be running (the script kills them).

## Scenarios

- **honest** — control: full chain to `job_done`, refund.
- **payto_swap** — merchant swaps the payee after the pin. Gate must refuse to sign.
- **amount_inflate** — charges 999999 against a 1M budget. Gate is ≤budget → signs.
- **amount_fractional** — under-charges (99 vs 100). Same ≤budget policy → signs.
- **sign_garbage** — fake MPC signature. Job settles ok=0 with refund, never ok=1.

## Findings so far (2026-10-15)

1. **Escrow leak on gate failure (real bug):** payto_swap → kernel onResult traps
   ("bad msgHex") → job never reaches job_done → the 1M budget stays escrowed
   forever. Security property holds (no signature), liveness doesn't (no refund).
   Fix: on gate failure, refund + close the job instead of panicking.
2. **Amount policy gap:** the kernel gate is `amount ≤ budget`, not
   `amount == quote`. Over/under-charge within budget gets signed. Decide policy:
   exact-match against the quote, or keep ≤budget deliberately.
3. **Compiler forward-ref regression (lisp-rlm):** function→function calls where
   the callee is defined later in the file fail ("unknown function"). The
   committed kernel2.ts can no longer compile as-is; the range build reorders
   functions (build_range_wasms.py). A top-level export calling a later-defined
   function still resolves — only non-export→non-export forward refs break.

## Seed notes

The kernel ledger (`credittok:`) is credited directly via `state import` — do NOT
seed through `usdc.ft_transfer_call` (debits the sender; the refund path doesn't
complete in the mock → ERR_BAL on the funding leg). Jobs are submitted via CLI
while NO serve is running, then the serve is bounced (CLI writes the state file;
a running serve holds a stale in-memory copy).
