import { act } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { PortalHost } from "@rn-primitives/portal";

jest.mock("expo-router", () => ({
  Link: require("react-native").View,
  router: { push: jest.fn() },
}));

jest.mock(
  "@/auth/auth",
  () => ({
    signOut: jest.fn(),
    updateAiInstructions: jest.fn(),
    updateNativeLanguage: jest.fn(),
    updateTtsAutoplay: jest.fn(),
  }),
);
jest.mock("@/auth/session-store", () => ({
  useSession: () => ({
    user: {
      email: "ada@example.com",
      nativeLanguage: "en",
      ttsAutoplay: true,
      aiInstructions: "",
    },
  }),
}));

import { SettingsScreen } from "@/features/settings/settings-screen";
const mockAuth = require("@/auth/auth");

function renderSettingsScreen() {
  return render(
    <>
      <SettingsScreen />
      <PortalHost />
    </>,
  );
}

describe("SettingsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens the native language picker and saves one selected language", async () => {
    const view = await renderSettingsScreen();

    expect(view.getByRole("header", { name: "Settings" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Native language: English" }))
      .toBeTruthy();
    expect(view.getByRole("switch", { name: "Autoplay pronunciation" }))
      .toBeTruthy();
    await fireEvent.press(
      view.getByRole("button", { name: "Native language: English" }),
    );
    await fireEvent.press(view.getByRole("button", { name: "Polski" }));

    await waitFor(() =>
      expect(mockAuth.updateNativeLanguage).toHaveBeenCalledWith("pl")
    );
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Native language: Polski" }).props
          .accessibilityState.busy,
      ).toBe(false)
    );
    expect(mockAuth.updateNativeLanguage).toHaveBeenCalledTimes(1);
  });

  it("serializes preference writes while one is pending", async () => {
    let resolve!: () => void;
    mockAuth.updateTtsAutoplay.mockImplementationOnce(() =>
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    const view = await renderSettingsScreen();
    const autoplay = view.getByRole("switch", {
      name: "Autoplay pronunciation",
    });
    fireEvent.press(autoplay);
    await waitFor(() =>
      expect(mockAuth.updateTtsAutoplay).toHaveBeenCalledTimes(1)
    );
    fireEvent.press(autoplay);
    expect(mockAuth.updateTtsAutoplay).toHaveBeenCalledTimes(1);
    await new Promise<void>((done) => setImmediate(done));
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockAuth.updateTtsAutoplay).toHaveBeenCalledTimes(1)
    );
  });

  it("saves custom AI instructions only after the learner confirms", async () => {
    const view = await renderSettingsScreen();
    const instructions = view.getByLabelText("Custom AI instructions");

    await fireEvent.changeText(
      instructions,
      "Use short, everyday example sentences.",
    );
    expect(mockAuth.updateAiInstructions).not.toHaveBeenCalled();

    await fireEvent.press(
      view.getByRole("button", { name: "Save AI instructions" }),
    );

    await waitFor(() =>
      expect(mockAuth.updateAiInstructions).toHaveBeenCalledWith(
        "Use short, everyday example sentences.",
      )
    );
  });

  it("disables the language row while its update is pending", async () => {
    let resolve!: () => void;
    mockAuth.updateNativeLanguage.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const view = await renderSettingsScreen();

    await fireEvent.press(
      view.getByRole("button", { name: "Native language: English" }),
    );
    await fireEvent.press(view.getByRole("button", { name: "Polski" }));

    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Native language: Polski" }).props
          .accessibilityState,
      ).toEqual(expect.objectContaining({ busy: true, disabled: true }))
    );
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Native language: Polski" }).props
          .accessibilityState,
      ).toEqual(expect.objectContaining({ busy: false, disabled: false }))
    );
  });

  it("signs out through the account action", async () => {
    const view = await renderSettingsScreen();

    await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
  });

  it("shows sign-out progress and prevents another submission until it completes", async () => {
    let finish!: () => void;
    mockAuth.signOut.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const view = await renderSettingsScreen();

    await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
    expect(view.getByLabelText("Signing out")).toBeTruthy();
    expect(view.getByRole("button", { name: "Sign out" })).toBeDisabled();
    await fireEvent.press(view.getByRole("button", { name: "Sign out" }));
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(view.queryByLabelText("Signing out")).toBeNull();
  });
});
