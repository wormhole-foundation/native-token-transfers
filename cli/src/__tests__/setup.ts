// Shared test setup — imported by test files that need it
export const originalConsole = { ...console };

export function suppressConsole() {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
}

export function restoreConsole() {
  Object.assign(console, originalConsole);
}
