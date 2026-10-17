import Base

type NOutcome is Data:
  NPay{to: Nat, amt: Nat}
  NReject{}

def nbump(o: NOutcome) -> NOutcome:
  match o:
    case NPay{to, amt}:
      NPay{to, 1n+amt}
    case NReject{}:
      NReject{}

def nsettle(pay_to: Nat, claimed: Nat, budget: Nat) -> NOutcome:
  match claimed:
    case 0n:
      NPay{pay_to, 0n}
    case 1n+p:
      match budget:
        case 0n:
          NReject{}
        case 1n+q:
          nbump(nsettle(pay_to, p, q))

def npay_amt(o: NOutcome) -> Nat:
  match o:
    case NPay{to, amt}:
      amt
    case NReject{}:
      0n

def nzero_le(q: Nat) -> {Nat.is_le(0n, q) == True{} : Bool}:
  match q:
    case 0n:
      {==}
    case 1n+qq:
      {==}

def prove_le(a: Nat, b: Nat) -> Maybe<{Nat.is_le(a, b) == True{} : Bool}>:
  match a:
    case 0n:
      Some{nzero_le(b)}
    case 1n+p:
      match b:
        case 0n:
          None{}
        case 1n+q:
          prove_le(p, q)

# gate safety: settle(7n, 999n, 200n) REJECTS so pays 0 <= 200 (true!):
def gate_safe() -> Maybe<{Nat.is_le(npay_amt(nsettle(7n, 999n, 200n)), 200n) == True{} : Bool}>:
  prove_le(npay_amt(nsettle(7n, 999n, 200n)), 200n)

# FALSE claim: 999 <= 200 — must be None:
def main() -> Maybe<{Nat.is_le(999n, 200n) == True{} : Bool}>:
  prove_le(999n, 200n)
