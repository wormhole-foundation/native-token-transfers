PLATFORM_DIRS := evm solana

TARGETS := build test lint

.PHONY: $(TARGETS)
$(TARGETS):
	$(foreach dir,$(PLATFORM_DIRS), make -C $(dir) $@ &&) true
