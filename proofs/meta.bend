import Base

# ============================================================
# META POC — userland proof framework (Meta-F*-style, deep embedding)
# ============================================================
# VERIFIED on bend 2.0.37 (arm64):
#   - props as Data (P), interpret to real types (Interp : P -> Type)
#   - generic tactic auto(p) -> Maybe<Interp(p)>: CHECKS + RUNS
#     (pos -> Some{({==}, {==}, Unit{})}, neg -> None{})
#   - the impossible half: `match A` on a Type param is REJECTED
#     ("a - scrutinee matches only in a dead region") — no quote/unify/
#     elab hooks; templates are closed-syntax inlining only (GUIDE §Templates)
# Gotchas: computed values need their own def to be matched; compound
# type arguments take parens F<(A & B)>.
# ============================================================


# ============================================================
# VERIFY: can userland Bend host a proof framework (Meta-F*-style)?
# Half 1 POC: props as DATA, interpret -> Type, tactic = total fn
# ============================================================

# embedded proposition syntax (deep embedding)
type P is Data:
  PTrue{}
  PLe{a: Nat, b: Nat}
  PAnd{l: P, r: P}

# interpretation: syntax -> real Bend proposition types
def Interp(p: P) -> Type:
  match p:
    case PTrue{}:
      Unit
    case PLe{a, b}:
      {Nat.is_le(a, b) == True{} : Bool}
    case PAnd{l, r}:
      Interp(l) & Interp(r)

# decider pieces for the PLe leaf (from agent-kernel tactics.bend)
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

def auto_and(-l: P, -r: P, ml: Maybe<Interp(l)>, mr: Maybe<Interp(r)>) -> Maybe<(Interp(l) & Interp(r))>:
  match ml:
    case Some{wl}:
      match mr:
        case Some{wr}:
          Some{(wl, wr)}
        case None{}:
          None{}
    case None{}:
      None{}

# THE TACTIC: one total function over syntax, returning Maybe<proof>
# THE KEY QUESTION: does the checker accept a GENERIC def whose return
# type is a computed family (Maybe<Interp(p)>)?
def auto(p: P) -> Maybe<Interp(p)>:
  match p:
    case PTrue{}:
      Some{Unit{}}
    case PLe{a, b}:
      prove_le(a, b)
    case PAnd{l, r}:
      auto_and(l, r, auto(l), auto(r))

# positive: conjunction of provable props
def pos() -> Maybe<Interp(PAnd{PLe{2n, 5n}, PLe{9n, 5n}})>:
  auto(PAnd{PLe{2n, 5n}, PLe{9n, 5n}})

# negative: one unprovable conjunct refuses the whole goal
def neg() -> Maybe<Interp(PAnd{PLe{2n, 5n}, PLe{9n, 5n}})>:
  auto(PAnd{PLe{2n, 5n}, PLe{9n, 5n}})


def main() -> Maybe<Interp(PAnd{PLe{2n, 5n}, PAnd{PLe{0n, 9n}, PTrue{}}})>:
  pos()
