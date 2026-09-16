import { Children, type ReactElement } from "react";
import { SystemBars } from "@/components/system-bars";

describe("SystemBars", () => {
  it("requests dark controls for the app's light system-bar backgrounds", () => {
    const bars = SystemBars();
    const [statusBar, navigationBar] = Children.toArray(
      bars.props.children,
    ) as [
      ReactElement<{ barStyle: string }>,
      ReactElement<{ style: string }>,
    ];

    expect(statusBar.props.barStyle).toBe("dark-content");
    expect(navigationBar.props.style).toBe("dark");
  });
});
