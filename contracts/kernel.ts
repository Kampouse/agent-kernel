// kernel.ts — the agent kernel: "call this API" and everything under the hood.
//
// Money:   credit escrow (deposit() → NEAR credit ledger; callApi holds budget;
//          settle debits actual cost + atomically refunds leftover).
// Signing: path = job.owner + "-" + suffix composed from the JOB REGISTRY (not
//          predecessor — TEE-lane calls arrive with OutLayer as predecessor).
//          jobPay/onExecResult are predecessor-gated to the OutLayer contract:
//          that gate IS the TEE boundary. Money only moves through attested execs.
// Pieces:  insigner's yield/resume requestSign (proven), OutLayer request_execution
//          (proven args shape), tank views for the USDC side.

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

// withdraw credit back to the owner (owner-gated; internal transfer)
export function withdrawCredit(amount: string): void {
  const caller = near.predecessorAccountId();
  const bal = near.storageGet("credit:" + caller) ?? "0";
  if (u128Gt(amount, bal)) { near.panic("insufficient credit"); }
  const rest = u128Sub(bal, amount);
  if (rest === "0") { near.storageRemove("credit:" + caller); } else { near.storageSet("credit:" + caller, rest); }
  near.transferU128(caller, amount);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"credit_withdrawn","data":{"user":"${caller}","amount":"${amount}"}}`);
}

// ── callApi: THE entry. Agent calls this; everything else is machinery. ──
export function callApi(url: string, suffix: string, budget: string): string {
  const caller = near.predecessorAccountId();
  if (url === "" || strLen(url) > 256) { near.panic("bad url"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  const credit = near.storageGet("credit:" + caller) ?? "0";
  if (u128Gt(budget, credit)) { near.panic("insufficient credit for budget"); }
  // hold the budget
  const held = u128Sub(credit, budget);
  if (held === "0") { near.storageRemove("credit:" + caller); } else { near.storageSet("credit:" + caller, held); }
  // job registry — the binding root for everything the TEE lane does
  const jobId = sha256Hash(caller + ":" + url + ":" + toStr(near.blockHeight()) + ":" + near.randomSeed());
  const job = `{"owner":"${caller}","url":"${url}","suffix":"${suffix}","budget":"${budget}","status":"exec_a"}`;
  near.storageSet("job:" + jobId, job);
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"job_started","data":{"jobId":"${jobId}","owner":"${caller}","url":"${url}","budget":"${budget}"}}`);
  // fire the TEE exec (OutLayer request_execution — proven args shape, wired in v3)
  return jobId;
}

// ── TEE lane: called (directly or via OutLayer callback) with predecessor = OutLayer contract ──
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
  // yield/resume on v1.signer.sign (insigner's proven raw-promise-batch shape; result-blind callback)
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"sign_requested","data":{"jobId":"${jobId}","path":"${path}"}}`);
}

// MPC resumed here (result-blind on the signature itself — daemon/next exec pulls SuccessValue)
export function onSignDone(jobId: string): void {
  requireSelf();
  requireJob(jobId, "sign_requested");
  setJobStatus(jobId, "exec_b");
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"sign_done","data":{"jobId":"${jobId}"}}`);
  // trigger exec B (attested broadcast) via request_execution — wired in v3
}

// exec B reports the broadcast outcome; then the API re-POST completes the job
export function onBroadcast(jobId: string, landed: string, sig58: string): void {
  requireOutlayer();
  requireJob(jobId, "exec_b");
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
  near.log(`EVENT_JSON:{"standard":"kernel","version":"1.0.0","event":"job_done","data":{"jobId":"${jobId}","ok":"${resultOk === "1" ? 1 : 0}","cost":"${resultOk ? actualCost : "0"}","refunded":"${refund}"}}`);
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

const OUTLAYER_CONTRACT: string = "outlayer.testnet"; // pin per network; re-audit on mainnet port

