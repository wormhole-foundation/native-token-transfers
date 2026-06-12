import type { JestConfigWithTsJest } from "ts-jest";

const jestConfig: JestConfigWithTsJest = {
  verbose: true,
  testTimeout: 10000000,
  roots: ["./sdk/__tests__"],
  testMatch: ["**/*.test.ts"],
  modulePathIgnorePatterns: ["mocks"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      { tsconfig: "tsconfig.test.json", useESM: true, diagnostics: false },
    ],
  },
};

export default jestConfig;
