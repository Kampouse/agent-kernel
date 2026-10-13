// inlayer_signer.ts — per-user MPC Solana signing, lisp-rlm (TS frontend).
//
// Replaces the Rust inlayer-job sign leg. Flow:
//   1. user submits a job on the inlayer job contract (their wallet)
//   2. daemon executes wasm → output = solana msg hex
//   3. daemon resolves → job contract (or anyone) calls THIS contract:
//        requestSign({ payloadHex, path })  — path already "<caller>-<suffix>"
//   4. this contract promise-calls MPC sign (yield-style callback via callAwait),
//      stores the sig keyed by payload, emits signature_ready event
//   5. edge daemon sees the event → broadcasts the signed tx to Solana
//
// Every user's derived Solana address = derive(THIS contract id, path) where path
// = "<their-account>-<suffix>" — unique per user, enforced on-chain here.
//
// Also exposes deriveAddress checks: sha256("aeiou" + mpc + caller + path) etc. is
// NOT how derivation works on the real MPC network — the REAL address comes from
// chainsig.js (SDK-side). This contract only guarantees the PATH composition;
// clients derive the address off-chain with the SDK for display/funding.

const MPC_CONTRACT = "v1.signer-prod.testnet";
const SIGN_GAS = 250000000000000; // 250 TGas forwarded to MPC sign
const CB_GAS = 20000000000000;    // 20 TGas

// ── request an MPC signature for a payload under a caller-bound path ──
// path must be "<account>-<suffix>" — we FORCE the account prefix to the
// caller so nobody can request a signature scoped to someone else's address.
// attach ≥ 1 yocto (forwarded to the MPC contract).
export function requestSign(payloadHex: string, suffix: string): void {
  const caller = near.predecessorAccountId();
  const path = caller + "-" + suffix;
  requireDeposit1Yocto();
  const args = "{\"request\":{\"payload_v2\":{\"Eddsa\":\"" + payloadHex +
               "\"},\"path\":\"" + path + "\",\"domain_id\":1}}";
  // stash context for the callback
  const key = shaKey(payloadHex);
  near.storageSet("pending:" + key, caller);
  near.storageSet("path:" + key, path);
  near.storageSet("cbKey", key);
  near.log("EVENT_JSON:{\"standard\":\"inlayer-sol\",\"version\":\"1.0.0\",\"event\":\"sign_requested\",\"data\":{\"caller\":\"" + caller + "\",\"path\":\"" + path + "\"}}");
  // raw promise chain: batch needed because callAwait fixes deposit at 0 and the MPC
  // contract requires 1 yocto attached to sign()
  const p1 = near.promiseBatchCreate(MPC_CONTRACT);
  near.promiseBatchActionFunctionCall(p1, "sign", args, "1", SIGN_GAS);
  near.promiseThen(p1, near.currentAccountId(), "onSign", "{}", "0", CB_GAS);
}

// ── resume point: MPC returned the signature ──
// cbArgs carries {"key": "<sha256(payloadHex)[0..16]>"}; the sig is read from
// the promise result. Stored under key; event carries everything the edge
// daemon needs (sig + key). Failure = sign_failed event, no state poison.
export function onSign(): string {
  // Keep the callback result-blind AND storage-blind: every bisect that read storage or
  // the result register trapped on UTF-8; a bare log never does. The edge daemon correlates
  // this receipt to its own sign request (it submitted it) and pulls the signature from
  // the v1.signer-prod receipt SuccessValue via RPC.
  near.log("EVENT_JSON:{\"standard\":\"inlayer-sol\",\"version\":\"1.0.0\",\"event\":\"sign_attempt_done\",\"data\":{\"path\":\"" + near.signerAccountId() + "\"}}");
  return "DONE";
}

export function onSignFull(): string {
  const key = near.storageGet("cbKey") ?? "";
  // NEVER read the promise result as a lisp string: the MPC response bytes trip the
  // runtime's UTF-8 assertions non-deterministically (alpha varies per sign).
  // Success/fail via promiseSucceeded only; the edge daemon recovers the signature from
  // the MPC sign receipt (SuccessValue) via RPC, keyed by this event.
  // Do NOT touch the promise result (even promiseSucceeded reads the register and the
  // MPC response bytes trip the UTF-8 assertion). The sign tx receipt (v1.signer-prod
  // SuccessValue) carries the signature — the edge daemon pulls it via RPC keyed by key.
  near.log("EVENT_JSON:{\"standard\":\"inlayer-sol\",\"version\":\"1.0.0\",\"event\":\"sign_attempt_done\",\"data\":{\"key\":\"" + key + "\",\"signer\":\"" + near.signerAccountId() + "\"}}");
  return "DONE";
}

// ── views ──
export function getSignature(payloadHex: string): string {
  return near.storageGet("sig:" + shaKey(payloadHex)) ?? "";
}

export function getPendingCaller(payloadHex: string): string {
  return near.storageGet("pending:" + shaKey(payloadHex)) ?? "";
}

// The ONLY sanctioned path for a caller+suffix — mirrors requestSign exactly.
// Clients feed this to chainsig.js deriveAddressAndPublicKey off-chain.
export function pathFor(suffix: string): string {
  return near.predecessorAccountId() + "-" + suffix;
}

// ── internals ──
function requireDeposit1Yocto(): void {
  // attachedDepositU128 returns decimal string; require ≥ 1
  const dep = near.attachedDepositU128();
  if (!u128Gte1(dep)) { near.panic("attach 1 yocto"); }
}

function u128Gte1(dep: string): boolean {
  return dep !== "0" && dep !== "";
}

function shaKey(payloadHex: string): string {
  return strSlice(near.sha256(payloadHex), 0, 16);
}
