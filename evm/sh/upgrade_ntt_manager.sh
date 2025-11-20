#!/bin/bash

while getopts ":n:c:u:e:k:" opt; do
  case $opt in
    n) network="$OPTARG"
    ;;
    c) chain="$OPTARG"
    ;;
    u) rpc="$OPTARG"
    ;;
    e) etherscan_key="$OPTARG"
    ;;
    k) private_key="$OPTARG"
    ;;
    \?) echo "Invalid option -$OPTARG" >&2
    exit 1
    ;;
  esac

  case $OPTARG in
    -*) echo "Option $opt needs a valid argument" >&2
    exit 1
    ;;
  esac
done

if [ -z ${network+x} ];
then
    echo "network (-n) is unset" >&2
    exit 1
fi

if [ -z ${chain+x} ];
then
    echo "chain (-c) is unset" >&2
    exit 1
fi

if [ -z ${private_key+x} ];
then
    echo "private key (-k) is unset" >&2
    exit 1
fi

set -euo pipefail

ROOT=$(dirname $0)
ENV=$ROOT/../env
FORGE_SCRIPTS=$ROOT/../script

. $ENV/$network/$chain.env

# Use the RPC environment variable if rpc isn't set.
if [ -z ${rpc+x} ];
then
    rpc=$RPC
fi

# Use the ETHERSCAN_KEY environment variable if etherscan_key isn't set.
if [ -z ${etherscan_key+x} ];
then
    etherscan_key=$ETHERSCAN_KEY
fi

forge script $FORGE_SCRIPTS/DeployWormholeNtt.s.sol \
    --sig "upgrade(address)" \
    $RELEASE_MANAGER_ADDRESS \
    --rpc-url $rpc \
    --broadcast \
    --private-key $private_key \
    --verify --etherscan-api-key $etherscan_key \
    --slow \
    --skip test
