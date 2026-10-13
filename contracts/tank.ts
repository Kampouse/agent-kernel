/// <reference path="./types/lisp-rlm.d.ts" />
// tank.ts — per-user Solana tank coordinator (fund/withdraw intents), lisp-rlm TS frontend.
//
// Design: the contract holds NO principal. It is a ledger + intent emitter.
//   fund()    → credit ledger[user][suffix], emit fund_intent {user, suffix, amount,
//               destination} — destination is ALWAYS derive(INSIGNER, "<user>-<suffix>"),
//               computed by clients off-chain; the contract only pins the PATH string so
//               a keeper cannot redirect funds anywhere else.
//   withdraw(user, suffix) — user (or anyone; funds are path-bound) asks for the return
//               leg; contract emits withdraw_intent. The actual USDC→NEAR swap is signed
//               via insigner requestSign under the SAME path — only the user's base key
//               can produce it. Contract-side "withdraw" = bookkeeping only.
//   Keeper executes 1Click swaps on the events. Malicious keeper = delayed funds, never
//   redirected funds (destination is enforced by path convention, not keeper honesty).
//
// Suffix convention: ONE canonical suffix "main" per user = their single Solana identity.

// ── fund: DECLARE the intent, never take custody ──
// The NEAR→USDC leg runs through 1Click solvers directly (user sends NEAR to the
// quoted deposit address). This call only records the declared amount + emits the
// event. ANY attached deposit is REFUSED (no out-path exists — attaching would
// strand funds in the contract).
export function fund(suffix: string, amount: string): string {
  const caller = near.predecessorAccountId();
  const dep = near.attachedDepositU128();
  if (dep !== "0" && dep !== "") { near.panic("no deposit here — send NEAR to the quoted 1Click deposit address"); }
  if (suffix === "" || strLen(suffix) > 32) { near.panic("bad suffix"); }
  if (amount === "" || amount === "0") { near.panic("declare amount"); }
  const prev = near.storageGet("bal:" + caller + ":" + suffix) ?? "0";
  const total = u128Add(prev, amount);
  near.storageSet("bal:" + caller + ":" + suffix, total);
  const path = caller + "-" + suffix;
  near.log(`EVENT_JSON:{"standard":"tank","version":"1.0.0","event":"fund_intent","data":{"user":"${caller}","suffix":"${suffix}","amount":"${amount}","path":"${path}"}}`);
  return total;
}

// record that the keeper executed the swap leg (bookkeeping; keeper posts the txid hash)
export function recordSwap(user: string, suffix: string, txid: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  near.storageSet("swap:" + user + ":" + suffix, txid);
  near.log(`EVENT_JSON:{"standard":"tank","version":"1.0.0","event":"swap_recorded","data":{"user":"${user}","suffix":"${suffix}"}}`);
}

// ── withdraw: emit the return-leg intent (the leg itself is signed off-contract
//    via insigner requestSign — path-bound, user-key-gated) ──
export function withdrawRequest(suffix: string): void {
  const caller = near.predecessorAccountId();
  const bal = near.storageGet("bal:" + caller + ":" + suffix) ?? "0";
  if (bal === "0") { near.panic("nothing funded"); }
  const path = caller + "-" + suffix;
  near.log(`EVENT_JSON:{"standard":"tank","version":"1.0.0","event":"withdraw_intent","data":{"user":"${caller}","suffix":"${suffix}","ledger":"${bal}","path":"${path}"}}`);
}

// settle a withdraw: zero the ledger leg after the return swap lands (self-call)
export function withdrawSettle(user: string, suffix: string): void {
  if (near.predecessorAccountId() !== near.currentAccountId()) { near.panic("self only"); }
  near.storageSet("bal:" + user + ":" + suffix, "0");
  near.log(`EVENT_JSON:{"standard":"tank","version":"1.0.0","event":"withdrawn","data":{"user":"${user}","suffix":"${suffix}"}}`);
}

// ── views ──
export function balance(suffix: string): string {
  return near.storageGet("bal:" + near.predecessorAccountId() + ":" + suffix) ?? "0";
}

export function balanceOf(user: string, suffix: string): string {
  return near.storageGet("bal:" + user + ":" + suffix) ?? "0";
}

// the ONE sanctioned path for a caller's tank — mirrors fund() exactly.
// Feed to chainsig.js deriveAddressAndPublicKey(INSIGNER, path) off-chain for the
// deposit address.
export function pathFor(suffix: string): string {
  return near.predecessorAccountId() + "-" + suffix;
}

export function lastSwap(user: string, suffix: string): string {
  return near.storageGet("swap:" + user + ":" + suffix) ?? "";
}

// ── internals ──
function strLen(s: string): number {
  return len(s);
}
