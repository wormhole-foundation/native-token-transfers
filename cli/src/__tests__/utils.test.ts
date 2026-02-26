import { describe, it, expect } from "bun:test";
import { diffObjects, colorizeDiff } from "../diff";
import { colors } from "../colors";

describe("diffObjects", () => {
  it("should return empty diff for identical objects", () => {
    const a = { x: 1, y: "hello" };
    const b = { x: 1, y: "hello" };
    const diff = diffObjects(a, b);
    expect(diff).toEqual({});
  });

  it("should detect changed values", () => {
    const a = { x: 1, y: "hello" };
    const b = { x: 2, y: "hello" };
    const diff = diffObjects(a, b);
    expect(diff).toHaveProperty("x");
    expect((diff.x as any)?.push).toBe(1);
    expect((diff.x as any)?.pull).toBe(2);
  });

  it("should detect nested changes", () => {
    const a = { nested: { x: 1 } };
    const b = { nested: { x: 2 } };
    const diff = diffObjects(a, b);
    expect(diff).toHaveProperty("nested");
  });

  it("should respect excluded paths", () => {
    const a = { x: 1, ignored: "a" };
    const b = { x: 1, ignored: "b" };
    const diff = diffObjects(a, b, ["ignored"]);
    expect(diff).toEqual({});
  });

  it("should detect keys only in obj1 (push)", () => {
    const a = { x: 1, extra: "only-in-a" };
    const b = { x: 1 };
    const diff = diffObjects(a, b as any);
    expect((diff.extra as any)?.push).toBe("only-in-a");
  });

  it("should detect keys only in obj2 (pull)", () => {
    const a = { x: 1 };
    const b = { x: 1, extra: "only-in-b" };
    const diff = diffObjects(a, b as any);
    expect((diff as any).extra?.pull).toBe("only-in-b");
  });

  it("should prune empty nested diffs", () => {
    const a = { nested: { x: 1 } };
    const b = { nested: { x: 1 } };
    const diff = diffObjects(a, b);
    expect(diff).toEqual({});
  });
});

describe("colorizeDiff", () => {
  it("should return a string", () => {
    const diff = { x: { push: 1, pull: 2 } };
    const result = colorizeDiff(diff);
    expect(typeof result).toBe("string");
  });

  it("should handle empty diff", () => {
    const result = colorizeDiff({});
    expect(typeof result).toBe("string");
  });

  it("should handle non-object input", () => {
    const result = colorizeDiff("test");
    expect(typeof result).toBe("string");
  });
});

describe("colors", () => {
  it("should have all expected color functions", () => {
    const expectedColors = [
      "red",
      "green",
      "yellow",
      "blue",
      "cyan",
      "white",
      "gray",
      "dim",
      "reset",
    ];
    for (const color of expectedColors) {
      expect(typeof (colors as any)[color]).toBe("function");
    }
  });

  it("should return strings", () => {
    expect(typeof colors.red("test")).toBe("string");
    expect(typeof colors.green("test")).toBe("string");
  });

  it("should include the input text in output", () => {
    const result = colors.red("hello");
    expect(result).toContain("hello");
  });
});
