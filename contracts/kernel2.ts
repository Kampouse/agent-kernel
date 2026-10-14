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
const SIGN_GAS: number = 250000000000000;
const CB_GAS: number = 20000000000000;
const EXEC_GAS: number = 150000000000000;
const EXEC_FEE: string = "4000010000000000000000";
const EXEC_A_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-a.wasm";
const EXEC_A_HASH: string = "c959eba24d9ed7f86d02b71da4d71fb6400c5a62aac404d380beaf4f03e6f50e";
const EXEC_B_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-b.wasm";
const EXEC_B_HASH: string = "3ee30751002e1c4d4099e0c1b311883e94bf7e17ae9ca80266312db5c47d2665";

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

// ── EMIT: the only entry an agent needs to start a job ──
export function callApi(url: string, suffix: string, budget: string, payer58: string): string {
  const caller = near.predecessorAccountId();
  if (url === "" || strLen(url) > 256) { near.panic("bad url"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (strLen(payer58) > 48) { near.panic("bad payer"); }
  if (near.storageGet("payto:" + suffix) === null) { near.panic("unpinned suffix"); }
  const credit = near.storageGet("credit:" + caller) ?? "0";
  if (u128Gt(budget, credit)) { near.panic("insufficient credit for budget"); }
  if (u128Gt(EXEC_FEE, budget)) { near.panic("budget below exec fee"); }
  const held = u128Sub(credit, budget);
  if (held === "0") { near.storageRemove("credit:" + caller); } else { near.storageSet("credit:" + caller, held); }
  const jobId = sha256Hash(caller + ":" + url + ":" + toStr(near.blockHeight()) + ":" + near.randomSeed());
  // ONE storage write at emit: the job record. No agent resume, no lastYield — outlayer's
  // yield/resume delivers exec-a's output straight into onResult via promise_result.
  const job = `{"owner":"${caller}","url":"${url}","suffix":"${suffix}","budget":"${budget}","payer":"${payer58}","jobId":"${jobId}","status":"exec_a"}`;
  near.storageSet("job:" + jobId, job);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.1.0","event":"job_started","data":{"jobId":"${jobId}","owner":"${caller}","url":"${url}","budget":"${budget}"}}`);
  // fire exec-a on outlayer; the contract's on_execution_response value_returns the output
  // to this .then() — onResult runs with the exec-a msgHex as promiseResult(0).
  const path = caller + "-" + suffix;
  const input = `${jobId}|${url}|${path}|${payer58}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_A_WASM}","hash":"${EXEC_A_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  near.promiseThen(p, near.currentAccountId(), "onResult", `{"jobId":"${jobId}"}`, "0", CB_GAS);
  return jobId;
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
  // promiseResult(0) = outlayer's on_execution_response value_return = the FULL
  // response JSON ({"success":true,"output":{"Text":"<msgHex>"},...}); extract Text.
  const respJson = near.promiseResult(0);
  const msgHex = near.jsonGetStr("output.Text", respJson) ?? "";
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
  near.promiseThen(p1, near.currentAccountId(), "onSignDone", `{"jobId":"${jobId}"}`, "0", CB_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_requested","data":{"jobId":"${jobId}","path":"${path}","amount":"${amount}"}}`);
}

// MPC resumed here (result-blind on the signature itself — relay pulls SuccessValue via RPC)
export function onSignDone(jobId: string): void {
  // v2.1: predecessor = MPC contract (its sign promise .then's back here)
  if (near.predecessorAccountId() !== MPC_CONTRACT) { near.panic("mpc lane only"); }
  requireJob(jobId, "sign_requested");
  setJobStatus(jobId, "exec_b");
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"sign_done","data":{"jobId":"${jobId}"}}`);
}

// attested relay uploads the sig (pulled from the MPC receipt) → fire exec-b
export function sigUpload(jobId: string, sig58: string): void {
  requireOutlayer();
  requireJob(jobId, "exec_b");
  if (sig58 === "" || strLen(sig58) > 96) { near.panic("bad sig"); }
  near.storageSet("jobsig:" + jobId, sig58);
  setJobStatus(jobId, "broadcasting");
  const msgHex = near.storageGet("jobmsg:" + jobId) ?? "";
  const input = `${jobId}|${sig58}|${msgHex}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_B_WASM}","hash":"${EXEC_B_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"2.0.0","event":"broadcast_requested","data":{"jobId":"${jobId}"}}`);
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
    const prev = near.storageGet("credit:" + owner) ?? "0";
    near.storageSet("credit:" + owner, u128Add(prev, refund));
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
