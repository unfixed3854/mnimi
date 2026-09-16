import {
  fireEvent,
  render,
  screen,
} from "@testing-library/react-native";
import { AppProviders } from "../app/_layout";
import { AddCardDialog } from "@/components/add-card-dialog";
import { CardEditForm } from "@/components/card-edit-form";
import { PortalHost } from "@rn-primitives/portal";
import { createCardDraft } from "@/lib/card-draft";

jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => jest.fn() },
}));

async function renderCard(
  card = createCardDraft("basic", "new-1"),
  overrides: Partial<React.ComponentProps<typeof CardEditForm>> = {},
) {
  const props = {
    card,
    errors: {},
    imageCueAllowed: false,
    onChange: jest.fn(),
    onDelete: jest.fn(),
    onReset: jest.fn(),
    ...overrides,
  };
  return { props, view: await render(<CardEditForm {...props} />) };
}

describe("CardEditForm", () => {
  it("edits an open aspect and a basic card without technical fields", async () => {
    const onChange = jest.fn();
    const card = {
      ...createCardDraft("basic", "new-1"),
      question: "What is inertia?",
      answer: "Resistance to motion change.",
    };
    const view = await render(
      <CardEditForm
        card={card}
        errors={{}}
        imageCueAllowed={false}
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    expect(view.queryByLabelText("Learning focus")).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "More options" }));
    expect(view.getByLabelText("Learning focus")).toBeTruthy();
    expect(view.getByLabelText("Question")).toBeTruthy();
    expect(view.getByLabelText("Answer")).toBeTruthy();
    expect(view.queryByText("Front")).toBeNull();
    expect(view.queryByText("Back")).toBeNull();

    await fireEvent.changeText(view.getByLabelText("Learning focus"), "Physics");
    expect(onChange).toHaveBeenCalledWith({ ...card, aspect: "Physics" });
    expect(view.queryByLabelText("Use the note image as the main cue")).toBeNull();
  });

  it("creates a cloze selection without showing storage markup", async () => {
    const card = {
      ...createCardDraft("cloze", "new-1"),
      sentence: "Ich wohne im Haus.",
      hint: "dom",
    };
    const onChange = jest.fn();
    const view = await render(
      <CardEditForm
        card={card}
        errors={{}}
        imageCueAllowed
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    await fireEvent(view.getByLabelText("Sentence"), "selectionChange", {
      nativeEvent: { selection: { start: 13, end: 17 } },
    });
    await fireEvent.press(view.getByRole("button", { name: "Hide selection" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      answerRange: { start: 13, end: 17 },
    }));
    expect(view.queryByText("{{c1::", { exact: false })).toBeNull();
  });

  it("announces each cloze selection state and exposes selection instructions", async () => {
    const cloze = createCardDraft("cloze", "new-1");
    if (cloze.kind !== "cloze") throw new Error("Expected cloze draft");
    const card = { ...cloze, sentence: "Ich wohne im Haus." };
    const onChange = jest.fn();
    const { view } = await renderCard(card, { onChange });
    const sentence = view.getByLabelText("Sentence");

    expect(sentence.props.accessibilityHint).toBe(
      "Select a word or phrase, then activate Hide selection to make it the hidden answer.",
    );
    const status = () => view.getByTestId("hidden-answer-status");
    expect(status()).toHaveTextContent(
      "No hidden answer selected. Select a word or phrase to hide.",
    );
    expect(status().props.accessibilityLiveRegion).toBe("polite");

    await fireEvent(sentence, "selectionChange", {
      nativeEvent: { selection: { start: 13, end: 17 } },
    });
    expect(status()).toHaveTextContent(
      "Selected “Haus”. Activate Hide selection to make it the hidden answer.",
    );

    await fireEvent.press(view.getByRole("button", { name: "Hide selection" }));
    expect(status()).toHaveTextContent("Hidden answer set to “Haus”.");

    await view.rerender(
      <CardEditForm
        card={{ ...card, answerRange: { start: 13, end: 17 } }}
        errors={{}}
        imageCueAllowed={false}
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    await fireEvent.press(
      view.getByRole("button", { name: "Clear hidden answer" }),
    );
    expect(status()).toHaveTextContent(
      "Hidden answer cleared. Select a word or phrase to hide.",
    );

    await view.rerender(
      <CardEditForm
        card={{ ...card, answerRange: null }}
        errors={{ answerRange: "Select the text to hide." }}
        imageCueAllowed={false}
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    expect(status()).toHaveTextContent("Select the text to hide.");
    expect(status().props.accessibilityLiveRegion).toBe("assertive");
    expect(status().props.accessibilityRole).toBe("alert");
  });

  it("keeps the text cue in the preview when the image is the main cue", async () => {
    const card = {
      ...createCardDraft("cloze", "new-1"),
      sentence: "Ich wohne im Haus.",
      answerRange: { start: 13, end: 17 },
      hint: "dom",
      imageCue: true,
    };
    const { view } = await renderCard(card, { imageCueAllowed: true });

    expect(await view.findByText("[dom]", { exact: false })).toBeTruthy();
    expect(view.getByText("Uses the note image as a cue")).toBeTruthy();
    expect(view.queryByText("{{c1::", { exact: false })).toBeNull();
  });

  it("only offers an image cue for an allowed cloze context", async () => {
    const allowedCard = createCardDraft("cloze", "new-1");
    if (allowedCard.kind !== "cloze") throw new Error("Expected cloze draft");
    const allowed = await render(
      <CardEditForm
        card={{
          ...allowedCard,
          sentence: "Ich wohne im Haus.",
          answerRange: { start: 13, end: 17 },
          hint: "dom",
        }}
        errors={{}}
        imageCueAllowed
        onChange={jest.fn()}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    await fireEvent.press(allowed.getByRole("button", { name: "More options" }));
    expect(allowed.getByLabelText("Use the note image as the main cue"))
      .toBeTruthy();
    await allowed.unmount();

    const unavailable = await renderCard(createCardDraft("cloze", "new-2"));
    expect(
      unavailable.view.queryByLabelText("Use the note image as the main cue"),
    ).toBeNull();
    await unavailable.view.unmount();

    const basic = await renderCard(createCardDraft("basic", "new-3"), {
      imageCueAllowed: true,
    });
    expect(basic.view.queryByLabelText("Use the note image as the main cue"))
      .toBeNull();
  });

  it("keeps the image cue unavailable when the text cue is blank", async () => {
    const card = createCardDraft("cloze", "new-1");
    if (card.kind !== "cloze") throw new Error("Expected cloze draft");
    const { view } = await renderCard({ ...card, hint: "   " }, {
      imageCueAllowed: true,
    });

    expect(view.queryByLabelText("Use the note image as the main cue"))
      .toBeNull();
  });

  it("turns off an existing image cue when its text cue is cleared", async () => {
    const card = createCardDraft("cloze", "new-1");
    if (card.kind !== "cloze") throw new Error("Expected cloze draft");
    const enabledCard = { ...card, hint: "dom", imageCue: true };
    const onChange = jest.fn();
    const { view } = await renderCard(enabledCard, {
      imageCueAllowed: true,
      onChange,
    });

    await fireEvent.changeText(view.getByLabelText("Text cue"), "   ");

    expect(onChange).toHaveBeenCalledWith({
      ...enabledCard,
      hint: "   ",
      imageCue: false,
    });
  });

  it("exposes reset only for persisted cards and keeps actions controlled", async () => {
    const persisted = {
      ...createCardDraft("basic", "saved-1"),
      persistedId: "saved-1",
      question: "Question",
      answer: "Answer",
    };
    const onChange = jest.fn();
    const onDelete = jest.fn();
    const onReset = jest.fn();
    const view = await render(
      <><CardEditForm
        card={persisted}
        errors={{}}
        imageCueAllowed={false}
        onChange={onChange}
        onDelete={onDelete}
        onReset={onReset}
      /><PortalHost /></>,
    );

    expect(view.queryByRole("button", { name: "Reset progress" })).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "More card actions" }));
    await fireEvent.press(view.getByRole("button", { name: "Reset progress" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Reset progress" })).toBeNull();

    await fireEvent.press(view.getByRole("button", { name: "More card actions" }));
    await fireEvent.press(view.getByRole("button", { name: "Delete card" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Delete card" })).toBeNull();

    await view.unmount();
    const fresh = await renderCard(createCardDraft("basic", "new-1"));
    expect(fresh.view.queryByRole("button", { name: "Reset progress" }))
      .toBeNull();
    expect(fresh.view.getByRole("button", { name: "More card actions" })).toBeTruthy();
  });

  it("describes a selected progress reset without relying on color", async () => {
    const card = {
      ...createCardDraft("basic", "saved-1"),
      persistedId: "saved-1",
      resetProgress: true,
    };
    const { view } = await renderCard(card);
    const action = view.getByRole("button", { name: "Keep existing progress" });

    expect(action.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });

  it("renders local and server errors as ordered card-local alerts", async () => {
    const { view } = await renderCard(createCardDraft("basic", "new-1"), {
      errors: {
        aspect: "Describe what this card practises.",
        question: "Enter a question.",
      },
      serverError: "The card changed on another device.",
    });
    const alerts = view.getAllByRole("alert");

    expect(alerts.map((alert) => alert.props.children)).toEqual([
      "Enter a question.",
      "Describe what this card practises.",
      "The card changed on another device.",
    ]);
  });

  it("focuses the first card-content field instead of the prefilled focus", async () => {
    const basic = await renderCard(createCardDraft("basic", "new-1"), {
      autoFocus: true,
    });
    expect(basic.view.queryByLabelText("Learning focus")).toBeNull();
    expect(basic.view.getByLabelText("Question").props.autoFocus).toBe(true);
    await basic.view.unmount();

    const cloze = await renderCard(createCardDraft("cloze", "new-2"), {
      autoFocus: true,
    });
    expect(cloze.view.getByLabelText("Sentence").props.autoFocus).toBe(true);
  });

  it("clears a stale native selection when the sentence changes", async () => {
    const card = {
      ...createCardDraft("cloze", "new-1"),
      sentence: "Ich wohne im Haus.",
    };
    const onChange = jest.fn();
    const { view } = await renderCard(card, {
      imageCueAllowed: true,
      onChange,
    });
    const sentence = view.getByLabelText("Sentence");

    await fireEvent(sentence, "selectionChange", {
      nativeEvent: { selection: { start: 13, end: 17 } },
    });
    expect(
      view.getByRole("button", { name: "Hide selection" }).props
        .accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));

    await fireEvent.changeText(sentence, "Ich wohne dort.");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      sentence: "Ich wohne dort.",
    }));
    expect(
      view.getByRole("button", { name: "Hide selection" }).props
        .accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: true }));
  });

  it("clears the hidden answer while preserving learner cue context", async () => {
    const cloze = createCardDraft("cloze", "new-1");
    if (cloze.kind !== "cloze") throw new Error("Expected cloze draft");
    const card = {
      ...cloze,
      sentence: "Ich wohne im Haus.",
      answerRange: { start: 13, end: 17 },
      hint: "dom",
      imageCue: true,
    };
    const onChange = jest.fn();
    const { view } = await renderCard(card, {
      imageCueAllowed: true,
      onChange,
    });

    expect(view.getByTestId("hidden-answer-status")).toHaveTextContent("Hidden answer: “Haus”.");
    await fireEvent.press(
      view.getByRole("button", { name: "Clear hidden answer" }),
    );
    expect(onChange).toHaveBeenCalledWith({ ...card, answerRange: null });

    await view.rerender(
      <CardEditForm
        card={{ ...card, answerRange: null }}
        errors={{ answerRange: "Select the text to hide." }}
        imageCueAllowed
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
    expect(view.getByText("Uses the note image as a cue")).toBeTruthy();
  });

  it("never exposes cloze storage syntax in the fallback preview", async () => {
    const card = createCardDraft("cloze", "new-1");
    if (card.kind !== "cloze") throw new Error("Expected cloze draft");
    const { view } = await renderCard({
      ...card,
      sentence: "Ich wohne im {{c1::Haus::dom}}.",
      hint: "dom",
    }, { imageCueAllowed: true });

    expect(view.getByText("Ich wohne im Haus.")).toBeTruthy();
    expect(view.queryByText("{{c1::", { exact: false })).toBeNull();
  });
});

describe("AddCardDialog", () => {
  it.each([
    ["Question and answer", "basic"],
    ["Fill in the blank", "cloze"],
  ] as const)("returns the exact %s card type", async (label, kind) => {
    const onOpenChange = jest.fn();
    const onSelect = jest.fn();
    await render(
      <AppProviders>
        <AddCardDialog
          open
          onOpenChange={onOpenChange}
          onSelect={onSelect}
        />
      </AppProviders>,
    );

    await fireEvent.press(screen.getByRole("button", { name: label }));
    expect(onSelect).toHaveBeenCalledWith(kind);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
