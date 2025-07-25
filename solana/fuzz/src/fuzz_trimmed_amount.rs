use afl::fuzz;
use ntt_messages::trimmed_amount::TrimmedAmount;

// #[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]

fn main() {
    loop {
        fuzz!(|input: (u64, u8, u8)| {
            let _ = TrimmedAmount::trim(input.0, input.1, input.2);
        });
    }
}
