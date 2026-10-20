// xexec-b v6 (TS, lisp-rlm outlayer target) — x402 settlement lane + broadcast.
// stdin (x402): "jobId|sig58|msgHex|cluster|resourceUrl|chalB64"
// stdin (broadcast): "jobId|sig58|msgHex|cluster"
// x402: assemble partial v0 wire (zeroSig + ourSig + 0x80 + msg), b64 it, inject
// into the challenge, POST via relay with PAYMENT-SIGNATURE. The merchant's
// facilitator co-signs as fee payer and settles; the risk JSON is the job result.
// NO broadcast in this lane — the client never submits; that's the facilitator's job.
// stdout: {"ok":true,"jobId":"...","sig58":"...","slot":"..."} | {"ok":false,...,"error":"..."}
const RPC: string = "https://solana-rpc.publicnode.com";

// base58 → hex (up to 64 bytes; digits preallocated — surface arrays never grow)

// hex (lowercase) → base58. Digits array PREALLOCATED (TS surface never grows
// arrays past their literal — index assignment past the end silently no-ops).
const HEXD: string = "0123456789abcdef";
const B58: string = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B64A: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PRINTABLE: string = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const RELAY_URL: string = "https://fetch-relay.kj95hgdgnn.workers.dev";
const RELAY_X402: string = "https://fetch-relay.kj95hgdgnn.workers.dev/x402";
const X402_RESOURCE_URL: string = "https://svalin-api.noobshole.workers.dev/v1/risk/chercher.near";


