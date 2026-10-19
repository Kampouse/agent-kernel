#![allow(warnings)]
mod bindings;
use std::io::{Read, Write};

bindings::export!(Echo with_types_in bindings);

struct Echo;

impl bindings::exports::wasi::cli::run::Guest for Echo {
    fn run() -> Result<(), ()> {
        let mut input = String::new();
        let _ = std::io::stdin().read_to_string(&mut input);
        let safe: String = input.chars().map(|c| if c == '"' || c == '\\' { ' ' } else { c }).collect();
        let out = format!("{{\"echo\":\"{}\",\"len\":{}}}", safe, input.len());
        let _ = std::io::stdout().write_all(out.as_bytes());
        Ok(())
    }
}
