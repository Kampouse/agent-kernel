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
const OUTLAYER_CONTRACT: string = "outlayerlocal.testnet";
const MPC_CONTRACT: string = "v1.signer-prod.testnet";
const TOKEN_CONTRACT: string = "usdc.kampy.testnet"; // our fundable testnet FT (real NEP-141). 1Click is MAINNET-ONLY (no testnet
// assets/solvers): the funding rail is only provable on mainnet. Mainnet token:
// bridged USDC nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1

const SIGN_GAS: number = 40000000000000;
const CB_GAS_RESULT: number = 200000000000000;
const CB_GAS_SIGN: number = 150000000000000;
const CB_GAS_EXECB: number = 60000000000000;
const CB_GAS_QUOTE: number = 230000000000000;
const EXEC_GAS: number = 60000000000000;
const EXEC_FEE: string = "4000010000000000000000"; // outlayer payment per execution
const FT_GAS: number = 10000000000000;

// TEE workers: pinned by SHA-256, fetched by outlayer over GitHub raw (CDN lag ~2 min
// after a push — re-hash before re-pinning).
const EXEC_A_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-a.wasm";
const EXEC_A_HASH: string = "8bd9ac9c59a971dcb5642d7addbc188889323b7ae62be9e7e03621e231801c6c";
const EXEC_B_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-b.wasm";
const EXEC_B_HASH: string = "5fefd387e37ad304f4825f5fec2ce9e3f243a362316ee4a228ff8f214da8aeb4";
const EXEC_QUOTE_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-quote.wasm";
const EXEC_QUOTE_HASH: string = "70c637480084eb0668b7bb897112f8e74130abef285f6e4eebcffbc194870c5d";

// Storage keys: payto:<suffix>, job:<id> (JSON record), jobquote:<id>, jobmsg:<id>,
// jobamt:<id>, credit:<account> (NEAR), credittok:<account> (FT).

// ── admin: merchant registry ──────────────────────────────────────────────────
export function pinPayTo(suffix: string, payTo58: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payTo58) !== 44) { near.panic("bad payTo"); }
  near.storageSet("payto:" + suffix, payTo58);
}
export function payToOf(suffix: string): string {
  return near.storageGet("payto:" + suffix) ?? "";
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
export function callApi(url: string, suffix: string, budget: string, payer58: string): string {
  const caller = near.predecessorAccountId();
  if (url === "" || strLen(url) > 256) { near.panic("bad url"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payer58) !== 44) { near.panic("bad payer"); }
  if (near.storageGet("payto:" + suffix) === null) { near.panic("unpinned suffix"); }
  const credit = ledgerGet("credittok:", caller);
  if (u128Lt(budget, "1")) { near.panic("bad budget"); }
  if (u128Gt(budget, credit)) { near.panic("insufficient token credit for budget"); }
  setLedger("credittok:", caller, u128Sub(credit, budget));
  const jobId = sha256Hash(caller + ":" + url + ":" + toStr(near.blockHeight()) + ":" + near.randomSeed());
  setJobFields(jobId, "quote_phase", jobJson(caller, url, suffix, budget, payer58));
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"job_started","data":{"jobId":"${jobId}","owner":"${caller}","url":"${url}","budget":"${budget}"}}`);
  // funding phase: TEE fetches the 1Click quote (USDC.near → USDC@solana,
  // recipient = payer); onQuote gates it and fires ft_transfer_call + exec-a.
  requestWasmExecution(EXEC_QUOTE_WASM, EXEC_QUOTE_HASH, `${jobId}|${payer58}|${budget}`, "onQuote", jobId, CB_GAS_QUOTE);
  return jobId;
}

// ── quote gate + the two funding legs ─────────────────────────────────────────
// promiseResult(0) = exec-quote's output as JSON-escaped text; jsonGetStrEsc
// unescapes then scans at any object depth (nested JSON-in-JSON included).
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
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  // gate: the quoted input must be exactly what we escrowed — no over/under-spend
  if (amountIn !== budget) { near.panic("quote amountIn != budget"); }
  near.storageSet("jobquote:" + jobId, addr);
  setJobStatus(jobId, "funding");
  // leg 1: fund — USDC → 1Click escrow; solvers deliver to the payer (async, refundable)
  const pf = near.promiseBatchCreate(TOKEN_CONTRACT);
  near.promiseBatchActionFunctionCall(pf, "ft_transfer_call", `{"receiver_id":"${addr}","amount":"${budget}","msg":"${memo}"}`, "1", FT_GAS);
  // leg 2: fetch — runs concurrently; exec-a's own payer-balance check gates payment
  const path = owner + "-" + suffix;
  // funding is async + refundable; exec-a re-checks the payer balance before paying,
  // so the state machine proceeds to exec_a immediately (v2.3 gap: nothing ever
  // transitioned funding → exec_a, so onResult could never legally fire).
  setJobStatus(jobId, "exec_a");
  requestWasmExecution(EXEC_A_WASM, EXEC_A_HASH, `${jobId}|${near.jsonGetStr("url", raw) ?? ""}|${path}|${payer}`, "onResult", jobId, CB_GAS_RESULT);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"funding_started","data":{"jobId":"${jobId}","depositAddress":"${addr}","amount":"${budget}"}}`);
}

