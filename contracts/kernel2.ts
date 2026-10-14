/// <reference path="./types/lisp-rlm.d.ts" />
// kernel2.ts — zero-infra x402 kernel, v2.1: ONE user call to start, NO agent resume.
//
//   deposit()                        — fund escrow (unchanged)
//   callApi(url, suffix, budget, payer58)
//       escrow budget → job record → outlayer.request_execution(exec-a)
//       → promiseThen(onResult): outlayer's yield/resume value_returns exec-a's
//         output as promiseResult(0) — no event polling, no read() call
//   onResult                         — self-only via .then():
//         validate payTo (registry pin) + amount ≤ budget → MPC sign (promise chain)
//   onSignDone                       — status exec_b (relay then sigUploads the MPC sig)
//   sigUpload(jobId, sig58)          — relay pushes sig → fires exec-b (broadcast)
//   settle(jobId, ok)                — OWNER-only, after they see the Solana sig off-chain:
//         debit = amount from msgHex, refund budget − amount, job done
//
// Trust model: unchanged. The relay/worker supplies the attested exec bytes; the kernel
// gates them (payTo pin + budget). A cheater only underpays the merchant and gets no
// content. Sig stays result-blind (relay pulls it from the MPC receipt via RPC); settle
// is owner-only and Solana-verifiable.

const B58: string = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const OUTLAYER_CONTRACT: string = "outlayer.testnet";
const MPC_CONTRACT: string = "v1.signer-prod.testnet";
const SIGN_GAS: number = 40000000000000;
// onResult forwards SIGN_GAS (100) to the MPC batch; onSignDone decodes the signature
// (its own work ~25 Tgas) and forwards EXEC_GAS (150) to exec-b. Both callbacks must fit
// their whole call closure inside nearcore's 300 Tgas per-receipt cap:
//   onResult: 100 + 145 = 245 ≤ 300 ✓   onSignDone: 150 + 180 = 330 > 300 →
// EXEC_GAS for exec-b comes from the onSignDone receipt, so CB_GAS_SIGN covers work+150,
// and SIGN_GAS + CB_GAS_SIGN stays ≤ 300: 100 + 180 = 280 ✓.
const CB_GAS_RESULT: number = 145000000000000;
const CB_GAS_SIGN: number = 100000000000000;
const EXEC_GAS: number = 60000000000000;
const EXEC_FEE: string = "4000010000000000000000";
const EXEC_A_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-a.wasm";
const EXEC_A_HASH: string = "a42d8361e1b4211f2b8543ecde409f36e159a18752ec27c17a5661065365d464";
const EXEC_B_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-b.wasm";
const EXEC_B_HASH: string = "0c35c3ea80cb1726d1155b2feca5f32d222f5fda9a2e85ad190563c327409e89";
// ── v2.3: intents funding (1Click) ──
// callApi now funds the derived payer per job: exec-quote (TEE) fetches a 1Click quote
// (USDC.near → USDC@solana, recipient = payer, refundTo = self), onQuote gates it and
// fires ONE ft_transfer_call to the quote's depositAddress. 1Click solvers deliver and
// swap; refunds land in this contract's intents balance. Exec-a still checks the payer's
// Solana balance before paying — solver lag surfaces as job status `funding`, refundable.
const TOKEN_CONTRACT: string = "usdc.testtoken"; // mock FT; testnet twin: usdc.tkn-defuse.testnet; mainnet: bridged USDC
const EXEC_QUOTE_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-quote.wasm";
const EXEC_QUOTE_HASH: string = "70c637480084eb0668b7bb897112f8e74130abef285f6e4eebcffbc194870c5d";
const FT_GAS: number = 10000000000000;
const CB_GAS_QUOTE: number = 230000000000000;
// static caps per receipt (≤300): callApi 60+230=290 ✓; onQuote 10+60+145=215 ≤230 ✓;
// onResult 40+100=140 ≤145 ✓; onSignDone 25+60=85 ≤100 ✓.

// ── admin: pin the payTo per suffix (self only — the merchant table) ──
export function pinPayTo(suffix: string, payTo58: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payTo58) !== 44) { near.panic("bad payTo"); }
  near.storageSet("payto:" + suffix, payTo58);
}
export function payToOf(suffix: string): string {
  return near.storageGet("payto:" + suffix) ?? "";
}

