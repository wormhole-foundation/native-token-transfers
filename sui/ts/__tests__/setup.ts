// Global test setup

// Increase timeout for async operations
jest.setTimeout(30000);

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  // Keep error for debugging
  error: console.error,
};

// Handle BigInt serialization for Jest
(BigInt.prototype as any).toJSON = function() {
  return this.toString() + 'n';
};
