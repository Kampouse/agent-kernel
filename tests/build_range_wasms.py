#!/usr/bin/env python3
"""Regenerate the range wasms from the committed sources.

Why this exists: the current lisp-rlm compiler rejects FORWARD REFERENCES between
non-export functions (function→function calls where the callee is defined later
in the file fail with "unknown function"; a top-level export calling a
later-defined function resolves fine). contracts/kernel2.ts uses forward refs, so
the range build reorders all top-level functions into dependency order (callees
first, topo sort) before compiling. Re-run this whenever kernel2.ts or exec-a.ts
change, or after the compiler forward-ref bug is fixed (then the reorder can go).

Outputs (in tests/wasms/):
  exec-a-range-fixture.wasm  — exec-a with the relay fetch replaced by inline
                               mutated challenges (URL path = scenario id) and
                               the https-only gate disabled (fixture ids are
                               opaque).
  kernel2-range.wasm         — kernel2 with EXEC_A_WASM pinned to the local
                               fixture wasm path + EXEC_A_HASH to its sha256.
"""
import hashlib, re, subprocess, os

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
COMPILE = f"{HOME}/dev/lisp-rlm/target/release/compile"


def reorder_functions(src: str) -> str:
    """Topo-sort top-level `function` defs so callees precede callers."""
    funcs = []
    for m in re.finditer(r'^function (\w+)\(', src, re.M):
        start = m.start(); name = m.group(1)
        brace = src.index("{", start)
        depth = 0; j = brace; in_str = None
        while True:
            c = src[j]
            if in_str:
                if c == "\\": j += 2; continue
                if c == in_str: in_str = None
            elif c in ('"', "'", "`"): in_str = c
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0: break
            j += 1
        funcs.append((name, src[start:j+1], start, j+1))
    for _, _, a, b in sorted(funcs, key=lambda f: -f[2]):
        src = src[:a] + src[b:]
    names = {n for n, _, _, _ in funcs}
    bodies = {n: b for n, b, _, _ in funcs}
    calls = {n: {m for m in names if m != n and re.search(r'\b' + m + r'\(', b)}
             for n, b, _, _ in funcs}
    order, seen = [], set()
    def visit(n, stack=()):
        if n in seen or n in stack: return
        for c in sorted(calls[n]): visit(c, stack + (n,))
        seen.add(n); order.append(n)
    for n in sorted(names): visit(n)
    anchor = src.index("\nexport function ")
    return src[:anchor] + "\n" + "\n\n".join(bodies[n] for n in order) + "\n" + src[anchor:]


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    # ── exec-a-range-fixture ──────────────────────────────────────────────────
    s = open(f"{HOME}/dev/agent-kernel/wasms/v4/exec-a.ts").read()
    fixture = '''  // 1. RANGE FIXTURE: no network — the URL path selects a mutated challenge
  const scen = strSlice(url, strIndexOf(url, "://") + 3, strLength(url));
  const slash = strIndexOf(scen, "/");
  const sid = slash >= 0 ? strSlice(scen, slash + 1, strLength(scen)) : "honest";
  let body = "";
  const PIN: string = "DhQPaqYLtgbpjreGhrP1jPXvvZ3u8Jz4fQ2NKJExCoDE";
  if (sid == "payto_swap") {
    body = strCat("{\\"accepts\\":[{\\"network\\":\\\"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\\",\\"payTo\\":\\"43chANgedPayeeAddrxxxxxxxxxxxxxxxQQQ\\",\\"amount\\":100}]}");
  } else if (sid == "amount_inflate") {
    body = strCat("{\\"accepts\\":[{\\"network\\":\\\"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\\",\\"payTo\\":\\"", PIN, "\\",\\"amount\\":999999}]}");
  } else if (sid == "amount_fractional") {
    body = strCat("{\\"accepts\\":[{\\"network\\":\\\"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\\",\\"payTo\\":\\"", PIN, "\\",\\"amount\\":99}]}");
  } else if (sid == "bad_payer58") {
    body = strCat("{\\"accepts\\":[{\\"network\\":\\\"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\\",\\"payTo\\":\\"not_base58_garbage\\",\\"amount\\":100}]}");
  } else {
    body = strCat("{\\"accepts\\":[{\\"network\\":\\\"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\\",\\"payTo\\":\\"", PIN, "\\",\\"amount\\":100}]}");
  }
  const status = "402";
'''
    old = '''  // 1. fetch the merchant endpoint via relay (GET)
  const req = strCat("{", Q, "url", Q, ":", Q, url, Q, "}");
  const resp = httpPost(RELAY, req, "application/json");
  const status = extractNum(resp, "status");
  const body = relayBody(resp);
'''
    assert old in s, "exec-a relay anchor not found — upstream changed?"
    s = s.replace(old, fixture)
    s = s.replace('if (strSlice(url, 0, 8) != "https://") {', 'if (false) {')
    open(f"{HERE}/wasms/exec-a-range-fixture.ts", "w").write(s)
    r = subprocess.run([COMPILE, f"{HERE}/wasms/exec-a-range-fixture.ts",
                        "-o", f"{HERE}/wasms/exec-a-range-fixture.wasm",
                        "--target", "outlayer-p2"], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[-1] if r.stdout else r.stderr)
    fix_hash = sha256(f"{HERE}/wasms/exec-a-range-fixture.wasm")

    # ── kernel2-range ─────────────────────────────────────────────────────────
    k = open(f"{HOME}/dev/agent-kernel/contracts/kernel2.ts").read()
    k = k.replace(
        'const EXEC_A_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-a.wasm";',
        f'const EXEC_A_WASM: string = "{HERE}/wasms/exec-a-range-fixture.wasm";')
    # exec-b: pin the LOCAL build (GitHub still has the old bare-sig version)
    import hashlib as _h
    eb_hash = _h.sha256(open(f"{HOME}/dev/agent-kernel/wasms/v4/exec-b.wasm", "rb").read()).hexdigest()
    k = k.replace(
        'const EXEC_B_WASM: string = "https://raw.githubusercontent.com/Kampouse/agent-kernel/main/wasms/v4/exec-b.wasm";',
        f'const EXEC_B_WASM: string = "{HOME}/dev/agent-kernel/wasms/v4/exec-b.wasm";')
    k = re.sub(r'const EXEC_B_HASH: string = "[0-9a-f]{64}";',
               f'const EXEC_B_HASH: string = "{eb_hash}";', k)
    k = re.sub(r'const EXEC_A_HASH: string = "[0-9a-f]{64}";',
               f'const EXEC_A_HASH: string = "{fix_hash}";', k)
    assert fix_hash in k, "EXEC_A_HASH pin replace failed"
    k = reorder_functions(k)
    open(f"{HERE}/wasms/kernel2-range.ts", "w").write(k)
    r = subprocess.run([COMPILE, f"{HERE}/wasms/kernel2-range.ts",
                        "-o", f"{HERE}/wasms/kernel2-range.wasm",
                        "--target", "near"], capture_output=True, text=True)
    print((r.stdout.strip().splitlines() or ["?"])[-1] if r.stdout else r.stderr)
    print("kernel2-range sha256:", sha256(f"{HERE}/wasms/kernel2-range.wasm"))


if __name__ == "__main__":
    main()
