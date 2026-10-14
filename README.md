# agent-kernel

The kernel contract for "call this API, everything under the hood" — NEAR credit
escrow + job registry + MPC signing + TEE (OutLayer) execution, paying x402
HTTP APIs from a per-user MPC-derived Solana tank.

## kernel2 (current) — one call, zero infrastructure

`contracts/kernel2.ts` v2.3: **one user call starts and completes the whole
payment, and the contract itself funds the payer cross-chain.** No watcher,
no indexer, no relay service, no agent resume loop, no sig upload step, no
operator float. The frozen OutLayer contract is untouched.

```
agent: kernel2.ft_transfer_call(TOKEN, amt, caller)   // once, top-up USDC credit
       kernel2.callApi(url, suffix, budget, payer58)  // → jobId. That's it.
       …  (kernel debits budget → quote_phase; TEE exec-quote fetches a REAL
          1Click quote; onQuote gates amountIn==budget → status `funding`
          → one ft_transfer_call to the quote's depositAddress — solvers
          swap + deliver to the MPC-derived payer on Solana
          → TEE runs exec-a, kernel gates + self-resumes, MPC signs,
             kernel decodes the sig in-callback, TEE runs exec-b, broadcast)
       kernel2.settle(jobId, "1")                     // owner-only, after
                                                      // they see the Solana tx land
```

### Funding rail: 1Click (NEAR Intents' own cross-chain)

At job time the kernel swaps its token credit for destination-chain funds,
delivered **to the MPC-derived payer itself** — per job, or as one-time
"arming" (the same primitive with a bigger amount):

1. `exec-quote` (TEE, hash-pinned wasm) POSTs to
   `https://1click.chaindefuser.com/v0/quote` through the fetch relay:
   `swapType EXACT_INPUT`, `depositType ORIGIN_CHAIN`, origin USDC.near →
   destination USDC (or native SOL) on Solana, `recipient` = derived payer,
   `refundTo` = kernel2. No API key. Response is a **signed quote** with
   `depositAddress` + `amountIn` + `minAmountOut`.
2. `onQuote` (outlayer-yield callback) gates the quote —
   `amountIn == escrowed budget`, address sanity — then fires **one**
   `ft_transfer_call(depositAddress, amount)` plus exec-a, concurrently.
3. 1Click's bonded solvers deliver; failure means the deposit is refunded
   to kernel2's intents balance. No custom bridge code anywhere.
4. Solver lag surfaces as job status `funding` — refundable, never lost:
   exec-a re-checks the payer's Solana balance via RPC before paying.

Trust ledger: kernel promise chain (escrow) + MPC (signing) + 1Click solvers
(the one unavoidable leg — bonded, competitive) + TEE (fetch/quote).
Verification stays in-path: no operator float, no indexer.

Proven end-to-end in mock (`scripts/run_k2v23.sh`, near-mock + the **real
1Click API**): NEP-141 credit 10M → callApi debit 1M → live quote
(depositAddress, amountIn, minAmountOut) → `funding_started` → status
`funding` → funding `ft_transfer_call` fired to the live depositAddress +
exec-a requested → credit held 9M → `withdrawToken` refund to 0.

Known cost: 1Click withdraw fee on small USDC→USDC pairs is heavy at tiny
sizes (~28% on 1 USDC; amortizes with amount). Testnet twin token:
`usdc.tkn-defuse.testnet`.

### The callback chain (all on-chain, all predecessor-gated)

| Step | Who fires it | Predecessor at entry | Gate |
|---|---|---|---|
| `onQuote` | outlayer's yield resume (`.then` on exec-quote) | `outlayer.testnet` | `requireOutlayer()` + job in `quote_phase` |
| `onResult` | outlayer's yield resume (`.then`) | `outlayer.testnet` | `requireOutlayer()` + job in `exec_a` |
| `onSignDone` | the kernel's own `.then` on the sign promise | self (the scheduler) | `requireSelf()` + job in `sign_requested` |
| (exec-b) | fired directly from `onSignDone` | — | no extra step |

`callApi` internals: budget debited from the caller's **token credit**
(`credittok:<user>`, u128), job written (status `quote_phase`), exec-quote
requested with `.then(onQuote)`. `onQuote` gates the quote then flips to
`funding` and fires the deposit + exec-a. From there the chain below is
v2.2-identical.

The v2.1 `sigUpload` method and the planned relay watcher are **deleted**:
the signature rides the kernel's own promise chain.

