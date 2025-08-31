import {
  deserializeLayout,
  encoding,
  serializeLayout,
} from "@wormhole-foundation/sdk-base";
import * as fs from "fs";
import * as path from "path";
import {
  nativeTokenTransferLayout,
  nttManagerMessageLayout,
  transceiverInfo,
  transceiverRegistration,
  wormholeTransceiverMessageLayout,
} from "../src/index.js";

const payloads = {
  transceiver: {
    info: ["transceiver_info_1.txt"],
    message: [
      "transceiver_message_1.txt",
      "transceiver_message_with_empty_payload.txt",
      "transceiver_message_with_32byte_payload.txt",
    ],
    registration: ["transceiver_registration_1.txt"],
  },
};

const filePath = path.join(__dirname, "../../../evm/test/payloads");
describe("Ntt Layout Tests", function () {
  test.each(payloads.transceiver.message)(
    "Test Transceiver %s messages",
    async (filename) => {
      const raw = fs
        .readFileSync(path.join(filePath, filename), "utf-8")
        .trim();
      const data = encoding.hex.decode(raw);
      const deserialized = deserializeLayout(
        wormholeTransceiverMessageLayout(
          nttManagerMessageLayout(nativeTokenTransferLayout)
        ),
        data
      );

      const srcToken =
        deserialized.nttManagerPayload.payload.sourceToken.toString();

      expect(srcToken).toEqual(
        "0xbeefface00000000000000000000000000000000000000000000000000000000"
      );
      expect(deserialized.nttManagerPayload.payload.recipientChain).toEqual(
        "Ethereum"
      );
      expect(
        deserialized.nttManagerPayload.payload.additionalPayload
      ).toHaveLength(
        filename === "transceiver_message_with_32byte_payload.txt" ? 32 : 0
      );
      expect(deserialized.transceiverPayload).toHaveLength(0);

      if (filename !== "transceiver_message_with_empty_payload.txt") {
        // empty payloads don't get their length serialized
        expect(
          serializeLayout(
            wormholeTransceiverMessageLayout(
              nttManagerMessageLayout(nativeTokenTransferLayout)
            ),
            deserialized
          )
        ).toEqual(data);
      }
    }
  );

  test.each(payloads.transceiver.info)(
    "Test Transceiver %s messages",
    async (filename) => {
      const raw = fs
        .readFileSync(path.join(filePath, filename), "utf-8")
        .trim();
      const data = encoding.hex.decode(raw);
      const deserialized = deserializeLayout(transceiverInfo, data);
      expect(deserialized.decimals).toEqual(16);
      expect(deserialized.mode).toEqual(0);
      expect(serializeLayout(transceiverInfo, deserialized)).toEqual(data);
    }
  );

  test.each(payloads.transceiver.registration)(
    "Test Transceiver %s messages",
    async (filename) => {
      const raw = fs
        .readFileSync(path.join(filePath, filename), "utf-8")
        .trim();
      const data = encoding.hex.decode(raw);
      const deserialized = deserializeLayout(transceiverRegistration, data);

      expect(deserialized.chain).toEqual("Arbitrum");
      expect(deserialized.transceiver).toBeTruthy();
      expect(serializeLayout(transceiverRegistration, deserialized)).toEqual(
        data
      );
    }
  );
});

//const vaa = createVAA("Ntt:TransceiverInfo", {
//  guardianSet: 0,
//  timestamp: 0,
//  nonce: 0,
//  emitterChain: "Solana",
//  emitterAddress: new UniversalAddress(new Uint8Array(32)),
//  sequence: BigInt(0),
//  consistencyLevel: 0,
//  signatures: [],
//  payload: deserializeLayout(
//    transceiverInfo,
//    encoding.hex.decode(
//      "9c23bd3b000000000000000000000000bb807f76cda53b1b4256e1b6f33bb46be36508e3000000000000000000000000002a68f967bfa230780a385175d0c86ae4048d309612"
//    )
//  ),
//});
