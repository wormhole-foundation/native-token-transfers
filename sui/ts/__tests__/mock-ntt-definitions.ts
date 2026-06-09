// Mock NTT definitions for testing
export type NttMessage = any;
export type NttTransceiver<N, C> = any;

export interface NttTxParams {
  sourceChain?: any;
  mode?: any;
  threshold?: number;
  queue?: boolean;
}

export interface NttConfig {
  network: any;
  contracts: {
    ntt?: any;
    transceiver?: any;
  };
}

export const mocks = {
  NttMessage: {},
  NttTransceiver: {},
  NttTxParams: {},
  NttConfig: {},
};

// Runtime value exports consumed by the source modules. These must exist as
// named exports for native-ESM imports to link successfully.
// `Ntt` / `NttWithExecutor` are only used as type namespaces at runtime.
export const Ntt: any = {};
export const NttWithExecutor: any = {};
// `NttTransceiver` is imported as a value binding (used only as a type).
export const NttTransceiver: any = {};
// Intentionally undefined so that `serializeLayout(nativeTokenTransferLayout, ...)`
// throws "Failed to serialize native token transfer payload" in tests.
export const nativeTokenTransferLayout: any = undefined;
