use honggfuzz::fuzz;
use example_native_token_transfers::queue::rate_limit::RateLimitState;

fn main() {
    loop {
         fuzz!(|input: (u64, u64)| {
            let (limit, new_limit) = input;

            let mut rls = RateLimitState::new(limit);
            rls.set_limit(new_limit)
        });
    }
}