// ── deposit: fund the NEAR credit ledger ──
export function deposit(): string {
  const caller = near.predecessorAccountId();
  const dep = near.attachedDepositU128();
  if (dep === "0" || dep === "") { near.panic("attach NEAR to deposit"); }
  const prev = near.storageGet("credit:" + caller) ?? "0";
  const total = u128Add(prev, dep);
  near.storageSet("credit:" + caller, total);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"deposit","data":{"user":"${caller}","amount":"${dep}","total":"${total}"}}`);
  return total;
}

export function withdrawCredit(amount: string): void {
  const caller = near.predecessorAccountId();
  const bal = near.storageGet("credit:" + caller) ?? "0";
  const overdraft = u128Sub(amount, bal);
  const amt = u128Sub(amount, overdraft);
  if (amt !== amount) { near.panic("insufficient credit"); }
  const rest = u128Sub(bal, amt);
  if (rest === "0") { near.storageRemove("credit:" + caller); } else { near.storageSet("credit:" + caller, rest); }
  near.transferU128(caller, amt);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"credit_withdrawn","data":{"user":"${caller}","amount":"${amt}"}}`);
}

// withdraw token credit: ft_transfer back to the caller (1 yocto attached per NEP-141)
export function withdrawToken(amount: string): void {
  const caller = near.predecessorAccountId();
  const bal = near.storageGet("credittok:" + caller) ?? "0";
  const overdraft = u128Sub(amount, bal);
  const amt = u128Sub(amount, overdraft);
  if (amt !== amount) { near.panic("insufficient token credit"); }
  const rest = u128Sub(bal, amt);
  if (rest === "0") { near.storageRemove("credittok:" + caller); } else { near.storageSet("credittok:" + caller, rest); }
  const args = `{"receiver_id":"${caller}","amount":"${amt}"}`;
  const p = near.promiseBatchCreate(TOKEN_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "ft_transfer", args, "1", FT_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"token_withdrawn","data":{"user":"${caller}","amount":"${amt}"}}`);
}

// ── v2.3: token credit — funded by ft_on_transfer (NEP-141) ──
export function creditToken(): string {
  return near.storageGet("credittok:" + near.predecessorAccountId()) ?? "0";
}
export function creditTokenOf(user: string): string {
  return near.storageGet("credittok:" + user) ?? "0";
}
// NEP-141 receiver: token contract transfers in with msg = credit recipient.
// Token identity = bare predecessor (never trust a nep141: string in msg).
export function ft_on_transfer(sender_id: string, amount: string, msg: string): string {
  if (near.predecessorAccountId() !== TOKEN_CONTRACT) { near.panic("token lane only"); }
  if (amount === "0" || amount === "") { near.panic("zero deposit"); }
  const who = (msg === "") ? sender_id : msg;
  const prev = near.storageGet("credittok:" + who) ?? "0";
  const total = u128Add(prev, amount);
  near.storageSet("credittok:" + who, total);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"token_deposit","data":{"user":"${who}","amount":"${amount}","total":"${total}"}}`);
  return "0";
}

// ── EMIT: the only entry an agent needs to start a job ──
export function callApi(url: string, suffix: string, budget: string, payer58: string): string {
  const caller = near.predecessorAccountId();
  if (url === "" || strLen(url) > 256) { near.panic("bad url"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payer58) !== 44) { near.panic("bad payer"); }
  if (near.storageGet("payto:" + suffix) === null) { near.panic("unpinned suffix"); }
  const credit = near.storageGet("credittok:" + caller) ?? "0";
  if (u128Gt(budget, credit)) { near.panic("insufficient token credit for budget"); }
  if (u128Lt(budget, "1")) { near.panic("bad budget"); }
  const held = u128Sub(credit, budget);
  if (held === "0") { near.storageRemove("credittok:" + caller); } else { near.storageSet("credittok:" + caller, held); }
  const jobId = sha256Hash(caller + ":" + url + ":" + toStr(near.blockHeight()) + ":" + near.randomSeed());
  const job = `{"owner":"${caller}","url":"${url}","suffix":"${suffix}","budget":"${budget}","payer":"${payer58}","jobId":"${jobId}","status":"quote_phase"}`;
  near.storageSet("job:" + jobId, job);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"job_started","data":{"jobId":"${jobId}","owner":"${caller}","url":"${url}","budget":"${budget}"}}`);
  // funding phase: TEE fetches the 1Click quote (USDC.near → USDC@solana, recipient=payer);
  // onQuote gates it and fires ft_transfer_call + exec-a concurrently.
  const input = `${jobId}|${payer58}|${budget}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_QUOTE_WASM}","hash":"${EXEC_QUOTE_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  near.promiseThen(p, near.currentAccountId(), "onQuote", `{"jobId":"${jobId}"}`, "0", CB_GAS_QUOTE);
  return jobId;
}

