# Default environment for building/testing (testnet or mainnet)
ENV ?= testnet

test:
	@set -e; \
	for move_toml in $(shell find packages -name Move.toml); do \
		dir=$$(dirname "$$move_toml"); \
		echo "Running tests in $$dir..."; \
		(cd "$$dir" && sui move test -e $(ENV)) || exit $$?; \
	done

build:
	@set -e; \
	for move_toml in $(shell find packages -name Move.toml); do \
		dir=$$(dirname "$$move_toml"); \
		echo "Building $$dir..."; \
		(cd "$$dir" && sui move build -e $(ENV)) || exit $$?; \
	done
