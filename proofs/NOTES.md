# Bend 2 x402 escrow experiment (2026-10-16)

## What works
- Escrow model in /tmp/bend-x402/escrow.bend: settle() with the kernel's
  amount gate (pay exactly claimed if <= budget, else reject). Runs: Pay{7,100}.
- Law stated in LAWS.bend: "outcome_pay(settle(job)) <= budget for all jobs"
  (the amount_inflate scenario as a theorem).
- The checker catches open/false proofs instantly: `{==}` closes computing
  cases; ?TODO prints "1 TODO found" — the gate is real.

## Where it got hard (no tactics)
Proving never_over_budget needs, in the claimed=1n+p, budget=1n+q case:
- IH on (p, q): settle pays <= q
- monotonicity lemmas: is_le(p,q) => is_le(p,1n+q) and amt<=q => amt<=1n+q
Without tactic support each lemma is a manual induction over Nat/U32 word
structures. ~1-2h more to close; every proof step is explicit.

## Ergonomics notes (correct as of bend 2.0.37)
- match can ONLY scrutinize parameters (never computed values or binders)
  -> every case split needs its own def, or quantify the Bool with `where`
- `where`-bound vars are Sigma pairs; no field access; must destructure in
  the proof def via `(a, b) = p` — but the LAW body sees the Sigma, so laws
  can't USE the where-var as its base type (gotcha)
- constructors: positional at call sites Job{a,b,c}; named fields only in
  type decls and patterns; U32 literals need U32.from_nat(n); 0n is Nat
- affine by default: reuse a field requires +binder in the pattern
- nested match arms need colons (base.bend style), top-level too
- match on a later binder while an earlier binder is matched: forbidden
- rewrites: %e : {goal == _ : T} replaces the `_`-marked occurrence of b
  with a — footgun: the motive must normalize EXACTLY like the checker's
  goal (see the p/q vs 1n+q mismatch above)

## Meta-level session 2 (structural form + lemmas)
- Restated the model structurally (step/bump, gate-free): the trivial cases
  of never_over_budget now close with {==} alone (claimed/budget splits).
- Built the contradiction toolkit in-term: disc motive + %px rewrite gives
  contra : {False==True:Bool} -> Empty; Empty.absurd closes any goal.
  This is Bend's "lift a false hypothesis to anything" — works, verified.
- The remaining lemma (is_le x q =True -> is_le x (1n+q)=True) needs the
  induction hypothesis GENERALIZED over x (px depends on x) — the law-form
  `for px: {...} where` pins px at the top, so the IH doesn't rewrap. This
  is the classic "need a generalized induction" wall; fix = prove it as a
  standalone total function returning the implication via Nat recursion
  (double induction), which is mechanical but another session of term-writing.

## Session 4c: payto.bend — the payto/budget laws PROVEN
- payto.bend: NOutcome model (NPay/NReject), nsettle as affine-safe
  recursion (each param consumed once — def params are strictly affine,
  even Pair-dup trick fails; only match-consumption or law +binders).
- 3 laws: n_payee_is_pay_to, n_pay_within_budget, npayee_bump (transport).
- Transport WITHOUT %rewrite (motive syntax kept capturing _ := Bool from
  the ascription): used helper-fn transport instead — payee_bump_ih and
  amt_bump_ih match on o (NOutcome) and return the bumped-form proof
  directly. This is the reusable pattern: CAN'T rewrite? MATCH on the
  structure and re-derive.
- nat_eq_refl: {is_eq(x,x)==True} for symbolic x — induction on x, goal
  normalizes to stripped form (cmp strips leading succs, same insight).
- Negative: prove_le(999n,200n) → None{}; settle(7n,999n,200n) → pays 0
  (gate rejects) so is_le(0,200) is provable — the ATTACK scenario is a
  theorem about the SAFE outcome.
- 5 laws total across x402.bend + payto.bend, all filled, all checking.

- x402.bend now carries the full toolkit (disc/contra/false_eq) + the
  prove_le tactic + 4 tactic-proved instances (inst_honest 100<=200,
  inst_exact 200<=200, inst_zero 0<=999, inst_paid_ok = paid(100,200)<=200).
  Each instance body is ONE prove_le call — no hand proof.
- Driver design decision: a total function INTO a proof type cannot
  refuse, so go_le returns the Maybe unchanged; callers that know the
  goal is true match it to extract the proof. ?TACTIC_EXHAUSTED holes
  are dishonest in that position (they claim a proof exists).
- Verified: bend x402.bend runs (100n) + all proofs check;
  negative tests BOTH refuse: run_evil.bend prove_le(7n,3n) → None{}
  at runtime; fake.bend hand-faked proof → checker rejects
  (expected {False==True}, observed {True==True}).
