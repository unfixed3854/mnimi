import { render } from "@testing-library/react-native";

let mockDueCount = 0;

jest.mock("expo-router", () => {
  const { Pressable } = require("react-native");
  return {
    Link: ({
      accessibilityLabel,
      asChild,
      children,
      className,
      href,
    }: {
      accessibilityLabel?: string;
      asChild?: boolean;
      children?: React.ReactNode;
      className?: string;
      href: unknown;
    }) => asChild
      ? require("react").cloneElement(children, { href })
      : (
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="link"
          className={className}
          href={href as never}
        >
          {children}
        </Pressable>
      ),
  };
});

jest.mock("@/api/cards", () => ({
  useDueCount: () => ({ data: mockDueCount, isLoading: false, isError: false }),
}));

import { TodayScreen } from "@/features/today/today-screen";

describe("TodayScreen", () => {
  it("starts an all-decks review when cards are due", async () => {
    mockDueCount = 7;
    const view = await render(<TodayScreen />);

    expect(view.getAllByRole("header", { name: "Today" })).toHaveLength(1);
    expect(view.getByText("7")).toBeTruthy();
    expect(view.getByText("cards due")).toBeTruthy();
    expect(view.getByRole("button", { name: "Start review" }).props.className)
      .toContain("bg-primary");
    expect(view.getByRole("button", { name: "Start review" }).props.href)
      .toBe("/review");
  });

  it("keeps browsing quiet when nothing is due", async () => {
    mockDueCount = 0;
    const view = await render(<TodayScreen />);

    expect(view.getByRole("link", { name: "Browse decks" }).props.className)
      .toContain("text-primary");
    expect(view.getByRole("link", { name: "Browse decks" }).props.href)
      .toBe("/decks");
  });
});