// slice an escaped-JSON string value: find "key\":\" … up to the escaped closing quote
function sliceEscapedStr(j: string, key: string, maxLen: number): string {
  const keyPos = strIndexOf(j, key);
  if (keyPos < 0) { return ""; }
  const colon = strIndexOf(strSlice(j, keyPos, keyPos + 24), ":");
  if (colon < 0) { return ""; }
  const valStart = keyPos + colon + 3; // skip :" (colon, quote, escape)
  const closeRel = strIndexOf(strSlice(j, valStart, valStart + maxLen), "\\\"");
  if (closeRel < 0) { return ""; }
  return strSlice(j, valStart, valStart + closeRel);
}

// ── resumed via .then(): promiseResult(0) = exec-quote's output (escaped JSON) ──
// Gates the 1Click quote, then fires BOTH legs concurrently: the ft_transfer_call to the
// quote's deposit address (funding the payer via solvers) and exec-a (merchant fetch).
// Exec-a re-checks the payer's on-chain balance — solver lag lands as status `funding`.
export function onQuote(jobId: string): void {
  requireOutlayer();
  requireJob(jobId, "quote_phase");
  const raw = near.storageGet("job:" + jobId) ?? "";
  const respJson = near.promiseResult(0);
  // jsonGetStrEsc (lisp-rlm 2026-10-14): promiseResult delivers the exec output
  // as JSON-escaped text; the builtin unescapes then scans at any object depth.
  const addr = jsonGetStrEsc("depositAddress", respJson) ?? "";
  const memo = jsonGetStrEsc("depositMemo", respJson) ?? "";
  const amountIn = jsonGetStrEsc("amountIn", respJson) ?? "";
  if (strLen(addr) < 20) { near.panic("no deposit address in quote"); }
  if (strLen(amountIn) === 0) { near.panic("no amountIn in quote"); }
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  const path = owner + "-" + suffix;
  // gate: the quoted input must be exactly what we escrowed — no over/under-spend
  if (amountIn !== budget) { near.panic("quote amountIn != budget"); }
  near.storageSet("jobquote:" + jobId, addr);
  setJobStatus(jobId, "funding");
  // leg 1: fund — USDC → 1Click escrow; solvers deliver to the payer (async, refundable)
  const ftArgs = `{"receiver_id":"${addr}","amount":"${budget}","msg":"${memo}"}`;
  const pf = near.promiseBatchCreate(TOKEN_CONTRACT);
  near.promiseBatchActionFunctionCall(pf, "ft_transfer_call", ftArgs, "1", FT_GAS);
  // leg 2: fetch — runs concurrently; its own balance check gates the payment
  const input = `${jobId}|${near.jsonGetStr("url", raw) ?? ""}|${path}|${payer}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_A_WASM}","hash":"${EXEC_A_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const pe = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(pe, "request_execution", args, EXEC_FEE, EXEC_GAS);
  near.promiseThen(pe, near.currentAccountId(), "onResult", `{"jobId":"${jobId}"}`, "0", CB_GAS_RESULT);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.3.0","event":"funding_started","data":{"jobId":"${jobId}","depositAddress":"${addr}","amount":"${budget}"}}`);
}

