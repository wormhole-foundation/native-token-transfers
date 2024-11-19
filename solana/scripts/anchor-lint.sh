#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
TARGET=${SCRIPT_DIR}/../programs

# Anchor IDL does not handle nested imports well (https://github.com/coral-xyz/anchor/issues/1099)
# This directory has a workaround for it but that is not recognized by idl parse - hence it is skipped
SKIP_DIR="${TARGET}/ntt-transceiver/src"
 
RESULTS=$(find "${TARGET}" -path "${SKIP_DIR}" -prune -o -name "*.rs" -type f -exec anchor idl parse -o /dev/null --file {} \; 2>&1 | grep -v '^Error: Program module not found$')
if [[ -n "$RESULTS" ]]; then
	echo "${RESULTS}"
	exit 1
fi
