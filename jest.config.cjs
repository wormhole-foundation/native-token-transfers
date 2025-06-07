const jestConfig = {
  verbose: true,
  testTimeout: 10000000,
  roots: ["./sdk/__tests__"],
  testMatch: ["**/*.test.ts"],
  modulePathIgnorePatterns: ["mocks"],
  preset: "ts-jest",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
};

module.exports = jestConfig;
