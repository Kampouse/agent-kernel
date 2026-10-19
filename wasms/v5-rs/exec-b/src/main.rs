// exec-b v5 (Rust, OutLayer official pattern: [[bin]] + wasi-http-client)
// stdin: "jobId|sig58|msgHex|cluster|resourceUrl|chalB64"
// flow: wire = 02 | zeroSig64 | sig | 80 | msg -> x402 settle with
// PAYMENT-SIGNATURE header (full size, real wasi:http, NO relay).
use std::io::{self, Read, Write};
use wasi_http_client::{Client, Method};

fn main() {
    let mut input = String::new();
    let _ = io::stdin().read_to_string(&mut input);
    let out = run(input.trim());
    print!("{}", out);
    io::stdout().flush().ok();
}

fn run(input: &str) -> String {
    let parts: Vec<&str> = input.split('|').collect();
    if parts.len() < 6 {
        return err("expected jobId|sig58|msgHex|cluster|resourceUrl|chalB64");
    }
    let job_id = parts[0];
    let sig58 = parts[1];
    let msg_hex = parts[2];
    let _cluster = parts[3];
    let resource_url = parts[4];
    let _chal = parts[5];

    if sig58.len() < 80 {
        return err("sig not 64B");
    }
    if msg_hex.len() < 190 {
        return err("msg too short");
    }
    let sig_bytes = match bs58_decode(sig58) {
        Some(v) if v.len() == 64 => v,
        _ => return err("sig b58 decode"),
    };

    // partial v0 wire: cu16(2) + zeroSig + ourSig + version(80) + msg
    let mut wire: Vec<u8> = Vec::with_capacity(2 + 128 + 1 + msg_hex.len() / 2);
    wire.push(2);
    wire.extend_from_slice(&[0u8; 64]);
    wire.extend_from_slice(&sig_bytes);
    wire.push(0x80); // v0 version byte: wire = cu16|sigs|0x80|msg(350B)
    let mut i = 0;
    while i + 2 <= msg_hex.len() {
        match u8::from_str_radix(&msg_hex[i..i + 2], 16) {
            Ok(b) => wire.push(b),
            Err(_) => return err("bad msg hex"),
        }
        i += 2;
    }

    use base64::Engine;
    let tx_b64 = base64::engine::general_purpose::STANDARD.encode(&wire);

    // fresh challenge (402) — needed for resource + accepted
    let client = Client::new();
    let pre = client
        .get(resource_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .send();
    let pre_resp = match pre {
        Ok(r) => r,
        Err(e) => return err(&format!("challenge: {:?}", e)),
    };
    // x402 v2: challenge rides the payment-required RESPONSE HEADER
    // (b64 JSON). Body is empty {} on 402.
    let hdrs = pre_resp.headers();
    let chal_b64 = hdrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("payment-required"))
        .map(|(_, v)| v.clone());
    let chal_body = match chal_b64 {
        Some(cb) => {
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(cb.trim()) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                Err(_) => cb, // maybe not b64 — use raw
            }
        }
        None => {
            // fallback: body
            let chal_bytes = match pre_resp.body() { Ok(b) => b, Err(e) => return err(&format!("challenge body: {:?}", e)) };
            String::from_utf8_lossy(&chal_bytes).to_string()
        }
    };
    let resource = match json_field(&chal_body, "resource") {
        Some(v) => v,
        None => return err("challenge: no resource"),
    };
    let accepted = match json_accepts0(&chal_body) {
        Some(v) => v,
        None => return err("challenge: no accepts"),
    };

    let payment = format!(
        "{{\"x402Version\":2,\"resource\":{},\"accepted\":{},\"payload\":{{\"transaction\":\"{}\"}}}}",
        resource, accepted, tx_b64
    );
    let pay_b64 = base64::engine::general_purpose::STANDARD.encode(payment.as_bytes());

    // settle — big PAYMENT-SIGNATURE header, no relay
    let resp = client
        .request(Method::Get, resource_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .header("PAYMENT-SIGNATURE", pay_b64.as_bytes())
        .send();
    match resp {
        Ok(r) => {
            let status = r.status();
            // surface svalin's payment-* response headers (error details)
            let mut pay_headers = String::new();
            for (k, v) in r.headers() {
                if k.to_lowercase().starts_with("payment-") {
                    pay_headers.push_str(&format!("\"{}\":\"{}\",", k, v));
                }
            }
            let body_bytes = match r.body() { Ok(b) => b, Err(e) => return err(&format!("body: {:?}", e)) };
            let body = String::from_utf8_lossy(&body_bytes).to_string();
            let pay_b64_short: String = pay_b64.chars().take(60).collect();
            format!("{{\"ok\":true,\"status\":{},\"payhdrs\":{{{}}}\"pay\":\"{}\",\"wire_len\":{},\"body\":{}}}",
                status, pay_headers, pay_b64_short, wire.len(), body)
        }
        Err(e) => err(&format!("settle: {:?}", e)),
    }
}

fn err(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":\"{}\"}}", msg)
}

fn json_field(s: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\":", field);
    let i = s.find(&needle)? + needle.len();
    let rest = &s[i..];
    let start = rest.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    for (j, c) in rest[start..].char_indices() {
        if esc { esc = false; continue; }
        match c {
            '\\' if in_str => esc = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[start..=start + j].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn json_accepts0(s: &str) -> Option<String> {
    let needle = "\"accepts\":[";
    let i = s.find(needle)? + needle.len();
    let rest = &s[i..];
    let start = rest.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    for (j, c) in rest[start..].char_indices() {
        if esc { esc = false; continue; }
        match c {
            '\\' if in_str => esc = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[start..=start + j].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn bs58_decode(s: &str) -> Option<Vec<u8>> {
    const ALPH: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut num: Vec<u8> = vec![0];
    for c in s.bytes() {
        let val = ALPH.iter().position(|&a| a == c)? as u32;
        let mut carry = val;
        for d in num.iter_mut().rev() {
            let x = (*d as u32) * 58 + carry;
            *d = (x & 0xff) as u8;
            carry = x >> 8;
        }
        while carry > 0 {
            num.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    while num.first() == Some(&0) && num.len() > 1 { num.remove(0); }
    let mut out = vec![0u8; zeros];
    out.extend_from_slice(&num);
    Some(out)
}
