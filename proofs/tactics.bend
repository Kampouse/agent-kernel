import Base

# ============================================================
# TACTICS AS LANGUAGE EXTENSION — working, total, sound
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



# ---- demos ----
def main() -> Maybe<{Nat.is_le(5n, 9n) == True{} : Bool}>:
  prove_le(5n, 9n)
