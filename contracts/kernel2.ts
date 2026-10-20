/// <reference path="./types/lisp-rlm.d.ts" />
// kernel2.ts — zero-infra x402 kernel, v2.3.1: ONE user call, promise chain all the way down.
//
//   pinPayTo(suffix, payTo58)        — SELF-only merchant registry (Solana destination per suffix)
//   deposit() / withdrawCredit(a)    — NEAR escrow ledger ("credit:")
//   ft_on_transfer                   — token escrow ledger ("credittok:"), predecessor = token contract
//   callApi(url, suffix, budget, payer58)
//       debit budget → job record → exec-quote (TEE 1Click quote)
//       → promiseThen(onQuote)
//   onQuote                          — validate quote, fire BOTH legs:
//         leg 1  ft_transfer_call → 1Click depositAddress (solvers deliver to payer)
//         leg 2  exec-a (merchant fetch) → promiseThen(onResult)
//   onResult                         — payTo-pin + budget gates on msgHex → MPC sign
//         → promiseThen(onSignDone)
//   onSignDone                       — decode sig, b58, fire exec-b (broadcast)
//   settle(jobId, ok)                — OWNER-only: debit jobamt, refund budget − amount
//
// Trust model: the TEE workers supply attested exec output; the kernel gates every hop
// (job state machine, payTo pin from THIS contract's registry, amount ≤ budget, quote
// amountIn === budget). The signature rides the kernel's own promise chain from
// v1.signer-prod — no off-chain fetcher ever sees it before broadcast. settle is
// owner-only and the Solana sig is independently verifiable.
//
// Job state machine:
//   quote_phase → funding → exec_a → sign_requested → broadcasting → settle() → done|failed
// (settle accepts from any pre-settle state; fail path refunds the full budget.)

// ── wire constants ─────────────────────────────────────────────────────────────
// Gas budget per hop must fit nearcore's 300 Tgas per-receipt static cap. The callback
// receipt carries its own work PLUS the forwarded call gas, so CB_GAS_* = work + forward:
//   callApi     60 + 230 = 290 ✓        onQuote   10 + 60 + 145 = 215 ≤ 230 ✓
//   onResult    40 + 100 = 140 ≤ 145 ✓   onSignDone 25 + 60 = 85 ≤ 100 ✓
const B58: string = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const OUTLAYER_CONTRACT: string = "outlayer.testnet";
const MPC_CONTRACT: string = "v1.signer-prod.testnet";
// per-caller MPC pubkey cache ("pub:<caller>" = derived ed25519 pubkey hex).
// Filled by onKeyDerived via MPC.derived_public_key (cross-contract view —
// direct view from RPC fails: the method reads predecessor_account_id).
// Path = caller-suffix; caller = k2 at sign time, so the path IS the namespace.
// MPC-derived ed25519 pubkey (hex, 64 chars). Pinned to the honest-signer test
// key for the devnet lane; the real MPC derive replaces this (same slot, key
// derived from MPL path "kernel-<jobId>"). Address on Solana:
// 7A8K8xWVejU68WQojRAkmabz5x3X5SdKMo237vAvAW9U
const MPC_PUBKEY_HEX: string = "170e64182ddff3e723a0c492a0e4e6056337b379e23dc7634c066fcc9a187acf";  // derive(v1.signer-prod, predecessor=k2, path owner-suffix) = caller-stable; addr 2Z174bRdxeQWow5bamH9UE8kdsmC4cbEwUYVVufq36ES
// SPL Token / Memo / ComputeBudget program ids (hex). Chain-verified from a landed
// devnet TransferChecked settlement (x402 lane, 2026-10); library-cross-checked.
const TOKEN_PROG_HEX: string = "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9";
const MEMO_PROG_HEX: string = "054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d";
const CU_PROG_HEX: string = "0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000";
const TOKEN_CONTRACT: string = "usdc.kampy.testnet"; // our fundable testnet FT (real NEP-141). 1Click is MAINNET-ONLY (no testnet
// assets/solvers): the funding rail is only provable on mainnet. Mainnet token:
// bridged USDC nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1

const SIGN_GAS: number = 40000000000000;
// v2.5 split-chain gas budget. nearcore caps EVERY receipt at 300 Tgas and
// nested promise gas is DEDUCTED from the parent receipt — so each stage's
// (own work + forwarded gas + attached callbacks) must fit in 300:
//   callApi:    own ~15 + exec 130 + cb_quote 150 = 295
//   start:      own ~15 + ft 10 + exec 130 + cb_result 145 = 300 (tight, proven in v2.2)
//   onResult:   own ~40 + sign 40 + cb_sign 60 = 140 ≤ 145 ✓
//   broadcast:  own ~15 + exec 130 + cb_execb 60 = 205
// The old one-call design needed ~460 across nested receipts → always died
// on-chain at the cap (mock has no cap, so 14/14 mock-green masked it).
const CB_GAS_RESULT: number = 450000000000000; // onResult: own + sign 40 + cb_sign 60
const CB_GAS_EXECB: number = 60000000000000;
const CB_GAS_SIGN: number = 300000000000000;  // sign work only (early exec-b handles settle)
const CB_GAS_QUOTE: number = 720000000000000; // start spawn 680 + own
const EXEC_GAS: number = 185000000000000;
const EXEC_FEE: string = "4000100000000000000000"; // outlayer payment per execution (worker requires 4.0001e21)
const FT_GAS: number = 10000000000000;

// TEE workers: pinned by SHA-256, fetched by outlayer over GitHub raw (CDN lag ~2 min
// after a push — re-hash before re-pinning).
const EXEC_A_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-a.wasm";
const EXEC_A_HASH: string = "9bdab87e04cf47f0b9a32a44189366fa02267c2fe8ce81a078d544116eb6d0b9";
// exec-b: LISP-RLM — v4 source rebuilt with the FIXED compiler (P2
// component: input-host→stdin shims in build_combined_p2_core). On-chain
// AND outlayer legs are now both lisp-rlm. -rs (110ccd71…) kept as
// fallback. v4 settles via relay /x402; merchant URL hardcoded chercher.
const EXEC_B_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-b.wasm";
const EXEC_B_HASH: string = "4eebc0fdf916f9145c71fbb0697e7faa4c535c891cfeb724b57da9605c78b579";
const EXEC_QUOTE_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-quote.wasm";
const EXEC_QUOTE_HASH: string = "70c637480084eb0668b7bb897112f8e74130abef285f6e4eebcffbc194870c5d";

// Storage keys: payto:<suffix>, job:<id> (JSON record), jobquote:<id>, jobmsg:<id>,
// jobamt:<id>, credit:<account> (NEAR), credittok:<account> (FT).

// ── admin: merchant registry ──────────────────────────────────────────────────
export function pinPayTo(suffix: string, payTo58: string, dstAta58: string, mint58: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payTo58) !== 44) { near.panic("bad payTo"); }
  // dest ATA + mint: PDAs can't be derived on-chain (b58 bignum unreliable in the
  // P2 gate) — they're constants of (payTo, mint), pinned by the operator at
  // registry time and verified off-chain before pinning.
  if (strLen(dstAta58) !== 44) { near.panic("bad dstAta"); }
  if (strLen(mint58) !== 44) { near.panic("bad mint"); }
  near.storageSet("payto:" + suffix, payTo58);
  near.storageSet("paytoata:" + suffix, dstAta58);
  near.storageSet("paytomint:" + suffix, mint58);
}
// v6.3: pin the challenge's stable fields (price micro-USDC + facilitator
// feePayer). With these pinned, callApi can build the msg ON-CHAIN at call
// time — no exec-a leg, blockhash comes fresh from the caller.
export function pinChallenge(suffix: string, price: string, feePayer58: string, networkTag: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  if (strLen(feePayer58) !== 44) { near.panic("bad feePayer"); }
  if (networkTag !== "devnet" && networkTag !== "mainnet") { near.panic("bad network"); }
  near.storageSet("paytoprice:" + suffix, price);
  near.storageSet("paytofee:" + suffix, feePayer58);
  near.storageSet("paytonet:" + suffix, networkTag);
}
export function payToOf(suffix: string): string {
  return near.storageGet("payto:" + suffix) ?? "";
}
// Payer-side source ATA: PDA(payer, mint) — can't derive on-chain (b58 bignum),
// pinned per payer by the operator (verified off-chain) before jobs use it.
export function pinSrcAta(payer58: string, srcAta58: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  if ((strLen(payer58) !== 43 && strLen(payer58) !== 44) || strLen(srcAta58) !== 44) { near.panic("bad pin args"); }
  near.storageSet("srcata:" + payer58, srcAta58);
}

