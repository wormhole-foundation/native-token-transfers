// Sui network addresses configuration
export const SUI_ADDRESSES = {
  Mainnet: {
    coreBridgeStateId:
      "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c",
    executorId:
      "0xdb0fe8bb1e2b5be628adbea0636063325073e1070ee11e4281457dfd7f158235",
    executorRequestsId:
      "0xa55f6f81649b071b5967dc56227bbee289e4c411ab610caeec7abce499e262b8",
  },
  Testnet: {
    coreBridgeStateId:
      "0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790",
    executorId:
      "0x4000cfe2955d8355b3d3cf186f854fea9f787a457257056926fde1ec977670eb",
    executorRequestsId:
      "0x8e5ec98738885325294060fd067fde47e10313bedc531d0500b24a752be41788",
  },
};

// Rate limit duration constant (24 hours in milliseconds)
export const RATE_LIMIT_DURATION = BigInt(24 * 60 * 60 * 1000);

// Native token identifiers
export const NATIVE_TOKEN_IDENTIFIERS = ["native", "0x2::sui::SUI"] as const;