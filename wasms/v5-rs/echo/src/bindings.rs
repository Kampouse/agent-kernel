#![allow(warnings)]
wit_bindgen::generate!({
    path: "wit",
    world: "echo-http",
    generate_all,
});
