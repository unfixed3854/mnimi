import { render } from "@testing-library/react-native";

jest.mock("@/auth/auth", () => ({
  signIn: jest.fn(),
  signUp: jest.fn(),
}));
jest.mock("expo-router/build/link/Link", () => ({
  Link: require("react-native").Text,
}));
jest.mock("expo-router", () => ({
  Link: require("react-native").View,
}));

import { LoginContent } from "../app/(auth)/login";
import { SignupContent } from "../app/(auth)/signup";

describe("registration routes", () => {
  it("shows the signup link only when registration is enabled", async () => {
    const enabled = await render(<LoginContent registrationEnabled />);
    expect(enabled.getByText("Create an account")).toBeTruthy();

    const disabled = await render(
      <LoginContent registrationEnabled={false} />,
    );
    expect(disabled.queryByText("Create an account")).toBeNull();
  });

  it("blocks direct signup when registration is unavailable", async () => {
    const view = await render(<SignupContent registrationEnabled={false} />);

    expect(view.getByText("Registration is unavailable")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Create account" })).toBeNull();
  });
});