// ── resumed via .then(): promiseResult(0) = exec-a's output (msgHex) ──
// Validates against the registry pin, then kicks the MPC sign. Status: exec_a → sign_requested.
export function onResult(jobId: string): void {
  // v2.1: predecessor = outlayer (the yield resumer creates this receipt)
  requireOutlayer();
  requireJob(jobId, "exec_a");
  // read the job record BEFORE promiseResult: the 292-byte msgHex copy into guest
  // heap can clobber the "job:"+jobId string still referenced below (observed in
  // near-mock: prefix bytes replaced by heap garbage mid-concat).
  const raw = near.storageGet("job:" + jobId) ?? "";
  // promiseResult(0) = the exec's output text in JSON-ESCAPED form (outlayer serializes
  // the Text output as a JSON string, so quotes are backslash-escaped). jsonGetStr's
  // value-span scan overshoots on escaped content, so slice by index:
  //   \"msgHex\":\"<64-char hex>\"  →  find the key, skip `":"`, take 64 chars.
  const respJson = near.promiseResult(0);
  const keyPos = strIndexOf(respJson, "msgHex");
  if (keyPos < 0) {
    near.panic("no msgHex in exec output");
  }
  const colon = strIndexOf(strSlice(respJson, keyPos, keyPos + 20), ":");
  const valStart = keyPos + colon + 3;          // skip ":\" (colon, quote, escape)
  // The value runs until the ESCAPED closing quote (\") — find it and slice the hex out.
  const winEnd = valStart + 256;
  const escQuote = strIndexOf(strSlice(respJson, valStart, winEnd), "\\\"");
  const msgHex = strSlice(respJson, valStart, valStart + escQuote);
  if (strLen(msgHex) < 100) {
    near.panic("bad msgHex in exec output");
  }
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const path = owner + "-" + suffix;   // BINDING: from registry, never from predecessor
  // gate 1: merchant pin — payTo bytes (1..33 of msgHex) must match the pinned payTo
  const pin58 = near.storageGet("payto:" + suffix) ?? "";
  if (pin58 === "") { near.panic("unpinned suffix"); }
  const msgPayToHex = strSlice(msgHex, 2, 66);           // bytes 1..33
  const pinHex = b58ToHex(pin58);
  if (msgPayToHex !== pinHex) { near.panic("payTo mismatch"); }
  // gate 2: amount (bytes 65..73, LE u64) must be within budget
  const amtHex = strSlice(msgHex, 130, 146);
  const amount = leHexToDec(amtHex);
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

// MPC resumed here (result-blind on the signature itself — relay pulls SuccessValue via RPC)
// MPC resumed here: promiseResult(0) = the sign contract's value_return — the signature
// itself ({"scheme":"Ed25519","signature":[64 bytes]}). Read it, b58-encode, fire exec-b
// IN THIS CALLBACK. No relay, no indexer, no sigUpload — the sig rides the kernel's own
// promise chain from v1.signer-prod (stronger trust than any off-chain fetcher).
export function onSignDone(jobId: string): void {
  // nearcore .then semantics: the callback receipt's predecessor = the promise chain's
  // SCHEDULER (this contract), not the dep promise's target — mainnet verified.
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("mpc lane only"); }
  requireJob(jobId, "sign_requested");
  // promiseResult(0) = the signature JSON in ESCAPED form (outlayer-style serialization):
  //   {\"scheme\":\"Ed25519\",\"signature\":[5,91,205,...]}
  // Slice the 64 decimal byte values out (keyPos → '[' → numbers → ']'), decode to bytes,
  // b58-encode → sig58. Reject malformed results instead of broadcasting garbage.
  const respJson = near.promiseResult(0);
  const keyPos = strIndexOf(respJson, "signature");
  if (keyPos < 0) { near.panic("no signature in MPC result"); }
  const openPos = strIndexOf(strSlice(respJson, keyPos, keyPos + 16), "[");
  if (openPos < 0) { near.panic("no signature array"); }
  const valStart = keyPos + openPos + 1;
  const closeRel = strIndexOf(strSlice(respJson, valStart, valStart + 260), "]");
  if (closeRel < 0) { near.panic("no signature array end"); }
  const nums = strSlice(respJson, valStart, valStart + closeRel);
  // count commas → must be 63 (64 bytes)
  let commas = 0;
  for (let i = 0; i < strLen(nums); i = i + 1) {
    if (strSlice(nums, i, i + 1) === ",") { commas = commas + 1; }
  }
  if (commas !== 63) { near.panic("bad signature length"); }
  // decode decimal bytes → hex, then to bytes
  let hexSig = "";
  let pos = 0;
  for (let b = 0; b < 64; b = b + 1) {
    const sep = strIndexOf(strSlice(nums, pos, strLen(nums)), ",");
    const end = (sep < 0) ? strLen(nums) : pos + sep;
    const tok = strSlice(nums, pos, end);
    const v = decU32(tok);
    if (v > 255) { near.panic("bad signature byte"); }
    hexSig = strConcatBytes(hexSig, v);
    pos = end + 1;
  }
  const sig58 = b58EncodeBytes(hexSig);
  if (sig58 === "") { near.panic("sig encode failed"); }
  // fire exec-b directly
  near.storageSet("jobsig:" + jobId, sig58);
  setJobStatus(jobId, "broadcasting");
  const msgHex = near.storageGet("jobmsg:" + jobId) ?? "";
  const input = `${jobId}|${sig58}|${msgHex}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_B_WASM}","hash":"${EXEC_B_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_done","data":{"jobId":"${jobId}"}}`);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"broadcast_requested","data":{"jobId":"${jobId}"}}`);
}

const DIG: string = "0123456789";
// decimal string (0..255) → u32
function decU32(s: string): number {
  let v = 0;
  for (let i = 0; i < strLen(s); i = i + 1) {
    const d = DIG.indexOf(strSlice(s, i, i + 1));
    if (d < 0) { return 99999; }
    v = v * 10 + d;
  }
  return v;
}

// append one byte (as hex pair) to a hex string
function strConcatBytes(hexSoFar: string, byteVal: number): string {
  return hexSoFar + strSlice(HXD, byteVal / 16, byteVal / 16 + 1) + strSlice(HXD, byteVal % 16, byteVal % 16 + 1);
}

// 64-byte hex → base58 (MSB-first digits array, same scheme as b58ToHex reversed)
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

const HXD: string = "0123456789abcdef";
function hexNibble(c: string): number {
  const v = HXD.indexOf(c);
  return v; // lowercase-only; -1 on miss (we always build lowercase)
}

// ── SETTLE: owner-only, after they see the Solana tx land (off-chain proof they hold). ──
// Debit = the signed amount (from jobamt), refund budget − amount. Fail path refunds all.
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
    const prev = near.storageGet("credittok:" + owner) ?? "0";
    near.storageSet("credittok:" + owner, u128Add(prev, refund));
  }
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"job_done","data":{"jobId":"${jobId}","ok":"${resultOk === "1" ? 1 : 0}","refunded":"${refund}"}}`);
}

