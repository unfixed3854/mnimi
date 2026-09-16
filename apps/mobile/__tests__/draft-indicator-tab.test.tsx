import { render } from "@testing-library/react-native";

let mockCreations: any[] = [];
jest.mock("@/api/creations", () => ({
  useCreationList: () => ({ data: mockCreations }),
  actionableCreationCount: (items: any[]) => items.filter((item) =>
    ["needsChoice", "ready", "failed"].includes(item.group)
  ).length,
}));

import { DraftIndicator } from "@/components/draft-indicator";

describe("creation indicator", () => {
  it("counts only choice, ready, and failed creations", async () => {
    mockCreations = [
      { group: "needsChoice" },
      { group: "ready" },
      { group: "failed" },
      { group: "creating" },
      { group: "queued" },
    ];
    const view = await render(<DraftIndicator />);
    expect(view.getByLabelText("3 creations need attention")).toBeTruthy();
  });

  it("stays quiet when no creation needs attention", async () => {
    mockCreations = [{ group: "creating" }, { group: "queued" }];
    const view = await render(<DraftIndicator />);
    expect(view.toJSON()).toBeNull();
  });
});
