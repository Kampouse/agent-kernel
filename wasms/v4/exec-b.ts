// xexec-b v5 (TS, lisp-rlm outlayer target) — broadcast + CONFIRM.
// stdin: "jobId|sig58|msgHex"
// stdout: {"ok":true,"jobId":"...","sig58":"...","slot":"..."} | {"ok":false,...,"error":"..."}
const RPC: string = "https://solana-rpc.publicnode.com";

// base58 → hex (up to 64 bytes; digits preallocated — surface arrays never grow)

// hex (lowercase) → base58. Digits array PREALLOCATED (TS surface never grows
// arrays past their literal — index assignment past the end silently no-ops).
const HEXD: string = "0123456789abcdef";
const B58: string = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";


export function run(input: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const p = input.split("|");
  const jobId = p[0] ?? "";
  const sig58 = p[1] ?? "";
  const msgHex = p[2] ?? "";
  const cluster = p[3] ?? "mainnet";
  if (strLen(sig58) < 80) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "bad sig", Q, "}");
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
  let rpc = "";
  if (cluster === "devnet") { rpc = "https://api.devnet.solana.com"; }
  if (cluster !== "devnet") { rpc = "https://solana-rpc.publicnode.com"; }
  const sendResp: string = httpPost(rpc, sendBody, "application/json");
  const sendErr = extractStr(sendResp, "message");
  if (strLen(sendErr) > 0) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, strCat("send: ", sendErr), Q, ",", Q, "tx58", Q, ":", Q, tx58, Q, "}");
  }

  // 2. poll confirmation (the sig IS the tx id)
  let slot: string = "";
  let tries = 0;
  while (tries < 10) {
    const pollBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignatureStatuses\",\"params\":[[\"", sig58, "\"],{\"searchTransactionHistory\":false}]}");
    const pollResp: string = httpPost(rpc, pollBody, "application/json");
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
