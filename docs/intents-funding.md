# Intents-Funded kernel2 — Design Notes

Status: DESIGN v4 — contract-baked funding via 1Click (NEAR Intents' own
cross-chain rail). The kernel swaps its USDC credit for SOL/USDC **on
Solana at the derived payer**, per job or per arm. No operator float.
Not yet implemented. Native NEAR `deposit()` stays live until then.

## The model

```
USER                     KERNEL2 (on-chain, contract-baked)              SOLANA
────                     ────────────────────────────────────            ──────
USDC (nep141) ─────────► credit_token:<user>
                           │ callApi (or arm):
                           │ 1. debit credit
                           │ 2. 1Click quote: USDC.near → USDC@solana
                           │    recipient = DERIVED PAYER (b58)
                           │    refundTo   = kernel2 (INTENTS)
                           │ 3. ft_transfer_call to quote.depositAddress
                           ▼
                         payer funded ◄──── solver/1Click delivers ────
                           │
                           ├─► exec-a (fetch 402 + payer balance check)
                           ├─► MPC sign
                           └─► exec-b pays merchant FROM the payer
```

Everything asked for: the CONTRACT funds the payer, using intents, and the
USDC→SOL conversion happens inside the same rail — 1Click's destination
asset can be Solana USDC or native SOL; market makers compete on the route.
Swaps are what the intents engine IS.

## 1Click is the right primitive (verified against API docs)

- `POST /v0/quote` with `originAsset: nep141:…omft.near`,
  `destinationAsset: nep141:sol-….omft.near` (Solana USDC twin) or native
  SOL, `recipientType: DESTINATION_CHAIN`, `recipient: <derived payer b58>`,
  `refundType: INTENTS`, `refundTo: kernel2`.
- Response: `depositAddress` (quote-specific escrow) + `depositMemo`, and
  the quote is SIGNED by 1Click (`signature` field).
- Deposit = plain `ft_transfer_call(depositAddress, amount, depositMemo)`.
  The kernel's whole on-chain funding action is ONE promise.
- Delivery, solver coordination, retries, refunds are 1Click-side (async).
  The kernel verifies completion on Solana itself (exec-a reads RPC), not
  via an indexer.
- Refunds land in kernel2's intents balance (`refundTo: kernel2`) —
  recoverable on-chain, no leak.

## Who calls 1Click? (the one genuinely-open piece)

The quote is an HTTPS REST call — the kernel can't do HTTPS; only exec-a in
the TEE can. Options:

a. Front-end fetches quote, kernel verifies + executes. Kernel checks the
   deposit address against a pinned 1Click escrow registry (like payTo) and
   the quote's 1Click signature. Trust: 1Click signature — decent.
b. **Exec-a (TEE) fetches the quote, kernel verifies + executes.** The TEE
   is already in our trust envelope for fetching merchant data; quoting
   1Click adds no new party. Kernel gates: amountIn == budget, recipient ==
   payer, then one ft_transfer_call. ← PREFERRED
c. Relayer holds the API key. Rejected — re-introduces a relayer.

## Flow (shape b)

1. `callApi(url, suffix, budget, payer58)` — unchanged signature.
2. Gate: `credit_token ≥ budget`.
3. Quote phase (exec-a): TEE POSTs /v0/quote (USDC.near → USDC.sol,
   recipient=payer, refundTo=kernel2, amount=budget), yield-resumes
   {depositAddress, depositMemo, amountIn, minAmountOut}.
4. `onQuote`: gates (amountIn == budget, recipient == payer, deposit
   address shape), debit credit, fire
   `ft_transfer_call(depositAddress, budget, memo)`, .then(onFunded).
5. `onFunded` → fire exec-a (fetch phase). Exec-a ALSO checks payer USDC
   balance via Solana RPC; unfunded → status `funding` (retry or refund:
   1Click refunds to kernel2's intents balance → kernel re-credits user).
6. Funded → gates → MPC sign → exec-b pays → settle (unchanged).

**Arming = the same primitive with a bigger amount.** Top the payer up once
(per user-path), jobs draw it down. Per-job and arm are one code path — no
separate "float management" logic.

## Trust ledger (v4, final)

- Escrow/gates/settle: kernel2 promise chain (unchanged).
- Payment signing: MPC (unchanged).
- Cross-chain movement + USDC→SOL swap: 1Click solvers/market makers
  (accepted; the only bridge; quotes signed by 1Click).
- Funding verification: exec-a reads Solana RPC (no indexer).
- Quote discovery: the TEE (already trusted for merchant fetches).
- Operator float: eliminated. Watchers/indexers/custom relayers: none.

## Open items

- Destination assets: Solana USDC twin (`nep141:sol-5ce3…omft.near`) for
  the payment + a small native-SOL quote for gas/rent, or one quote if the
  merchant asset covers it.
- ATA rent for the payer's USDC account: solver-side creation on first
  fill, or pre-fund via tiny SOL quote.
- Gas: quote phase is exec gas (150, unchanged); the ft_transfer_call
  attach is a small literal (~10 Tgas) — fits if CB_RESULT 145→135.
- slippageTolerance: kernel stores `minAmountOut` from the quote and
  accounts the delta at settle.
- 1Click API key: per-developer key rides in the TEE quote call (not
  secret-sensitive; verify public rate limits).
