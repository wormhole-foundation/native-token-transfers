if test -z "$ENV"; then
  echo "ENV is not set"
  exit 1
fi

scanner_tokens_file="$SCANNER_TOKENS_FILE_PATH"
if test -z $scanner_tokens_file; then
    echo "SCANNER_TOKENS_FILE_PATH is not set"
    exit 1
fi
echo "Using scanner tokens file at $scanner_tokens_file"

chains_file_path="ts-scripts/config/$ENV/chains.json"
if ! test -f "$chains_file_path"; then
  echo "File does not exist at $chains_file_path"
  exit 1
fi

contracts_file_path="ts-scripts/config/$ENV/contracts.json"
if ! test -f "$contracts_file_path"; then
  echo "Contracts file configuration does not exist at $contracts_file_path"
  exit 1
fi

operating_chains=$(jq -r '.operatingChains' $chains_file_path);

if [ "$operating_chains" = "null" ]; then
  operating_chains=$(jq -r '.chains[] | .chainId' $chains_file_path)
else
  operating_chains=$(jq -r '.operatingChains[]' $chains_file_path)
fi

export FOUNDRY_PROFILE=prod

for chain in $operating_chains; do
  echo "Operating on chain $chain:"

  export governance_address=$(jq --raw-output ".GeneralPurposeGovernances[] | select(.chainId == $chain) | .address" $contracts_file_path)
  export core_wormhole_address=$(jq --raw-output ".WormholeCoreContracts[] | select(.chainId == $chain) | .address" $contracts_file_path)
  export etherscan_api_key=$(jq --raw-output ".[] | select(.chainId == $chain) | .etherscan" $scanner_tokens_file)
  export evm_chain_id=$(jq ".chains[] | select(.chainId == $chain) | .evmNetworkId" $chains_file_path)

  # echo "governance_address: $governance_address"
  # echo "etherscan_api_key: $etherscan_api_key"
  # echo "evm_chain_id: $evm_chain_id"

  if [ "$governance_address" = "" ] ||
    [ "$governance_address" = "" ] ||
    [ "$etherscan_api_key" = "null" ] ||
    [ "$evm_chain_id" = "null" ]; then
      echo "One of the addresses is not set. Skipping...";
      continue
  fi
  
  forge verify-contract --chain "$evm_chain_id" \
    --etherscan-api-key "$etherscan_api_key" \
    "$governance_address" \
    src/wormhole/Governance.sol:Governance --watch \
    --constructor-args $(cast abi-encode "constructor(address)" "$core_wormhole_address")
done