export function run(input: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const p = input.split("|");
  const jobId = p[0] ?? "";
  const sig58 = p[1] ?? "";
  const msgHex = p[2] ?? "";
  const cluster = p[3] ?? "mainnet";
  const resourceUrl = p[4] ?? "";
  const chalB64 = p[5] ?? "";
  if (strLen(resourceUrl) > 0) {
    return x402settle(Q, jobId, sig58, msgHex, resourceUrl, chalB64);
  }
  if (strLen(sig58) < 80) {
    return errOut(Q, jobId, "settle: empty merchant response");
  }
  if (strLen(msgHex) < 190) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "bad msg", Q, "}");
  }

  // 1. assemble the REAL tx wire: vec1(sig) || message  →  0x01 + sig64 + msg
  //    sig58 arrives b58-encoded; decode to hex, then re-encode the full tx.
  // INLINE b58ToHex (P2 codegen bug: local arrays inside non-exported
  // helper functions read back nil — bignum only works inline in run())
  const sIn: string = sig58;
  const digitsA: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let dlenA = 1;
  for (let i = 0; i < strLen(sIn); i = i + 1) {
    const v = B58.indexOf(sIn.charAt(i));
    let carry = v;
    for (let j = 0; j < dlenA; j = j + 1) {
      const x = digitsA[j] * 58 + carry;
      digitsA[j] = x % 256;
      carry = x / 256;
    }
    while (carry > 0) {
      digitsA[dlenA] = carry % 256;
      dlenA = dlenA + 1;
      carry = carry / 256;
    }
  }
  let hex = "";
  let hi = 64;
  while (hi > 0) {
    hi = hi - 1;
    let b = 0;
    if (hi < dlenA) { b = digitsA[hi]; }
    hex = hex + HEXD.charAt(b / 16) + HEXD.charAt(b % 16);
  }
  const sigHex: string = hex;
  if (strLen(sigHex) !== 128) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "sig not 64B", Q, "}");
  }
  const txHex: string = strCat("01", sigHex, msgHex);
  // INLINE hexToB58 (same P2 helper-array bug)
  const nDec: number = strLen(txHex) / 2;
  const bytesB: number[] = [0];
  for (let i = 0; i < nDec; i = i + 1) {
    const hb = HEXD.indexOf(strSlice(txHex, i * 2, i * 2 + 1));
    const lb = HEXD.indexOf(strSlice(txHex, i * 2 + 1, i * 2 + 2));
    if (i === 0) { bytesB[0] = hb * 16 + lb; } else { bytesB.push(hb * 16 + lb); }
  }
  const digitsB: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let dlenB = 1;
  for (let i = 0; i < nDec; i = i + 1) {
    let carry = bytesB[i];
    for (let j = 0; j < dlenB; j = j + 1) {
      const x = digitsB[j] * 256 + carry;
      digitsB[j] = x % 58;
      carry = x / 58;
    }
    while (carry > 0) { digitsB[dlenB] = carry % 58; dlenB = dlenB + 1; carry = carry / 58; }
  }
  let pad = 0;
  while (pad < nDec && bytesB[pad] === 0) { pad = pad + 1; }
  let out = "";
  for (let z = 0; z < pad; z = z + 1) { out = out + "1"; }
  for (let i = dlenB - 1; i >= 0; i = i - 1) { out = out + strSlice(B58, digitsB[i], digitsB[i] + 1); }
  const tx58: string = out;
  if (strLen(tx58) < 100) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "tx encode failed", Q, "}");
  }

  // 2. broadcast
  const sendBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sendTransaction\",\"params\":[\"", tx58, "\",{\"encoding\":\"base58\",\"skipPreflight\":false}]}");
  let sendResp: string = "";
  if (cluster === "devnet") {
    sendResp = httpPost("https://api.devnet.solana.com", sendBody, "application/json");
  } else {
    sendResp = httpPost("https://solana-rpc.publicnode.com", sendBody, "application/json");
  }
  const sendErr = extractStr(sendResp, "message");
  if (strLen(sendErr) > 0) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, strCat("send: ", sendErr), Q, ",", Q, "tx58", Q, ":", Q, tx58, Q, "}");
  }

  // 2. poll confirmation (the sig IS the tx id)
  let slot: string = "";
  let tries = 0;
  while (tries < 10) {
    const pollBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignatureStatuses\",\"params\":[[\"", sig58, "\"],{\"searchTransactionHistory\":false}]}");
    let pollResp: string = "";
    if (cluster === "devnet") {
      pollResp = httpPost("https://api.devnet.solana.com", pollBody, "application/json");
    } else {
      pollResp = httpPost("https://solana-rpc.publicnode.com", pollBody, "application/json");
    }
    slot = extractNum(pollResp, "slot");
    const confirmations = extractNum(pollResp, "confirmations");
    const errStr = extractStr(pollResp, "err");
    if (strLen(errStr) > 2 && errStr != "null") {
      return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, strCat("tx failed onchain: ", errStr), Q, "}");
    }
    if (strLen(confirmations) > 0) {
      return strCat("{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "sig58", Q, ":", Q, sig58, Q, ",", Q, "slot", Q, ":", Q, slot, Q, "}");
    }
    tries = tries + 1;
  }
  return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "timeout waiting confirmation", Q, ",", Q, "sig58", Q, ":", Q, sig58, Q, "}");
}

