#!/bin/bash
# Prove kernel2 v2.3: token credit (ft_on_transfer) → callApi (debit + quote_phase) →
# exec-quote (REAL 1Click quote via relay) → resolve → onQuote (gates + funding leg +
# exec-a leg) → statuses. Then withdrawToken refund path.
set -e
M=~/dev/lisp-rlm/target/release/near-mock
IL=~/dev/near-outlayer/worker/target/release/inlayer
OL=~/dev/near-outlayer/contract/target/wasm32-unknown-unknown/release/outlayer_contract.wasm
KW=~/dev/agent-kernel/contracts/kernel2.wasm
FT=~/dev/lisp-rlm/afp-clmm/port/contracts/escrow/ft/ts/target/ft-ts.wasm
ST=/tmp/soltee/x402-local/k2state23.bin
MAN="gasbench2.testnet=$KW,outlayer.testnet=$OL,usdc.testtoken=$FT"
PAYER=DhQPaqYLtgbpjreGhrP1jPXvvZ3u8Jz4fQ2NKJExCoDE
PAYTO=2Lq8dHowvuW5hPrsYCRFZmkK47nudzrjRpVx2C7WJXcf
RELAY=https://fetch-relay.kj95hgdgnn.workers.dev

say(){ echo "── $1"; }

say "deploy kernel2 + outlayer + fake-FT; init outlayer; pin payTo"
rm -f "$ST"
$M call "$ST" "$MAN" outlayer.testnet new '{"owner_id":"gasbench2.testnet","operator_id":"gasbench2.testnet","event_standard":null,"event_version":null}' --signer gasbench2.testnet --json >/dev/null 2>&1
$M call "$ST" "$MAN" gasbench2.testnet pinPayTo "{\"suffix\":\"pay\",\"payTo58\":\"$PAYTO\"}" --signer gasbench2.testnet --json >/dev/null 2>&1

say "FT init + register kernel2 + mint 10 USDC to gasbench2"
$M call "$ST" "$MAN" usdc.testtoken register "{\"account_id\":\"gasbench2.testnet\"}" --signer gasbench2.testnet --json >/dev/null 2>&1 || true
$M call "$ST" "$MAN" usdc.testtoken mint '{"to":"gasbench2.testnet","amount":"10000000"}' --signer gasbench2.testnet --deposit 1250000000000000000000 --json >/dev/null 2>&1 || true
$M call "$ST" "$MAN" usdc.testtoken ft_balance_of '{"account_id":"gasbench2.testnet"}' --signer gasbench2.testnet --view --json 2>/dev/null | grep '^JSON' | head -c 80; echo

say "credit via ft_transfer_call (10 USDC x 0.01 budget check later; msg = caller)"
$M call "$ST" "$MAN" usdc.testtoken ft_transfer_call "{\"receiver_id\":\"gasbench2.testnet\",\"amount\":\"10000000\",\"msg\":\"gasbench2.testnet\"}" --signer gasbench2.testnet --deposit 1 --json >/dev/null 2>&1
$M call "$ST" "$MAN" gasbench2.testnet creditToken "{\"user\":\"gasbench2.testnet\"}" --signer gasbench2.testnet --view --json 2>/dev/null | grep '^JSON'

say "callApi — budget 1 USDC (1000000); ends quote_phase with outlayer yield OPEN"
OUT=$($M call "$ST" "$MAN" gasbench2.testnet callApi "{\"url\":\"$RELAY\",\"suffix\":\"pay\",\"budget\":\"1000000\",\"payer58\":\"$PAYER\"}" --signer gasbench2.testnet --json 2>/dev/null)
JOB=$(echo "$OUT" | grep '^JSON' | python3 -c "import sys,json; print(json.loads(sys.stdin.read()[5:])['return'])")
echo "jobId: $JOB"
echo "$OUT" | grep -o '"outcome":"[a-z]*"' | head -1
$M call "$ST" "$MAN" gasbench2.testnet job "{\"jobId\":\"$JOB\"}" --signer gasbench2.testnet --view --json 2>/dev/null | grep '^JSON' | grep -o '"status":"[a-z_]*"'

say "driver=TEE: pull quote request input, run exec-quote (REAL 1Click via relay)"
INPUT=$($M state dump "$ST" 2>/dev/null | python3 -c "
import sys, json, base64, re
d = json.load(sys.stdin)
for e in d:
    if e['account']=='outlayer.testnet' and base64.b64decode(e['key']).startswith(b'\x00\x00'):
        v = base64.b64decode(e['value'])
        for s in re.findall(rb'[ -~]{10,}', v):
            if s.count(b'|') == 2: print(s.decode()); break
        break")
echo "quote input: $INPUT"
Q_OUT=$($IL run /tmp/soltee/xexec-ts/xexec-quote.wasm "$INPUT" 2>&1 | grep 📤 | sed 's/📤 Output: //')
echo "$Q_OUT" | head -c 200; echo

say "resolve_execution with the quote output → onQuote gates + fires funding + exec-a"
# outlayer expects the raw output text; unwrap to the inner JSON text
Q_TEXT=$(python3 -c "
import sys
raw = sys.stdin.read()
i = raw.find('{\\\\\"ok\\\\\"')
if i < 0: i = raw.find('{\"ok\"')
print(raw[i:])" <<< "$Q_OUT")
R_OUT=$($M call "$ST" "$MAN" outlayer.testnet resolve_execution "{\"request_id\":0,\"response\":{\"success\":true,\"output\":{\"Text\":\"$(echo "$Q_TEXT" | python3 -c "import sys; print(sys.stdin.read().strip().encode('unicode_escape').decode().replace(chr(34), chr(92)+chr(34)))")\"},\"error\":null,\"resources_used\":{\"instructions\":1000000,\"time_ms\":500},\"compilation_note\":null,\"refund_usd\":null}}" --signer gasbench2.testnet --json 2>&1)
echo "$R_OUT" | grep -o '"outcome":"[a-z]*"' | head -1
echo "$R_OUT" | grep -o 'funding_started\|quote amountIn[^"]*\|no deposit address' | sort -u
say "job state (expect funding) + events"
$M call "$ST" "$MAN" gasbench2.testnet job "{\"jobId\":\"$JOB\"}" --signer gasbench2.testnet --view --json 2>/dev/null | grep '^JSON' | grep -o '"status":"[a-z_]*"'

say "creditToken after debit (expect 9000000)"
$M call "$ST" "$MAN" gasbench2.testnet creditToken "{\"user\":\"gasbench2.testnet\"}" --signer gasbench2.testnet --view --json 2>/dev/null | grep '^JSON'

say "withdrawToken the rest (expect ft_transfer event + balance 0)"
$M call "$ST" "$MAN" gasbench2.testnet withdrawToken "{\"amount\":\"9000000\"}" --signer gasbench2.testnet --json 2>&1 | grep -o '"outcome":"[a-z]*"\|ft_transfer' | head -2
$M call "$ST" "$MAN" gasbench2.testnet creditToken "{\"user\":\"gasbench2.testnet\"}" --signer gasbench2.testnet --view --json 2>/dev/null | grep '^JSON'
