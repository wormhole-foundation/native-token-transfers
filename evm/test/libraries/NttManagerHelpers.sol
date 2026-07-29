// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.8 <0.9.0;

import "../../src/libraries/TrimmedAmount.sol";
import "../../src/NttManager/NttManager.sol";
import "../../src/interfaces/INttManager.sol";
import "wormhole-sdk/Utils.sol";

library NttManagerHelpersLib {
    uint16 constant SENDING_CHAIN_ID = 1;

    using TrimmedAmountLib for TrimmedAmount;

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
            SENDING_CHAIN_ID,
            toUniversalAddress(address(nttManager)),
            tokenDecimals,
            type(uint64).max
        );
        recipientNttManager.setInboundLimit(inboundLimit.untrim(decimals), SENDING_CHAIN_ID);
    }
}