function extractStr(j: string, key: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const pat = strCat(Q, key, Q, ":", Q);
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const vs = at + strLen(pat);
  let p = vs;
  while (p < strLen(j)) {
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
  let p = at + strLen(pat);
  const start = p;
  while (p < strLen(j)) {
    const ch = strSlice(j, p, p + 1);
    if (ch == "," || ch == "}") { break; }
    p = p + 1;
  }
  const raw = strSlice(j, start, p);
  if (raw == " null" || raw == "null" || strLen(raw) == 0) { return ""; }
  let out = "";
  let i = 0;
  while (i < strLen(raw)) {
    const ch = strSlice(raw, i, i + 1);
    if (ch == "0" || ch == "1" || ch == "2" || ch == "3" || ch == "4" || ch == "5" || ch == "6" || ch == "7" || ch == "8" || ch == "9") {
      out = strCat(out, ch);
    }
    i = i + 1;
  }
  return out;
}

// ── x402 exact-SVM settlement (v6) ────────────────────────────────────────────
const ZERO_SIG: string = "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

function x402settle(Q: string, jobId: string, sig58: string, msgHex: string,
                    resourceUrl: string, chalB64: string): string {
  // The P2 gate truncates long dynamic strCat loops (varied content cut at 100
  // chars; probed d19/d21), so the wasm does NO b64 of its own: it ships the raw
  // pieces (sig58, msgHex, chalB64) and the relay's /x402 endpoint assembles,
  // base64s, headers and POSTs the payment. Zero-error surface here.
  if (strLen(sig58) < 80) { return errOut(Q, jobId, "bad sig"); }
  if (strLen(msgHex) < 100) { return errOut(Q, jobId, "bad msg"); }
  // chalB64 unused in relay-mode (relay self-fetches the challenge).

  // sig b58 -> 64B hex (inline bignum)
  const digits: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  let dlen = 1;
  for (let i = 0; i < strLen(sig58); i = i + 1) {
    const v = scanIdx(B58, strSlice(sig58, i, i + 1));
    let carry = v;
    for (let j = 0; j < dlen; j = j + 1) {
      const x = digits[j] * 58 + carry;
      digits[j] = x % 256;
      carry = x / 256;
    }
    for (let guard = 0; guard < 90 && carry > 0; guard = guard + 1) {
      digits[dlen] = carry % 256;
      dlen = dlen + 1;
      carry = carry / 256;
    }
  }
  let sigHex = "";
  for (let hi = 64; hi > 0; hi = hi - 1) {
    let b = 0;
    if (hi - 1 < dlen) { b = digits[hi - 1]; }
    sigHex = strCat(sigHex, strSlice(HEXD, b / 16, b / 16 + 1), strSlice(HEXD, b % 16, b % 16 + 1));
  }
  if (strLen(sigHex) !== 128) { return errOut(Q, jobId, "sig not 64B"); }

  // partial v0 wire: cu16(2) + zeroSig + ourSig + version(80) + msg
  // P2 lowering bug: a strCat whose FIRST arg is a short LITERAL and
  // whose later args are runtime strings DROPS the literal ("02" lost
  // -> wire started 0x00, b64 "AAAA..."). Route the literal through a
  // runtime slice so every arg is runtime-tagged.
  const ver2 = strSlice("02", 0, 2);
  const tail = strSlice("80", 0, 2);
  const wireHex = strCat(ver2, ZERO_SIG, sigHex, tail, msgHex);

  // DIRECT settle — no relay (v7c). Both legs plain GETs from inside the
  // wasm (challenge rides svalin's payment-required response header):
  //   leg1: GET resource -> capture payment-required hdr (b64 challenge)
  //   decode -> resource{...} + accepts[0]{...} (brace-matched raw)
  //   leg2: GET resource with PAYMENT-SIGNATURE = b64(payment JSON)
  // P2 codegen notes (both hit live 2026-10-20):
  // - helper-called-from-helper misreads strLen(s) (b64OfStr saw 378 of
  //   1514 chars; same class as the inline-bignum bug) -> both b64
  //   encoders are INLINED here
  // - quotes via DQ (strSlice'd quote char) to avoid escape-soup
  const DQ: string = strSlice("\u0022x", 0, 1);
  // inline hex->b64 of the wire
  let txB64: string = "";
  {
    let bi = 0;
    const bn = strLen(wireHex);
    while (bi + 6 <= bn) {
      const ha = hexPairVal(strSlice(wireHex, bi, bi + 2));
      const hb = hexPairVal(strSlice(wireHex, bi + 2, bi + 4));
      const hc = hexPairVal(strSlice(wireHex, bi + 4, bi + 6));
      txB64 = strCat(txB64,
        strSlice(B64A, ha / 4, ha / 4 + 1),
        strSlice(B64A, (ha % 4) * 16 + hb / 16, (ha % 4) * 16 + hb / 16 + 1),
        strSlice(B64A, (hb % 16) * 4 + hc / 64, (hb % 16) * 4 + hc / 64 + 1),
        strSlice(B64A, hc % 64, hc % 64 + 1));
      bi = bi + 6;
    }
    const rem = bn - bi;
    if (rem == 2) {
      const ha = hexPairVal(strSlice(wireHex, bi, bi + 2));
      txB64 = strCat(txB64, strSlice(B64A, ha / 4, ha / 4 + 1), strSlice(B64A, (ha % 4) * 16, (ha % 4) * 16 + 1), "==");
    }
    if (rem == 4) {
      const ha = hexPairVal(strSlice(wireHex, bi, bi + 2));
      const hb = hexPairVal(strSlice(wireHex, bi + 2, bi + 4));
      txB64 = strCat(txB64,
        strSlice(B64A, ha / 4, ha / 4 + 1),
        strSlice(B64A, (ha % 4) * 16 + hb / 16, (ha % 4) * 16 + hb / 16 + 1),
        strSlice(B64A, (hb % 16) * 4, (hb % 16) * 4 + 1), "=");
    }
  }
  // leg1: fresh challenge from the payment-required response header
  const chal2048 = httpGetHdr("https://svalin-api.noobshole.workers.dev/v1/risk/chercher.near", "payment-required");
  let cn: number = 0;
  let b64 = "";
  while (cn < 2048) {
    const ch = strSlice(chal2048, cn, cn + 1);
    if (strIndexOf("\u0000", ch) == 0) { break; }
    b64 = strCat(b64, ch);
    cn = cn + 1;
  }
  if (strLen(b64) < 20) { return errOut(Q, jobId, "no challenge hdr"); }
  const chal = b64ToStr(b64);
  const resource = extractBraced(chal, "resource");
  const accepted = extractArray0(chal, "accepts");
  if (strLen(resource) < 10 || strLen(accepted) < 10) {
    return errOut(Q, jobId, "challenge missing resource/accepts");
  }
  // payment JSON, chunked
  let payment: string = strCat("{", DQ, "x402Version", DQ, ":2,", DQ, "resource", DQ, ":", resource);
  payment = strCat(payment, ",", DQ, "accepted", DQ, ":", accepted);
  payment = strCat(payment, ",", DQ, "payload", DQ, ":{", DQ, "transaction", DQ, ":", DQ);
  payment = strCat(payment, txB64, DQ, "}}");
  // inline ascii->b64 (the PAYMENT-SIGNATURE header value)
  let payHdr: string = "";
  {
    let ei = 0;
    const en = strLen(payment);
    while (ei + 3 <= en) {
      const v0 = scanIdx(PRINTABLE, payment.charAt(ei));
      const v1 = scanIdx(PRINTABLE, payment.charAt(ei + 1));
      const v2 = scanIdx(PRINTABLE, payment.charAt(ei + 2));
      const ec0 = v0 + 32;
      const ec1 = v1 + 32;
      const ec2 = v2 + 32;
      const q0 = ec0 / 4;
      const q1 = (ec0 - q0 * 4) * 16 + ec1 / 16;
      const q2 = (ec1 - (ec1 / 16) * 16) * 4 + ec2 / 64;
      const q3 = ec2 - (ec2 / 64) * 64;
      payHdr = strCat(payHdr, strSlice(B64A, q0, q0 + 1), strSlice(B64A, q1, q1 + 1), strSlice(B64A, q2, q2 + 1), strSlice(B64A, q3, q3 + 1));
      ei = ei + 3;
    }
  }
  // leg2: settle
  const paid = httpGetWithHeader(resourceUrl, "PAYMENT-SIGNATURE", payHdr);
  if (strLen(paid) > 2) {
    return strCat("{", Q, "ok", Q, ":true,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
      Q, "result", Q, ":", paid, "}");
  }
  return errOut(Q, jobId, "settle: empty merchant response");
}

// base64 -> ASCII (JSON text). 4 chars -> 3 bytes via B64A scan.
function b64ToStr(s: string): string {
  let out = "";
  let i = 0;
  const total = strLen(s);
  while (i + 4 <= total) {
    const c0 = scanIdx(B64A, strSlice(s, i, i + 1));
    const c1 = scanIdx(B64A, strSlice(s, i + 1, i + 2));
    const c2 = scanIdx(B64A, strSlice(s, i + 2, i + 3));
    const c3 = scanIdx(B64A, strSlice(s, i + 3, i + 4));
    const b0 = c0 * 4 + c1 / 16;
    const b1 = (c1 - (c1 / 16) * 16) * 16 + c2 / 4;
    const b2 = (c2 - (c2 / 4) * 4) * 64 + c3;
    out = strCat(out, strSlice(PRINTABLE, b0 - 32, b0 - 31), strSlice(PRINTABLE, b1 - 32, b1 - 31), strSlice(PRINTABLE, b2 - 32, b2 - 31));
    i = i + 4;
  }
  return out;
}

// raw value of "key":{...} with brace-depth matching
function extractBraced(j: string, key: string): string {
  const DQ: string = strSlice("\u0022x", 0, 1);
  const pat = strCat(DQ, key, DQ, ":{");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const start = at + strLen(pat) - 1;
  let depth = 0;
  let p = start;
  while (p < strLen(j)) {
    const ch = strSlice(j, p, p + 1);
    if (ch == "{") { depth = depth + 1; }
    if (ch == "}") {
      depth = depth - 1;
      if (depth == 0) { return strSlice(j, start, p + 1); }
    }
    p = p + 1;
  }
  return "";
}

// raw value of "key":[{...},...] -> first object of the array
function extractArray0(j: string, key: string): string {
  const DQ: string = strSlice("\u0022x", 0, 1);
  const pat = strCat(DQ, key, DQ, ":[{");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const start = at + strLen(pat) - 1;
  let depth = 0;
  let p = start;
  while (p < strLen(j)) {
    const ch = strSlice(j, p, p + 1);
    if (ch == "{") { depth = depth + 1; }
    if (ch == "}") {
      depth = depth - 1;
      if (depth == 0) { return strSlice(j, start, p + 1); }
    }
    p = p + 1;
  }
  return "";
}

function errOut(Q: string, jobId: string, msg: string): string {
  return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",",
    Q, "error", Q, ":", Q, msg, Q, "}");
}

