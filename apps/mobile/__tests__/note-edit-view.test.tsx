import type { ComponentProps } from "react";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import { AppProviders } from "../app/_layout";
import type { NoteCard } from "@/api/notes";
import { createCardDraft, type NoteEditDraft } from "@/lib/card-draft";

type NavigationEvent = {
  data: { action: unknown };
};

const mockNavigation = {
  dispatch: jest.fn(),
};
let preventRemove: ((event: NavigationEvent) => void) | undefined;

jest.mock("expo-router", () => ({
  useNavigation: () => mockNavigation,
}));
jest.mock("expo-router/react-navigation", () => ({
  usePreventRemove: (
    _enabled: boolean,
    callback: (event: NavigationEvent) => void,
  ) => {
    preventRemove = callback;
  },
}));
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => jest.fn() },
}));

import { NoteEditView } from "@/features/notes/note-edit-view";

const originalCards: NoteCard[] = [
  {
    id: "card-basic",
    cardType: "basic",
    aspect: "Vocabulary",
    front: "What does Haus mean?",
    back: "house",
    imageCue: false,
    audioEligible: true,
    hasAudio: true,
    audioStatus: "ready",
  },
  {
    id: "card-cloze",
    cardType: "cloze",
    aspect: "Case",
    front: "Ich wohne im {{c1::Haus::dom}}.",
    back: "Mieszkam w domu.",
    imageCue: true,
    audioEligible: false,
    hasAudio: false,
    audioStatus: null,
  },
];

const draft: NoteEditDraft = {
  noteId: "note-1",
  revision: 4,
  originalCards,
  cards: [
    {
      key: "card-basic",
      persistedId: "card-basic",
      kind: "basic",
      aspect: "Vocabulary",
      question: "What does Haus mean?",
      answer: "house",
      imageCue: false,
      resetProgress: false,
    },
    {
      key: "card-cloze",
      persistedId: "card-cloze",
      kind: "cloze",
      aspect: "Case",
      sentence: "Ich wohne im Haus.",
      answerRange: { start: 13, end: 17 },
      hint: "dom",
      back: "Mieszkam w domu.",
      imageCue: true,
      resetProgress: false,
    },
  ],
};

function dirtyDraft(): NoteEditDraft {
  return {
    ...draft,
    cards: [
      { ...draft.cards[0], aspect: "Everyday vocabulary" },
      draft.cards[1],
    ],
  };
}

const newBasicCard = createCardDraft("basic", "new-basic");
if (newBasicCard.kind !== "basic") throw new Error("Expected basic draft");
const newCardOnlyDraft: NoteEditDraft = {
  ...draft,
  cards: [{
    ...newBasicCard,
    question: "Question",
    answer: "Answer",
  }],
};

const deletionCases: Array<[
  string,
  NoteEditDraft,
  string,
  string,
  string,
]> = [
  [
    "persisted",
    draft,
    "Delete this card?",
    "Saving will permanently delete this card and its review history.",
    "Delete card",
  ],
  [
    "new",
    newCardOnlyDraft,
    "Remove this new card?",
    "This unsaved card will be removed from this editing session.",
    "Remove card",
  ],
];

