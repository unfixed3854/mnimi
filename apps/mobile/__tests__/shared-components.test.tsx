import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { AppProviders } from "../app/_layout";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { LoadingState } from "@/components/loading-state";
import { PrimaryButton } from "@/components/primary-button";
import { SelectionDialog } from "@/components/selection-dialog";
import { TextField } from "@/components/text-field";

jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => jest.fn() },
}));

describe("shared mobile components", () => {
  it("announces content loading once without exposing placeholder controls", async () => {
    const view = await render(<LoadingState layout="registration" label="Checking registration" />);
    expect(view.getByRole("progressbar", { name: "Checking registration" }).props.accessibilityState)
      .toEqual({ busy: true });
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByText("Checking registration")).toBeNull();
  });

  it.each(
    [
      [
        "empty",
        <EmptyState illustration="decks" message="Create a deck to begin." title="No decks yet" />,
        "summary",
        "No decks yet",
      ],
      [
        "error",
        <ErrorState message="Try again later." onRetry={jest.fn()} />,
        "alert",
        "Something went wrong",
      ],
    ] as const,
  )(
    "keeps the %s state role without adding a page header",
    async (_state, component, role, title) => {
      const view = await render(component);

      const root = view.getByText(title).parent;
      expect(root?.props.accessibilityRole).toBe(role);
      expect(view.queryByRole("header")).toBeNull();
    },
  );

  it("keeps PrimaryButton busy and destructive semantics", async () => {
    const onPress = jest.fn(() => new Promise<void>(() => undefined));
    await render(
      <PrimaryButton destructive onPress={onPress}>
        Remove
      </PrimaryButton>,
    );

    fireEvent.press(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Remove" }).props
          .accessibilityState,
      ).toEqual(expect.objectContaining({ busy: true, disabled: true }));
    });
  });

  it.each(
    [
      ["tonal", "#315C4D"],
      ["selection", "#1D1C1A"],
    ] as const,
  )(
    "uses a contrasting pending spinner for the %s action treatment",
    async (variant, color) => {
      const view = await render(
        <PrimaryButton pending variant={variant} onPress={jest.fn()}>
          Loading
        </PrimaryButton>,
      );

      expect(view.toJSON()).toMatchObject({
        children: expect.arrayContaining([
          expect.objectContaining({ props: { color } }),
        ]),
      });
    },
  );

  it("exposes selected state without treating the control as disabled", async () => {
    await render(
      <PrimaryButton selected variant="selected" onPress={jest.fn()}>
        German
      </PrimaryButton>,
    );

    expect(
      screen.getByRole("button", { name: "German" }).props.accessibilityState,
    ).toEqual(expect.objectContaining({ selected: true, disabled: false }));
  });

  it("passes layout classes to the underlying press target", async () => {
    await render(
      <PrimaryButton className="flex-1" onPress={jest.fn()}>
        Good
      </PrimaryButton>,
    );

    expect(screen.getByRole("button", { name: "Good" }).props.className)
      .toContain("flex-1");
  });

  it("keeps long selection option lists scrollable", async () => {
    const options = Array.from({ length: 12 }, (_, index) => ({
      label: `Deck ${index + 1}`,
      value: `deck-${index + 1}`,
    }));
    const view = await render(
      <AppProviders>
        <SelectionDialog
          open
          title="Native language"
          value=""
          options={options}
          onOpenChange={jest.fn()}
          onValueChange={jest.fn()}
        />
      </AppProviders>,
    );

    expect(view.getByTestId("selection-options").props).toEqual(
      expect.objectContaining({
        accessibilityLabel: "Native language options",
        accessibilityRole: "list",
      }),
    );
    expect(view.getByRole("button", { name: "Deck 12" })).toBeTruthy();
  });

  it("keeps TextField label and accessible error", async () => {
    await render(<TextField label="Front" error="Required" />);

    expect(screen.getByLabelText("Front")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });

  it("forwards TextInput selection events through TextField", async () => {
    const onSelectionChange = jest.fn();
    await render(
      <TextField label="Sentence" onSelectionChange={onSelectionChange} />,
    );
    const event = { nativeEvent: { selection: { start: 4, end: 8 } } };

    await fireEvent(
      screen.getByLabelText("Sentence"),
      "selectionChange",
      event,
    );

    expect(onSelectionChange).toHaveBeenCalledWith(event);
  });

  it("keeps confirm and cancellation controlled independently", async () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn(() => new Promise<void>(() => undefined));

    await render(
      <AppProviders>
        <ConfirmDialog
          confirmLabel="Remove"
          message="This cannot be undone."
          onCancel={onCancel}
          onConfirm={onConfirm}
          title="Remove deck?"
          visible
        />
      </AppProviders>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await fireEvent(screen.getByRole("button", { name: "Remove" }), "press");

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Remove" }).props
          .accessibilityState,
      ).toEqual(expect.objectContaining({ busy: true, disabled: true }));
      expect(
        screen.getByRole("button", { name: "Cancel" }).props
          .accessibilityState,
      ).toEqual(expect.objectContaining({ disabled: true }));
    });
  });

  it("does not treat a direct confirm press as cancellation", async () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn(() => new Promise<void>(() => undefined));

    await render(
      <AppProviders>
        <ConfirmDialog
          confirmLabel="Remove"
          message="This cannot be undone."
          onCancel={onCancel}
          onConfirm={onConfirm}
          title="Remove deck?"
          visible
        />
      </AppProviders>,
    );

    await fireEvent(screen.getByRole("button", { name: "Remove" }), "press");

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("names a safe alternative without changing existing confirm callers", async () => {
    await render(
      <AppProviders>
        <ConfirmDialog
          cancelLabel="Keep editing"
          confirmLabel="Discard changes"
          message="Your changes are still here."
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
          title="Discard changes?"
          visible
        />
      </AppProviders>,
    );

    expect(
      screen.getByRole("button", { name: "Keep editing" }),
    ).toBeTruthy();
  });
});