// hex -> base64 (3B -> 4 chars, padded)

// Manual char scan — .indexOf misfires inside some helper contexts
// (returns 0 for any needle). Proven-safe loop form.
function scanIdx(hay: string, ch: string): number {
  for (let k = 0; k < strLen(hay); k = k + 1) {
    if (strIndexOf(ch, strSlice(hay, k, k + 1)) == 0) { return k; }
  }
  return -1;
}


// hex pair (2 chars) -> 0..255 via two 1-char scans (scanIdx is
// single-char only; a 2-char needle never matches).
function hexPairVal(pair: string): number {
  const h = scanIdx(HEXD, strSlice(pair, 0, 1));
  const l = scanIdx(HEXD, strSlice(pair, 1, 2));
  return h * 16 + l;
}

function b64OfHex(hex: string): string {
  let out = "";
  const n = strLen(hex) / 2;
  let i = 0;
  while (i + 3 <= n) {
    const a = hexPairVal(strSlice(hex, i * 2, i * 2 + 2));
    const b = hexPairVal(strSlice(hex, i * 2 + 2, i * 2 + 4));
    const c = hexPairVal(strSlice(hex, i * 2 + 4, i * 2 + 6));
    out = strCat(out,
      strSlice(B64A, a / 4, a / 4 + 1),
      strSlice(B64A, (a % 4) * 16 + b / 16, (a % 4) * 16 + b / 16 + 1),
      strSlice(B64A, (b % 16) * 4 + c / 64, (b % 16) * 4 + c / 64 + 1),
      strSlice(B64A, c % 64, c % 64 + 1));
    i = i + 3;
  }
  return out;
}

