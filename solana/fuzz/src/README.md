# Fuzzing

Requires cargo-afl.

## Install

```bash
cargo install cargo-afl
```

## Build

```bash
# in solana/fuzz/src
cargo afl build
```

## Run

```bash
cargo afl fuzz target/debug/ntt-fuzz
```

As more targets are added, other targets for `run` can be found and added as `bins` defined in `Cargo.toml`.
`name` corresponds to the binary used by `cargo afl fuzz`.

```toml
...
[[bin]]
name = "ntt-fuzz"
...
```
