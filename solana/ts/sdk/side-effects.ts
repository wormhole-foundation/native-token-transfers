// <sigh>
// when the native secp256k1 is missing, the eccrypto library decides TO PRINT A MESSAGE TO STDOUT:
// https://github.com/bitchan/eccrypto/blob/a4f4a5f85ef5aa1776dfa1b7801cad808264a19c/index.js#L23
//
// do you use a CLI tool that depends on that library and try to pipe the output
// of the tool into another? tough luck
//
// for lack of a better way to stop this, we patch the console.info function to
// drop that particular message...
// </sigh>
(() => {
  const originalConsoleInfo: typeof console.info = console.info;
  console.info = function (x?: any, ...params: any[]) {
    if (x !== 'secp256k1 unavailable, reverting to browser version') {
      originalConsoleInfo.call(console, x, ...params);
    }
  };

  const originalConsoleWarn: typeof console.warn = console.warn;
  console.warn = function (x?: any, ...params: any[]) {
    if (
      x !==
      'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)'
    ) {
      originalConsoleWarn.call(console, x, ...params);
    }
  };
})();