// ── NEAR escrow ledger ────────────────────────────────────────────────────────
export function deposit(): string {
  const caller = near.predecessorAccountId();
  const dep = near.attachedDepositU128();
  if (dep === "0" || dep === "") { near.panic("attach NEAR to deposit"); }
  const total = u128Add(ledgerGet("credit:", caller), dep);
  near.storageSet("credit:" + caller, total);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"deposit","data":{"user":"${caller}","amount":"${dep}","total":"${total}"}}`);
  return total;
}

export function withdrawCredit(amount: string): void {
  const caller = near.predecessorAccountId();
  const bal = near.storageGet("credit:" + caller) ?? "0";   // ledger read = checked money
  if (u128Lt(bal, amount)) { near.panic("insufficient credit"); }
  near.storageSet("credit:" + caller, u128Sub(bal, amount));
  near.transferU128(caller, bal);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"credit_withdrawn","data":{"user":"${caller}","amount":"${amount}"}}`);
}

// ── token escrow ledger (NEP-141) ─────────────────────────────────────────────
// NEP-141 receiver: token contract transfers in with msg = credit recipient.
// Token identity = bare predecessor (never trust a nep141: string in msg).
export function ft_on_transfer(sender_id: string, amount: string, msg: string): string {
  if (near.predecessorAccountId() !== TOKEN_CONTRACT) { near.panic("token lane only"); }
  if (amount === "0" || amount === "") { near.panic("zero deposit"); }
  const who = (msg === "") ? sender_id : msg;
  const total = u128Add(ledgerGet("credittok:", who), amount);
  near.storageSet("credittok:" + who, total);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"token_deposit","data":{"user":"${who}","amount":"${amount}","total":"${total}"}}`);
  return "0";
}

export function creditToken(): string {
  return ledgerGet("credittok:", near.predecessorAccountId());
}
export function creditTokenOf(user: string): string {
  return ledgerGet("credittok:", user);
}
// TEST-LANE ONLY: the usdc.kampy mock FT's ledger is corrupted (s:bal rows
// zeroed while the bare pool grew — repeated ERR_BAL runs, 2026-10-18).
// Owner-direct credit to keep the pipeline testable without the FT.
export function ownerMint(amount: string): string {
  const caller = near.predecessorAccountId();
  // only k2's own access key can produce predecessor == currentAccountId
  if (caller !== near.currentAccountId()) { near.panic("self only"); }
  const total = u128Add(ledgerGet("credittok:", caller), amount);
  near.storageSet("credittok:" + caller, total);
  return total;
}

export function withdrawToken(amount: string): void {
  const caller = near.predecessorAccountId();
  const bal = ledgerGet("credittok:", caller);
  if (u128Lt(bal, amount)) { near.panic("insufficient token credit"); }
  near.storageSet("credittok:" + caller, u128Sub(bal, amount));
  const p = near.promiseBatchCreate(TOKEN_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "ft_transfer", `{"receiver_id":"${caller}","amount":"${amount}"}`, "1", FT_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"token_withdrawn","data":{"user":"${caller}","amount":"${amount}"}}`);
}

// ── EMIT: the only entry an agent needs ───────────────────────────────────────
// v6.3: ONE exec leg. The caller passes a FRESH blockhash (fetched off-chain
// seconds before this tx) — the msg is built ON-CHAIN right here from the
// merchant pins, the MPC sign fires immediately, and onSignDone runs the
// single settle-only exec. No quote leg, no exec-a leg, no blockhash race:
// age at settle = sign latency + daemon pickup (~20-60s) < devnet window.
export function callApi(url: string, suffix: string, budget: string, payer58: string, blockhash58: string): string {
  const caller = near.predecessorAccountId();
  if (url === "" || strLen(url) > 256) { near.panic("bad url"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payer58) !== 43 && strLen(payer58) !== 44) { near.panic("bad payer"); }
  // base58 drops leading zero bytes → ~1/256 blockhashes serialize to 43
  // chars (observed live: KbHRZBfNqLxWZ8xNZzSfhp6qdH6dCJ8KMgmwbUUMCiV).
  // Pad with a leading '1' (zero byte in b58) so decode is always 32B.
  if (strLen(blockhash58) === 43) { blockhash58 = "1" + blockhash58; }
  if (strLen(blockhash58) !== 44) { near.panic("bad blockhash"); }
  const payTo = near.storageGet("payto:" + suffix) ?? "";
  if (payTo === "") { near.panic("unpinned suffix"); }
  // challenge pins (v6.3): price + feePayer + network must be pinned
  const price = near.storageGet("paytoprice:" + suffix) ?? "";
  const feePayer = near.storageGet("paytofee:" + suffix) ?? "";
  const network = near.storageGet("paytonet:" + suffix) ?? "";
  if (price === "" || feePayer === "" || network === "") { near.panic("unpinned challenge"); }
  // src ATA pin for this payer
  const srcAta = near.storageGet("srcata:" + payer58) ?? "";
  if (srcAta === "") { near.panic("unpinned srcAta"); }
  const dstAta = near.storageGet("paytoata:" + suffix) ?? "";
  const mint = near.storageGet("paytomint:" + suffix) ?? "";
  // payer MUST be the caller's MPC-derived key (per-wallet-per-call)
  let pubHex = near.storageGet("pub:" + caller) ?? "";
  if (pubHex === "" && caller === near.currentAccountId()) { pubHex = MPC_PUBKEY_HEX; }
  if (pubHex === "") {
    // first call from this caller: derive key async, caller retries after
    const path = caller + "-" + suffix;
    near.callAwait(MPC_CONTRACT, "derived_public_key",
      `{"path":"${path}","domain_id":1}`, 30000000000000,
      "onKeyDerived", 10000000000000, `{"caller":"${caller}"}`);
    near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"key_deriving","data":{"caller":"${caller}"}}`);
    return "deriving:" + caller;
  }
  if (b58ToHex(payer58) !== pubHex) { near.panic("payer != caller derived key"); }
  // escrow
  const credit = ledgerGet("credittok:", caller);
  if (u128Lt(budget, "1")) { near.panic("bad budget"); }
  if (u128Gt(budget, credit)) { near.panic("insufficient token credit for budget"); }
  if (u128Gt(price, budget)) { near.panic("price exceeds budget"); }
  setLedger("credittok:", caller, u128Sub(credit, budget));
  const jobId = sha256Hash(caller + ":" + url + ":" + toStr(near.blockHeight()) + ":" + near.randomSeed());
  setJobFields(jobId, "sign_requested", jobJson(caller, url, suffix, budget, payer58));
  near.storageSet("jobnet:" + jobId, network);
  near.storageSet("jobamt:" + jobId, price);
  near.storageSet("jobchal:" + jobId, ""); // settle-only exec refetches the challenge itself
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"job_started","data":{"jobId":"${jobId}","owner":"${caller}","url":"${url}","budget":"${budget}"}}`);
  // v0 msg — built HERE, byte layout identical to the old onResult path
  // (verified vs solders + landed settlements): hdr + 8 keys + blockhash +
  // CUlimit | CUprice | TransferChecked(price) | Memo(nonce(jobId)).
  const amtHex = decToLeHexU64(price);
  // INCREMENTAL accumulation — a single 13+-segment strCat call silently
  // DROPS segments in this gate (observed: the CUlimit ix progIdx byte
  // vanished → svalin sim_failed; job f380aec0). Loop-append is the
  // codebase's proven pattern (exec-a b64decode, msgBin in onResult v1).
  let msgBin: string = "020104" + "08";
  msgBin = strCat(msgBin, b58ToHex(feePayer), pubHex);
  msgBin = strCat(msgBin, b58ToHex(dstAta), b58ToHex(srcAta));
  msgBin = strCat(msgBin, CU_PROG_HEX, MEMO_PROG_HEX, TOKEN_PROG_HEX);
  msgBin = strCat(msgBin, b58ToHex(mint), b58ToHex(blockhash58));
  msgBin = strCat(msgBin, "04");
  msgBin = strCat(msgBin, "04", "00", "05", "0260ea0000");
  msgBin = strCat(msgBin, "04", "00", "09", "03e803000000000000");
  msgBin = strCat(msgBin, "06", "04", "03", "07", "02", "01", "0a", "0c", amtHex, "06");
  msgBin = strCat(msgBin, "05", "00", "20", nonceOf(jobId), "00");
  near.storageSet("jobmsg:" + jobId, msgBin);
  // MPC sign fires IMMEDIATELY — blockhash clock starts now, ~15-30s
  const path = caller + "-" + suffix;
  const args = `{"request":{"payload_v2":{"Eddsa":"80${msgBin}"},"path":"${path}","domain_id":1}}`;
  const p1 = near.promiseBatchCreate(MPC_CONTRACT);
  near.promiseBatchActionFunctionCall(p1, "sign", args, "1", SIGN_GAS);
  near.promiseThen(p1, near.currentAccountId(), "onSignDone", `{"jobId":"${jobId}"}`, "0", CB_GAS_SIGN);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_requested","data":{"jobId":"${jobId}","path":"${path}","amount":"${price}"}}`);
  return jobId;
}

