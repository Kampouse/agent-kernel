//! Honest MPC signer — same ABI as the fake (`/tmp/fake_mpc.wasm`) but produces
//! REAL ed25519 signatures over the kernel's msgHex payload.
//!
//! ABI (env imports, identical to fake_mpc.wasm):
//!   input(reg) -> len            — guest calls with reg 0, then read_register
//!   register_len(reg) -> len
//!   read_register(reg, ptr)
//!   value_return(ptr, len)
//!
//! Input:  {"request":{"payload_v2":{"Eddsa":"<msgHex>"},"path":"...","domain_id":1}}
//! Output: {"scheme":"Ed25519","signature":[64 decimal bytes]}  (same shape the
//!         real MPC returns and kernel2 parseSigBytes expects)
//!
//! Keypair: fixed, seeded from the constant SEED below. The pubkey is derived
//! deterministically — for real devnet settlement (rung 2) fund THIS pubkey.
#![no_std]
#![no_main]

use ed25519_dalek::{Signature, Signer, SigningKey};

// 32-byte deterministic seed (os.urandom, generated once — NOT a production key).
const SEED: [u8; 32] = [
    0x9d, 0x1b, 0x43, 0xf8, 0xa7, 0x22, 0x5e, 0xc4, 0x18, 0x30, 0xdb, 0x67, 0x94, 0xd2, 0x0a, 0x51,
    0xe6, 0x7c, 0x3b, 0x09, 0xf5, 0x8d, 0x71, 0xaa, 0x2e, 0xc0, 0x64, 0x13, 0xb8, 0x5f, 0x97, 0x46,
];

// ── minimal host ABI (undefined symbols resolve to env.* imports at link time
//    via the -Wl,--allow-undefined + import-namespace flags below) ─────────────
extern "C" {
    fn input(reg: u64);
    fn register_len(reg: u64) -> u64;
    fn read_register(reg: u64, ptr: u64);
    fn value_return(ptr: u64, len: u64);
}

const INPUT_REG: u64 = 0;

fn read_input() -> usize {
    let len = unsafe { register_len(INPUT_REG) } as usize;
    len
}

// ── tiny helpers (no alloc, fixed buffers) ───────────────────────────────────
static mut IN_BUF: [u8; 512] = [0; 512];
static mut OUT_BUF: [u8; 512] = [0; 512];

fn hex_val(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    }
}

// (msg hex extraction happens inline in sign() — no separate helper needed)

fn u64_to_dec(mut v: u32, out: &mut [u8]) -> usize {
    if v == 0 {
        out[0] = b'0';
        return 1;
    }
    let mut tmp = [0u8; 10];
    let mut n = 0;
    while v > 0 {
        tmp[n] = b'0' + (v % 10) as u8;
        v /= 10;
        n += 1;
    }
    for i in 0..n {
        out[i] = tmp[n - 1 - i];
    }
    n
}

#[no_mangle]
pub extern "C" fn sign() {
    unsafe {
        // CLI-direct calls don't pre-fill reg 0: guest must call input(reg) first
        // (real NEAR semantics — input() writes the args into the register).
        input(INPUT_REG);
        let len = read_input();
        if len == 0 || len > 500 {
            return;
        }
        let in_buf = &mut *(&raw mut IN_BUF);
        read_register(INPUT_REG, in_buf.as_mut_ptr() as u64);
        let json = &in_buf[..len];

        // locate "Eddsa":"<hex>"
        const KEY: &[u8] = b"\"Eddsa\":\"";
        let mut pos = None;
        let mut i = 0;
        'scan: while i + KEY.len() <= json.len() {
            for (k, kc) in KEY.iter().enumerate() {
                if json[i + k] != *kc {
                    i += 1;
                    continue 'scan;
                }
            }
            pos = Some(i + KEY.len());
            break;
        }
        let hex_start = match pos {
            Some(p) => p,
            None => return,
        };
        let mut hex_end = hex_start;
        while hex_end < json.len() && json[hex_end] != b'"' {
            hex_end += 1;
        }
        let hex_len = hex_end - hex_start;
        if hex_len == 0 || hex_len % 2 != 0 || hex_len / 2 > 256 {
            return;
        }

        // hex-decode the message in place (reuse the tail of IN_BUF)
        let msg_len = hex_len / 2;
        let mut msg = [0u8; 256];
        for b in 0..msg_len {
            msg[b] = (hex_val(json[hex_start + 2 * b]) << 4) | hex_val(json[hex_start + 2 * b + 1]);
        }

        // REAL ed25519 signature over the decoded payload
        let sk = SigningKey::from_bytes(&SEED);
        let sig: Signature = sk.sign(&msg[..msg_len]);
        let sig_bytes = sig.to_bytes();

        // build {"scheme":"Ed25519","signature":[b0,b1,...,b63]}
        let out = &mut *(&raw mut OUT_BUF);
        let mut n = 0;
        const PFX: &[u8] = b"{\"scheme\":\"Ed25519\",\"signature\":[";
        out[..PFX.len()].copy_from_slice(PFX);
        n = PFX.len();
        for (i, b) in sig_bytes.iter().enumerate() {
            if i > 0 {
                out[n] = b',';
                n += 1;
            }
            n += u64_to_dec(*b as u32, &mut out[n..]);
        }
        out[n] = b']';
        n += 1;
        out[n] = b'}';
        n += 1;
        // mock ABI: value_return(len, ptr) — NOT (ptr, len)
        value_return(n as u64, out.as_ptr() as u64);
    }
}

#[panic_handler]
fn ph(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
