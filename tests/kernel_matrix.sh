#!/bin/bash
# Full kernel state-machine mock matrix — run from repo root.
# NOT in-memory: near-mock single-call mode persists to /tmp/near-mock-state.bin
# (NEAR_MOCK_STATE default) — GLOBAL across dirs. rm it or results are stale.
set -e
cd "$(dirname "$0")/.."
W=contracts/kernel.wasm
M=${M:-~/dev/lisp-rlm/target/release/near-mock}
export NEAR_MOCK_CONTRACT=gasbench2.testnet
rm -f /tmp/near-mock-state.bin

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }
jget() { python3 -c "import sys,json; l=[x for x in sys.stdin if x.startswith('JSON ')][0]; d=json.loads(l[5:]); print(d.get('$1',''))"; }

echo "== kernel state machine =="
DEP=$($M $W deposit '{}' --signer gasbench2.testnet --deposit 1000000000000000000000000 --json | jget return)
[ "$DEP" = "1000000000000000000000000" ] && pass "deposit 1.0 N" || fail "deposit: $DEP"

JOB=$($M $W callApi '{"url":"https://x.io","suffix":"main","budget":"100000000000000000000000"}' --signer gasbench2.testnet --json | jget return)
[ ${#JOB} -eq 64 ] && pass "callApi → jobId (64 hex)" || fail "callApi: $JOB"

C=$($M $W credit '{}' --signer gasbench2.testnet --view --json | jget return)
[ "$C" = "900000000000000000000000" ] && pass "budget held (credit 0.9)" || fail "credit: $C"

$M $W jobPay "{\"jobId\":\"$JOB\",\"msgHex\":\"aabb\"}" --signer gasbench2.testnet --json | grep -q '"outcome":"ok"' && pass "jobPay (outlayer lane)" || fail "jobPay"

$M $W jobPay "{\"jobId\":\"$JOB\",\"msgHex\":\"aabb\"}" --signer mallory.testnet --json | grep -q 'trap' && pass "jobPay rejects non-outlayer" || fail "jobPay gate"

$M $W onSignDone "{\"jobId\":\"$JOB\"}" --signer gasbench2.testnet --json | grep -q '"outcome":"ok"' && pass "onSignDone" || fail "onSignDone"

$M $W onBroadcast "{\"jobId\":\"$JOB\",\"landed\":\"1\",\"sig58\":\"3Abc\"}" --signer gasbench2.testnet --json | grep -q '"outcome":"ok"' && pass "onBroadcast (landed)" || fail "onBroadcast"

$M $W settleJob "{\"jobId\":\"$JOB\",\"actualCost\":\"10000000000000000000000\",\"resultOk\":\"1\"}" --signer gasbench2.testnet --json | grep -q '"outcome":"ok"' && pass "settle (0.01 actual)" || fail "settle"

C=$($M $W credit '{}' --signer gasbench2.testnet --view --json | jget return)
[ "$C" = "990000000000000000000000" ] && pass "refund exact (credit 0.99)" || fail "credit: $C"

$M $W settleJob "{\"jobId\":\"$JOB\",\"actualCost\":\"1\",\"resultOk\":true}" --signer gasbench2.testnet --json | grep -q 'trap' && pass "double-settle traps" || fail "double-settle"

$M $W jobPay '{"jobId":"deadbeef","msgHex":"aa"}' --signer gasbench2.testnet --json | grep -q 'trap' && pass "unknown job traps" || fail "unknown job"

$M $W deposit '{}' --signer gasbench2.testnet --json | grep -q 'trap' && pass "deposit without attach traps" || fail "zero-deposit guard"

$M $W callApi '{"url":"https://x.io","suffix":"main","budget":"2000000000000000000000000"}' --signer gasbench2.testnet --json | grep -q 'trap' && pass "over-budget callApi traps" || fail "over-budget"

# failed path: refund whole budget
JOB2=$($M $W callApi '{"url":"https://x.io","suffix":"main","budget":"50000000000000000000000"}' --signer gasbench2.testnet --json | jget return)
$M $W jobPay "{\"jobId\":\"$JOB2\",\"msgHex\":\"aa\"}" --signer gasbench2.testnet --json > /dev/null
$M $W onSignDone "{\"jobId\":\"$JOB2\"}" --signer gasbench2.testnet --json > /dev/null
$M $W onBroadcast "{\"jobId\":\"$JOB2\",\"landed\":\"0\",\"sig58\":\"\"}" --signer gasbench2.testnet --json | grep -q '"outcome":"ok"' && pass "onBroadcast (failed → refund)" || fail "failed broadcast"
C=$($M $W credit '{}' --signer gasbench2.testnet --view --json | jget return)
[ "$C" = "990000000000000000000000" ] && pass "failed job refunds full budget" || fail "refund: $C"

rm -f /tmp/near-mock-state.bin
echo "ALL GREEN"
