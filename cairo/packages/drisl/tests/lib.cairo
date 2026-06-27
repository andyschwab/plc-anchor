//! Test crate root for the drisl keystone. Declaring `tests/lib.cairo` makes the whole
//! `tests/` directory a single crate, so the generated vector table and the shared hex
//! helper are ordinary modules the test files can reference.

mod cid;
mod codec;
mod common;
mod conformance;
mod plc_ops;
mod plc_vectors_generated;
mod vectors_generated;
