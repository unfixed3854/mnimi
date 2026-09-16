const mockAsyncStorage = require(
  "@react-native-async-storage/async-storage/jest/async-storage-mock",
);

jest.mock(
  "@react-native-async-storage/async-storage",
  () => mockAsyncStorage,
);

jest.mock("react-native-reanimated", () => {
  const { View } = require("react-native");
  const animation = () => ({
    duration() {
      return this;
    },
    delay() {
      return this;
    },
  });
  return {
    __esModule: true,
    default: { View },
    FadeIn: animation(),
    FadeInUp: animation(),
    useReducedMotion: () => false,
  };
});
