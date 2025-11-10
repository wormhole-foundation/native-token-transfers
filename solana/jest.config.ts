import type { JestConfigWithTsJest } from "ts-jest";

const jestConfig: JestConfigWithTsJest = {
  verbose: true,
  testTimeout: 10000000,
  modulePathIgnorePatterns: ["mocks"],
  roots: ["./tests/anchor"],
  testMatch: ["**/*.test.ts"],
  preset: "ts-jest",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.anchor.json" }],
  },
};

export default jestConfig;
