describe("definitions register warning behavior", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    warnSpy.mockRestore();
  });

  test("does not warn when register() is called explicitly", async () => {
    await jest.isolateModulesAsync(async () => {
      const mod = await import("../src/index.js");
      mod.register();
    });

    jest.runOnlyPendingTimers();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("warns when relying on side-effect import auto-registration", async () => {
    await jest.isolateModulesAsync(async () => {
      await import("../src/index.js");
    });

    jest.runOnlyPendingTimers();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "@wormhole-foundation/sdk-definitions-ntt: auto-registration on import is deprecated."
      )
    );
  });
});
