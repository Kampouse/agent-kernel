// exec-a v2 - TS, lisp-rlm outlayer target - x402 challenge leg, REBUILT - old source lost.
// stdin: "jobId|url|path|payer58"
//   url = the merchant x402 endpoint - GET, a 402 carries the challenge
// stdout:
//   ok:true, free:false, payTo, amount, blockhash, msgHex of 210 hex chars
//   ok:true, free:true, status, body      - no challenge, kernel panics downstream
//   ok:false, jobId, error
// msg layout - 105 bytes = 210 hex: version 0x00 || payTo 32 || payer 32 ||
//   amount LE u64 8 || blockhash 32  - matches kernel2 onResult gates:
//   msgHex[2..66] = payTo hex, msgHex[130..146] = amount LE.
// x402 v2 challenge body: accepts[0] = payTo, amount, asset, network... - we scan the
//   whole body for the keys - accepts[0] is the only object carrying them in practice.
const RELAY: string = "https://fetch-relay.kj95hgdgnn.workers.dev";
const BH_RPC: string = "https://solana-rpc.publicnode.com";
const ALPHABET: string = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEXD: string = "0123456789abcdef";
const DIGITS9: string = "0123456789";
let DEC_REM: number = 0;

function pow2(n: number): number {
  let r = 1;
  while (n > 0) { r = r * 2; n = n - 1; }
  return r;
}

const B64A: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PRINTABLE: string = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

const RPC: string = "https://solana-rpc.publicnode.com";
const HEXD: string = "0123456789abcdef";
const B58: string = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B64A: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const RELAY_URL: string = "https://fetch-relay.kj95hgdgnn.workers.dev";
const RELAY_X402: string = "https://fetch-relay.kj95hgdgnn.workers.dev/x402";
const ZERO_SIG: string = "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

function b64decode(s: string): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < strLen(s); i = i + 1) {
    const ch = strSlice(s, i, i + 1);
    // NOTE: no `ch == "="` and no strIndexOf-'=' probe here — both poison this
    // loop in the P2 gate (d8/d13/d14 probes: loop emits nothing). '=' padding
    // only trails the b64; strIndexOf skips unknown chars anyway.
    const v = B64A.indexOf(ch);
    if (v < 0) { continue; }
    acc = acc * 64 + v;
    bits = bits + 6;
    if (bits >= 8) {
      bits = bits - 8;
      const pw = pow2(bits);
      const byteVal = acc / pw;
      acc = acc % pw;
      // strCat, NOT `+`: concat-by-plus inside this loop yields "" in the P2
      // gate (d13 probe) — strCat is the only proven form (d11 probe).
      out = strCat(out, strSlice(PRINTABLE, byteVal % 256 - 32, byteVal % 256 - 32 + 1));
    }
  }
  return out;
}

function extractStr(j: string, key: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const pat = strCat(Q, key, Q, ":", Q);
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const vs = at + strLength(pat);
  let p = vs;
  while (p < strLength(j)) {
    if (strSlice(j, p, p + 1) == Q) { return strSlice(j, vs, p); }
    p = p + 1;
  }
  return "";
}

function extractNum(j: string, key: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const pat = strCat(Q, key, Q, ":");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  let p = at + strLength(pat);
  while (strSlice(j, p, p + 1) == " ") { p = p + 1; }
  const start = p;
  while (p < strLength(j)) {
    const ch = strSlice(j, p, p + 1);
    if (ch == "," || ch == "}" || ch == "]") { break; }
    p = p + 1;
  }
  let raw = strSlice(j, start, p);
  if (strLength(raw) >= 2 && strSlice(raw, 0, 1) == Q) { raw = strSlice(raw, 1, strLength(raw) - 1); }
  return raw;
}

