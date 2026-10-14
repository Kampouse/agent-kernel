# agent-kernel

The kernel contract for "call this API, everything under the hood" — NEAR credit
escrow + job registry + MPC signing + TEE (OutLayer) execution, paying x402
HTTP APIs from a per-user MPC-derived Solana USDC tank.

## kernel2 (current) — one-call x402, zero agent loop

`contracts/kernel2.ts` v2.1: **one user call starts and drives the whole
payment.** No watcher, no indexer, no relay service, no agent resume loop.
The frozen OutLayer contract is untouched.

```
agent: kernel2.deposit()                              // once, top-up credit
       kernel2.callApi(url, suffix, budget, payer58)  // → jobId. That's it.
       … (TEE runs exec-a, kernel callbacks itself, MPC signs, relay broadcasts)
       kernel2.settle(jobId, "1")                     // owner-only, after
                                                      // they see the Solana tx land
```

### What happens inside callApi

1. Budget escrowed from the caller's credit (u128 math), job record written
   (one storage key, status `exec_a`).
2. Fires exec-a on OutLayer (`request_execution`, hash-pinned wasm from
   GitHub) and chains `.then(onResult)` on the same batch. OutLayer's
   yield/resume `value_return`s the exec output back into `onResult` as
   `promiseResult(0)` — no event polling, no second call.

### The callback chain (all on-chain, all predecessor-gated)

| Step | Who fires it | Predecessor at entry | Gate |
|---|---|---|---|
| `onResult` | outlayer's yield resume (`.then`) | `outlayer.testnet` | `requireOutlayer()` + job in `exec_a` |
| `onSignDone` | MPC contract's sign promise (`.then`) | `v1.signer-prod.testnet` | `mpc lane only` + job in `sign_requested` |
| `sigUpload` | attested relay posting the sig | `outlayer.testnet` | `requireOutlayer()` + job in `exec_b` |

`onResult` details that matter:

- `promiseResult(0)` is the **full response JSON**
  (`{"success":true,"output":{"Text":"<msgHex>"},...}`), not the raw Text —
  the msgHex is extracted with a dot-path `jsonGetStr("output.Text", …)`.
- Gate 1 — **payTo pin**: bytes 1..33 of the msgHex must match the registry
  pin (`pinPayTo(suffix, payTo58)`, self-only). The path is composed from
  the job registry (`owner + "-" + suffix`), never from the predecessor.
- Gate 2 — **budget**: the msgHex amount (bytes 65..73, LE u64) must be
  ≤ the escrowed budget.
- Passes both → stores `jobmsg`/`jobamt`, status `sign_requested`, fires the
  raw-promise MPC batch (`v1.signer-prod.testnet sign`, payload_v2 Eddsa,
  domain 1, 1 yocto) with `.then(onSignDone)`.

`sigUpload` stores the sig and fires exec-b (hash-pinned wasm) which
broadcasts to Solana mainnet. `settle(jobId, ok)` is **owner-only**: debit =
the signed amount, refund = budget − amount, or full refund on the fail
path. Every path ends settle-or-refund — escrow cannot leak.

### Proven end-to-end (near-mock, real bytecode, real mainnet)

`/tmp/soltee/x402-local/run_k2v21.sh` drives the full v2.1 loop: real
kernel2.wasm + real outlayer contract.wasm in one near-mock state, real TS
execs (inlayer) hitting the real fetch-relay and Solana mainnet, local
ed25519 standing in for MPC. Latest green run: job ends `done`, credit
debited exactly 1e24 − 1500 lamports (the signed x402 amount), mainnet
broadcast `sent58` returned by exec-b.

The local mock needed two parity fixes (lisp-rlm `f7ea402e`): cross-tx yield
callback delivery (yielddeps persistence + anchor re-push) and
callback-receipt predecessor = the dep promise's target contract.

### Known gaps before testnet

- Swap the local ed25519 stub for the real `v1.signer-prod.testnet` leg
  (constant is already correct; the stub is in the harness, not the kernel).
- Confirm the relay's `/pay` → `sigUpload` path passes the same gates with
  the msgHex it already posts.

---

## Layout

