import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

jest.mock("@expo/vector-icons", () => ({
  Ionicons: ({ name, ...props }: { name: string }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");
    return createElement(Text, { ...props, testID: `icon-${name}` });
  },
}));

jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: any;
    href: unknown;
    asChild?: boolean;
  }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");

    return asChild
      ? react.cloneElement(children, { href })
      : createElement(Text, undefined, children);
  },
}));

import { ListRow } from "@/components/list-row";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";

describe("layout primitives", () => {
  it("renders one page heading with subtitle and stable back link", async () => {
    await render(
      <PageHeader
        title="German"
        subtitle="4 notes · 3 due"
        back={{ href: "/decks", label: "Back to decks" }}
      />,
    );

    expect(screen.getByRole("header", { name: "German" })).toBeTruthy();
    expect(screen.getByText("4 notes · 3 due")).toBeTruthy();
    const backLink = screen.getByRole("link", { name: "Back to decks" });
    expect(backLink).toBeTruthy();
    expect(backLink.props.className).toContain("active:opacity-80");
  });

  it("makes a destination row a full-height link", async () => {
    await render(
      <ListRow
        title="German"
        href="/decks/german"
        leadingIcon="layers-outline"
      />,
    );

    const row = screen.getByRole("link", { name: "German" });
    expect(row.props.className).toContain("min-h-[56px]");
    expect(row.props.className).toContain("w-full");
    expect(row.props.className).toContain("active:bg-surface-muted");
    expect(row.props.className).toContain("active:opacity-80");
  });

  it("runs a row action and renders its trailing value", async () => {
    const onPress = jest.fn();
    await render(
      <ListRow
        title="Native language"
        trailing={<Text>English</Text>}
        onPress={onPress}
      />,
    );

    const row = screen.getByRole("button", { name: "Native language" });
    expect(row.props.className).toContain("w-full");
    expect(row.props.className).toContain("active:opacity-80");
    fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("English")).toBeTruthy();
  });

  it("rejects ambiguous link and press behavior", async () => {
    await expect(
      render(
        <ListRow href="/decks" onPress={jest.fn()} title="German" />,
      ),
    ).rejects.toThrow("ListRow accepts either href or onPress, not both.");
  });

  it("renders a passive row without interactive semantics", async () => {
    await render(
      <ListRow title="Native language" trailing={<Text>English</Text>} />,
    );

    expect(screen.queryByRole("button", { name: "Native language" }))
      .toBeNull();
    expect(screen.queryByRole("link", { name: "Native language" })).toBeNull();
    expect(screen.getByText("English")).toBeTruthy();
  });

  it("hides supporting row icons from accessibility", async () => {
    const view = await render(
      <ListRow
        href="/decks/german"
        leadingIcon="layers-outline"
        title="German"
      />,
    );

    for (const name of ["layers-outline", "chevron-forward"]) {
      const icon = view.getByTestId(`icon-${name}`, {
        includeHiddenElements: true,
      });
      expect(icon.props.accessibilityElementsHidden).toBe(true);
      expect(icon.props.importantForAccessibility).toBe("no-hide-descendants");
    }
  });

  it("renders a section title below page-title prominence", async () => {
    await render(<SectionHeader title="Your decks" detail="2 decks" />);
    expect(screen.getByText("Your decks").props.className).toContain(
      "text-[20px]",
    );
    expect(screen.getByText("2 decks")).toBeTruthy();
  });
});
