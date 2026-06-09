import type { Config } from "jest";

const jestConfig: Config = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  verbose: true,
  testTimeout: 10000000,
  modulePathIgnorePatterns: ["mocks"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.esm.json",
        diagnostics: false,
      },
    ],
  },
};

export default jestConfig;
