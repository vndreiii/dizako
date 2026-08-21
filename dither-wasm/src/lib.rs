//! Crate root. The engine is plain Rust (native-testable via the rlib
//! target); wasm-bindgen bindings live in `wasm_api` and only compile for
//! wasm32.

pub mod color;
pub mod engine;
pub mod kernels;
pub mod masks;
pub mod palette;
pub mod prepare;
pub mod region;
pub mod settings;
pub mod shared;
pub mod tables;

#[cfg(target_arch = "wasm32")]
mod wasm_api;
