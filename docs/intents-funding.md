# Intents-Funded kernel2 — Design Notes

Status: DESIGN v2 — real intents (defuse engine), per user decision. Not yet
implemented. Native NEAR `deposit()` remains the live funding path until this
lands.

## The value path (two sides, honestly separated)

```
USER (NEAR side)                     KERNEL                    SOLANA side
─────────────────                    ─────                     ───────────
USDC (nep141)                        credit_token ledger       MPC-derived payer
  │ ft_transfer_call ──────────────► credit upon deposit           │
  │   to kernel2                     │                            │ pays merchant
  │                                  ▼                            ▼
  └─ optional: route through      settle debits ────────►  merchant gets paid
     defuse intents vault            credit                 (x402, from payer)
```

The deposit (user→kernel) and the payment (payer→merchant) are DIFFERENT
transfers on DIFFERENT chains. Nothing "moves" the user's deposit to Solana.
What crosses is *obligation*: the kernel owes the merchant on Solana and owes
the user a refund right on NEAR; settle nets them. The only asset that must
physically exist on Solana is the payer's float.

## Funding leg — intents (user decision: USE INTENTS)

User deposits USDC (nep141) via `ft_transfer_call` to the defuse intents
contract (or directly to kernel2 — see "kernel2 as FT receiver"), then the
kernel's settle path is unchanged. The defuse contract (verified in
~/dev/near-intents, v0.2.10):

- `ft_on_transfer(sender_id, amount, msg)` — msg names the internal
  recipient; token identity = **bare predecessor** (nep141:<id> string traps
  silently).
- Intent enum (mod.rs:42): AddPublicKey / Transfer / FtWithdraw / NftWithdraw
  / MtWithdraw / NativeWithdraw / StorageDeposit / TokenDiff / SetAuthBy...
  — **no cross-chain intent exists on-contract**. FtWithdraw.receiver_id is
  a NEAR AccountId (nep141 → NEAR accounts only).
- Cross-chain exits are therefore SOLVER territory: solvers watch published
  intents and fill on the destination chain. That is a real, bonded,
  competitive network — but it IS the trusted-ish leg. Accept it: the user
  has decided intents are in.

### Where intents plug in (minimal surface)

1. **Deposit**: user funds the defuse account, then kernel2's funding method
   composes a signed defuse intent `Transfer` (kernel2 ← user, token, amount)
   OR kernel2 is a plain FT receiver. Preference: kernel2 as plain FT
   receiver (Shape A) for the *ledger*, defuse only if the user wants to pay
   from held intents positions. Fewest moving parts; no solver on the
   deposit side.
2. **Solana float**: this is where intents genuinely help. The payer
   (MPC-derived Solana address) needs USDC/SOL float. Options:
   a. Operator tops the float off-chain (simple; business trust).
   b. Kernel publishes a defuse intent that pays a solver to deliver USDC to
      the derived payer on Solana. Solver network = the bridge. Bonded,
      competitive, no custom code by us — we reuse existing intents infra
      instead of building a bridge.
3. **Settle**: unchanged — exact u128 debit of the user's token credit
   against the signed amount. PayTo pin + budget gates unchanged.

## Trust ledger (final)

- NEAR side escrow: kernel2's own promise chain (unchanged).
- Solana payment: MPC network signing (unchanged).
- Cross-chain float replenishment: defuse solver network (NEW, accepted by
  decision) — or operator float as the simpler v1.
- No watchers, no indexers, no custom relayer anywhere.

## Implementation sketch (kernel2 v2.3)

1. `ft_on_transfer` in kernel2 (lisp-rlm TS): predecessor = token contract,
   msg = credit recipient → `credit_token:<user>:<predecessor>`.
2. `settle` gains token-id arg; debits the matching ledger only.
3. exec-a amount must equal the escrowed token amount — gate next to payTo
   pin in onResult.
4. Float: v1 = operator-top (document the address, monitor), v2 = defuse
   intent per-top-up with solver fill to the derived payer.
5. Refund: ft_transfer back to user; escrow cannot leak (owner-only
   settle-or-refund unchanged).

## Open items

- Which USDC? Solana USDC ≠ NEAR USDC (bridged variants: CCTP vs Wormhole).
  Merchant's payTo token decides the Solana-side asset; the NEAR-side
  deposit asset should be the bridged twin of it (same canonical mint) to
  avoid an oracle. If the merchant token has no NEAR-side nep141 twin, a
  swap is unavoidable → defuse TokenDiff/solver swap on deposit (accept).
- Derived-payer float accounting: kernel must track payer balance vs
  outstanding obligations — reject callApi if float < amount.
