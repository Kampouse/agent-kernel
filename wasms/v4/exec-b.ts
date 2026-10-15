// xexec-b v5 (TS, lisp-rlm outlayer target) — broadcast + CONFIRM.
// stdin: "jobId|sig58|msgHex"
// stdout: {"ok":true,"jobId":"...","sig58":"...","slot":"..."} | {"ok":false,...,"error":"..."}
const RPC: string = "https://solana-rpc.publicnode.com";

export function run(input: string): string {
  const Q: string = strSlice("\"x", 0, 1);
  const p = input.split("|");
  const jobId = p[0] ?? "";
  const sig58 = p[1] ?? "";
  if (strLen(sig58) < 80) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, "bad sig", Q, "}");
  }

  // 1. broadcast
  const sendBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sendTransaction\",\"params\":[\"", sig58, "\",{\"encoding\":\"base58\",\"skipPreflight\":false}]}");
  const sendResp: string = httpPost("https://solana-rpc.publicnode.com", sendBody, "application/json");
  const sendErr = extractStr(sendResp, "message");
  if (strLen(sendErr) > 0) {
    return strCat("{", Q, "ok", Q, ":false,", Q, "jobId", Q, ":", Q, jobId, Q, ",", Q, "error", Q, ":", Q, strCat("send: ", sendErr), Q, "}");
  }

  // 2. poll confirmation (the sig IS the tx id)
  let slot: string = "";
  let tries = 0;
  while (tries < 10) {
    const pollBody = strCat("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignatureStatuses\",\"params\":[[\"", sig58, "\"],{\"searchTransactionHistory\":false}]}");
    const pollResp: string = httpPost("https://solana-rpc.publicnode.com", pollBody, "application/json");
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
