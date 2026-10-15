#!/usr/bin/env python3
"""k24 final: kernel2 v2.4 auto-settle E2E (mock).

Proven here:
  A. seed → token credit → callApi → quote_phase
  B. resolve quote → onQuote gates (amountIn==budget) → funding legs → exec_a
     (v2.3 gap fix: nothing ever transitioned funding → exec_a)
  C. resolve exec-a (pinned payTo + amount≤budget msgHex) → onResult gates →
     sign_requested (MPC promise to v1.signer-prod)
  D. onExecBDone FAIL leg: broadcasting → failed + FULL token refund, no owner call
  E. settle() owner-recovery still gated (already-settled rejects)

The OK leg (exec-b confirms on-chain sig → refund budget−amount) reuses settle's
v1-matrix-proven debit math; it needs the real MPC lane (mock defers cross-account
.then joins by design) — proven live in the v2.2 chain (tx FdARXQRb…).
"""
import json, subprocess, os, base64, struct, sys

M = os.path.expanduser("~/dev/lisp-rlm/target/release/near-mock")
OL = os.path.expanduser("~/dev/near-outlayer/contract/target/wasm32-unknown-unknown/release/outlayer_contract.wasm")
KW = os.path.expanduser("~/dev/agent-kernel/contracts/kernel2.wasm")
FT = os.path.expanduser("~/dev/lisp-rlm/afp-clmm/port/contracts/escrow/ft/ts/target/ft-ts.wasm")
MPC = "/tmp/fake_mpc.wasm"
ST = os.path.expanduser("~/dev/agent-kernel/tests/tmp/k24_final.bin")
MAN = f"gasbench2.testnet={KW},outlayer.testnet={OL},usdc.testnet={FT},v1.signer-prod.testnet={MPC}"
PAYTO = "2Lq8dHowvuW5hPrsYCRFZmkK47nudzrjRpVx2C7WJXcf"
PAYER = "DhQPaqYLtgbpjreGhrP1jPXvvZ3u8Jz4fQ2NKJExCoDE"
PASS = []

def ok(name, cond):
    PASS.append((name, bool(cond)))
    print(("  ✓ " if cond else "  ✗ ") + name)

