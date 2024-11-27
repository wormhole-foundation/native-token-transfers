.DEFAULT_GOAL = build
.PHONY: build cargo-build anchor-build prod-build test cargo-test anchor-test idl sdk clean node_modules lint cargo-lint anchor-lint fix-lint

#find and convert version line:
#  turn `const VERSION: &str = "major.minor.patch";` into `major_minor_patch`
#use make functions to minimize dependence on shell
VERSION = $(subst .,_,$(subst ;,,$(subst ",,$(lastword \
  $(shell grep "const VERSION" programs/example-native-token-transfers/src/lib.rs) \
))))


#######################
## BUILD

build: cargo-build anchor-build


cargo-build:
	BPF_OUT_DIR="$(pwd)/target/deploy" cargo build-sbf

# after building, remove the generics from the idl file. This is necessary as of anchor 0.29.0,
# because the javascript library does not support generics yet, and just panics
anchor-build:
	anchor build --arch sbf
	for jsonfile in target/idl/*.json; do \
	  echo "Removing generics from" $$jsonfile; \
	  ./scripts/patch-idl $$jsonfile; \
	done

prod-build:
	anchor build --verifiable

idl: anchor-build
	@echo "IDL Version: $(VERSION)"
	mkdir -p ts/idl/$(VERSION)/json
	mkdir -p ts/idl/$(VERSION)/ts
	cp -r target/idl/* ts/idl/$(VERSION)/json/
	for jsonfile in ts/idl/$(VERSION)/json/*.json; do \
	  tsfile=$$(echo $$jsonfile | sed 's/json\/\(.*\)\.json/ts\/\1.ts/'); \
	  tsx scripts/regenerateIdl.ts $$jsonfile > $$tsfile; \
	done

sdk: anchor-build
	@echo "Building SDK"
	cd .. && npm ci && npm run build:solana

clean:
	anchor clean
	rm -rf .anchor node_modules

node_modules:
	npm install


#######################
## TESTS

test: cargo-test anchor-test


cargo-test:
	cargo build-sbf --features "mainnet"
	cargo test-sbf --features "mainnet"
	cargo test

anchor-test: idl sdk node_modules
	anchor test --skip-build


#######################
## LINT

lint: cargo-lint anchor-lint


cargo-lint:
	cargo fmt --check --all --manifest-path Cargo.toml
	cargo check --workspace --tests --manifest-path Cargo.toml
	cargo clippy --workspace --tests --manifest-path Cargo.toml -- -Dclippy::cast_possible_truncation

# Run anchor's linter on all Rust files in the current directory via `anchor idl parse`
# Results written to /dev/null because we're just calling parse for the linting capabilities and we don't care about
# the JSON output.
# anchor-cli v0.29.0 doesn't seem to do linting on the command-line during the build process so this is a workaround
anchor-lint:
	bash scripts/anchor-lint.sh

fix-lint:
	cargo fmt --all --manifest-path Cargo.toml