// ASCII string -> base64
function b64OfStr(s: string): string {
  let out = "";
  const n = strLen(s);
  let i = 0;
  while (i + 3 <= n) {
    const ch0 = s.charAt(i);
    const ch1 = s.charAt(i + 1);
    const ch2 = s.charAt(i + 2);
    const v0 = scanIdx(PRINTABLE, ch0);
    const v1 = scanIdx(PRINTABLE, ch1);
    const v2 = scanIdx(PRINTABLE, ch2);
    const c0 = v0 + 32;
    const c1 = v1 + 32;
    const c2 = v2 + 32;
    const n0 = c0 / 4;
    const n1 = (c0 - n0 * 4) * 16 + c1 / 16;
    const n2 = (c1 - (c1 / 16) * 16) * 4 + c2 / 64;
    const n3 = c2 - (c2 / 64) * 64;
    out = strCat(out, strSlice(B64A, n0, n0 + 1), strSlice(B64A, n1, n1 + 1),
      strSlice(B64A, n2, n2 + 1), strSlice(B64A, n3, n3 + 1));
    i = i + 3;
  }
  // Remainder via pad-and-trim: spaces are index 0 (code 32). Padding
  // avoids arith-in-guard blocks that poison in this exec (found: the
  // rem==1 block type-broke the whole module).
  const rem = n - i;
  if (rem == 0) { return out; }
  let padded = s;
  let drop = 0;
  if (rem == 1) {
    padded = strCat(s, "  ");
    drop = 2;
  }
  if (rem == 2) {
    padded = strCat(s, " ");
    drop = 1;
  }
  let full = "";
  let j = 0;
  const np = strLen(padded);
  while (j + 3 <= np) {
    const d0 = padded.charAt(j);
    const d1 = padded.charAt(j + 1);
    const d2 = padded.charAt(j + 2);
    const w0 = PRINTABLE.indexOf(d0);
    const w1 = PRINTABLE.indexOf(d1);
    const w2 = PRINTABLE.indexOf(d2);
    const e0 = w0 + 32;
    const e1 = w1 + 32;
    const e2 = w2 + 32;
    const m0 = e0 / 4;
    const m1 = (e0 - m0 * 4) * 16 + e1 / 16;
    const m2 = (e1 - (e1 / 16) * 16) * 4 + e2 / 64;
    const m3 = e2 - (e2 / 64) * 64;
    full = strCat(full, strSlice(B64A, m0, m0 + 1), strSlice(B64A, m1, m1 + 1),
      strSlice(B64A, m2, m2 + 1), strSlice(B64A, m3, m3 + 1));
    j = j + 3;
  }
  return strSlice(full, 0, strLen(full) - drop);
}


