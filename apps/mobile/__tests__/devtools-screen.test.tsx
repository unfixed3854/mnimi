import React from "react";
import { PortalHost } from "@rn-primitives/portal";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

const mockReset = {
  mutateAsync: jest.fn(),
  isPending: false,
  reset: jest.fn(),
  error: null as unknown,
};
const mockSeed = {
  mutateAsync: jest.fn(),
  isPending: false,
  reset: jest.fn(),
  error: null as unknown,
};

jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: React.ReactElement;
    href: string;
    asChild?: boolean;
  }) => {
    const react = require("react");
    return asChild ? react.cloneElement(children, { href }) : children;
  },
}));

jest.mock("@/api/debug", () => ({
  useDebugSummary: () => ({
    data: { totalCards: 2, decks: [], cards: [] },
    isLoading: false,
  }),
  useResetSrs: () => mockReset,
  useSeedGerman: () => mockSeed,
}));

import { DevtoolsScreen } from "@/features/devtools/devtools-screen";

describe("DevtoolsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReset.error = null;
    mockSeed.error = null;
  });

  it("exposes the native server-backed reset and German seed tools", async () => {
    const view = await render(<DevtoolsScreen />);

    expect(view.getByRole("header", { name: "Development tools" }))
      .toBeTruthy();
    expect(
      view.getByRole("link", { name: "Back to Settings" }).props.href,
    ).toBe("/settings");
    expect(
      view.getByRole("button", { name: "All cards" }).props
        .accessibilityState,
    ).toEqual(expect.objectContaining({ selected: true, disabled: false }));
    expect(view.getByRole("button", { name: "Reset SRS" }).props.className)
      .toContain("bg-destructive");
    expect(view.getByRole("button", { name: "Seed German" }).props.className)
      .toContain("bg-primary");
    expect(view.getByRole("button", { name: "Reset SRS" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Seed German" })).toBeTruthy();
  });

  it("shows only the latest action result after a reset failure and seed success", async () => {
    const resetError = new Error("Reset failed.");
    mockReset.mutateAsync.mockImplementationOnce(async () => {
      mockReset.error = resetError;
      throw resetError;
    });
    mockSeed.mutateAsync.mockResolvedValueOnce({
      status: "created",
      noteCount: 3,
      cardCount: 9,
      replaced: false,
    });
    const view = await render(<><DevtoolsScreen /><PortalHost /></>);

    await fireEvent.press(view.getByRole("button", { name: "Reset SRS" }));
    await fireEvent.press(view.getByRole("button", { name: /^Reset$/ }));
    await waitFor(() => expect(view.getByText("Reset failed.")).toBeTruthy());

    await fireEvent.press(view.getByRole("button", { name: "Seed German" }));

    await waitFor(() => {
      expect(view.getByText("Created German seed (3 notes, 9 cards)."))
        .toBeTruthy();
      expect(view.queryByText("Reset failed.")).toBeNull();
    });
  });
});