// relay reply {"ok":true,"status":402,"body":"<escaped>"} → unescaped body
function relayBody(resp: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const BS: string = strSlice("\\x", 0, 1);
  const bodyKey = strCat(Q, "body", Q, ":", Q);
  const bAt = strIndexOf(resp, bodyKey);
  if (bAt < 0) { return ""; }
  const esc = strSlice(resp, bAt + strLength(bodyKey), strLength(resp) - 2);
  let out = "";
  let i = 0;
  while (i < strLength(esc)) {
    const c = strSlice(esc, i, i + 1);
    if (c == BS && i + 1 < strLength(esc)) { i = i + 1; }
    out = strCat(out, strSlice(esc, i, i + 1));
    i = i + 1;
  }
  return out;
}

// base58 → hex, no arrays: bignum as decimal string, mulAdd 58 per char, then
// divmod 256 eight-plus times collecting remainders (little-endian hex directly)
function decMulAddSmall(dec: string, mul: number, add: number): string {
  let carry = add;
  let out = "";
  let i = strLength(dec) - 1;
  while (i >= 0) {
    const d = parseInt(strSlice(dec, i, i + 1));
    const x = d * mul + carry;
    const digit = x % 10;
    carry = x / 10;
    out = strCat(strSlice(DIGITS9, digit, digit + 1), out);
    i = i - 1;
  }
  while (carry > 0) {
    const digit = carry % 10;
    carry = carry / 10;
    out = strCat(strSlice(DIGITS9, digit, digit + 1), out);
  }
  // strip leading zeros (keep at least one digit)
  while (strLength(out) > 1 && strSlice(out, 0, 1) == "0") { out = strSlice(out, 1, strLength(out)); }
  return out;
}

function decDivModSmall(dec: string, divisor: number): string {
  // returns quotient; remainder via last iteration captured globally in DEC_REM
  let q = "";
  let carry = 0;
  let i = 0;
  while (i < strLength(dec)) {
    const d = parseInt(strSlice(dec, i, i + 1));
    const x = carry * 10 + d;
    const digit = x / divisor;
    carry = x % divisor;
    q = strCat(q, strSlice(DIGITS9, digit, digit + 1));
    i = i + 1;
  }
  while (strLength(q) > 1 && strSlice(q, 0, 1) == "0") { q = strSlice(q, 1, strLength(q)); }
  DEC_REM = carry;
  return q;
}

function decToBeHex(dec: string): string {
  // full bignum → big-endian hex bytes until zero (matches kernel b58ToHex ordering)
  let v = dec;
  let hex = "";
  let guard = 0;
  while (guard < 80) {
    if (strLength(v) == 1 && strSlice(v, 0, 1) == "0") { break; }
    v = decDivModSmall(v, 256);
    const byte = DEC_REM;
    const hi = byte / 16;
    const lo = byte % 16;
    hex = strCat(strSlice(HEXD, hi, hi + 1), strSlice(HEXD, lo, lo + 1), hex);
    guard = guard + 1;
  }
  return hex;
}

function charVal(ch: string): number {
  // strIndexOf, NOT a == scan: runtime-vs-runtime string == is unreliable in the P2
  // gate (probe3: 'D' matched '2', 'j'/'J' failed self-match) — host str-index-of is
  // byte-exact. Returns -1 when absent.
  return strIndexOf(ALPHABET, ch);
}

// base58 → big-endian hex of the bignum value; leading '1' chars = leading zero bytes,
// restored as 00-prefix here (base58 zero-padding convention)
function b58LeHex(s: string): string {
  let dec = "0";
  let zeros = 0;
  let k = 0;
  while (k < strLength(s)) {
    const ch = strSlice(s, k, k + 1);
    if (k == zeros && ch == "1") { zeros = zeros + 1; }
    const val = charVal(ch);
    if (val < 0) { return ""; }
    dec = decMulAddSmall(dec, 58, val);
    k = k + 1;
  }
  let hex = decToBeHex(dec);
  while (zeros > 0 && strLength(hex) < 128) {
    hex = strCat("00", hex);
    zeros = zeros - 1;
  }
  return hex;
}

