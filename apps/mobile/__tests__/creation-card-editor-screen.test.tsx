import { PortalHost } from "@rn-primitives/portal";
import { router } from "expo-router";
import { act, fireEvent, render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));
const mockChange = jest.fn();
const mockDone = jest.fn(() => Promise.resolve(true));
const mockRemove = jest.fn(() => Promise.resolve(true));
let mockCard: any = {
  key: "card-1",
  persistedId: "card-1",
  kind: "basic",
  aspect: "meaning",
  question: "Haus",
  answer: "House",
  imageCue: false,
  resetProgress: false,
};
jest.mock("@/hooks/use-creation-card-edit", () => ({
  useCreationCardEdit: () => ({
    ready: true,
    card: mockCard,
    errors: {},
    serverError: null,
    imageCueAllowed: true,
    saving: false,
    change: mockChange,
    done: mockDone,
    remove: mockRemove,
    retry: jest.fn(),
    refresh: jest.fn(),
  }),
}));

import { CreationCardEditorScreen } from "@/features/create/creation-card-editor-screen";

describe("CreationCardEditorScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCard = {
      key: "card-1",
      persistedId: "card-1",
      kind: "basic",
      aspect: "meaning",
      question: "Haus",
      answer: "House",
      imageCue: false,
      resetProgress: false,
    };
  });

  it("mounts one focused card and keeps advanced fields behind More options", async () => {
    const view = await render(
      <><CreationCardEditorScreen creationId="creation-1" cardKey="card-1" /><PortalHost /></>,
    );
    expect(view.getAllByLabelText("Prompt")).toHaveLength(1);
    expect(view.getAllByLabelText("Answer")).toHaveLength(1);
    expect(view.queryByLabelText("Learning focus")).toBeNull();
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "More options" }))
    );
    expect(view.getByLabelText("Learning focus")).toBeTruthy();
    expect(view.getByLabelText("Use the creation image as a cue")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Remove card" })).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Fewer options" }));
    expect(view.queryByLabelText("Learning focus")).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "More card actions" }));
    await fireEvent.press(view.getByRole("button", { name: "Remove card" }));
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(router.back).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(view.getByLabelText("Prompt"), "Baum");
    expect(mockChange).toHaveBeenCalledWith(expect.objectContaining({ question: "Baum" }));
    await fireEvent.press(view.getByRole("button", { name: "Done" }));
    expect(mockDone).toHaveBeenCalledTimes(1);
    await fireEvent.press(view.getByRole("button", { name: "Back to creation" }));
    expect(router.back).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(view.toJSON())).not.toMatch(/model|storage|\{\{c1::/i);
  });

  it("uses structured cloze fields without exposing serialized syntax", async () => {
    mockCard = {
      key: "card-2",
      persistedId: "card-2",
      kind: "cloze",
      aspect: "usage",
      sentence: "Das Haus ist groß.",
      answerRange: { start: 4, end: 8 },
      hint: "building",
      back: "The house is large.",
      imageCue: true,
      resetProgress: false,
    };
    const view = await render(
      <CreationCardEditorScreen creationId="creation-1" cardKey="card-2" />,
    );
    expect(view.getByLabelText("Sentence")).toBeTruthy();
    expect(view.getByLabelText("Hidden answer").props.value).toBe("Haus");
    expect(view.getByLabelText("Hint").props.value).toBe("building");
    expect(view.getByLabelText("Full meaning (optional)")).toBeTruthy();
    await fireEvent.changeText(view.getByLabelText("Hidden answer"), "Auto");
    expect(mockChange).toHaveBeenCalledWith(expect.objectContaining({
      sentence: "Das Auto ist groß.",
      answerRange: { start: 4, end: 8 },
    }));
    expect(JSON.stringify(view.toJSON())).not.toMatch(/\{\{c1::/);
  });
});
