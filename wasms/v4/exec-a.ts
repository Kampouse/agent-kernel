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

// base58 → big-endian hex of the bignum value; leading '1' chars = leading zero bytes,
// restored as 00-prefix here (base58 zero-padding convention)
function b58LeHex(s: string): string {
  let dec = "0";
  let zeros = 0;
  let k = 0;
  while (k < strLength(s)) {
    const ch = strSlice(s, k, k + 1);
    if (k == zeros && ch == "1") { zeros = zeros + 1; }
    let val = -1;
    let t = 0;
    while (t < 58) {
      if (strSlice(ALPHABET, t, t + 1) == ch) { val = t; }
      t = t + 1;
    }
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
  if (strSlice(url, 0, 8) != "https://") {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "https only", Q, "}");
  }
  if (strLength(payer58) != 44) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "bad payer", Q, "}");
  }

  // 1. fetch the merchant endpoint via relay (GET)
  const req = strCat("{", Q, "url", Q, ":", Q, url, Q, "}");
  const resp = httpPost(RELAY, req, "application/json");
  const status = extractNum(resp, "status");
  const body = relayBody(resp);

  // 2. challenge: x402 v2 body, accepts[0] carries payTo + amount (number or string)
  let payTo = "";
  let amount = "";
  if (status == "402") {
    payTo = extractStr(body, "payTo");
    amount = extractNum(body, "amount");
    if (strLength(amount) == 0) { amount = extractStr(body, "amount"); }
  }
  if (strLength(payTo) != 44) {
    return strCat("{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
      Q, "free", Q, ":true,", Q, "status", Q, ":", Q, status, Q, ",",
      Q, "body", Q, ":", Q, strSlice(body, 0, 200), Q, "}");
  }

  // 3. blockhash
  const bhBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getLatestBlockhash\",\"params\":[{\"commitment\":\"finalized\"}]}");
  const bhResp = httpPost(BH_RPC, bhBody, "application/json");
  const blockhash = extractStr(bhResp, "blockhash");
  if (strLength(blockhash) != 44) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "no blockhash", Q, ",",
      Q, "rpc", Q, ":", Q, strSlice(bhResp, 0, 120), Q, "}");
  }

  // 4. msg = 0x00 || payTo(32) || payer(32) || amount LE(8) || blockhash(32)
  const payToHex = zeroPad(b58LeHex(payTo), 32);
  const payerHex = zeroPad(b58LeHex(payer58), 32);
  const bhHex = zeroPad(b58LeHex(blockhash), 32);
  const amtHex = u64LeHex(amount);
  if (strLength(payToHex) != 64 || strLength(payerHex) != 64 || strLength(bhHex) != 64) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "b58 decode failed", Q, "}");
  }
  const msgHex = strCat("00", payToHex, payerHex, amtHex, bhHex);
  return strCat("{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
    Q, "free", Q, ":false,", Q, "payTo", Q, ":", Q, payTo, Q, ",",
    Q, "amount", Q, ":", Q, amount, Q, ",",
    Q, "blockhash", Q, ":", Q, blockhash, Q, ",",
    Q, "msgHex", Q, ":", Q, msgHex, Q, "}");
}