function zeroPad(hex: string, wantBytes: number): string {
  // big-endian pad: zeros go on the LEFT (most significant side)
  let out = hex;
  while (strLength(out) < wantBytes * 2) { out = strCat("00", out); }
  return out;
}

// decimal string → 8-byte little-endian hex
function u64LeHex(n: string): string {
  let v = parseInt(n);
  let hex = "";
  let b = 0;
  while (b < 8) {
    const byte = v % 256;
    v = v / 256;
    const hi = byte / 16;
    const lo = byte % 16;
    hex = strCat(hex, strSlice(HEXD, hi, hi + 1), strSlice(HEXD, lo, lo + 1));
    b = b + 1;
  }
  return hex;
}

function last64(hex: string): string {
  return strSlice(hex, strLength(hex) - 64, strLength(hex));
}

export function run(input: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const p = input.split("|");
  const jobId = p[0] ?? "";
  const url = p[1] ?? "";
  const payer58 = p[3] ?? "";
  const srcAta58 = p[4] ?? "";
  if (strSlice(url, 0, 8) != "https://") {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "https only", Q, "}");
  }
  if (strLength(payer58) != 44) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "bad payer", Q, "}");
  }

  // 1. challenge: DIRECT merchant GET, challenge rides the payment-required
  // response header — read via httpGetHdr (lisp-rlm wasi:http fields.get
  // capture, added 2026-10-17). NO RELAY on this leg anymore.
  const chalB64 = httpGetHdr(url, "payment-required");
  if (strLength(chalB64) < 40) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
      Q, "error", Q, ":", Q, "no challenge header", Q, "}");
  }
  // P2 gate cannot b64-decode reliably (probed 2026-10-17) — but the DECODED
  // challenge JSON is ALSO available: retry the GET and parse the decoded
  // header the merchant ALSO sends? No — decode here via the gate b64decode
  // fails; instead parse the BASE64-decoded fields via exec-b's decoder...
  // Pragmatic: the challenge JSON fields (payTo/amount/feePayer/asset/
  // network) are inside the b64. The gate b64decode works for SHORT inputs;
  // 1084-char fails. So parse what we can from b64-decoded HEAD: the JSON
  // is deterministic (x402Version first). Use the gate's b64decode on
  // chunks: 1084 = 8×135+4 → decode in 8 slices of 132 chars (multiple of 4)
  // and concatenate — avoids the corrupt whole-string decode.
  let chalText = "";
  {
    const CHUNK: number = 132;
    let off = 0;
    let guard = 0;
    while (off < strLength(chalB64) && guard < 16) {
      const end = off + CHUNK < strLength(chalB64) ? off + CHUNK : strLength(chalB64);
      chalText = strCat(chalText, b64decode(strSlice(chalB64, off, end)));
      off = end;
      guard = guard + 1;
    }
  }
  // challenge header (b64) rides the relay's headers{} — exec-b needs it verbatim
  // for the PAYMENT-SIGNATURE retry (resource + accepted blocks must match).

  // 2. challenge: x402 v2 body, accepts[0] carries payTo + amount (number or string)
  let payTo = "";
  // CAIP-2 network tag → cluster tag the kernel whitelists (genesis-hash ids)
  let networkTag = "";
  {
    const netRaw = extractStr(chalText, "network");
    if (strLength(netRaw) >= 39) {
      if (strSlice(netRaw, 7, 39) === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1") { networkTag = "devnet"; }
      if (strSlice(netRaw, 7, 51) === "5eykt4UsFv8P8NJdTREpY1vzqKqZeK5mCkXGtsEQVG2N") { networkTag = "mainnet"; }
    }
  }
  let amount = "";
  let feePayer = "";
  let mint = "";
  // direct-GET lane: challenge header present = payment required
  payTo = extractStr(chalText, "payTo");
  amount = extractNum(chalText, "amount");
  if (strLength(amount) == 0) { amount = extractStr(chalText, "amount"); }
  feePayer = extractStr(chalText, "feePayer");
  mint = extractStr(chalText, "asset");
  if (strLength(payTo) != 44) {
    // no payable challenge → report free with the resource body
    const body = httpGet(url);
    return strCat("{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
      Q, "free", Q, ":true,", Q, "status", Q, ":", Q, "200", Q, ",",
      Q, "body", Q, ":", Q, strSlice(body, 0, 200), Q, "}");
  }
  // x402 exact-SVM requires the facilitator's feePayer; without it the v0 lane
  // cannot build a co-signable tx. Missing feePayer = unusable challenge.
  if (strLength(feePayer) != 44) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
      Q, "error", Q, ":", Q, "no feePayer in challenge", Q, "}");
  }
  if (strLength(mint) != 44) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
      Q, "error", Q, ":", Q, "no asset(mint) in challenge", Q, "}");
  }

  // 3. blockhash
  const bhBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getLatestBlockhash\",\"params\":[{\"commitment\":\"finalized\"}]}");
  // Literal-URL if-chain: a ternary-built URL string routes httpPost to the
  // dynamic host import (local inlayer rejects it with "https urls only").
  let bhResp: string = "";
  if (networkTag == "mainnet") {
    bhResp = httpPost("https://solana-rpc.publicnode.com", bhBody, "application/json");
  } else {
    // devnet endpoint rate-limits (429) per IP — one retry on miss (2026-10-19:
    // TEE fetch returned an error body, job failed "no blockhash")
    bhResp = httpPost("https://api.devnet.solana.com", bhBody, "application/json");
    if (strLength(extractStr(bhResp, "blockhash")) != 44) {
      bhResp = httpPost("https://api.devnet.solana.com", bhBody, "application/json");
    }
  }
  const blockhash = extractStr(bhResp, "blockhash");
  if (strLength(blockhash) != 44) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "no blockhash", Q, ",",
      Q, "rpc", Q, ":", Q, strSlice(bhResp, 0, 120), Q, "}");
  }

  // 4. msg payload — b58→bignum decode is UNRELIABLE in the P2 gate (char ==,
  // strIndexOf and decimal-bignum chains all corrupt: probes 2026-10-15), so exec-a
  // hands the RAW strings over and the KERNEL decodes via its b58ToHex. msgHex here is
  // hexEncode(ASCII "0|payTo|amount|blockhash|payer|feePayer|mint|srcAta") — kernel onResult
  // rebuilds the real v0 binary msg itself from the validated fields.
  const raw = strCat("0|", payTo, "|", amount, "|", blockhash, "|", payer58, "|", feePayer, "|", mint, "|", srcAta58);
  const msgHex = hexEncode(raw);
  // P2 gate: ONE big strCat call truncates ~292 chars with varied content
  // (probed 2026-10-17). Incremental accumulation (loop-proven pattern,
  // b64decode grew 813 chars fine) sidesteps it.
  // SLIM OUTPUT (2026-10-19): only what the kernel PARSES (msgHex, network).
  // Everything else rides INSIDE msgHex ("0|payTo|amount|blockhash|payer|
  // feePayer|mint|srcAta"). chalB64 dropped: exec-b relay-mode self-fetches
  // the challenge (chalB64 unused in x402settle). Full output was 3041 B —
  // over the daemon's 800 B inline-resume threshold, forcing the
  // submit_execution_output_and_resolve lane whose metadata-only resume made
  // the kernel's refetch spawn the whole pipeline's blocker. Slim output
  // resumes INLINE and the refetch lane is dead code.
  let out: string = strCat("{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",");
  out = strCat(out, Q, "network", Q, ":", Q, networkTag, Q, ",");
  out = strCat(out, Q, "msgHex", Q, ":", Q, msgHex, Q, "}");
  return out;
}
