//! Test crate root for plc_core. Declaring tests/lib.cairo makes the whole
//! tests/ directory a single crate, so the generated vector table and test
//! files are ordinary modules.

mod common;
mod op_decode;
mod op_verify;
mod op_verify_vectors_generated;
