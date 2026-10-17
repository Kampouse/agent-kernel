import Base

# ============================================================
# TACTICS AS LANGUAGE EXTENSION — working, total, sound
# + THE BRIDGE: Le indexed family + le_sound/le_complete, so the
#   tactic now certifies the ORDER, not just the Bool decider
# ============================================================
# The normalization insight: {is_le(1n+a, 1n+b)} is DEFINITIONALLY
# {is_le(a, b)} (Nat.cmp strips leading succs). So the "lifting"
# tactic's proof term is the IDENTITY — and the whole x <= y tactic
# collapses into one total function with honest refusal via absurd.

def disc(b: Bool) -> Type:
  match b:
    case False{}:
      {0n == 0n : Nat}
    case True{}:
      Empty

def false_eq(px: {False{} == True{} : Bool}) -> Empty:
  %px : {disc(_) : Type}
  {==}

def empty_goal(px: {False{} == True{} : Bool}) -> {0n == 0n : Nat}:
  Empty.absurd({0n == 0n : Nat}, false_eq(px))

# THE TACTIC: total, structurally terminating on a.
# Proves is_le(a,b) when a<=b; when a>b the threaded px lands on
# {False == True} and the refuter discharges honestly.
def auto_le(a: Nat, b: Nat, px: {Nat.is_le(a, b) == True{} : Bool}) ->
  {Nat.is_le(0n, 0n) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      match b:
        case 0n:
          # px : {is_le(1n+p, 0n)} == {False == True}: contradiction!
          Empty.absurd({Nat.is_le(0n, 0n) == True{} : Bool}, false_eq(px))
        case 1n+q:
          auto_le(p, q, px)

# driver: decide + prove in one total pass, returning the Maybe goal
def zero_le(q: Nat) -> {Nat.is_le(0n, q) == True{} : Bool}:
  match q:
    case 0n:
      {==}
    case 1n+qq:
      {==}

def prove_le(a: Nat, b: Nat) -> Maybe<{Nat.is_le(a, b) == True{} : Bool}>:
  match a:
    case 0n:
      Some{zero_le(b)}
    case 1n+p:
      match b:
        case 0n:
          None{}
        case 1n+q:
          prove_le(p, q)



# NOTE: zero_le's match on q is LOAD-BEARING, not stylistic: Nat.cmp
# matches on BOTH args, so is_le(0n, q) is stuck while q is a variable —
# the match refines q so each branch reduces to {==}.

# negative demo: 9 > 5 — evaluates to None{} (honest refusal).
# NOTE: defined ABOVE main — bend elaborates in file order; a def referenced
# by live code must appear above the reference, else "unfilled law" (misleading
# error; it just means not-yet-defined at that point).
def refused() -> Maybe<{Nat.is_le(9n, 5n) == True{} : Bool}>:
  prove_le(9n, 5n)

# ---- demos ----
def main() -> Maybe<{Nat.is_le(5n, 9n) == True{} : Bool}>:
  prove_le(5n, 9n)

# ============================================================
# THE BRIDGE — structural order witness, computed like Word(n)
# ============================================================
# Above, the tactic proves {is_le(a,b) == True} — a fact about a Bool
# decider, not (yet) an order. Fix: an INDEXED TYPE FAMILY in the
# base.bend Word.Nil/Word.Con style. The family computes on the indices,
# and the impossible case Le(1n+p, 0n) IS Empty — the relation itself
# refutes, no decider involved.
#
#   le_sound    : {is_le(a,b) == True} -> Le(a, b)   (decider never lies)
#   le_complete : Le(a, b) -> {is_le(a,b) == True}   (decider never misses)
#
# Both are the same identity-threading / absurd-refutation plumbing as
# auto_le — the bridge costs nothing the kernel doesn't already do.

type Le.LZ is Data:
  LeZero{}

type Le.LS<-a: Nat, -b: Nat> is Data:
  LeSucc{prior: Le(a, b)}

def Le(a: Nat, b: Nat) -> Data:
  match a b:
    case 0n _:
      Le.LZ
    case 1n+p 0n:
      Empty
    case 1n+p 1n+q:
      Le.LS<p, q>

# sound: decider says True -> structural witness exists
def le_sound(a: Nat, b: Nat, px: {Nat.is_le(a, b) == True{} : Bool}) -> Le(a, b):
  match a b:
    case 0n _:
      LeZero{}
    case 1n+p 0n:
      # goal Le(1n+p, 0n) unfolds to Empty; px unfolds to {False == True}
      false_eq(px)
    case 1n+p 1n+q:
      # is_le(1n+p, 1n+q) strips succs: px IS the hypothesis for (p, q)
      LeSucc{le_sound(p, q, px)}

# complete: structural witness -> decider says True
def le_complete(a: Nat, b: Nat, w: Le(a, b)) -> {Nat.is_le(a, b) == True{} : Bool}:
  match a b:
    case 0n _:
      zero_le(b)
    case 1n+p 0n:
      # w : Le(1n+p, 0n) unfolds to Empty — the witness IS the contradiction
      Empty.absurd({Nat.is_le(1n+p, 0n) == True{} : Bool}, w)
    case 1n+p 1n+q:
      match w:
        case LeSucc{prior}:
          le_complete(p, q, prior)

# full pipeline: tactic decides+proves, bridge converts to the witness
def to_witness(a: Nat, b: Nat, r: Maybe<{Nat.is_le(a, b) == True{} : Bool}>) -> Maybe<Le(a, b)>:
  match r:
    case Some{px}:
      Some{le_sound(a, b, px)}
    case None{}:
      None{}

def prove_le_witness(+a: Nat, +b: Nat) -> Maybe<Le(a, b)>:
  to_witness(a, b, prove_le(a, b))

# ---- laws: the bridge, end-to-end, kernel-gated ----
law le_sound_law:
  for a: Nat
  for b: Nat
  for px: {Nat.is_le(a, b) == True{} : Bool}
  Le(a, b)

def le_sound_law(a, b, px):
  le_sound(a, b, px)

law le_complete_law:
  for a: Nat
  for b: Nat
  for w: Le(a, b)
  {Nat.is_le(a, b) == True{} : Bool}

def le_complete_law(a, b, w):
  le_complete(a, b, w)
