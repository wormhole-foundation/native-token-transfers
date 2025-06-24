#![no_main]

use libfuzzer_sys::fuzz_target;
use ntt_messages::trimmed_amount::TrimmedAmount;

fuzz_target!(|input: (u64, u8, u8)| {
    let _ = TrimmedAmount::trim(input.0, input.1, input.2);
});
