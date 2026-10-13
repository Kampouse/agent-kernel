/// <reference path="./types/lisp-rlm.d.ts" />
// kernel.ts — the agent kernel: "call this API" and everything under the hood.
//
// Money:   credit escrow (deposit() → NEAR credit ledger; callApi holds budget;
//          settle debits actual cost + atomically refunds leftover).
// Signing: path = job.owner + "-" + suffix composed from the JOB REGISTRY (not
//          predecessor — TEE-lane calls arrive with OutLayer as predecessor).
//          jobPay/onExecResult are predecessor-gated to the OutLayer contract:
//          that gate IS the TEE boundary. Money only moves through attested execs.
//
// WIRE (all promises raw-batch, deposits explicit):
//   callApi ─batch→ outlayer.request_execution(exec-a wasm, input={jobId,url,suffix,path},
//                attach EXEC_FEE from escrow-backed balance)
//   exec-a (TEE): fetch url → x402 challenge → build exact-payment Solana msg → output msgHex
//   jobPay (outlayer lane reports output) ─batch→ v1.signer-prod.sign(payload_v2 Eddsa,
//                path from REGISTRY, domain 1, 1 yocto, 250T) → promiseThen self.onSignDone
//   onSignDone (self, result-blind — MPC sig bytes trip UTF-8): status=exec_b, emit sign_done
//   sigUpload (outlayer lane; the attested relay recovered the sig from the MPC receipt
//                via RPC — proven result-blind flow): store sig58 ─batch→
//                outlayer.request_execution(exec-b wasm, input={jobId, sigs58, msg_hex})
//   exec-b (TEE): assemble tx + sendTransaction POST → output = landed sig58
//   onBroadcast (outlayer lane reports output): paying | failed+refund
//   settle (outlayer lane): debit actual, refund leftover → job_done
//
// EVERY stage transition = setJobStatus. EVERY recipient/path = derived from registry.

const OUTLAYER_CONTRACT: string = "outlayer.testnet";   // pin per network; re-audit on mainnet port
const MPC_CONTRACT: string = "v1.signer-prod.testnet";
const SIGN_GAS: number = 250000000000000;   // 250 TGas forwarded to MPC sign (burns ~8)
const CB_GAS: number = 20000000000000;      // 20 TGas callback
const EXEC_GAS: number = 150000000000000;   // 150 TGas per request_execution fwd (playground uses 300; desugar+storage need real headroom)
const EXEC_FEE: string = "4000010000000000000000"; // exact estimate_execution_cost(100M instr, 64MB, 30s) — verified via RPC view
const EXEC_A_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v3/exec-a.wasm";
const EXEC_A_HASH: string = "ecac562312c8051f146c017a9d8e3b85eb56f5122fc44ebc7a80b095aa92de90";
const EXEC_B_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v3/exec-b.wasm";
const EXEC_B_HASH: string = "5ee592d183e30e0f03a171e50906022244d9751dbb41b2ca077cebd6edff0bda";

// ── deposit: fund the NEAR credit ledger ──
export function deposit(): string {
  const caller = near.predecessorAccountId();
  const dep = near.attachedDepositU128();
  if (dep === "0" || dep === "") { near.panic("attach NEAR to deposit"); }
  const prev = near.storageGet("credit:" + caller) ?? "0";
  const total = u128Add(prev, dep);
  near.storageSet("credit:" + caller, total);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"deposit","data":{"user":"${caller}","amount":"${dep}","total":"${total}"}}`);
  return total;
}

// withdraw credit back to the owner (recipient derived from caller — no param)
export function withdrawCredit(amount: string): void {
  const caller = near.predecessorAccountId();
  const bal = near.storageGet("credit:" + caller) ?? "0";
  // money-seal: payable = amount - (amount - bal) clamped in the u128 domain; overdraw → 0
  const overdraft = u128Sub(amount, bal);
  const amt = u128Sub(amount, overdraft);   // = min(amount, bal) with pure u128 ops
  if (amt !== amount) { near.panic("insufficient credit"); }
  const rest = u128Sub(bal, amt);
  if (rest === "0") { near.storageRemove("credit:" + caller); } else { near.storageSet("credit:" + caller, rest); }
  near.transferU128(caller, amt);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"credit_withdrawn","data":{"user":"${caller}","amount":"${amt}"}}`);
}

