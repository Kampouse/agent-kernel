import Base

def zero_le(q: Nat) -> {Nat.is_le(0n, q) == True{} : Bool}:
  match q:
    case 0n:
      {==}
    case 1n+qq:
      {==}

# attempt to hand-fake a proof of a FALSE claim:
def fake() -> {Nat.is_le(7n, 3n) == True{} : Bool}:
  zero_le(3n)