// base64 to ASCII (challenge JSON is pure ASCII)
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

function pow2(n: number): number {
  let r = 1;
  while (n > 0) { r = r * 2; n = n - 1; }
  return r;
}

function chrCode(code: number): string {
  // P2 surface has no charCodeAt/chr: look the char up in the printable-ASCII
  // constant (challenge JSON = base64 text = printable only).
  return strSlice(PRINTABLE, code - 32, code - 32 + 1);
}


// balanced-brace object after "key":
function extractObj(json: string, key: string): string {
  const pat = strCat("\"", key, "\":");
  const at = strIndexOf(json, pat);
  if (at < 0) { return ""; }
  const start = at + strLen(pat);
  let depth = 0;
  let p = start;
  while (p < strLen(json)) {
    const ch = strSlice(json, p, p + 1);
    if (ch == "{") { depth = depth + 1; }
    if (ch == "}") {
      depth = depth - 1;
      if (depth == 0) { return strSlice(json, start, p + 1); }
    }
    p = p + 1;
  }
  return "";
}

// JSON string field with escape handling
function extractJsonField(j: string, key: string): string {
  const pat = strCat("\"", key, "\":\"");
  const at = strIndexOf(j, pat);
  if (at < 0) { return ""; }
  const vs = at + strLen(pat);
  let p = vs;
  let esc = false;
  while (p < strLen(j)) {
    const ch = strSlice(j, p, p + 1);
    if (esc) { esc = false; }
    else if (ch == "\\") { esc = true; }
    else if (ch == "\"") { return strSlice(j, vs, p); }
    p = p + 1;
  }
  return "";
}
