// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";

import "../src/libraries/TransceiverStructs.sol";
import "../src/interfaces/IManagerBase.sol";
import "../src/interfaces/INttManager.sol";

contract TestTransceiverStructs is Test {
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    // TODO: add some negative tests for unknown message types etc

    function test_serialize_TransceiverInit() public {
        bytes4 wh_prefix = 0x9c23bd3b;
        TransceiverStructs.TransceiverInit memory ti = TransceiverStructs.TransceiverInit({
            transceiverIdentifier: wh_prefix,
            nttManagerAddress: hex"BABABABABABA",
            nttManagerMode: uint8(IManagerBase.Mode.LOCKING),
            tokenAddress: hex"DEDEDEDEDEDEDE",
            tokenDecimals: 16
        });

        bytes memory encodedTransceiverInit = TransceiverStructs.encodeTransceiverInit(ti);

        bytes memory encodedExpected =
            vm.parseBytes(vm.readLine("./test/payloads/transceiver_info_1.txt"));
        assertEq(encodedTransceiverInit, encodedExpected);
    }

    function test_SerdeRoundtrip_TransceiverInit(
        TransceiverStructs.TransceiverInit memory ti
    ) public {
        bytes memory message = TransceiverStructs.encodeTransceiverInit(ti);
        TransceiverStructs.TransceiverInit memory parsed =
            TransceiverStructs.decodeTransceiverInit(message);

        assertEq(ti.transceiverIdentifier, parsed.transceiverIdentifier);
        assertEq(ti.nttManagerAddress, parsed.nttManagerAddress);
        assertEq(ti.nttManagerMode, parsed.nttManagerMode);
        assertEq(ti.tokenAddress, parsed.tokenAddress);
        assertEq(ti.tokenDecimals, parsed.tokenDecimals);
    }

    function test_serialize_TransceiverRegistration() public {
        bytes4 wh_prefix = 0x18fc67c2;
        TransceiverStructs.TransceiverRegistration memory tr = TransceiverStructs
            .TransceiverRegistration({
            transceiverIdentifier: wh_prefix,
            transceiverChainId: 23,
            transceiverAddress: hex"BABABAFEFE"
        });

        bytes memory encodedTransceiverRegistration =
            TransceiverStructs.encodeTransceiverRegistration(tr);

        bytes memory encodedExpected =
            vm.parseBytes(vm.readLine("./test/payloads/transceiver_registration_1.txt"));
        assertEq(encodedTransceiverRegistration, encodedExpected);
    }

    function test_SerdeRoundtrip_TransceiverRegistration(
        TransceiverStructs.TransceiverRegistration memory tr
    ) public {
        bytes memory message = TransceiverStructs.encodeTransceiverRegistration(tr);

        TransceiverStructs.TransceiverRegistration memory parsed =
            TransceiverStructs.decodeTransceiverRegistration(message);

        assertEq(tr.transceiverIdentifier, parsed.transceiverIdentifier);
        assertEq(tr.transceiverChainId, parsed.transceiverChainId);
        assertEq(tr.transceiverAddress, parsed.transceiverAddress);
    }

    function test_serialize_TransceiverMessage() public {
        TransceiverStructs.NativeTokenTransfer memory ntt = TransceiverStructs.NativeTokenTransfer({
            amount: packTrimmedAmount(uint64(1234567), 7),
            sourceToken: hex"BEEFFACE",
            to: hex"FEEBCAFE",
            toChain: 17,
            additionalPayload: ""
        });

        TransceiverStructs.NttManagerMessage memory mm = TransceiverStructs.NttManagerMessage({
            id: hex"128434bafe23430000000000000000000000000000000000ce00aa0000000000",
            sender: hex"46679213412343",
            payload: TransceiverStructs.encodeNativeTokenTransfer(ntt)
        });

        bytes4 wh_prefix = 0x9945FF10;
        TransceiverStructs.TransceiverMessage memory em = TransceiverStructs.TransceiverMessage({
            sourceNttManagerAddress: hex"042942FAFABE",
            recipientNttManagerAddress: hex"042942FABABE",
            nttManagerPayload: TransceiverStructs.encodeNttManagerMessage(mm),
            transceiverPayload: new bytes(0)
        });

        bytes memory encodedTransceiverMessage =
            TransceiverStructs.encodeTransceiverMessage(wh_prefix, em);

        // this is a useful test case for implementations on other runtimes
        bytes memory encodedExpected =
            vm.parseBytes(vm.readLine("./test/payloads/transceiver_message_1.txt"));
        assertEq(encodedTransceiverMessage, encodedExpected);

        TransceiverStructs.TransceiverMessage memory emParsed =
            TransceiverStructs.parseTransceiverMessage(wh_prefix, encodedTransceiverMessage);

        TransceiverStructs.NttManagerMessage memory mmParsed =
            TransceiverStructs.parseNttManagerMessage(emParsed.nttManagerPayload);

        // deep equality check
        assertEq(abi.encode(mmParsed), abi.encode(mm));

        TransceiverStructs.NativeTokenTransfer memory nttParsed =
            TransceiverStructs.parseNativeTokenTransfer(mmParsed.payload);

        // deep equality check
        assertEq(abi.encode(nttParsed), abi.encode(ntt));
    }

    function test_parse_TransceiverMessageWithEmptyPayload() public {
        TransceiverStructs.NativeTokenTransfer memory ntt = TransceiverStructs.NativeTokenTransfer({
            amount: packTrimmedAmount(uint64(1234567), 7),
            sourceToken: hex"BEEFFACE",
            to: hex"FEEBCAFE",
            toChain: 17,
            additionalPayload: ""
        });

        TransceiverStructs.NttManagerMessage memory mm = TransceiverStructs.NttManagerMessage({
            id: hex"128434bafe23430000000000000000000000000000000000ce00aa0000000000",
            sender: hex"46679213412343",
            payload: TransceiverStructs.encodeNativeTokenTransfer(ntt)
        });

        bytes4 wh_prefix = 0x9945FF10;

        // this message can't be generated but does technically adhere to the spec
        bytes memory encodedExpected =
            vm.parseBytes(vm.readLine("./test/payloads/transceiver_message_with_empty_payload.txt"));

        TransceiverStructs.TransceiverMessage memory emParsed =
            TransceiverStructs.parseTransceiverMessage(wh_prefix, encodedExpected);

        TransceiverStructs.NttManagerMessage memory mmParsed =
            TransceiverStructs.parseNttManagerMessage(emParsed.nttManagerPayload);

        // add empty payload length
        mm.payload = abi.encodePacked(mm.payload, hex"0000");

        // deep equality check
        assertEq(abi.encode(mmParsed), abi.encode(mm));

        TransceiverStructs.NativeTokenTransfer memory nttParsed =
            TransceiverStructs.parseNativeTokenTransfer(mmParsed.payload);

        // deep equality check
        assertEq(abi.encode(nttParsed), abi.encode(ntt));
    }

    function test_serialize_TransceiverMessageWithAdditionalPayload() public {
        TransceiverStructs.NativeTokenTransfer memory ntt = TransceiverStructs.NativeTokenTransfer({
            amount: packTrimmedAmount(uint64(1234567), 7),
            sourceToken: hex"BEEFFACE",
            to: hex"FEEBCAFE",
            toChain: 17,
            additionalPayload: hex"deadbeef000000000000000000000000000000000000000000000000deadbeef"
        });

        TransceiverStructs.NttManagerMessage memory mm = TransceiverStructs.NttManagerMessage({
            id: hex"128434bafe23430000000000000000000000000000000000ce00aa0000000000",
            sender: hex"46679213412343",
            payload: TransceiverStructs.encodeNativeTokenTransfer(ntt)
        });

        bytes4 wh_prefix = 0x9945FF10;
        TransceiverStructs.TransceiverMessage memory em = TransceiverStructs.TransceiverMessage({
            sourceNttManagerAddress: hex"042942FAFABE",
            recipientNttManagerAddress: hex"042942FABABE",
            nttManagerPayload: TransceiverStructs.encodeNttManagerMessage(mm),
            transceiverPayload: new bytes(0)
        });

        bytes memory encodedTransceiverMessage =
            TransceiverStructs.encodeTransceiverMessage(wh_prefix, em);

        // this is a useful test case for implementations on other runtimes
        bytes memory encodedExpected = vm.parseBytes(
            vm.readLine("./test/payloads/transceiver_message_with_32byte_payload.txt")
        );
        assertEq(encodedTransceiverMessage, encodedExpected);

        TransceiverStructs.TransceiverMessage memory emParsed =
            TransceiverStructs.parseTransceiverMessage(wh_prefix, encodedTransceiverMessage);

        TransceiverStructs.NttManagerMessage memory mmParsed =
            TransceiverStructs.parseNttManagerMessage(emParsed.nttManagerPayload);

        // deep equality check
        assertEq(abi.encode(mmParsed), abi.encode(mm));

        TransceiverStructs.NativeTokenTransfer memory nttParsed =
            TransceiverStructs.parseNativeTokenTransfer(mmParsed.payload);

        // deep equality check
        assertEq(abi.encode(nttParsed), abi.encode(ntt));
    }

    function test_SerdeRoundtrip_NttManagerMessage(
        TransceiverStructs.NttManagerMessage memory m
    ) public {
        bytes memory message = TransceiverStructs.encodeNttManagerMessage(m);

        TransceiverStructs.NttManagerMessage memory parsed =
            TransceiverStructs.parseNttManagerMessage(message);

        assertEq(m.id, parsed.id);
        assertEq(m.sender, parsed.sender);
        assertEq(m.payload, parsed.payload);
    }

    function test_SerdeJunk_NttManagerMessage(
        TransceiverStructs.NttManagerMessage memory m
    ) public {
        bytes memory message = TransceiverStructs.encodeNttManagerMessage(m);

        bytes memory junk = "junk";

        vm.expectRevert(
            abi.encodeWithSelector(
                BytesParsing.LengthMismatch.selector, message.length + junk.length, message.length
            )
        );
        TransceiverStructs.parseNttManagerMessage(abi.encodePacked(message, junk));
    }

    function test_SerdeRoundtrip_NativeTokenTransfer(
        TransceiverStructs.NativeTokenTransfer memory m
    ) public {
        bytes memory message = TransceiverStructs.encodeNativeTokenTransfer(m);

        TransceiverStructs.NativeTokenTransfer memory parsed =
            TransceiverStructs.parseNativeTokenTransfer(message);

        assertEq(m.amount.getAmount(), parsed.amount.getAmount());
        assertEq(m.to, parsed.to);
        assertEq(m.toChain, parsed.toChain);
    }

    function test_SerdeJunk_NativeTokenTransfer(
        TransceiverStructs.NativeTokenTransfer memory m
    ) public {
        bytes memory message = TransceiverStructs.encodeNativeTokenTransfer(m);

        bytes memory junk = "junk";

        uint256 expectedRead = message.length;
        if (m.additionalPayload.length == 0) {
            // when there isn't an additionalPayload, "ju" is interpreted as the length
            expectedRead = message.length + 2 + 0x6A75;
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                BytesParsing.LengthMismatch.selector, message.length + junk.length, expectedRead
            )
        );
        TransceiverStructs.parseNativeTokenTransfer(abi.encodePacked(message, junk));
    }
}
