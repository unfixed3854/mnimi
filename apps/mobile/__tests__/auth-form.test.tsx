import { fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("@/auth/auth", () => ({ signIn: jest.fn(), signUp: jest.fn() }));

import { AuthForm } from "@/features/auth/auth-form";
const mockAuth = require("@/auth/auth");

describe("AuthForm", () => {
  it("keeps credentials visible after a rejected sign-in", async () => {
    mockAuth.signIn.mockRejectedValueOnce(
      new Error("Incorrect email or password"),
    );
    const view = await render(<AuthForm mode="signin" />);
    await fireEvent.changeText(view.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(view.getByLabelText("Password"), "secret");
    await fireEvent.press(view.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(view.getByText("Incorrect email or password")).toBeTruthy()
    );
    expect(view.getByDisplayValue("ada@example.com")).toBeTruthy();
    expect(view.getByDisplayValue("secret")).toBeTruthy();
  });
});