- Gotcha: Maybe is called Maybe in tactics.bend but the def sigs must
  use the SAME name as Base's (Maybe) — Some/None constructors unchanged.

Working architecture (all files in /tmp/bend-x402/):
- Normalization insight that unlocked everything: {is_le(1n+a,1n+b)} is
  DEFINITIONALLY {is_le(a,b)} (Nat.cmp strips leading succs). So the
  "lifting" tactic's proof term is literally the identity, and prove_le
  recurses by direct self-call with no combinator.
- auto_le(a,b,px): total refuter — when a>b the threaded hypothesis
  lands on {False==True} and false_eq (%px + disc) + Empty.absurd
  discharges it. Negative test: prove_le(7n,3n) returns None{} (honest
  refusal), ALL PROOFS CHECK.
- Key Bend gotchas learned (cost hours, write these into any future
  bend session):
  1. defs must be defined BEFORE use (no forward refs) — a forward ref
     surfaces as "unfilled law" for the CALLEE, hugely misleading.
  2. match binders are AFFINE: a binder consumed twice (e.g. q in
     lift(p,q,prove_le(p,q))) fails "consumed more than once".
  3. Empty.match is `match e:` with NO cases (not `case _:`).
  4. Empty.absurd(GOAL, e) — first arg is the TARGET type.
  5. def params can't take +/- prefixes (only law for-binders can).
  6. Equality proofs {a==b} are not datatypes — cannot match on them;
     refutation goes through the disc/%px rewrite instead.
  7. The checker normalizes types at binder-introduction but a
     function ARG of type {long form} does not auto-coerce to its
     {short normal form} in all positions — passing it to a def whose
     param is the literal normal form DID work (mc.bend).

## Session 5: tactics.bend — THE BRIDGE (is_le == True ⟷ order)
- Fixed the soundness gap: tactic proved `{is_le(a,b)==True}` (a Bool fact),
  not an order. Now bridged via a COMPUTATIONAL INDEXED FAMILY, base.bend's
  Word.Nil/Word.Con pattern:
  `type Le.LZ (LeZero)` + `type Le.LS<a,b> (LeSucc{prior: Le(a,b)})` +
  `def Le(a,b) -> Data` computing on indices — **Le(1n+p, 0n) IS Empty**:
  the relation itself refutes, decider not involved.
- le_sound (decider→witness) & le_complete (witness→decider): same
  identity-threading/absurd plumbing as auto_le — px : {False==True} in the
  impossible case; w : Empty IS the contradiction in complete. + Laws
  le_sound_law / le_complete_law as kernel gates. prove_le_witness: full
  pipeline tactic → eq-proof → witness (needs +a/+b — affine double-use).
- Gotchas hit: family def must return Data (Type rejected in field position,
  Empty is Data so fine); +binder reuse for double consumption; zero_le's
  match on q is LOAD-BEARING (Nat.cmp matches both args → is_le(0n,q) stuck
  on variable q).
- Verified on bend 2.0.37 (arm64): all proofs check; sabotage matrix —
  bogus LeZero in the impossible case → rejected; family lie → rejected;
  prove_le(9n,5n) → None{} runtime; repo matrix re-run: x402/payto check,
  fake.bend correctly FAILS (hand-fake), evil pair → None.
- Quirk RESOLVED: "unfilled law" on main→refused() was FILE ORDER, not laws —
  bend elaborates defs in order; a def referenced by live code must sit ABOVE
  the reference. Moved refused above main: main→refused() now checks AND runs
  (prints None{}). Also: checker refuses a lying main annotation (Maybe<True>
  vs body Maybe<False>) — caught my own test bug, good sign.

## Session 5b: meta.bend — the framework question, verified empirically
- Half 1 (tactic engine as library): REAL. Deep embedding works end-to-end:
  P syntax (PTrue/PLe/PAnd) -> Interp : P -> Type -> generic
  auto(p) -> Maybe<Interp(p)> checks AND runs (Some{({==},{==},Unit{})};
  one false conjunct -> None{}). Computed goal families in generic
  signatures are accepted — the load-bearing capability.
- Half 2 (Meta-F* powers): ABSENT, checker-confirmed. `match A` on a
  Type param: "a - scrutinee matches only in a dead region". No quote,
  no unify API, no elab hooks; templates = closed syntax inlining.
- `bend --verdict` exists (Lean-formalized kernel, bendtt.lean) but needs
  lean v4.34.0 via elan — not installed here; fell back to the standard
  checker with a clean error (no silent trust lie).