// ── merchant fetch result → MPC sign ──────────────────────────────────────────
// promiseResult(0) = exec-a's output, JSON-escaped. msgHex = the Solana transfer
// instruction the TEE built: byte 0 = instruction tag, 1..33 = payTo, 65..73 = LE u64 amount.
export function onResult(jobId: string): void {
  // the yield resumer's receipt predecessor = outlayer
  requireOutlayer();
  requireJob(jobId, "exec_a");
  // read the job record BEFORE promiseResult: the 292-byte msgHex copy into guest
  // heap can clobber the "job:"+jobId string still referenced below (observed in
  // near-mock: prefix bytes replaced by heap garbage mid-concat).
  const raw = near.storageGet("job:" + jobId) ?? "";
  const msgHex = escapedField(respText(), "msgHex", 296); // full 210-char hex msg + slack
  if (strLen(msgHex) < 100) { near.panic("bad msgHex in exec output"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const path = owner + "-" + suffix;   // BINDING: from registry, never from predecessor
  // gate 1: merchant pin — payTo bytes (1..33 of msgHex) must match the pinned payTo
  const pin58 = near.storageGet("payto:" + suffix) ?? "";
  if (pin58 === "") { near.panic("unpinned suffix"); }
  if (strSlice(msgHex, 2, 66) !== b58ToHex(pin58)) { near.panic("payTo mismatch"); }
  // gate 2: amount (bytes 65..73, LE u64) must be within budget
  const amount = leHexToDec(strSlice(msgHex, 130, 146));
  if (u128Gt(amount, budget)) { near.panic("amount exceeds budget"); }
  near.storageSet("jobmsg:" + jobId, msgHex);
  near.storageSet("jobamt:" + jobId, amount);
  setJobStatus(jobId, "sign_requested");
  // MPC sign via raw promise batch (insigner's proven wire), callback to self
  const args = `{"request":{"payload_v2":{"Eddsa":"${msgHex}"},"path":"${path}","domain_id":1}}`;
  const p1 = near.promiseBatchCreate(MPC_CONTRACT);
  near.promiseBatchActionFunctionCall(p1, "sign", args, "1", SIGN_GAS);
  near.promiseThen(p1, near.currentAccountId(), "onSignDone", `{"jobId":"${jobId}"}`, "0", CB_GAS_SIGN);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_requested","data":{"jobId":"${jobId}","path":"${path}","amount":"${amount}"}}`);
}

// ── MPC result → exec-b broadcast ─────────────────────────────────────────────
// Result-blind on WHERE the sig goes (it's already committed in msgHex); the sig
// itself rides this promise chain — no relay, no indexer.
export function onSignDone(jobId: string): void {
  // nearcore .then semantics: the callback receipt's predecessor = the promise chain's
  // SCHEDULER (this contract), not the dep promise's target — mainnet verified.
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("mpc lane only"); }
  requireJob(jobId, "sign_requested");
  const sig58 = b58EncodeBytes(parseSigBytes(respText()));
  if (sig58 === "") { near.panic("sig encode failed"); }
  near.storageSet("jobsig:" + jobId, sig58);
  setJobStatus(jobId, "broadcasting");
  const input = `${jobId}|${sig58}|${near.storageGet("jobmsg:" + jobId) ?? ""}`;
  requestWasmExecution(EXEC_B_WASM, EXEC_B_HASH, input, "onExecBDone", jobId, CB_GAS_EXECB);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_done","data":{"jobId":"${jobId}"}}`);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"broadcast_requested","data":{"jobId":"${jobId}"}}`);
}

// ── exec-b result → AUTO-SETTLE ──────────────────────────────────────────────
// Outlayer yield-resume callback: predecessor = this contract (scheduler), same
// semantics as onSignDone. exec-b v5 reports {"ok":true,"sig58":...,"slot":...}
// after CONFIRMING the Solana tx via getSignatureStatuses. Settlement closes the
// loop with no human in the middle; settle() remains as owner-only recovery for
// genuinely stuck jobs (exec-b timeout / TEE unreachable).
export function onExecBDone(jobId: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("outlayer lane only"); }
  const raw = near.storageGet("job:" + jobId);
  if (raw === null) { near.panic("unknown job"); }
  const status = near.jsonGetStr("status", raw) ?? "";
  if (status === "done" || status === "failed") { near.panic("already settled"); }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const out = respText();
  const okAt = strIndexOf(out, "\"ok\":true");
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
function requestWasmExecution(wasmUrl: string, hash: string, input: string, callback: string, jobId: string, cbGas: number): void {
  const args = `{"source":{"WasmUrl":{"url":"${wasmUrl}","hash":"${hash}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  if (callback !== "") {
    near.promiseThen(p, near.currentAccountId(), callback, `{"jobId":"${jobId}"}`, "0", cbGas);
  }
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

// base58 (32-byte pubkey) → big-endian hex; MSB-first digits array
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
  const bytes: number[] = [];
  for (let i = 0; i < 64; i = i + 1) {
    const hi = hexNibble(strSlice(hexSig, i * 2, i * 2 + 1));
    const lo = hexNibble(strSlice(hexSig, i * 2 + 1, i * 2 + 2));
    if (hi < 0 || lo < 0) { return ""; }
    bytes.push(hi * 16 + lo);
  }
  const digits: number[] = [0];
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
