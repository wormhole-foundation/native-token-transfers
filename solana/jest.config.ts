import type { JestConfigWithTsJest } from "ts-jest";

const jestConfig: JestConfigWithTsJest = {
  verbose: true,
  testTimeout: 10000000,
  modulePathIgnorePatterns: ["mocks"],
  roots: ["./tests/anchor"],
  testMatch: ["**/*.test.ts"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      { tsconfig: "tsconfig.anchor.json", useESM: true, diagnostics: false },
    ],
  },
};

export default jestConfig;
