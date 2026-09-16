module.exports = {
  preset: "jest-expo",
  setupFiles: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/__tests__/**/*.test.ts?(x)"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.css$": "<rootDir>/__mocks__/styleMock.js",
  },
  transformIgnorePatterns: [
    "node_modules/(?!((react-native(-.*)?|@react-native|@react-native-community|@rn-primitives|expo(-.*)?|@expo|react-navigation|@react-navigation|standard-navigation|nativewind|react-native-css-interop)/))",
    "node_modules/react-native-reanimated/plugin/",
  ],
};
