import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { Text } from "react-native";
import { Portal } from "@rn-primitives/portal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ButtonText } from "@/components/ui/button";

jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => jest.fn() },
}));

import { AppProviders } from "../app/_layout";

describe("NativeWind root integration", () => {
  it("mounts styled descendants and the Reusables portal host", async () => {
    await render(
      <AppProviders>
        <Text className="text-foreground" testID="nativewind-descendant">
          Ready
        </Text>
        <Portal name="nativewind-root-test">
          <Text testID="nativewind-portal-child">Portal ready</Text>
        </Portal>
      </AppProviders>,
    );

    expect(screen.getByTestId("nativewind-descendant")).toBeTruthy();
    expect(screen.getByTestId("nativewind-portal-host")).toBeTruthy();
    expect(screen.getByTestId("nativewind-portal-child")).toBeTruthy();
  });

  it("keeps the portal host viewport-bound without blocking its siblings", async () => {
    await render(
      <AppProviders>
        <Text>Ready</Text>
      </AppProviders>,
    );

    const portalHost = screen.getByTestId("nativewind-portal-host");
    expect(portalHost.props.className).toBe("absolute inset-0");
    expect(portalHost.props.pointerEvents).toBe("box-none");
  });

  it("projects an alert dialog through the real portal host with accessible actions", async () => {
    const view = await render(
      <AppProviders>
        <AlertDialog>
          <AlertDialogTrigger>
            <Text>Open confirmation</Text>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove deck?</AlertDialogTitle>
              <AlertDialogDescription>
                This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <ButtonText>Cancel</ButtonText>
              </AlertDialogCancel>
              <AlertDialogAction variant="destructive">
                <ButtonText>Remove</ButtonText>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </AppProviders>,
    );

    const nodes = () => view.container.queryAll(() => true);
    const findAlertDialog = () =>
      nodes().find(
        (node) => node.props.role === "alertdialog",
      );
    const hasAlertDialog = () => Boolean(findAlertDialog());
    const hasOverlay = () =>
      nodes().some((node) =>
        String(node.props.className).includes("bg-black/55")
      );

    await fireEvent.press(
      screen.getByRole("button", { name: "Open confirmation" }),
    );

    await waitFor(() => expect(findAlertDialog()).toBeTruthy());
    const alertDialog = findAlertDialog();
    expect(alertDialog?.props.accessibilityViewIsModal).toBe(true);
    expect(alertDialog?.props["aria-modal"]).toBe(true);
    expect(screen.getByText("Remove deck?")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(hasOverlay()).toBe(true);

    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(hasAlertDialog()).toBe(false));

    await fireEvent.press(
      screen.getByRole("button", { name: "Open confirmation" }),
    );
    await waitFor(() => expect(hasAlertDialog()).toBe(true));
    await fireEvent.press(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(hasAlertDialog()).toBe(false));
  });
});