// ── quote gate + the two funding legs ─────────────────────────────────────────
// promiseResult(0) = exec-quote's output as JSON-escaped text; jsonGetStrEsc
// unescapes then scans at any object depth (nested JSON-in-JSON included).
// ── agent surface (self-describing onboarding + one-shot paid call) ─────────
// agent(caller?) — one view an AI agent calls FIRST: returns its derived
// payer, srcAta, credit, funding intent JSON, and full usage instructions.
// The contract teaches the protocol; the agent just follows it.
export function agent(caller: string): string {
  const me = (caller === "") ? near.predecessorAccountId() : caller;
  const pubHex = near.storageGet("pub:" + me) ?? "";
  let payer58 = "";
  if (pubHex !== "") { payer58 = hexToB58(pubHex); }
  const srcAta = (payer58 === "") ? "" : (near.storageGet("srcata:" + payer58) ?? "");
  const first = (payer58 === "")
    ? `{"step":1,"action":"call callApi once (any args) to trigger derive, retry in ~2s","derivePath":"${me}-<suffix>"}`
    : `{"step":"ready","payer":"${payer58}","srcAta":"${srcAta}"}`;
  const omft = near.storageGet("fundomft:") ?? "sol-epjfwdd5aufqssqep2q2nhhy3ryuvbzeacsp7ttg6lhcy.omft.near";
  return `{"caller":"${me}",` +
    `"payer":"${payer58}",` +
    `"srcAta":"${srcAta}",` +
    `"creditTok":"${ledgerGet("credittok:", me)}",` +
    `"keyState":${first},` +
    `"fundIntent":${"{"} "intent":"ft_withdraw","token":"${omft}","receiver_id":"${omft}","memo":"WITHDRAW_TO:${payer58}","signer_id":"${me}" ${"}"},` +
    `"call":"callApi(url, suffix, budget, payer58, blockhash58) -> jobId | 'deriving:<you>'",` +
    `"suffixes":["chercher"],` +
    `"poll":"job(jobId).status -> done|failed; resultOf(jobId) -> paid response",` +
    `"note":"payer58 MUST be your derived payer; blockhash: POST getLatestBlockhash to https://api.devnet.solana.com"}`;
}

// fundDomft pin (admin): which OMFT token id the fundIntent advertises
export function pinFundOmft(omft: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  if (strLen(omft) < 5 || strLen(omft) > 100) { near.panic("bad omft"); }
  near.storageSet("fundomft:", omft);
}

// ── per-caller MPC key derivation (per-wallet-per-call) ────────────────────
// callback of callAwait(MPC.derived_public_key). Result = quoted hex pubkey
// (64 chars) for path caller-suffix. Store under "pub:<caller>"; the caller
// then re-fires callApi with payer58 = b58(pubHex).
export function onKeyDerived(caller: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  const raw = near.promiseResult(0);
  if (raw === "" || strLen(raw) < 16) {
    near.log("DBG derived=[" + raw + "]");
    near.panic("derive failed");
  }
  // strip quotes if the result is a JSON string literal
  let b58 = raw;
  if (strSlice(b58, 0, 1) == "\"") { b58 = strSlice(b58, 1, strLen(b58) - 1); }
  // result is "ed25519:<b58 key>" — strip the prefix
  const p = strIndexOf(b58, "ed25519:");
  if (p >= 0) { b58 = strSlice(b58, p + 8, strLen(b58)); }
  const hex = b58ToHex(b58);
  if (strLen(hex) !== 64) { near.panic("bad derived pubkey len " + toStr(strLen(hex))); }
  near.storageSet("pub:" + caller, hex);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"key_derived","data":{"caller":"${caller}"}}`);
}

export function pubKeyOf(caller: string): string {
  return near.storageGet("pub:" + caller) ?? "";
}

export function onQuote(jobId: string): void {
  requireOutlayer();
  requireJob(jobId, "quote_phase");
  const raw = near.storageGet("job:" + jobId) ?? "";
  const respJson = near.promiseResult(0);
  const addr = jsonGetStrEsc("depositAddress", respJson) ?? "";
  const memo = jsonGetStrEsc("depositMemo", respJson) ?? "";
  const amountIn = jsonGetStrEsc("amountIn", respJson) ?? "";
  if (strLen(addr) < 20) { near.panic("no deposit address in quote"); }
  if (strLen(amountIn) === 0) { near.panic("no amountIn in quote"); }
  // stash the memo for start()'s funding leg (onQuote no longer funds inline)
  near.storageSet("jobmemo:" + jobId, memo);
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  // gate: the quoted input must be exactly what we escrowed — no over/under-spend
  if (amountIn !== budget) { near.panic("quote amountIn != budget"); }
  near.storageSet("jobquote:" + jobId, addr);
  // v2.5 SPLIT STAGE 1: gas-infeasibility fix. The one-call nested chain
  // (callApi → quote → onQuote funding exec-a → sign → exec-b) needs more
  // than nearcore's 300 Tgas PER-RECEIPT cap for the nested promises; the
  // mock doesn't enforce the cap so it proved green while on-chain every
  // job froze at quote_phase. onQuote now only PARSES + GATES (cheap) and
  // parks the job at quote_ready; a fresh top-level tx (agent's start())
  // carries the funding + exec-a legs with its own 300 Tgas budget.
  setJobStatus(jobId, "quote_ready");
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.5.0","event":"quote_ready","data":{"jobId":"${jobId}","depositAddress":"${addr}","amount":"${budget}"}}`);
  // v2.6 SINGLE-CALL: auto-spawn start() on a fresh self-receipt (needs its
  // own 300 Tgas budget for the exec-a forwarding leg — onQuote's receipt
  // can't fit it). start()'s gate allows self-spawn.
  const pStart = near.promiseBatchCreate(near.currentAccountId());
  near.promiseBatchActionFunctionCall(pStart, "start", `{"jobId":"${jobId}"}`, "0", 680000000000000);
}

