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
  NttConfig: {}
};