import { encoding, serializeLayout } from "@wormhole-foundation/sdk-base";
import { nttTransferLayout } from "../layouts.js";

it("should match known good encoding", async () => {
  const encoded = serializeLayout(nttTransferLayout, {
    recipient_ntt_manager_address: encoding.hex.decode(
      "059bdc37034b00b1e984371d8af04c5423fcea8a9c868b836e49838619dd5dc6"
    ),
    recipient_address: encoding.hex.decode(
      "83718b7ec89617b7040685e01bdcca03214022980daae91340e0c3f840c005ef"
    ),
    recipient_chain: 1,
    from_decimals: 6,
    to_decimals: 6,
  });
  expect(encoded).toEqual(
    encoding.hex.decode(
      "994E5454059bdc37034b00b1e984371d8af04c5423fcea8a9c868b836e49838619dd5dc683718b7ec89617b7040685e01bdcca03214022980daae91340e0c3f840c005ef00010606"
    )
  );
});