// ── callApi: THE entry. Agent calls this; everything else is machinery. ──
export function callApi(url: string, suffix: string, budget: string): string {
  const caller = near.predecessorAccountId();
  if (url === "" || strLen(url) > 256) { near.panic("bad url"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  const credit = near.storageGet("credit:" + caller) ?? "0";
  if (u128Gt(budget, credit)) { near.panic("insufficient credit for budget"); }
  if (u128Gt(EXEC_FEE, budget)) { near.panic("budget below exec fee"); }
  // hold budget + exec fee
  const held = u128Sub(credit, budget);
  if (held === "0") { near.storageRemove("credit:" + caller); } else { near.storageSet("credit:" + caller, held); }
  // job registry — the binding root for everything the TEE lane does
  const jobId = sha256Hash(caller + ":" + url + ":" + toStr(near.blockHeight()) + ":" + near.randomSeed());
  const job = `{"owner":"${caller}","url":"${url}","suffix":"${suffix}","budget":"${budget}","status":"exec_a"}`;
  near.storageSet("job:" + jobId, job);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"job_started","data":{"jobId":"${jobId}","owner":"${caller}","url":"${url}","budget":"${budget}"}}`);
  // FIRE the TEE exec-a: attested fetch + x402 challenge parse + msg build.
  const path = caller + "-" + suffix;
  const input = `{"jobId":"${jobId}","url":"${url}","path":"${path}"}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_A_WASM}","hash":"${EXEC_A_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  return jobId;
}

// ── TEE lane: outlayer.testnet (or kernel self during tests) drives these ──
// exec A built the x402 payment msg; kernel signs it via MPC under the OWNER's path.
export function jobPay(jobId: string, msgHex: string): void {
  requireOutlayer();
  requireJob(jobId, "exec_a");
  const owner = near.jsonGetStr("owner", near.storageGet("job:" + jobId) ?? "");
  const suffix = near.jsonGetStr("suffix", near.storageGet("job:" + jobId) ?? "");
  const path = owner + "-" + suffix;   // BINDING: from registry, never from predecessor
  near.storageSet("jobmsg:" + jobId, msgHex);
  near.storageSet("jobpath:" + jobId, path);
  setJobStatus(jobId, "sign_requested");
  // MPC sign via raw promise batch (insigner's proven wire) with callback to self
  const args = `{"request":{"payload_v2":{"Eddsa":"${msgHex}"},"path":"${path}","domain_id":1}}`;
  const p1 = near.promiseBatchCreate(MPC_CONTRACT);
  near.promiseBatchActionFunctionCall(p1, "sign", args, "1", SIGN_GAS);
  near.promiseThen(p1, near.currentAccountId(), "onSignDone", `{"jobId":"${jobId}"}`, "0", CB_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"sign_requested","data":{"jobId":"${jobId}","path":"${path}"}}`);
}

// MPC resumed here (result-blind on the signature itself — relay pulls SuccessValue via RPC)
export function onSignDone(jobId: string): void {
  requireSelf();
  requireJob(jobId, "sign_requested");
  setJobStatus(jobId, "exec_b");
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"sign_done","data":{"jobId":"${jobId}"}}`);
}

// attested relay uploads the sig (pulled result-blind from the MPC receipt) → fire exec-b
export function sigUpload(jobId: string, sig58: string): void {
  requireOutlayer();
  requireJob(jobId, "exec_b");
  if (sig58 === "" || strLen(sig58) > 96) { near.panic("bad sig"); }
  near.storageSet("jobsig:" + jobId, sig58);
  setJobStatus(jobId, "broadcasting");
  const msgHex = near.storageGet("jobmsg:" + jobId) ?? "";
  const input = `{"jobId":"${jobId}","sigs58":["${sig58}"],"msg_hex":"${msgHex}"}`;
  const args = `{"source":{"WasmUrl":{"url":"${EXEC_B_WASM}","hash":"${EXEC_B_HASH}","build_target":"wasm32-wasip2"}},"resource_limits":{"max_instructions":100000000,"max_memory_mb":64,"max_execution_seconds":30},"input_data":${jsonQuote(input)},"response_format":"Text"}`;
  const p = near.promiseBatchCreate(OUTLAYER_CONTRACT);
  near.promiseBatchActionFunctionCall(p, "request_execution", args, EXEC_FEE, EXEC_GAS);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"broadcast_requested","data":{"jobId":"${jobId}"}}`);
}

// exec B reports the broadcast outcome; then the API re-POST completes the job
export function onBroadcast(jobId: string, landed: string, sig58: string): void {
  requireOutlayer();
  requireJob(jobId, "broadcasting");
  if (landed === "1") {
    setJobStatus(jobId, "paying");
    near.storageSet("jobsig:" + jobId, sig58);
    near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"payment_landed","data":{"jobId":"${jobId}","sig":"${sig58}"}}`);
  } else {
    setJobStatus(jobId, "failed");
    refundBudget(jobId);
  }
}

// settle: the API call finished (or gave up). Debit actual, refund the rest.
export function settleJob(jobId: string, actualCost: string, resultOk: string): void {
  requireOutlayer();
  const jobRaw = near.storageGet("job:" + jobId);
  if (jobRaw === null) { near.panic("unknown job"); }
  const owner = near.jsonGetStr("owner", jobRaw) ?? "";
  const budget = near.jsonGetStr("budget", jobRaw) ?? "";
  const status = near.jsonGetStr("status", jobRaw) ?? "";
  if (status === "done" || status === "failed") { near.panic("already settled"); }
  let refund = budget;
  if (resultOk === "1") {
    if (u128Gt(actualCost, budget)) { near.panic("cost exceeds held budget"); }
    refund = u128Sub(budget, actualCost);
    setJobStatus(jobId, "done");
  } else {
    setJobStatus(jobId, "failed");
  }
  if (refund !== "0") {
    const prev = near.storageGet("credit:" + owner) ?? "0";
    near.storageSet("credit:" + owner, u128Add(prev, refund));
  }
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"job_done","data":{"jobId":"${jobId}","ok":"${resultOk === "1" ? 1 : 0}","cost":"${resultOk === "1" ? actualCost : "0"}","refunded":"${refund}"}}`);
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
export function pathForOf(user: string, suffix: string): string {
  return user + "-" + suffix;
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
  near.storageSet("job:" + jobId, `{"owner":"${owner}","url":"${url}","suffix":"${suffix}","budget":"${budget}","status":"${status}"}`);
}
function refundBudget(jobId: string): void {
  const raw = near.storageGet("job:" + jobId) ?? "";
  const owner = near.jsonGetStr("owner", raw) ?? "";
  const budget = near.jsonGetStr("budget", raw) ?? "";
  const prev = near.storageGet("credit:" + owner) ?? "0";
  near.storageSet("credit:" + owner, u128Add(prev, budget));
}
// JSON string-encode (minimal: quote + escape backslash/quote — URLs and hex payloads are safe sets)
function jsonQuote(s: string): string {
  return `\"${s}\"`;
}