function defaultProps(
  overrides: Partial<ComponentProps<typeof NoteEditView>> = {},
): ComponentProps<typeof NoteEditView> {
  return {
    draft,
    errorsByKey: {},
    imageCueAllowed: true,
    refreshError: null,
    saveIssue: null,
    saving: false,
    serverErrorsByKey: {},
    startAdding: false,
    onAddCard: jest.fn(() => "new-card"),
    onCancel: jest.fn(),
    onChangeCard: jest.fn(),
    onClearSaveIssue: jest.fn(),
    onDeleteCard: jest.fn(),
    onReloadLatest: jest.fn().mockResolvedValue(undefined),
    onRetryRefresh: jest.fn().mockResolvedValue(undefined),
    onResetCard: jest.fn(),
    onSave: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function renderView(
  overrides: Partial<ComponentProps<typeof NoteEditView>> = {},
) {
  const props = defaultProps(overrides);
  const view = await render(
    <AppProviders>
      <NoteEditView {...props} />
    </AppProviders>,
  );
  for (const disclosure of view.queryAllByRole("button", { name: "More options" })) {
    await fireEvent.press(disclosure);
  }
  return { props, view };
}

describe("NoteEditView", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    preventRemove = undefined;
  });

  it("keeps save reachable and edits learner-facing card fields", async () => {
    const onChangeCard = jest.fn();
    const { view } = await renderView({ onChangeCard });

    expect(view.getByRole("header", { name: "Edit note" })).toBeTruthy();
    expect(view.getByTestId("screen-footer")).toBeTruthy();
    expect(view.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(view.queryByText("{{c1::", { exact: false })).toBeNull();
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "case",
    );
    expect(onChangeCard).toHaveBeenCalledWith(
      "card-basic",
      expect.objectContaining({ aspect: "case" }),
    );
  });

  it.each([
    ["Question and answer", "basic", "Question"],
    ["Fill in the blank", "cloze", "Sentence"],
  ] as const)(
    "adds and focuses a trailing %s card through the controlled callback",
    async (label, kind, focusLabel) => {
      const key = `new-${kind}`;
      const onAddCard = jest.fn(() => key);
      const { props, view } = await renderView({ onAddCard, startAdding: true });

      expect(view.getByText("Choose a card type")).toBeTruthy();
      await fireEvent.press(view.getByRole("button", { name: label }));

      expect(onAddCard).toHaveBeenCalledWith(kind);
      expect(view.queryByText("Choose a card type")).toBeNull();

      const added = createCardDraft(kind, key);
      const nextDraft = { ...draft, cards: [...draft.cards, added] };
      await view.rerender(
        <AppProviders>
          <NoteEditView {...props} draft={nextDraft} />
        </AppProviders>,
      );

      for (const disclosure of view.queryAllByRole("button", { name: "More options" })) {
        await fireEvent.press(disclosure);
      }
      expect(view.getAllByLabelText("Learning focus").map((field) =>
        field.props.value
      )).toEqual(["Vocabulary", "Case", added.aspect]);
      expect(view.getAllByLabelText(focusLabel).at(-1)?.props.autoFocus)
        .toBe(true);
    },
  );

  it("retains direct card entry when a note has no cards", async () => {
    const { view } = await renderView({
      draft: { ...draft, originalCards: [], cards: [] },
    });

    expect(view.getByText("Give this thought a little practice")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Add card" }));
    expect(view.getByText("Choose a card type")).toBeTruthy();
  });

  it.each(deletionCases)(
    "distinguishes confirmation for a %s card deletion",
    async (_state, currentDraft, title, message, confirmLabel) => {
      const onDeleteCard = jest.fn();
      const { view } = await renderView({ draft: currentDraft, onDeleteCard });

      await fireEvent.press(
        within(view.getAllByLabelText("Card editor")[0]).getByRole(
          "button",
          { name: "More card actions" },
        ),
      );
      await fireEvent.press(view.getByRole("button", { name: confirmLabel }));

      expect(view.getByText(title)).toBeTruthy();
      expect(view.getByText(message)).toBeTruthy();
      expect(view.getAllByText(title)).toHaveLength(1);
      expect(onDeleteCard).not.toHaveBeenCalled();

      await fireEvent.press(
        view.getAllByRole("button", { name: confirmLabel }).at(-1)!,
      );
      await waitFor(() => {
        expect(onDeleteCard).toHaveBeenCalledWith(currentDraft.cards[0].key);
      });
    },
  );

  it("confirms a progress reset and clears an already-pending reset immediately", async () => {
    const onResetCard = jest.fn();
    const { props, view } = await renderView({ onResetCard });

    await fireEvent.press(
      within(view.getAllByLabelText("Card editor")[0]).getByRole(
        "button",
        { name: "More card actions" },
      ),
    );
    await fireEvent.press(view.getByRole("button", { name: "Reset progress" }));
    expect(view.getByText("Reset this card's progress?")).toBeTruthy();
    expect(view.getByText(
      "Saving will delete this card's review history and make it due now. Its content will stay.",
    )).toBeTruthy();
    expect(onResetCard).not.toHaveBeenCalled();

    await fireEvent.press(
      view.getAllByRole("button", { name: "Reset progress" }).at(-1)!,
    );
    await waitFor(() => {
      expect(onResetCard).toHaveBeenCalledWith("card-basic");
    });

    onResetCard.mockClear();
    const resetDraft = {
      ...draft,
      cards: [{ ...draft.cards[0], resetProgress: true }, draft.cards[1]],
    };
    await view.rerender(
      <AppProviders>
        <NoteEditView {...props} draft={resetDraft} />
      </AppProviders>,
    );
    await fireEvent.press(
      within(view.getAllByLabelText("Card editor")[0]).getByRole(
        "button",
        { name: "Keep existing progress" },
      ),
    );

    expect(onResetCard).toHaveBeenCalledWith("card-basic");
    expect(view.queryByText("Reset this card's progress?")).toBeNull();
  });

  it("keeps local and server errors with their matching card", async () => {
    const { view } = await renderView({
      errorsByKey: {
        "card-basic": { question: "Enter a question." },
      },
      serverErrorsByKey: {
        "card-basic": "This answer was rejected.",
      },
    });
    const [basicEditor, clozeEditor] = view.getAllByLabelText("Card editor");

    expect(within(basicEditor).getAllByRole("alert").map((alert) =>
      alert.props.children
    )).toEqual(["Enter a question.", "This answer was rejected."]);
    expect(within(clozeEditor).queryByRole("alert")).toBeNull();
  });

  it("keeps a general save failure beside an enabled retry action", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { view } = await renderView({
      draft: dirtyDraft(),
      onSave,
      saveIssue: { kind: "general", message: "Couldn't save this note." },
    });
    const footer = view.getByTestId("screen-footer");
    const save = within(footer).getByRole("button", { name: "Save changes" });

    expect(within(footer).getByRole("alert")).toHaveTextContent(
      "Couldn't save this note.",
    );
    expect(save.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
    await fireEvent.press(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(within(footer).getByRole("alert")).toBeTruthy();
  });

  it("keeps local conflict edits or explicitly loads the latest snapshot", async () => {
    const onClearSaveIssue = jest.fn();
    const onReloadLatest = jest.fn().mockResolvedValue(undefined);
    const { props, view } = await renderView({
      draft: dirtyDraft(),
      onClearSaveIssue,
      onReloadLatest,
      saveIssue: {
        kind: "conflict",
        message: "A newer revision is available.",
      },
    });

    expect(view.getByText("This note changed elsewhere")).toBeTruthy();
    expect(view.getByText(
      "A newer revision is available. Your local changes are still here.",
    )).toBeTruthy();
    expect(view.getAllByText("This note changed elsewhere")).toHaveLength(1);
    await fireEvent.press(
      view.getByRole("button", { name: "Keep editing" }),
    );
    expect(onClearSaveIssue).toHaveBeenCalledTimes(1);
    expect(view.getAllByLabelText("Learning focus")[0].props.value)
      .toBe("Everyday vocabulary");
    expect(onReloadLatest).not.toHaveBeenCalled();

    await view.rerender(
      <AppProviders>
        <NoteEditView {...props} />
      </AppProviders>,
    );
    await fireEvent.press(
      view.getByRole("button", { name: "Load latest" }),
    );
    await waitFor(() => expect(onReloadLatest).toHaveBeenCalledTimes(1));
  });

  it("guards dirty Cancel until the user explicitly discards the session", async () => {
    const onCancel = jest.fn();
    const { view } = await renderView({ draft: dirtyDraft(), onCancel });

    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));
    expect(view.getByText("Discard changes?")).toBeTruthy();
    expect(view.getByText(
      "Your card edits, additions, deletions, and pending progress resets will be discarded.",
    )).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();

    await fireEvent.press(
      view.getByRole("button", { name: "Keep editing" }),
    );
    expect(onCancel).not.toHaveBeenCalled();
    expect(view.getAllByLabelText("Learning focus")[0].props.value)
      .toBe("Everyday vocabulary");

    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));
    await fireEvent.press(
      view.getByRole("button", { name: "Discard changes" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("guards a captured back action and dispatches it only after discard", async () => {
    const { view } = await renderView({ draft: dirtyDraft() });
    const event = {
      data: { action: { type: "GO_BACK" } },
    };

    await act(() => preventRemove!(event));
    expect(view.getByText("Discard changes?")).toBeTruthy();
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();

    await fireEvent.press(
      view.getByRole("button", { name: "Keep editing" }),
    );
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();

    await act(() => preventRemove!(event));
    await fireEvent.press(
      view.getByRole("button", { name: "Discard changes" }),
    );
    expect(mockNavigation.dispatch).toHaveBeenCalledWith(event.data.action);
    expect(mockNavigation.dispatch).toHaveBeenCalledTimes(1);
  });

  it("calls clean Cancel immediately", async () => {
    const onCancel = jest.fn();
    const { view } = await renderView({ onCancel });

    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(view.queryByText("Discard changes?")).toBeNull();
  });
});