`onResult` details that matter:

- `promiseResult(0)` is the **exec output text in JSON-escaped form** — not
  the mock's wrapper JSON. Fields are extracted by manual slice: find
  `"msgHex"`, skip past `:\"`, read to the escaped closing quote
  (len ≥ 100 sanity guard). Normal JSON parsing over the escaped form fails;
  don't regression to `jsonGetStr`.
- Gate 1 — **payTo pin**: bytes 2..66 of the msgHex must match the registry
  pin (`pinPayTo(suffix, payTo58)`, self-only). The path is composed from
  the job registry (`owner + "-" + suffix`), never from the predecessor.
- Gate 2 — **budget**: the msgHex amount (bytes 66..74) must be ≤ the
  escrowed budget.
- Passes both → stores `jobmsg`/`jobamt`, status `sign_requested`, fires the
  raw-promise MPC batch (`v1.signer-prod.testnet sign`, payload_v2 Eddsa,
  domain 1, 1 yocto) with `.then(onSignDone)`.

`onSignDone` details that matter:

- **Mainnet `.then` semantics**: the callback receipt's predecessor is the
  *scheduler* (the kernel itself), not the dependency promise's target. The
  mock's old parity assumption (dep target) is wrong; guard with
  `requireSelf()`.
- `promiseResult(0)` is the escaped
  `{"scheme":"Ed25519","signature":[64 decimal bytes]}` — the sign
  contract's return value, delivered by nearcore. The kernel slices the
  byte array (exactly 64 entries, comma-count sanity check), converts to
  bytes via index-of lookup (`charCodeAt` is not a builtin), b58-encodes
  with the module-level digit table, stores `jobsig`, and fires exec-b
  (hash-pinned wasm) which broadcasts the signed Solana transaction.
- No sig ever touches an indexer or off-chain party. Trust =
  the kernel's own promise chain from the MPC contract.

`settle(jobId, ok)` is **owner-only**: debit = the signed amount, refund =
budget − amount, or full refund on the fail path. Every path ends
settle-or-refund — escrow cannot leak.

### Proven on testnet (real TEE, real MPC network)

Latest full-chain run (tx `FdARXQRb…`, gasbench2.testnet): one `callApi` →
real TEE exec-a through fetch-relay → both gates passed → the production MPC
contract `v1.signer-prod.testnet` signed the 105-byte Solana message
(sign_done on-chain) → `onSignDone` decoded + b58-encoded the signature
in-contract → exec-b executed and attempted the broadcast. Zero failed
receipts.

Independent off-chain verification: the MPC signature verifies against the
contract-derived key (`derived_public_key` view) over the exact payload the
kernel sent, no pre-hashing; epsilon = sha3_256 of
`"near-mpc-recovery v0.1.0 epsilon derivation:<predecessor>,<path>"`.
The pure-Python derivation reproduces the contract's derived key
byte-for-byte.

Remaining item is test-infra only: the devnet payer was drained by earlier
E2E runs and the faucet is rate-limiting; with a funded payer the broadcast
completes and the loop closes at settle.

### Gas budget (each receipt must fund what it forwards, ≤ 300 Tgas cap)

| Receipt | Attaches / forwards | Headroom |
|---|---|---|
| `callApi` | EXEC 60 (exec-quote) + CB_QUOTE 230 = 290 | 10 (compiler-enforced static cap) |
| `onQuote` | funding ft_transfer_call 10 + exec-a 60 + CB_RESULT 145 = 215 | ≤230 ✓ |
| `onResult` | forwards SIGN 40 + CB_SIGN 100 = 140 | ~157 |
| `onSignDone` | own work ~25 + forwards EXEC 60 (100+180=280 ≤300) | ✓ |
| exec-b | 60 | ~57 |

Actual burn for the whole tree ≈ 6–7 Tgas. Attached budgets are deliberate
headroom (prepaid-gas failures were the most expensive debug lesson); the
binding constraint is the 300 Tgas static literal sum per closure — the
compiler hard-fails the 296th literal, so new attach points mean shaving
elsewhere.

### Compiler / memory-map notes (bit us once; don't regress)

- Data segments must start at **139264** (lisp-rlm `a2a8a671`). At the old
  256 they sat on the host scratch buffers (TEMP_MEM 64, storage bufs,
  …), and `promiseResult`'s register copy silently overwrote interned
  strings like `"job:"` → empty job fields, "bad job state" on-chain,
  invisible in mock. Verified bounds: above near's storage cache
  [131072..136784), below outlayer's heap (HEAP_START 200000).
