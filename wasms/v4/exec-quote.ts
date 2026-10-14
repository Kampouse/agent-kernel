// xexec-quote (TS, lisp-rlm P2) — x402 funding stage: 1Click quote for cross-chain
// USDC delivery to the job's derived Solana payer.
// stdin: "jobId|payer58|amountBase"
//   amountBase = smallest units (6 dec USDC) to deliver on Solana
// stdout JSON:
//   {"ok":true,"jobId":"...","depositAddress":"...","depositMemo":"...","amountIn":"...",
//    "minAmountOut":"...","quoteJson":"<escaped>"}
//   {"ok":false,"jobId":"...","error":"..."}
// The kernel gates: amountIn == budget escrowed, then ft_transfer_call to depositAddress.
const RELAY: string = "https://fetch-relay.kj95hgdgnn.workers.dev";
const ONECLICK: string = "https://1click.chaindefuser.com/v0/quote";
const ORIGIN_ASSET: string = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // USDC (mainnet twin — swap for testnet twin at integration)
const DEST_ASSET: string = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"; // Solana USDC
const REFUND_TO: string = "gasbench2.testnet";
const QQ: string = strSlice("\"x", 0, 1); // quote char for scanning

function jsonStrVal(j: string, key: string): string {
  const pat = strCat("\\\"", key, "\\\":");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  let p = at + strLen(pat);
  while (j.charAt(p) === " ") { p = p + 1; }
  if (j.charAt(p) !== "\\\"") { return ""; }
  p = p + 1;
  const start = p;
  while (p < strLen(j)) {
    const ch = j.charAt(p);
    if (ch === "\\\\") { p = p + 2; } else { if (ch === "\\\"") { break; } p = p + 1; }
  }
  return strSlice(j, start, p);
}

function jsonNumStr(j: string, key: string): string {
  const pat = strCat("\\\"", key, "\\\":");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  let p = at + strLen(pat);
  while (j.charAt(p) === " ") { p = p + 1; }
  const start = p;
  while (p < strLen(j)) {
    const ch = j.charAt(p);
    if (ch === "," || ch === "}" || ch === " ") { break; }
    p = p + 1;
  }
  let raw = strSlice(j, start, p);
  if (strLen(raw) >= 2 && raw.charAt(0) === "\\\"") { raw = strSlice(raw, 1, strLen(raw) - 1); }
  return raw;
}

function jsonUnescape(s: string): string {
  let out = "";
  let i = 0;
  while (i < strLen(s)) {
    const ch = s.charAt(i);
    if (ch === "\\\\") {
      const nxt = s.charAt(i + 1);
      if (nxt === "n") { out = strCat(out, "\\n"); i = i + 2; }
      else { if (nxt === "t") { out = strCat(out, "\\t"); i = i + 2; }
        else { out = strCat(out, nxt); i = i + 2; } }
    } else { out = strCat(out, ch); i = i + 1; }
  }
  return out;
}

