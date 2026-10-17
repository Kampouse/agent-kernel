import Base

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

# FALSE claim: tactic must return None, never a proof
def main() -> Maybe<{Nat.is_le(7n, 3n) == True{} : Bool}>:
  prove_le(7n, 3n)
