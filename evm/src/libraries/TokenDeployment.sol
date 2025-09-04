// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "./TokenInfo.sol";
import {Token} from "../MultiTokenNtt/Token.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title TokenDeployment
/// @notice External library for deploying wrapped tokens using CREATE2
library TokenDeployment {
    error FailedToDeployToken();

    /// @notice Creates a new wrapped token using CREATE2
    /// @param tokenInfo The token metadata for initialization
    /// @param tokenImplementation The token implementation address
    /// @return localToken The address of the deployed token
    function createToken(
        TokenInfo memory tokenInfo,
        address tokenImplementation
    ) external returns (address localToken) {
        bytes32 salt =
            keccak256(abi.encodePacked(tokenInfo.token.chainId, tokenInfo.token.tokenAddress));

        bytes memory proxyBytecode = type(ERC1967Proxy).creationCode;
        bytes memory constructorArgs = abi.encode(
            tokenImplementation,
            abi.encodeWithSelector(
                Token.initialize.selector,
                _bytes32ToString(tokenInfo.meta.name),
                _bytes32ToString(tokenInfo.meta.symbol),
                tokenInfo.meta.decimals
            )
        );
        bytes memory deploymentBytecode = abi.encodePacked(proxyBytecode, constructorArgs);

        assembly {
            localToken := create2(0, add(deploymentBytecode, 0x20), mload(deploymentBytecode), salt)
        }

        if (localToken == address(0)) {
            revert FailedToDeployToken();
        }
    }

    /// @notice Get the creation code for the ERC1967Proxy contract
    /// @return The bytecode used for deploying token proxies
    function getTokenProxyCreationCode() external pure returns (bytes memory) {
        return type(ERC1967Proxy).creationCode;
    }

    /// @dev Converts bytes32 to string, removing null bytes
    function _bytes32ToString(
        bytes32 str
    ) internal pure returns (string memory) {
        uint8 i = 0;
        while (i < 32 && str[i] != 0) {
            i++;
        }
        bytes memory bytesArray = new bytes(i);
        for (i = 0; i < 32 && str[i] != 0; i++) {
            bytesArray[i] = str[i];
        }
        return string(bytesArray);
    }
}
