# Fuzzing

Requires honggfuzz. Fuzz tests will not run on Apple Silicon.

## Install

```bash
cargo install honggfuzz
```

## Build

```bash
# in solana/fuzz/src
cargo hfuzz build
```

## Run

```bash
cargo hfuzz run ntt-fuzz
```

As more targets are added, other targets for `run` can be found and added as `bins` defined in `Cargo.toml`.
`name` corresponds to the binary used by `cargo hfuzz run`.

```toml
...
[[bin]]
name = "ntt-fuzz"
...
```
