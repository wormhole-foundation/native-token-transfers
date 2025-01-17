// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";

import "../../src/libraries/TrimmedAmount.sol";
import "../../src/NttManager/NttManager.sol";
import "../../src/interfaces/INttManager.sol";

library NttManagerHelpersLib {
    using TrimmedAmountLib for TrimmedAmount;

    uint128 public constant gasLimit = 100000000;

    function setConfigs(
        TrimmedAmount inboundLimit,
        NttManager nttManager,
        NttManager recipientNttManager,
        uint8 decimals
    ) internal {
        (bool success, bytes memory queriedDecimals) =
            address(nttManager.token()).staticcall(abi.encodeWithSignature("decimals()"));

        if (!success) {
            revert INttManager.StaticcallFailed();
        }

        uint8 tokenDecimals = abi.decode(queriedDecimals, (uint8));
        recipientNttManager.setPeer(
            nttManager.chainId(),
            toWormholeFormat(address(nttManager)),
            tokenDecimals,
            gasLimit,
            type(uint64).max
        );
        recipientNttManager.setInboundLimit(inboundLimit.untrim(decimals), nttManager.chainId());
    }
}
