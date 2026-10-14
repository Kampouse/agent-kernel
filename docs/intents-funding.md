# Intents-Funded kernel2 — Design Notes

Status: DESIGN ONLY, not implemented. Native NEAR `deposit()` remains the live
funding path.

## What exists today

- `deposit()` (attached NEAR) → `credit:<user>` ledger. Settle debits the
  signed Solana amount against that credit. `withdrawCredit` refunds.
- tank.ts (superseded) sketched intents but assumed an off-contract swap leg —
  the exact piece that would break the zero-infrastructure rule.

## The funding leg, concretely

NEAR Intents (defuse) accepts tokens via `ft_on_transfer` on the intents
contract: `msg` names the internal recipient; token identity = the
**predecessor** (bare nep141 contract — `nep141:<id>` strings trap silently).
Proven live in ~/dev/near-intents local defuse (v0.2.10): auth =
add_public_key + 1 yocto; verifying_contract must equal the contract that
signed.

## Design: kernel2 as an intents-funded escrow

Two trust-compatible shapes:

### A. Direct ft_on_transfer into kernel2 (preferred)
Make kernel2 itself `FungTokenReceiver`: USDC (nep141) transfer-in with
`msg = user` credits `credit_token:<user>:<token>` — same ledger, keyed by
token. Settle stays identical: debit `amount` tokens instead of NEAR.
- Trust: unchanged. The token contract (USDC on NEAR) is the only new
  dependency, same trust level as NEAR itself for escrow purposes.
- The Solana payment still flows out via MPC from the derived payer — the
  token in, Solana out. No solver, no swap, no relayer.
- Refund path: `withdrawCreditToken` = ft_transfer back. Escrow cannot leak
  (same owner-only settle-or-refund).
- Open item: does the merchant x402 price unit (USDC lamports on Solana)
  match the NEAR-side USDC 1:1? If yes, settle math is unchanged u128. If
  the merchant takes a different token, we need a price gate — reject if
  `exec-a amount × oracle ≠ budget`. That oracle is a trust dependency —
  avoid by pinning accepted token = merchant token.

### B. Intents vault → kernel2 (rejected for now)
Deposit into the defuse vault, kernel reads a cross-contract balance.
Adds the vault as a component and needs a proving leg (either a callback we
must trust or an indexer — both violate the no-extra-infrastructure rule).

## Decision

Go with A when intents funding is wanted. Implementation sketch:
1. `#[ft_on_transfer]`-equivalent in lisp-rlm TS (predecessor = token
   contract; credit `msg` recipient).
2. Ledger keyed `credit_token:<user>:<predecessor>`; native NEAR ledger
   untouched.
3. `settle` takes token id; debits matching ledger only.
4. exec-a's amount (Solana-side) must equal the escrowed token amount —
   gate it in onResult next to the payTo pin.
