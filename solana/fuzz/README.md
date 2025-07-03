# Fuzzing

Requires cargo-fuzz.

## Install

```bash
cargo install cargo-fuzz
```

## Build

```bash
# in solana
cargo rustc --bin <target> -- \
    -C passes='sancov-module' \
    -C llvm-args='-sanitizer-coverage-level=3' \
    -C llvm-args='-sanitizer-coverage-inline-8bit-counters' \
    -Z sanitizer=address
```

## Run

```bash
cargo fuzz run <target>
```

Additional targets can be added using:

```bash
cargo fuzz add <target>
```