export function run(input: string): string {
  const p = input.split("|");
  const jobId = p[0] ?? "";
  const payer58 = p[1] ?? "";
  const amountBase = p[2] ?? "";
  if (strLen(payer58) < 32) { return `{\\\"ok\\\":false,\\\"jobId\\\":\\\"${jobId}\\\",\\\"error\\\":\\\"bad payer\\\"}`; }
  if (strLen(amountBase) === 0) { return `{\\\"ok\\\":false,\\\"jobId\\\":\\\"${jobId}\\\",\\\"error\\\":\\\"bad amount\\\"}`; }

  // 1. quote via relay (server-side POST, no CORS issues)
  const deadline: string = "2027-01-01T00:00:00Z";
  const Q: string = strSlice("\"x", 0, 1);
  const BQ: string = strSlice("\\x", 0, 1);
  const body2 = strCat(
    "{", BQ, Q, "dry", BQ, Q, ":false,",
    BQ, Q, "swapType", BQ, Q, ":", BQ, Q, "EXACT_INPUT", BQ, Q, ",",
    BQ, Q, "slippageTolerance", BQ, Q, ":100,",
    BQ, Q, "depositType", BQ, Q, ":", BQ, Q, "ORIGIN_CHAIN", BQ, Q, ",",
    BQ, Q, "originAsset", BQ, Q, ":", BQ, Q, ORIGIN_ASSET, BQ, Q, ",",
    BQ, Q, "destinationAsset", BQ, Q, ":", BQ, Q, DEST_ASSET, BQ, Q, ",",
    BQ, Q, "amount", BQ, Q, ":", BQ, Q, amountBase, BQ, Q, ",",
    BQ, Q, "refundTo", BQ, Q, ":", BQ, Q, REFUND_TO, BQ, Q, ",",
    BQ, Q, "refundType", BQ, Q, ":", BQ, Q, "INTENTS", BQ, Q, ",",
    BQ, Q, "recipient", BQ, Q, ":", BQ, Q, payer58, BQ, Q, ",",
    BQ, Q, "recipientType", BQ, Q, ":", BQ, Q, "DESTINATION_CHAIN", BQ, Q, ",",
    BQ, Q, "deadline", BQ, Q, ":", BQ, Q, deadline, BQ, Q, "}");
  const req = strCat(
    "{", Q, "url", Q, ":", Q, ONECLICK, Q, ",",
    Q, "method", Q, ":", Q, "POST", Q, ",",
    Q, "contentType", Q, ":", Q, "application/json", Q, ",",
    Q, "body", Q, ":", Q, body2, Q, "}");
  const resp = httpPost(RELAY, req, "application/json");
  // resp = {"ok":true,"status":201,"body":"<1Click JSON with raw quotes>"}
  // body is the LAST field: extract everything after "body":" minus the final "}
  const bodyKey = strCat(Q, "body", Q, ":", Q);
  const bAt = strIndexOf(resp, bodyKey);
  if (bAt < 0) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "no body in relay reply", Q, "}");
  }
  const bodyEsc0 = strSlice(resp, bAt + strLen(bodyKey), strLen(resp) - 2);
  // unescape relay JSON-encoding: backslash before any char -> bare char
  const BS: string = strSlice("\\x", 0, 1);
  let bodyRaw: string = "";
  let q: number = 0;
  let c: string = "";
  while (q < strLen(bodyEsc0)) {
    c = strSlice(bodyEsc0, q, q + 1);
    if (c == BS && q + 1 < strLen(bodyEsc0)) {
      q = q + 1;
      c = strSlice(bodyEsc0, q, q + 1);
    }
    bodyRaw = strCat(bodyRaw, c);
    q = q + 1;
  }
  // bodyRaw = real 1Click JSON; extract quote fields by key scan
  const depositAddress = extractStr(bodyRaw, "depositAddress");
  const amountIn = extractStr(bodyRaw, "amountIn");
  const minAmountOut = extractStr(bodyRaw, "minAmountOut");
  const deadlineOut = extractStr(bodyRaw, "deadline");
  if (strLen(depositAddress) < 10 || strLen(amountIn) < 1) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "quote missing fields", Q, ",", Q, "raw", Q, ":", Q, strSlice(bodyRaw, 0, 200), Q, "}");
  }
  const out = strCat(
    "{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
    Q, "depositAddress", Q, ":", Q, depositAddress, Q, ",",
    Q, "amountIn", Q, ":", Q, amountIn, Q, ",",
    Q, "minAmountOut", Q, ":", Q, minAmountOut, Q, ",",
    Q, "deadline", Q, ":", Q, deadlineOut, Q, "}");
  return out;
}

// extract "key":"value" from raw JSON (no escapes expected in these fields)
function extractStr(j: string, key: string): string {
  const QL: string = strSlice("\"x", 0, 1);
  const pat = strCat(QL, key, QL, ":", QL);
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const vs = at + strLen(pat);
  let p = vs;
  while (p < strLen(j)) {
    if (strSlice(j, p, p + 1) == QL) { return strSlice(j, vs, p); }
    p = p + 1;
  }
  return "";
}