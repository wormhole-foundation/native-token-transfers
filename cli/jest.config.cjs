const path = require("path");

module.exports = {
  verbose: true,
  testTimeout: 120000,
  rootDir: __dirname,
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.ts"],
  modulePathIgnorePatterns: ["mocks"],
  preset: "ts-jest",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: path.join(__dirname, "tsconfig.jest.json"),
      },
    ],
  },
};
