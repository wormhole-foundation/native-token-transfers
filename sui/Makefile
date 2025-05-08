test:
	@for move_toml in $(shell find packages -name Move.toml); do \
		dir=$$(dirname "$$move_toml"); \
		echo "Running tests in $$dir..."; \
		pushd "$$dir" && sui move test --skip-fetch-latest-git-deps; popd; \
	done