- `~/bin/compile` must be lisp-rlm's `target/release/compile` (12.4 MB,
  full TS frontend). `emit-wasm` (6.2 MB) has no frontend →
  "undefined variable 'near/predecessor_account_id'"-style scope errors.

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
wasms/v4/             hash-pinned exec wasms (exec-a fetch/402-parse, exec-b broadcast,
                      exec-quote 1Click quote — source: exec-quote.ts alongside)
scripts/
  run_k2v23.sh        v2.3 mock proof: credit → callApi → real 1Click quote →
                      onQuote gates → funding + exec-a legs → withdrawToken
tests/                near-mock scenarios + state-machine matrix
docs/                 design + deploy history
```

## Trust boundaries

- Money moves only through predecessor-gated lanes: `onQuote`/`onResult`
  require OutLayer, `onSignDone` requires self.
- The TEE can't steal: it only fetches quotes and sends unsigned messages;
  the funding destination and signature are gated inside the kernel
  (amountIn == budget; payTo pin + budget cap).
- The MPC can't redirect: it signs whatever bytes the kernel sends, and the
  kernel only sends output that passed the gates.
- The relay is a byte pipe: it can drop (job stalls → refund) but can't
  redirect. The 1Click quote is signed by the solvers; a bogus quote fails
  the `amountIn == budget` gate in `onQuote`.
- Funding custody: tokens leave only via `ft_transfer_call` to a gated
  quote's depositAddress with refundTo = the kernel; unsolved quotes refund
  to kernel2's intents balance, never to a third party.
- Signing paths compose from the **job registry** (`owner + "-" + suffix`),
  never from `predecessorAccountId()` — TEE-lane calls arrive with OutLayer
  as predecessor; registry binding pins the path to the payer.
- The x402 challenge fixes the exact amount before any money moves; settle
  math is exact u128.
- Nobody — agent, TEE, or attacker — can sign outside a registered, funded
  job. `insigner`-layer defense in depth: even direct `requestSign` composes
  the path from the caller, so an attacker can only sign under their own
  (empty) derived address.

## Build / test / deploy

```bash
# compile (lisp-rlm TS frontend)
~/bin/compile contracts/kernel2.ts contracts/kernel2.wasm

# deploy (existing funded account; faucet is 429-happy and .sub.name.testnet is
# CreateAccountNotAllowed — self-deploy to gasbench2.testnet works)
near contract deploy gasbench2.testnet use-file contracts/kernel2.wasm \
  without-init-call network-config testnet \
  sign-with-access-key-file ~/.near-credentials/testnet/gasbench2.testnet.json send
```

GitHub raw pins have ~2 min CDN lag: after pushing new exec wasms, wait
before testing on-chain or the kernel hash-mismatches.

## Deploy history (testnet)

- kernel v1 `2U82RwJ…`, deposit `2vLm269q…` (0.1 N), callApi `7bvshNPN…`
  → job `624a028b…` registered, credit 0.08 N (0.02 held) — verified via RPC
- tank v2 `9aSYtEjs…`; fund/withdrawRequest/withdrawSettle smoke all green
- insigner: deploy `41yWMX7f…`, memo E2E `9JxUk9t6…`, Solana `Gc53b2bSVJx…` slot 510692866
- exec-a via fetch-relay on-chain: tx `9DQCDSbx…` (output 723 bytes, cost 0.0010734 N)
- kernel2 v2.1 first full loop: tx `HaPNhkoG…` — one call → real TEE exec-a →
  gates → real MPC sign_done → job exec_b (relay sigUpload still used)
- kernel2 **v2.2** (`6fd00ae`): relay watcher + sigUpload deleted;
  onSignDone self-resumes. Full chain tx `FdARXQRb…`: sign_requested →
  sign_done (sig decoded in-contract) → broadcast_requested, exec-b executed;
  broadcast itself awaits a funded devnet payer
- kernel2 **v2.3** (current, `966a1f2`): intents-funded jobs — token credit
  via ft_on_transfer, callApi debits credit → quote_phase, TEE exec-quote
  fetches a REAL 1Click quote, onQuote gates amountIn==budget → funding:
  one ft_transfer_call to the live depositAddress + exec-a concurrently.
  Mock-proven end-to-end (`scripts/run_k2v23.sh`); testnet deploy pending

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
