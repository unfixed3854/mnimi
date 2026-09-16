import { act, render } from "@testing-library/react-native";
import { createElement } from "react";
import { Text } from "react-native";

type PreventRemoveEvent = {
  data: { action: unknown };
};

const mockNavigation = {
  dispatch: jest.fn(),
};
const mockUsePreventRemove = jest.fn();
let preventRemoveCallback: ((event: PreventRemoveEvent) => void) | undefined;

jest.mock("expo-router", () => ({
  useNavigation: () => mockNavigation,
}));
jest.mock("expo-router/react-navigation", () => ({
  usePreventRemove: (
    enabled: boolean,
    callback: (event: PreventRemoveEvent) => void,
  ) => {
    mockUsePreventRemove(enabled, callback);
    preventRemoveCallback = callback;
  },
}));

import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

let latestUnsavedChanges: ReturnType<typeof useUnsavedChanges> | null = null;
function UnsavedChangesHarness({ dirty }: { dirty: boolean }) {
  latestUnsavedChanges = useUnsavedChanges({ dirty });
  return createElement(Text, null, latestUnsavedChanges.confirming ? "confirming" : "editing");
}

describe("useUnsavedChanges", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    preventRemoveCallback = undefined;
    latestUnsavedChanges = null;
  });

  it.each([
    ["native gesture", { type: "POP", payload: { count: 1 } }],
    ["Android Back", { type: "GO_BACK" }],
  ])("holds a dirty %s action until discard", async (_source, action) => {
    await render(createElement(UnsavedChangesHarness, { dirty: true }));
    const event = { data: { action } };

    expect(mockUsePreventRemove).toHaveBeenLastCalledWith(
      true,
      expect.any(Function),
    );
    await act(() => preventRemoveCallback!(event));

    expect(latestUnsavedChanges?.confirming).toBe(true);

    await act(() => latestUnsavedChanges!.keepEditing());
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();

    await act(() => preventRemoveCallback!(event));
    await act(() => latestUnsavedChanges!.discardAndLeave());

    expect(mockNavigation.dispatch).toHaveBeenCalledWith(action);
    expect(mockNavigation.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not register clean routes for native removal prevention", async () => {
    await render(createElement(UnsavedChangesHarness, { dirty: false }));

    expect(mockUsePreventRemove).toHaveBeenLastCalledWith(
      false,
      expect.any(Function),
    );
    expect(latestUnsavedChanges?.confirming).toBe(false);
  });

  it("uses the same confirmation state for explicit leave actions", async () => {
    const leave = jest.fn();
    await render(createElement(UnsavedChangesHarness, { dirty: true }));

    await act(() => latestUnsavedChanges!.requestLeave(leave));

    expect(latestUnsavedChanges?.confirming).toBe(true);
    expect(leave).not.toHaveBeenCalled();

    await act(() => latestUnsavedChanges!.discardAndLeave());

    expect(leave).toHaveBeenCalledTimes(1);
  });
});
