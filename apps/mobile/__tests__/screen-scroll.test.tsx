import type { ComponentProps, ComponentType } from "react";
import { Text } from "react-native";
import { render, within } from "@testing-library/react-native";
import { Screen } from "@/components/screen";

describe("Screen", () => {
  it("provides a keyboard-safe scroll container for long dynamic content", async () => {
    const view = await render(
      <Screen>
        <Text>{"long content ".repeat(400)}</Text>
      </Screen>,
    );
    const scroll = view.getByTestId("screen-scroll-content");

    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.props.contentContainerClassName).toEqual(
      expect.stringContaining("grow"),
    );
    expect(scroll.props.contentContainerClassName).toEqual(
      expect.stringContaining("gap-md"),
    );
    expect(scroll.props.contentContainerClassName).toEqual(
      expect.stringContaining("pb-xl"),
    );
  });

  it("allows tab screens to omit the already-reserved bottom inset", async () => {
    const TabScreen = Screen as unknown as ComponentType<
      ComponentProps<typeof Screen> & {
        safeAreaEdges: readonly ["top", "right", "left"];
      }
    >;
    const view = await render(
      <TabScreen safeAreaEdges={["top", "right", "left"]} testID="tab-screen">
        <Text>Tab content</Text>
      </TabScreen>,
    );

    expect(view.getByTestId("tab-screen").props.edges).toEqual({
      bottom: "off",
      left: "additive",
      right: "additive",
      top: "additive",
    });
  });

  it("keeps a sticky footer outside the scroll content and inside keyboard safety", async () => {
    const view = await render(
      <Screen footer={<Text accessibilityLabel="sticky-save">Save changes</Text>}>
        <Text>Editor</Text>
      </Screen>,
    );

    expect(
      within(view.getByTestId("screen-scroll-content")).queryByLabelText(
        "sticky-save",
      ),
    ).toBeNull();
    expect(view.getByTestId("screen-footer").props.className).toContain(
      "border-t",
    );
    expect(view.getByLabelText("sticky-save")).toBeTruthy();
  });
});