def call(contract, method, args, signer="gasbench2.testnet", deposit=None, view=False):
    cmd = [M, "call", ST, MAN, contract, method, json.dumps(args), "--signer", signer, "--json"]
    if deposit: cmd += ["--deposit", str(deposit)]
    if view: cmd += ["--view"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    j = None
    for line in (r.stdout + r.stderr).splitlines():
        if line.startswith("JSON "):
            j = json.loads(line[5:])
    return j or {"outcome": "no-json"}

def resolve(rid, obj):
    args = {"request_id": rid, "response": {"success": True, "output": {"Text": json.dumps(json.dumps(obj, separators=(",", ":")))},
            "error": None, "resources_used": {"instructions": 1000000, "time_ms": 500},
            "compilation_note": None, "refund_usd": None}}
    return call("outlayer.testnet", "resolve_execution", args)

def status(job):
    j = call("gasbench2.testnet", "job", {"jobId": job}, view=True)
    ret = j.get("return")
    return ret.get("status") if isinstance(ret, dict) else "??"

def credit(user="gasbench2.testnet"):
    return call("gasbench2.testnet", "creditToken", {"user": user}, view=True).get("return")

print("── A. seed + credit + callApi")
if os.path.exists(ST): os.remove(ST)
call("outlayer.testnet", "new", {"owner_id": "gasbench2.testnet", "operator_id": "gasbench2.testnet", "event_standard": None, "event_version": None})
call("gasbench2.testnet", "pinPayTo", {"suffix": "pay", "payTo58": PAYTO})
call("usdc.testnet", "register", {"account_id": "gasbench2.testnet"})
call("usdc.testnet", "mint", {"to": "gasbench2.testnet", "amount": "10000000"}, deposit=1250000000000000000000)
r = call("usdc.testnet", "ft_transfer_call", {"receiver_id": "gasbench2.testnet", "amount": "10000000", "msg": "gasbench2.testnet"}, deposit=1)
ok("ft credit leg ok", r["outcome"] == "ok")
ok("token credit = 10000000", str(credit()) == "10000000")
r = call("gasbench2.testnet", "callApi", {"url": "https://x.io", "suffix": "pay", "budget": "1000000", "payer58": PAYER})
job = r.get("return", "")
ok("callApi opened job", len(job) == 64)
ok("status quote_phase", status(job) == "quote_phase")

print("── B. quote resolve → onQuote gates → funding → exec_a")
r = resolve(0, {"ok": True, "jobId": job, "depositAddress": "DEP111111111111111111111111111111111111111",
                "amountIn": "1000000", "minAmountOut": "990000", "deadline": "2027-01-01T00:00:00Z"})
ok("quote resolved clean", r["outcome"] == "ok" and not r.get("entry_trapped"))
ok("amountIn==budget gate passed → exec_a", status(job) == "exec_a")

print("── C. exec-a resolve → onResult pin+budget gates → sign_requested")
alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in PAYTO:
    n = n * 58 + alpha.index(c)
msghex = "0x" + n.to_bytes(32, "big").hex() + "00" * 32 + struct.pack("<Q", 1000000).hex() + "00" * 32
r = resolve(1, {"ok": True, "jobId": job, "msgHex": msghex})
ok("exec-a resolved clean", r["outcome"] == "ok" and not r.get("entry_trapped"))
ok("payTo pin + budget gates passed → sign_requested", status(job) == "sign_requested")

print("── D. onExecBDone auto-settle FAIL leg (no owner, no relay)")
d = subprocess.run([M, "state", "dump", ST], capture_output=True, text=True)
rows = json.loads(d.stdout)
acct = "gasbench2.testnet"
for e in rows:
    if e["account"] == acct and base64.b64decode(e["key"]).startswith(b"job:"):
        jj = json.loads(base64.b64decode(e["value"])); jj["status"] = "broadcasting"
        e["value"] = base64.b64encode(json.dumps(jj).encode()).decode()
SIG58 = (PAYTO * 3)[:88]
rows.append({"account": acct, "key": base64.b64encode(b"jobsig:" + job.encode()).decode(),
             "value": base64.b64encode(SIG58.encode()).decode()})
rows.append({"account": acct, "key": base64.b64encode(b"jobamt:" + job.encode()).decode(),
             "value": base64.b64encode(b"1000000").decode()})
rows.append({"account": acct, "key": base64.b64encode(b"jobmsg:" + job.encode()).decode(),
             "value": base64.b64encode(b"0xdeadbeef").decode()})
tmp = os.path.expanduser("~/dev/agent-kernel/tests/tmp/k24_final_mod.json")
open(tmp, "w").write(json.dumps(rows))
ST2 = os.path.expanduser("~/dev/agent-kernel/tests/tmp/k24_final2.bin")
r = subprocess.run([M, "state", "import", ST2, tmp, "--replace-acct"], capture_output=True, text=True)
ok("state surgery → broadcasting", True)  # verified below
def call2(contract, method, args, view=False):
    cmd = [M, "call", ST2, MAN, contract, method, json.dumps(args), "--signer", "gasbench2.testnet", "--json"]
    if view: cmd += ["--view"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    j = None
    for line in (r.stdout + r.stderr).splitlines():
        if line.startswith("JSON "): j = json.loads(line[5:])
    return j or {"outcome": "no-json"}
j = call2("gasbench2.testnet", "job", {"jobId": job}, view=True)
ok("job in broadcasting", j["return"]["status"] == "broadcasting")
j = call2("gasbench2.testnet", "onExecBDone", {"jobId": job})
ok("onExecBDone ran (outlayer/self lane)", j["outcome"] == "ok" and not j.get("entry_trapped"))
j = call2("gasbench2.testnet", "job", {"jobId": job}, view=True)
ok("auto-settled → failed (exec-b reported failure)", j["return"]["status"] == "failed")
j = call2("gasbench2.testnet", "creditToken", {"user": "gasbench2.testnet"}, view=True)
ok("FULL refund applied without owner (10000000)", str(j.get("return")) == "10000000")

print("── E. settle() recovery gate")
j = call2("gasbench2.testnet", "settle", {"jobId": job, "resultOk": "1"})
ok("settle rejects already-settled job", j.get("entry_trapped") is True or "already settled" in str(j.get("error", "")))

failed = [n for n, c in PASS if not c]
print(f"\n{'ALL GREEN' if not failed else 'FAILED'}: {len(PASS)-len(failed)}/{len(PASS)}")
sys.exit(1 if failed else 0)
