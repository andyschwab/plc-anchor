//! Shared test helpers.

/// Decode a lowercase-hex `ByteArray` into raw bytes. The conformance vectors carry their
/// CBOR as hex (so the generated table is plain ASCII string literals).
pub fn from_hex(hex: @ByteArray) -> ByteArray {
    let mut out: ByteArray = "";
    let len = hex.len();
    let mut i = 0;
    while i < len {
        let hi = nibble(hex.at(i).unwrap());
        let lo = nibble(hex.at(i + 1).unwrap());
        out.append_byte(hi * 16 + lo);
        i += 2;
    }
    out
}

fn nibble(c: u8) -> u8 {
    if c >= 0x30 && c <= 0x39 {
        c - 0x30
    } else {
        c - 0x61 + 10
    }
}