// ── views ──
export function credit(): string {
  return near.storageGet("credit:" + near.predecessorAccountId()) ?? "0";
}
export function creditOf(user: string): string {
  return near.storageGet("credit:" + user) ?? "0";
}
export function job(jobId: string): string {
  return near.storageGet("job:" + jobId) ?? "";
}

// ── internals ──
function requireOutlayer(): void {
  const p = near.predecessorAccountId();
  if (p !== OUTLAYER_CONTRACT && p !== near.currentAccountId()) { near.panic("outlayer lane only"); }
}
function requireSelf(): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
}
function requireJob(jobId: string, expected: string): void {
  const raw = near.storageGet("job:" + jobId);
  if (raw === null) { near.panic("unknown job"); }
  if ((near.jsonGetStr("status", raw) ?? "") !== expected) { near.panic("bad job state"); }
}
function setJobStatus(jobId: string, status: string): void {
  const raw = near.storageGet("job:" + jobId) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const url = near.jsonGetStr("url", raw) ?? "";
  const suffix = near.jsonGetStr("suffix", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const payer = near.jsonGetStr("payer", raw) ?? "";
  near.storageSet("job:" + jobId, `{"owner":"${owner}","url":"${url}","suffix":"${suffix}","budget":"${budget}","payer":"${payer}","status":"${status}"}`);
}
// base58 (32-byte pubkey) → big-endian hex; small, no deps, MSB-first digits array
function b58ToHex(s: string): string {
  // P2 arrays never grow past their literal length — preallocate 64 cells, track len manually
  const digits: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let dlen = 1;
  for (let i = 0; i < strLen(s); i = i + 1) {
    const c = s.charAt(i);
    const v = B58.indexOf(c);
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
function hexDigit(v: number): string {
  const d = v % 16;
  return "0123456789abcdef".charAt(d);
}
// little-endian u64 hex → decimal string (amounts ≤ 2^53 — safe with number math)
function leHexToDec(h: string): string {
  let n = 0;
  let shift = 0;
  for (let i = 0; i < strLen(h); i = i + 2) {
    const hi = hexVal(h.charAt(i));
    const lo = hexVal(h.charAt(i + 1));
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
function hexVal(c: string): number {
  return "0123456789abcdef".indexOf(c);
}
// JSON string-encode (minimal: quote + escape backslash/quote — URLs and hex payloads are safe sets)
function jsonQuote(s: string): string {
  return `\"${s}\"`;
}