```
contracts/
  kernel2.ts          THE current kernel: one-call x402 (this README's subject)
  kernel2.wasm        compiled artifact matching kernel2.ts
  kernel.ts           v1 kernel: credit escrow + registry + jobPay/settleJob state machine
  tank.ts             tank coordinator (ledger + intents; refuses custody) — superseded
  inlayer_signer.ts   per-user MPC signer (path = caller+suffix; the proven signing leg)
  types/              lisp-rlm.d.ts ambient types for the TS frontend
wasms/v4/             hash-pinned exec wasms (exec-a fetch/402-parse, exec-b broadcast)
tests/                near-mock scenarios + state-machine matrix
docs/                 design + deploy history
```

## Trust boundaries (unchanged in v2.1)

- Money moves only through predecessor-gated lanes: `onResult`/`sigUpload`
  require OutLayer (or self), `onSignDone` requires the MPC contract.
- Signing paths compose from the **job registry** (`owner + "-" + suffix`),
  never from `predecessorAccountId()` — TEE-lane calls arrive with OutLayer
  as predecessor; registry binding pins the path to the payer.
- The x402 challenge fixes the exact amount before any money moves; the
  facilitator rejects underpayment; settle math is exact u128.
- Nobody — agent, TEE, or attacker — can sign outside a registered, funded
  job. `insigner`-layer defense in depth: even direct `requestSign` composes
  the path from the caller, so an attacker can only sign under their own
  (empty) derived address.

## Build / test / deploy

```bash
# compile (lisp-rlm TS frontend)
~/bin/compile contracts/kernel2.ts contracts/kernel2.wasm

# full v2.1 loop in near-mock (real wasms, real relay, real Solana mainnet)
bash /tmp/soltee/x402-local/run_k2v21.sh

# single-tx checks (near-mock; state files are per-run, rm between runs)
M=~/dev/lisp-rlm/target/release/near-mock
OL=~/dev/near-outlayer/contract/target/wasm32-unknown-unknown/release/outlayer_contract.wasm
MAN="gasbench2.testnet=contracts/kernel2.wasm,outlayer.testnet=$OL"
$M call /tmp/k2.bin "$MAN" gasbench2.testnet deposit '{}' \
  --signer gasbench2.testnet --deposit 1000000000000000000000000

# deploy (existing funded account; faucet is 429-happy and .sub.name.testnet is
# CreateAccountNotAllowed — self-deploy to gasbench2.testnet works)
near contract deploy gasbench2.testnet use-file contracts/kernel2.wasm \
  without-init-call network-config testnet \
  sign-with-access-key-file ~/.near-credentials/testnet/gasbench2.testnet.json send
```

## Deploy history (testnet)

- kernel v1 `2U82RwJ…`, deposit `2vLm269q…` (0.1 N), callApi `7bvshNPN…`
  → job `624a028b…` registered, credit 0.08 N (0.02 held) — verified via RPC
- tank v2 `9aSYtEjs…`; fund/withdrawRequest/withdrawSettle smoke all green
- insigner: deploy `41yWMX7f…`, memo E2E `9JxUk9t6…`, Solana `Gc53b2bSVJx…` slot 510692866
- exec-a via fetch-relay on-chain: tx `9DQCDSbx…` (output 723 bytes, cost 0.0010734 N)
- kernel2 is **not yet deployed** — v2.1 is mock-proven, deploy is the next step

## Types

`contracts/types/lisp-rlm.d.ts` — the TS frontend's ambient type definitions
(`near.*` namespace, u128 helpers, sha/json builtins, LispArr). Each contract
carries a `/// <reference path="./types/lisp-rlm.d.ts" />` at the top;
`tsconfig.json` is editor intel only — real builds go through `~/bin/compile`
(the compiler carries its own copy of the d.ts and ignores this one).

Known: `inlayer_signer.ts` predates stricter compiler type-checks (bool≠int on
predicate helpers, int≠str in a promise_then) — its committed `.wasm` is the
E2E-proven last-good artifact; porting to the current checker is a v3 item.

## v1 kernel (kernel.ts) — superseded by kernel2

Credit escrow + registry + the agent-driven state machine
(`exec_a → jobPay → sign_requested → onSignDone → exec_b → onBroadcast →
paying → settleJob → done | failed`), deployed and smoke-green on
gasbench2.testnet. The money-loop primitives it proved (predecessor-gated
settle, registry-bound paths, exact u128 settle math) carry into kernel2
verbatim. Keep for reference; new work targets kernel2.
