import { render } from "@testing-library/react-native";
import { Text } from "react-native";

jest.mock("expo-router", () => ({
  Stack: () => null,
}));
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => jest.fn() },
}));

import { AppProviders } from "../app/_layout";

it("renders descendants inside the native providers", async () => {
  const { getByText } = await render(
    <AppProviders>
      <Text>mnimi mobile</Text>
    </AppProviders>,
  );

  expect(getByText("mnimi mobile")).toBeTruthy();
});