// ── SPLIT STAGE 2 (v2.5): fresh 300 Tgas tx — fund + fire exec-a ────────────
// Owner-only (the caller who escrowed the budget drives their own job).
export function start(jobId: string): string {
  const caller = near.predecessorAccountId();
  const raw = near.storageGet("job:" + jobId) ?? "";
  if (raw === "") { near.panic("unknown job"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  if (caller !== owner && caller !== near.currentAccountId()) { near.panic("owner only"); }
  requireJob(jobId, "quote_ready");
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  const addr = near.storageGet("jobquote:" + jobId) ?? "";
  if (addr === "") { near.panic("no quote"); }
  // v2.5: funding moved to fund() (its own tx) — the 300 Tgas receipt cap
  // cannot fit ft(10) + exec fwd(185) + cb(100) in one receipt.
  // exec-a re-checks the payer balance before paying, so funding only needs
  // to land before exec-b's settle, not before exec-a runs.
  setJobStatus(jobId, "exec_a");
  const path = owner + "-" + suffix;
  const srcAta = near.storageGet("srcata:" + payer) ?? "";
  if (srcAta === "") { near.panic("payer srcAta unpinned"); }
  requestWasmExecution(EXEC_A_WASM, EXEC_A_HASH, `${jobId}|${near.jsonGetStr("url", raw) ?? ""}|${path}|${payer}|${srcAta}`, "onResult", jobId, CB_GAS_RESULT);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.5.0","event":"funding_started","data":{"jobId":"${jobId}","depositAddress":"${addr}","amount":"${budget}"}}`);
  return "started";
}

// ── SPLIT STAGE 2b (v2.5): funding tx — USDC → 1Click escrow ────────────────
// Own receipt, zero forwarding: trivially fits the cap. Idempotent-ish:
// requires status exec_a (start already ran); re-funding would double-pay,
// so gate on jobfund absent.
export function fund(jobId: string): string {
  const caller = near.predecessorAccountId();
  const raw = near.storageGet("job:" + jobId) ?? "";
  if (raw === "") { near.panic("unknown job"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  if (caller !== owner) { near.panic("owner only"); }
  const st = near.jsonGetStr("status", raw) ?? "";
  if (st !== "exec_a" && st !== "sign_requested" && st !== "sig_done" && st !== "broadcasting") {
    near.panic("bad job state for funding");
  }
  if (near.storageGet("jobfund:" + jobId) !== null) { near.panic("already funded"); }
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const addr = near.storageGet("jobquote:" + jobId) ?? "";
  if (addr === "") { near.panic("no quote"); }
  const memo = near.storageGet("jobmemo:" + jobId) ?? "";
  near.storageSet("jobfund:" + jobId, budget);
  const pf = near.promiseBatchCreate(TOKEN_CONTRACT);
  near.promiseBatchActionFunctionCall(pf, "ft_transfer_call", `{"receiver_id":"${addr}","amount":"${budget}","msg":"${memo}"}`, "1", FT_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.5.0","event":"funded","data":{"jobId":"${jobId}","amount":"${budget}"}}`);
  return "funded";
}

// ── large-output refetch: output stored by input hash on outlayer ────────────
// The daemon ships outputs >800B via submit_execution_output_and_resolve;
// the yield-resumed callback then sees output:None. The output lives in
// outlayer storage under sha256(input_data) — fetch with a cheap view call
// and re-enter the parse from a fresh callback receipt.
function refetchExecOutput(jobId: string): void {
  const raw = near.storageGet("job:" + jobId) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  const url = near.jsonGetStr("url", raw) ?? "";
  const path = owner + "-" + suffix;
  const srcAta = near.storageGet("srcata:" + payer) ?? "";
  const input = `${jobId}|${url}|${path}|${payer}|${srcAta}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "get_output_by_input_hash", `{"input_hash_hex":"${sha256Hash(input)}"}`, "0", 100000000000000);
  near.promiseThen(p, near.currentAccountId(), "onOutputRefetch", `{"jobId":"${jobId}"}`, "0", 250000000000000);
  near.log("DBG refetching exec output by input hash");
  near.storageSet("jobdbg:" + jobId, "refetch-fired");
}

export function onOutputRefetch(jobId: string): void {
  // predecessor = self (scheduler of the view promise)
  near.storageSet("jobdbg:" + jobId, "onOutputRefetch-entered");
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("kernel lane only"); }
  requireJob(jobId, "exec_a");
  const raw = near.storageGet("job:" + jobId) ?? "";
  // promiseResult(0) = the raw output text (same shape as the inline flow)
  parseExecAResult(jobId, raw, respText());
}

// ── REJECT: gate failure → close the job, refund the full budget ─────────────
// Panicking here would leave the budget escrowed forever (the credittok debit
// happened back in callApi — a separate committed tx). Reject closes the loop:
// mark failed, refund, emit job_done. The caller RETURNS after calling this.
function rejectJob(jobId: string, owner: string, budget: string, reason: string): void {
  setJobStatus(jobId, "failed");
  // persist the reason — events on deep callback receipts are hard to find
  // after the fact; this key is queryable via view_state
  near.storageSet("jobfail:" + jobId, reason);
  if (budget !== "0" && budget !== "") {
    near.storageSet("credittok:" + owner, u128Add(ledgerGet("credittok:", owner), budget));
  }
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"job_rejected","data":{"jobId":"${jobId}","reason":"${reason}"}}`);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"job_done","data":{"jobId":"${jobId}","ok":"0","refunded":"${budget}","auto":"1"}}`);
}

// ── merchant fetch result → MPC sign ──────────────────────────────────────────
// promiseResult(0) = exec-a's output, JSON-escaped. msgHex = the Solana transfer
// instruction the TEE built: byte 0 = instruction tag, 1..33 = payTo, 65..73 = LE u64 amount.
export function onResult(jobId: string): void {
  near.storageSet("jobdbg:" + jobId, "entered|pred=" + near.predecessorAccountId());
  // Yield-resume path: the resumed request_execution promise continues on THIS
  // contract, so predecessor = self (k2). Inline-resolve path: predecessor =
  // outlayer. Accept both; anything else is foreign.
  const pred = near.predecessorAccountId();
  if (pred !== OUTLAYER_CONTRACT && pred !== near.currentAccountId()) {
    near.storageSet("jobdbg:" + jobId, "BAD_PRED=" + pred);
    return;
  }
  const rawJob = near.storageGet("job:" + jobId) ?? "";
  if (rawJob === "") {
    near.storageSet("jobdbg:" + jobId, "NO_JOB_RECORD");
    return;
  }
  const st = near.jsonGetStr("status", rawJob) ?? "";
  if (st !== "exec_a") {
    near.storageSet("jobdbg:" + jobId, "BAD_STATE=" + st);
    return;
  }
  // read the job record BEFORE promiseResult: the 292-byte msgHex copy into guest
  // heap can clobber the "job:"+jobId string still referenced below (observed in
  // near-mock: prefix bytes replaced by heap garbage mid-concat).
  parseExecAResult(jobId, rawJob, respText());
}

// full exec-a output parse + gates + MPC sign dispatch. `resp` = the raw
// output text (inline flow) or the refetched stored output (large-output lane).
function parseExecAResult(jobId: string, raw: string, resp: string): void {
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  // payload is JSON-escaped JSON-in-JSON; jsonGetStrEsc unescapes then scans at any
  // depth (plain-field scans miss the escaped key form — observed in near-mock 2026-10).
  // exec-a hands over RAW payTo/amount/blockhash (b58→bignum is unreliable in the P2
  // gate — probes 2026-10-15) as hexEncode("0|payTo|amount|blockhash|payer"); this
  // contract decodes and re-validates everything itself.
  // escapedField: bounded index scan — jsonGetStrEsc re-unescapes the WHOLE
  // 7933-byte buffer and burned >300 Tgas (per-receipt cap) → "Exceeded the
  // account balance" on the callback receipt (2026-10-18 forensics).
  const msgHex = escapedField(resp, "msgHex", 1200) ?? "";
  if (strLen(msgHex) < 20) {
    // DIAGNOSTIC: record what we actually got, then refetch
    near.storageSet("jobdbg:" + jobId, "respLen=" + strLen(resp) + "|msgHexLen=" + strLen(msgHex) + "|head=" + strSlice(resp, 0, 60));
    refetchExecOutput(jobId);
    return;
  }
  const path = owner + "-" + suffix;   // BINDING: from registry, never from predecessor
  // unhex → "0|payTo|amount|blockhash|payer58"
  const payload = hexDecode(msgHex);
  // gate 0: shape — must start "0|" and carry 5 fields
  if (strSlice(payload, 0, 2) !== "0|") { rejectJob(jobId, owner, budget, "bad payload version"); return; }
  // gate 1: merchant pin — kernel decodes BOTH sides with its own b58ToHex
  const pin58 = near.storageGet("payto:" + suffix) ?? "";
  if (pin58 === "") { rejectJob(jobId, owner, budget, "unpinned suffix"); return; }
  const f1 = strIndexOf(payload, "|");
  const f2 = strIndexOf(strSlice(payload, f1 + 1, strLen(payload)), "|") + f1 + 1;
  const f3 = strIndexOf(strSlice(payload, f2 + 1, strLen(payload)), "|") + f2 + 1;
  const f4 = strIndexOf(strSlice(payload, f3 + 1, strLen(payload)), "|") + f3 + 1;
  const f5 = strIndexOf(strSlice(payload, f4 + 1, strLen(payload)), "|") + f4 + 1;
  const f6 = strIndexOf(strSlice(payload, f5 + 1, strLen(payload)), "|") + f5 + 1;
  const f7 = strIndexOf(strSlice(payload, f6 + 1, strLen(payload)), "|") + f6 + 1;
  const payTo = strSlice(payload, f1 + 1, f2);
  const amount = strSlice(payload, f2 + 1, f3);
  const blockhash = strSlice(payload, f3 + 1, f4);
  const payer58 = strSlice(payload, f4 + 1, f5);
  const feePayer = strSlice(payload, f5 + 1, f6);
  const mint = strSlice(payload, f6 + 1, f7);
  const srcAta = strSlice(payload, f7 + 1, strLen(payload));
  if (strLen(feePayer) !== 44 || strLen(mint) !== 44 || strLen(srcAta) !== 44) {
    rejectJob(jobId, owner, budget, "bad challenge fields"); return;
  }
  const payerHex = near.storageGet("pub:" + owner)
    ?? (owner === near.currentAccountId() ? MPC_PUBKEY_HEX : "");
  if (payerHex === "" || b58ToHex(payer58) !== payerHex) { rejectJob(jobId, owner, budget, "payer not MPC key"); return; }
  const dstAta = near.storageGet("paytoata:" + suffix) ?? "";
  const pinMint = near.storageGet("paytomint:" + suffix) ?? "";
  if (dstAta === "" || pinMint === "") { rejectJob(jobId, owner, budget, "incomplete merchant pin"); return; }
  if (b58ToHex(mint) !== b58ToHex(pinMint)) { rejectJob(jobId, owner, budget, "mint mismatch vs pin"); return; }
  if (strLen(payTo) !== 44 || b58ToHex(payTo) !== b58ToHex(pin58)) { rejectJob(jobId, owner, budget, "payTo mismatch"); return; }
  // gate 2: amount (decimal from the challenge) must be within budget
  if (u128Gt(amount, budget)) { rejectJob(jobId, owner, budget, "amount exceeds budget"); return; }
  // cluster: exec-a echoes the challenge's CAIP-2 network (accepts[0].network)
  // as a short tag. Whitelist — unknown tag → reject: never silently broadcast
  // to a cluster the merchant didn't name (mainnet send on a devnet job = real
  // funds at risk).
  const cluster = escapedField(resp, "network", 12) ?? "";
  near.log("DBG cluster=[" + cluster + "] respTail=[" + strSlice(resp, 180, 260) + "]");
  if (cluster !== "devnet" && cluster !== "mainnet") { rejectJob(jobId, owner, budget, "unknown solana cluster"); return; }
  near.storageSet("jobnet:" + jobId, cluster);
  // REAL x402 exact-SVM v0 tx MESSAGE (what MPC signs; exec-b assembles the
  // partial wire [zeroSig(feePayer) + ourSig] + version byte and POSTS it as
  // PAYMENT-SIGNATURE — the FACILITATOR co-signs as fee payer and settles):
  //   header: numReqSigs=2, roSigned=0, roUnsigned=4
  //   keys 8: feePayer(RW,sig) payer(RO,sig) srcATA(RW) dstATA(RW)
  //           mint(RO) tokenProg(RO) memoProg(RO) cuProg(RO)
  //   ixs:    CUlimit(60000) | CUprice(1000) | TransferChecked(amt,6) | Memo(nonce)
  //   MPC payload = "80" + msgHex (v0 version byte is INSIDE the signed bytes).
  const amtHex = decToLeHexU64(amount);
  // payer key = job owner's DERIVED key (per-wallet-per-call); pin fallback
  // covers the k2-self legacy lane only.
  // Byte-verified against solders MessageV0 ground truth AND the facilitator-
  // accepted landed settlement tx (devnet, 2026-10). Layout:
  //   hdr 02 01 04 || 8 keys: feePayer payer dstATA srcATA cu memo token mint
  //   || blockhash32 || 4 ixs: CUlimit(cu) CUprice(cu) TransferChecked(token)
  //   Memo(memo, 16B zero nonce) || trailing 00 (present in both references).
  // MPC payload = "80" + msgHex — the v0 version byte is INSIDE the signed bytes.
  const msgBin = strCat(
    // v0 layout: header(3B: numSig=2, roSigned=1, roUnsigned=4) + compact-u16
    // key count (08 = 8 static keys) + keys + blockhash + ix count + ixs.
    "020104", "08",
    b58ToHex(feePayer), payerHex,
    b58ToHex(dstAta), b58ToHex(srcAta),
    CU_PROG_HEX, MEMO_PROG_HEX, TOKEN_PROG_HEX, b58ToHex(mint),
    b58ToHex(blockhash),
    "04",
      "04", "00", "05", "0260ea0000",
      "04", "00", "09", "03e803000000000000",
      "06", "04", "03", "07", "02", "01", "0a", "0c", amtHex, "06",
      // memo nonce MUST vary per tx: all-zero memo = identical tx bytes across
      // jobs → the facilitator's replay filter 402s every payment after the
      // first (probed 2026-10-17: pay.py w/ random memo → 200; zero memo → 402).
      // jobId is unique per job — spread its chars across the 16 nonce bytes.
      "05", "00", "10", nonceOf(jobId), "00"
  );
  near.log("DBG msgBinLen=" + toStr(strLen(msgBin)) + " head=[" + strSlice(msgBin, 0, 20) + "] tail=[" + strSlice(msgBin, strLen(msgBin) - 20, strLen(msgBin)) + "]");
  near.storageSet("jobmsg:" + jobId, msgBin);
  // challenge b64 (from exec-a via relay headers) — exec-b reuses it verbatim in
  // PAYMENT-SIGNATURE so the facilitator sees an unmodified resource/accepted pair.
  const chalB64 = escapedField(resp, "chalB64", 400) ?? "";
  near.storageSet("jobchal:" + jobId, chalB64);
  near.storageSet("jobamt:" + jobId, amount);
  setJobStatus(jobId, "sign_requested");
  // MPC sign via raw promise batch (insigner's proven wire), callback to self
  // MPC signs "80" + msg — the v0 version byte is part of the signed message bytes
  // (proven: facilitator rejects sigs computed without it).
  const args = `{"request":{"payload_v2":{"Eddsa":"80${msgBin}"},"path":"${path}","domain_id":1}}`;
  const p1 = near.promiseBatchCreate(MPC_CONTRACT);
  near.promiseBatchActionFunctionCall(p1, "sign", args, "1", SIGN_GAS);
  near.promiseThen(p1, near.currentAccountId(), "onSignDone", `{"jobId":"${jobId}"}`, "0", CB_GAS_SIGN);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_requested","data":{"jobId":"${jobId}","path":"${path}","amount":"${amount}"}}`);
}

// ── MPC result → exec-b broadcast ─────────────────────────────────────────────
// Result-blind on WHERE the sig goes (it's already committed in msgHex); the sig
// itself rides this promise chain — no relay, no indexer.
export function onSignDone(jobId: string): string {
  // nearcore .then semantics: the callback receipt's predecessor = the promise chain's
  // SCHEDULER (this contract), not the dep promise's target — mainnet verified.
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("mpc lane only"); }
  requireJob(jobId, "sign_requested");
  const sig58 = b58EncodeBytes(parseSigBytes(respText()));
  if (sig58 === "") { near.panic("sig encode failed"); }
  near.storageSet("jobsig:" + jobId, sig58);
  setJobStatus(jobId, "broadcasting");
  // v6.3: THE one exec leg — settle-only, spawned INLINE here with the sig
  // in the input (30s window, cheap 4.0001e21 fee, no polling mode). The
  // sig→settle gap = daemon pickup only (~≤60s); blockhash age at settle
  // = sign latency + pickup ≈ 20-60s — inside the devnet window.
  const raw2 = near.storageGet("job:" + jobId) ?? "";
  const jobUrl = near.jsonGetStr("url", raw2) ?? "";
  const input = `${jobId}|${sig58}|${near.storageGet("jobmsg:" + jobId) ?? ""}|${near.storageGet("jobnet:" + jobId) ?? ""}|${jobUrl}|`;
  requestWasmExecutionEx(EXEC_B_WASM, EXEC_B_HASH, input, "onExecBDone", jobId, CB_GAS_EXECB, 30);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.5.1","event":"sign_done","data":{"jobId":"${jobId}"}}`);
  return "sig_done";
}

// ── EARLY exec-b: spawn the settle wasm while MPC sign is in flight ─────────
// exec-b v5.5 polls jobsig:<jobId> over RPC and settles within seconds of
// the signature landing (the daemon's ~60s poll made post-sign spawn miss
// the blockhash window).
export function execBEarly(jobId: string): string {
  const caller = near.predecessorAccountId();
  const raw = near.storageGet("job:" + jobId) ?? "";
  if (raw === "") { near.panic("unknown job"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  if (caller !== owner && caller !== near.currentAccountId()) { near.panic("owner only"); }
  const st = (near.jsonGetStr("status", raw) ?? "");
  if (st !== "sig_done" && st !== "quote_ready" && st !== "sign_requested") { near.panic("bad state " + st); }
  setJobStatus(jobId, "broadcasting");
  const jobUrl = near.jsonGetStr("url", raw) ?? "";
  // empty sig field → exec-b polls jobsig:<jobId> itself
  const input = `${jobId}||${near.storageGet("jobmsg:" + jobId) ?? ""}|${near.storageGet("jobnet:" + jobId) ?? ""}|${jobUrl}|${near.storageGet("jobchal:" + jobId) ?? ""}`;
  requestWasmExecutionEx(EXEC_B_WASM, EXEC_B_HASH, input, "onExecBDone", jobId, CB_GAS_EXECB, 170);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.6.0","event":"broadcast_requested","data":{"jobId":"${jobId}","early":"1"}}`);
  return "broadcasting";
}

// ── SPLIT STAGE 5 (v2.5): fresh 300 Tgas tx — exec-b + auto-settle ──────────
export function broadcast(jobId: string): string {
  const caller = near.predecessorAccountId();
  const raw = near.storageGet("job:" + jobId) ?? "";
  if (raw === "") { near.panic("unknown job"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  // auto-broadcast: self-spawned receipt arrives with predecessor = self
  if (caller !== owner && caller !== near.currentAccountId()) { near.panic("owner only"); }
  requireJob(jobId, "sig_done");
  const sig58 = near.storageGet("jobsig:" + jobId) ?? "";
  if (sig58 === "") { near.panic("no signature"); }
  setJobStatus(jobId, "broadcasting");
  // exec-b input: jobId|sig58|msgHex|cluster|resourceUrl — the x402 lane POSTs the
  // partial tx to the merchant URL (not an RPC broadcast).
  const jobUrl = near.jsonGetStr("url", raw) ?? "";
  const input = `${jobId}|${sig58}|${near.storageGet("jobmsg:" + jobId) ?? ""}|${near.storageGet("jobnet:" + jobId) ?? ""}|${jobUrl}|${near.storageGet("jobchal:" + jobId) ?? ""}`;
  requestWasmExecution(EXEC_B_WASM, EXEC_B_HASH, input, "onExecBDone", jobId, CB_GAS_EXECB);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.5.0","event":"broadcast_requested","data":{"jobId":"${jobId}"}}`);
  return "broadcasting";
}

// ── exec-b result → AUTO-SETTLE ──────────────────────────────────────────────
// Outlayer yield-resume callback: predecessor = this contract (scheduler), same
// semantics as onSignDone. exec-b v5 reports {"ok":true,"sig58":...,"slot":...}
// after CONFIRMING the Solana tx via getSignatureStatuses. Settlement closes the
// loop with no human in the middle; settle() remains as owner-only recovery for
// genuinely stuck jobs (exec-b timeout / TEE unreachable).

// replace every \" with " (single quote-layer unescape, division-free)
function unquoteLayer(s: string): string {
  let o = "";
  let i = 0;
  const n = strLen(s);
  while (i < n) {
    if (i + 1 < n && strSlice(s, i, i + 1) == "\\" && strSlice(s, i + 1, i + 2) == "\"") {
      o = strCat(o, "\"");
      i = i + 2;
    } else {
      o = strCat(o, strSlice(s, i, i + 1));
      i = i + 1;
    }
  }
  return o;
}

export function onExecBDone(jobId: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("outlayer lane only"); }
  const raw = near.storageGet("job:" + jobId);
  if (raw === null) { near.panic("unknown job"); }
  const status = near.jsonGetStr("status", raw) ?? "";
  if (status === "done" || status === "failed") { near.panic("already settled"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const out = respText();
  near.log("DBG execB=[" + out + "]");
  // The promiseResult payload is JSON-ESCAPED (\" ok \": true) — the plain
  // scan missed it and marked a paid job failed (b43c5ed4, 2026-10-19).
  // Accept either form; the merchant body {} still counts when the sig
  // binding holds (the facilitator settled the tx).
  let okAt = strIndexOf(out, "\"ok\":true");
  if (okAt < 0) { okAt = strIndexOf(out, "\\\"ok\\\":true"); }
  let refund = budget;
  if (okAt >= 0) {
    // binding: the sig exec-b confirmed must be the one the MPC gave us
    const confirmedSig = extractJsonStr(out, "sig58");
    const ourSig = near.storageGet("jobsig:" + jobId) ?? "";
    if (confirmedSig !== "" && ourSig !== "" && confirmedSig !== ourSig) {
      near.panic("exec-b sig mismatch");
    }
    const amount = near.storageGet("jobamt:" + jobId) ?? "0";
    if (u128Gt(amount, budget)) { near.panic("cost exceeds held budget"); }
    refund = u128Sub(budget, amount);
    setJobStatus(jobId, "done");
    // persist the API result so contracts/indexers can read it:
    // resultOf(jobId) view, or view_state prefix "jobres:<jobId>".
    // raw store (as received, minus the escape layers from promiseResult)
    let res = out;
    res = unquoteLayer(res);
    near.storageSet("jobres:" + jobId, res);
  } else {
    setJobStatus(jobId, "failed");
  }
  if (refund !== "0") {
    near.storageSet("credittok:" + owner, u128Add(ledgerGet("credittok:", owner), refund));
  }
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"job_done","data":{"jobId":"${jobId}","ok":"${okAt >= 0 ? 1 : 0}","refunded":"${refund}","auto":"1"}}`);
}

// extract "key":"value" from a raw (unescaped) JSON string
function extractJsonStr(j: string, key: string): string {
  const pat = strCat("\"", key, "\":\"");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const vs = at + strLen(pat);
  let p = vs;
  while (p < strLen(j)) {
    if (strSlice(j, p, p + 1) == "\"") { return strSlice(j, vs, p); }
    p = p + 1;
  }
  return "";
}

// ── SETTLE: owner-only, after the Solana tx is observable off-chain ───────────
// Debit = the signed amount (jobamt), refund budget − amount. Fail path refunds all.
export function settle(jobId: string, resultOk: string): void {
  const caller = near.predecessorAccountId();
  const raw = near.storageGet("job:" + jobId);
  if (raw === null) { near.panic("unknown job"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  if (caller !== owner) { near.panic("owner only"); }
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const status = near.jsonGetStr("status", raw) ?? "";
  if (status === "done" || status === "failed") { near.panic("already settled"); }
  let refund = budget;
  if (resultOk === "1") {
    const amount = near.storageGet("jobamt:" + jobId) ?? "0";
    if (u128Gt(amount, budget)) { near.panic("cost exceeds held budget"); }
    refund = u128Sub(budget, amount);
    setJobStatus(jobId, "done");
  } else {
    setJobStatus(jobId, "failed");
  }
  if (refund !== "0") {
    near.storageSet("credittok:" + owner, u128Add(ledgerGet("credittok:", owner), refund));
  }
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"job_done","data":{"jobId":"${jobId}","ok":"${resultOk === "1" ? 1 : 0}","refunded":"${refund}"}}`);
}

// ── views ─────────────────────────────────────────────────────────────────────
export function credit(): string {
  return near.storageGet("credit:" + near.predecessorAccountId()) ?? "0";
}
export function creditOf(user: string): string {
  return near.storageGet("credit:" + user) ?? "0";
}
export function job(jobId: string): string {
  return near.storageGet("job:" + jobId) ?? "";
}

// Paid-API result (risk report etc.), stored by onExecBDone on success.
// Readable by ANYONE: NEAR contract state is public — another contract can
// read it via a cross-contract call to resultOf(), or anyone via view_state
// prefix "jobres:". Do NOT put secrets here.
export function resultOf(jobId: string): string {
  return near.storageGet("jobres:" + jobId) ?? "";
}

// ── promiseThen parity probe (pure self-chain, no outlayer) ───────────────
// testThen() → batch(self, testThenTarget) → .then(testThenCb): if the
// emitter's promise_then registers correctly on nearcore, testThenCb runs
// and writes storage key "thenprobe". Direct call after = the verdict.
export function testThen(): string {
  const p = near.promiseBatchCreate(near.currentAccountId());
  near.promiseBatchActionFunctionCall(p, "testThenTarget", "{}", "0", 30000000000000);
  near.promiseThen(p, near.currentAccountId(), "testThenCb", "{}", "0", 40000000000000);
  return "fired";
}
export function testThenTarget(): string { return "ok"; }
export function testThenCb(): string {
  near.storageSet("thenprobe", "cb-ran");
  return "done";
}


export function testThenOutlayer(): string {
  const args = `{"source":{"WasmUrl":{"url":"https://raw.githubusercontent.com/Kampouse/lisp-rlm/main/examples/btc_avg_json.wasm","hash":"0eeb1b8747d5080e1d69f26603c61576ddb51793323ca8f9b518eb28ebae116d","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":"{}","response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, "10000000000000000000000", 130000000000000);
  near.promiseThen(p, near.currentAccountId(), "testThenCb2", "{}", "0", 40000000000000);
  return "fired-ol";
}
export function testThenCb2(): string {
  near.storageSet("thenprobe2", "cb2-ran");
  return "done2";
}

// ── internals: lanes, job record, outlayer requests ───────────────────────────
function requireOutlayer(): void {
  const p = near.predecessorAccountId();
  if (p !== OUTLAYER_CONTRACT && p !== near.currentAccountId()) { near.panic("outlayer lane only"); }
}
function requireJob(jobId: string, expected: string): void {
  const raw = near.storageGet("job:" + jobId);
  if (raw === null) { near.panic("unknown job"); }
  if ((near.jsonGetStr("status", raw) ?? "") !== expected) { near.panic("bad job state"); }
}

// JSON job record — setJobStatus rewrites the whole record (string concat, no
// jsonSet chain: byte-identical output, measurably cheaper gas).
function jobJson(owner: string, url: string, suffix: string, budget: string, payer: string): string {
  return `{"owner":"${owner}","url":"${url}","suffix":"${suffix}","budget":"${budget}","payer":"${payer}"}`;
}
function setJobFields(jobId: string, status: string, body: string): void {
  near.storageSet("job:" + jobId, body.slice(0, strLen(body) - 1) + `,"status":"${status}"}`);
}
function setJobStatus(jobId: string, status: string): void {
  const raw = near.storageGet("job:" + jobId) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const url = near.jsonGetStr("url", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  setJobFields(jobId, status, jobJson(owner, url, suffix, budget, payer));
}

// One builder for all three outlayer request_execution calls.
// callback/cbGas empty (onSignDone) = fire-and-forget: exec-b's failure surfaces
// as the job stuck in `broadcasting`, recoverable by settle(owner, "0").
function requestWasmExecutionEx(wasmUrl: string, hash: string, input: string, callback: string, jobId: string, cbGas: number, maxSecs: number): void {
  // worker prices compute: 1G instr + 170s window = 18.0001e21 (vs 4.0001e21
  // for 100M/30s). See execution.rs:138 — fee must cover the raised limits.
  const fee = maxSecs > 30 ? "18001000000000000000000" : EXEC_FEE;
  const args = `{"source":{"WasmUrl":{"url":"${wasmUrl}","hash":"${hash}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":1000000000,"max_memory_mb":64,"max_execution_seconds":${maxSecs}},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, fee, EXEC_GAS);
  if (callback !== "") {
    near.promiseThen(p, near.currentAccountId(), callback, `{"jobId":"${jobId}"}`, "0", cbGas);
  }
}

function requestWasmExecution(wasmUrl: string, hash: string, input: string, callback: string, jobId: string, cbGas: number): void {
  requestWasmExecutionEx(wasmUrl, hash, input, callback, jobId, cbGas, 30);
}


// promiseResult(0): outlayer serializes the Text output as a JSON string, so the
// payload arrives ESCAPED (\" → \\\"). Field values this kernel reads are fixed-format
// (hex / decimal), so slice by index: find the key, skip :"\, take until the escaped
// closing quote. (jsonGetStrEsc works too but re-unescapes the whole buffer.)
function escapedField(j: string, key: string, maxLen: number): string {
  const keyPos = strIndexOf(j, key);
  if (keyPos < 0) { return ""; }
  const colon = strIndexOf(strSlice(j, keyPos, keyPos + 24), ":");
  if (colon < 0) { return ""; }
  const valStart = keyPos + colon + 3; // skip :"\ (colon, quote, escape)
  const closeRel = strIndexOf(strSlice(j, valStart, valStart + maxLen), "\\\"");
  if (closeRel < 0) { return ""; }
  return strSlice(j, valStart, valStart + closeRel);
}
function respText(): string {
  return near.promiseResult(0);
}

// ledger helpers: "0" on miss, delete-at-zero keeps storage clean
function ledgerGet(prefix: string, who: string): string {
  return near.storageGet(prefix + who) ?? "0";
}
function setLedger(prefix: string, who: string, v: string): void {
  if (v === "0") { near.storageRemove(prefix + who); } else { near.storageSet(prefix + who, v); }
}

// ── base58 + hex codecs (no builtin b58-encode; these are flat loops) ─────────
const DIGITS: string = "0123456789";
const HEXD: string = "0123456789abcdef";

// 16-byte memo nonce from jobId: byte i = (i*7 + jobIdLen) % 256 — deterministic
// per job, distinct across jobs (jobId length + position mix), no randomness
// needed on-chain. Zero never appears at position 0 (jobIdLen >= 1).
function nonceOf(jobId: string): string {
  // Memo spec (x402 exact-svm §3.1): nonce must be "at least 16 bytes,
  // hex-encoded" = 32+ ASCII chars of hex. First nonceOf emitted 16 chars
  // (the minimum read as raw bytes) — borderline; pay.py and the landed
  // settlements use 32 chars (16 bytes hex-encoded). Extend to 32.
  let out = "";
  let i = 0;
  while (i < 32) {
    const c = strSlice(jobId, i, i + 1);
    if (c === "0") { out = strCat(out, "30"); }
    else if (c === "1") { out = strCat(out, "31"); }
    else if (c === "2") { out = strCat(out, "32"); }
    else if (c === "3") { out = strCat(out, "33"); }
    else if (c === "4") { out = strCat(out, "34"); }
    else if (c === "5") { out = strCat(out, "35"); }
    else if (c === "6") { out = strCat(out, "36"); }
    else if (c === "7") { out = strCat(out, "37"); }
    else if (c === "8") { out = strCat(out, "38"); }
    else if (c === "9") { out = strCat(out, "39"); }
    else if (c === "a") { out = strCat(out, "61"); }
    else if (c === "b") { out = strCat(out, "62"); }
    else if (c === "c") { out = strCat(out, "63"); }
    else if (c === "d") { out = strCat(out, "64"); }
    else if (c === "e") { out = strCat(out, "65"); }
    else if (c === "f") { out = strCat(out, "66"); }
    else { out = strCat(out, "78"); } // 'x' marker for bad char (still ASCII)
    i = i + 1;
  }
  return out;
}
// base58 (32-byte pubkey) → big-endian hex; MSB-first digits array

// hex (64 chars = 32 bytes) -> base58 (ed25519 pubkey address).
// MSB-first bignum: repeated divide-whole-array-by-58, remainders are digits.
function hexToB58(hex: string): string {
  const bytes: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let any = 0;
  for (let i = 0; i < 32; i = i + 1) {
    bytes[i] = hexVal(strSlice(hex, i * 2, i * 2 + 1)) * 16 + hexVal(strSlice(hex, i * 2 + 1, i * 2 + 2));
    if (bytes[i] !== 0) { any = 1; }
  }
  let out = "";
  let dbg = "";
  while (any === 1) {
    let rem = 0;
    any = 0;
    for (let i = 0; i < 32; i = i + 1) {
      const cur = rem * 256 + bytes[i];
      bytes[i] = cur / 58;
      rem = cur % 58;
      if (bytes[i] !== 0) { any = 1; }
    }
    out = B58.charAt(rem) + out;
  }
  return out;
}
function hexVal(c: string): number {
  // gate parseInt returns 0 (NOT NaN) on non-numeric — check letters FIRST
  if (c == "a" || c == "A") { return 10; }
  if (c == "b" || c == "B") { return 11; }
  if (c == "c" || c == "C") { return 12; }
  if (c == "d" || c == "D") { return 13; }
  if (c == "e" || c == "E") { return 14; }
  if (c == "f" || c == "F") { return 15; }
  if (c == "0") { return 0; }
  if (c == "1") { return 1; }
  if (c == "2") { return 2; }
  if (c == "3") { return 3; }
  if (c == "4") { return 4; }
  if (c == "5") { return 5; }
  if (c == "6") { return 6; }
  if (c == "7") { return 7; }
  if (c == "8") { return 8; }
  if (c == "9") { return 9; }
  return 0;
}
function b58ToHex(s: string): string {
  // P2 arrays never grow past their literal length — preallocate 64 cells, track len manually
  const digits: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let dlen = 1;
  for (let i = 0; i < strLen(s); i = i + 1) {
    const v = B58.indexOf(s.charAt(i));
    if (v < 0) { near.panic("bad b58 char"); }
    let carry = v;
    for (let j = 0; j < dlen; j = j + 1) {
      const x = digits[j] * 58 + carry;
      digits[j] = x % 256;
      carry = x / 256;
    }
    while (carry > 0) {
      digits[dlen] = carry % 256;
      dlen = dlen + 1;
      carry = carry / 256;
    }
  }
  let hex = "";
  let i = 32;
  while (i > 0) {
    i = i - 1;
    const b = i < dlen ? digits[i] : 0;
    hex = hex + hexDigit(b / 16) + hexDigit(b % 16);
  }
  return hex;
}

// 64 raw bytes (hex string) → base58; same digit-array scheme, base 58
function b58EncodeBytes(hexSig: string): string {
  // P2 surface arrays never grow past their literal (push past ~64 also
  // unreliable at runtime) — preallocate every cell, track len manually.
  const bytes: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  for (let i = 0; i < 64; i = i + 1) {
    const hi = hexNibble(strSlice(hexSig, i * 2, i * 2 + 1));
    const lo = hexNibble(strSlice(hexSig, i * 2 + 1, i * 2 + 2));
    if (hi < 0 || lo < 0) { return ""; }
    bytes[i] = hi * 16 + lo;
  }
  const digits: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let dlen = 1;
  for (let i = 0; i < 64; i = i + 1) {
    let carry = bytes[i];
    for (let j = 0; j < dlen; j = j + 1) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = (x - digits[j]) / 58;
    }
    while (carry > 0) { digits[dlen] = carry % 58; dlen = dlen + 1; carry = (carry - digits[dlen - 1]) / 58; }
  }
  let out = "";
  for (let i = dlen - 1; i >= 0; i = i - 1) {
    out = out + strSlice(B58, digits[i], digits[i] + 1);
  }
  return out;
}

// extract the 64-decimal-byte array from the MPC sign result (escaped JSON):
// find "signature", then '[', then the digits up to ']'; enforce exactly 64.
function parseSigBytes(j: string): string {
  const keyPos = strIndexOf(j, "signature");
  if (keyPos < 0) { near.panic("no signature in MPC result"); }
  const openPos = strIndexOf(strSlice(j, keyPos, keyPos + 16), "[");
  if (openPos < 0) { near.panic("no signature array"); }
  const valStart = keyPos + openPos + 1;
  const closeRel = strIndexOf(strSlice(j, valStart, valStart + 260), "]");
  if (closeRel < 0) { near.panic("no signature array end"); }
  const nums = strSlice(j, valStart, valStart + closeRel);
  let commas = 0;
  for (let i = 0; i < strLen(nums); i = i + 1) {
    if (strSlice(nums, i, i + 1) === ",") { commas = commas + 1; }
  }
  if (commas !== 63) { near.panic("bad signature length"); }
  let hex = "";
  let pos = 0;
  for (let b = 0; b < 64; b = b + 1) {
    const sep = strIndexOf(strSlice(nums, pos, strLen(nums)), ",");
    const end = (sep < 0) ? strLen(nums) : pos + sep;
    const v = decU32(strSlice(nums, pos, end));
    if (v > 255) { near.panic("bad signature byte"); }
    hex = hex + hexDigit(v / 16) + hexDigit(v % 16);
    pos = end + 1;
  }
  return hex;
}

// little-endian u64 hex → decimal string (amounts ≤ 2^53 — safe with number math)
function leHexToDec(h: string): string {
  let n = 0;
  let shift = 0;
  for (let i = 0; i < strLen(h); i = i + 2) {
    const hi = hexNibble(h.charAt(i));
    const lo = hexNibble(h.charAt(i + 1));
    n = n + (hi * 16 + lo) * pow256(shift);
    shift = shift + 1;
  }
  return toStr(n);
}

// decimal string → 8-byte little-endian hex (kernel-side mirror of the amount field;
// amounts ≤ 2^53 so number math is exact)
function decToLeHexU64(dec: string): string {
  let v = parseInt(dec);
  if (v < 0) { v = 0; }
  let hex = "";
  for (let b = 0; b < 8; b = b + 1) {
    const byte = v % 256;
    v = v / 256;
    hex = hex + hexDigit(byte / 16) + hexDigit(byte % 16);
  }
  return hex;
}
function pow256(k: number): number {
  let r = 1;
  for (let i = 0; i < k; i = i + 1) { r = r * 256; }
  return r;
}

function decU32(s: string): number {
  let v = 0;
  for (let i = 0; i < strLen(s); i = i + 1) {
    const d = DIGITS.indexOf(strSlice(s, i, i + 1));
    if (d < 0) { return 99999; }
    v = v * 10 + d;
  }
  return v;
}
function hexNibble(c: string): number {
  return HEXD.indexOf(c);
}
function hexDigit(v: number): string {
  return HEXD.charAt(v % 16);
}
