import type { ComponentProps } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { PortalHost } from "@rn-primitives/portal";
import { View } from "react-native";
import type { NoteDetails } from "@/api/notes";

jest.mock("@/components/generated-image", () => ({
  GeneratedImage: ({ present }: { present: boolean }) => {
    if (!present) return null;
    const react = require("react");
    const createElement = react["createElement"];
    const { Text, View } = require("react-native");
    return createElement(
      View,
      { accessibilityLabel: "note-image" },
      createElement(Text, undefined, "Generated image"),
    );
  },
}));
jest.mock("@/components/pronunciation-control", () => ({
  PronunciationControl: ({
    card,
  }: {
    card: { id: string; pronunciationSpeed?: string };
  }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text, View } = require("react-native");
    return createElement(
      View,
      {
        accessibilityLabel:
          `pronunciation-${card.id}-${card.pronunciationSpeed ?? "missing"}`,
      },
      createElement(Text, undefined, "Play pronunciation"),
    );
  },
}));
jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: import("react").ReactElement;
    href: unknown;
    asChild?: boolean;
  }) => asChild ? require("react").cloneElement(children, { href }) : children,
}));

import { NoteReadView } from "@/features/notes/note-read-view";

const details: NoteDetails = {
  pronunciationSpeed: "slow",
  note: {
    id: "note-1",
    deckId: "deck-1",
    sourceText: "Ich wohne im Haus.",
    revision: 4,
    domain: "German",
    language: "de",
    imagePath: "/notes/note-1.png",
    metadata: { imagePrompt: "A welcoming house" },
  },
  cards: [
    {
      id: "card-basic",
      cardType: "basic",
      aspect: "meaning",
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
      aspect: "sentence",
      front: "Ich wohne im {{c1::Haus::dom}}.",
      back: "Mieszkam w domu.",
      imageCue: true,
      audioEligible: false,
      hasAudio: false,
      audioStatus: null,
    },
  ],
  imageGenerating: false,
};

function renderView(overrides: Partial<ComponentProps<typeof NoteReadView>> = {}) {
  return render(
    <>
      <NoteReadView
        details={details}
        deleteError={null}
        deletePending={false}
        imageError={null}
        imagePending={false}
        refreshError={null}
        onAddCard={jest.fn()}
        onDelete={jest.fn()}
        onEdit={jest.fn()}
        onRetryImage={jest.fn()}
        onRetryRefresh={jest.fn()}
        {...overrides}
      />
      <View pointerEvents="box-none">
        <PortalHost />
      </View>
    </>,
  );
}

function hasAncestor(node: { parent: unknown } | null, ancestor: unknown) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent as typeof current;
  }
  return false;
}

function buttonForText(view: Awaited<ReturnType<typeof render>>, text: string) {
  const button = view.getByText(text).parent;
  expect(button?.props.accessibilityRole).toBe("button");
  return button!;
}

describe("NoteReadView", () => {
  it("renders a note as learning content rather than a disabled form", async () => {
    const view = await renderView();

    expect(view.getByRole("header", { name: details.note.sourceText })).toBeTruthy();
    expect(view.getByText("2 cards")).toBeTruthy();
    expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
    expect(view.getByText("Haus")).toBeTruthy();
    expect(view.getByText("Mieszkam w domu.", { exact: false })).toBeTruthy();
    expect(view.queryByText(/{{c1::Haus::dom}}/)).toBeNull();
    expect(view.queryAllByRole("textbox")).toHaveLength(0);
    expect(view.getAllByLabelText("note-image")).toHaveLength(1);
  });

  it("keeps editing and deck return actions at the reading boundary", async () => {
    const onEdit = jest.fn();
    const view = await renderView({ onEdit });

    await fireEvent.press(buttonForText(view, "Edit"));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(view.getByRole("link", { name: "Back to deck" }).props.href)
      .toEqual({ pathname: "/decks/[deckId]", params: { deckId: "deck-1" } });
  });

  it("shows the shared image once before cards without repeating an image cue", async () => {
    const view = await renderView();
    expect(view.getAllByLabelText("note-image")).toHaveLength(1);
    const content = JSON.stringify(view.toJSON());
    expect(content.indexOf("note-image")).toBeLessThan(content.indexOf("Meaning card"));
    expect(view.getByText("Uses the note image as a cue")).toBeTruthy();
    expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
  });

  it("keeps pronunciation with its matching inspected card", async () => {
    const view = await renderView();
    const pronunciation = view.getByLabelText("pronunciation-card-basic-slow");
    const card = view.getByLabelText("Meaning card");

    expect(hasAncestor(pronunciation, card)).toBe(true);
    expect(view.queryByLabelText("pronunciation-card-cloze-slow")).toBeNull();
  });

  it("offers a direct add-card action for an empty note", async () => {
    const onAddCard = jest.fn();
    const view = await renderView({
      details: { ...details, cards: [] },
      onAddCard,
    });

    expect(view.getByText("Give this thought a little practice")).toBeTruthy();
    await fireEvent.press(buttonForText(view, "Add card"));
    expect(onAddCard).toHaveBeenCalledTimes(1);
  });

  it("shows an accessible picture placeholder while generation is in progress", async () => {
    const generating = await renderView({
      details: {
        ...details,
        note: { ...details.note, imagePath: null },
        imageGenerating: true,
      },
    });
    expect(generating.getByRole("progressbar", { name: "Generating a picture" }).props.accessibilityState)
      .toMatchObject({ busy: true });
    expect(generating.queryByText("Generating a picture…")).toBeNull();
    expect(generating.queryByRole("button", { name: "Try picture again" })).toBeNull();
  });

  it("offers a failed image another generation attempt", async () => {
    const onRetryImage = jest.fn().mockResolvedValue(undefined);
    const retry = await renderView({
      details: { ...details, note: { ...details.note, imagePath: null } },
      onRetryImage,
    });
    await fireEvent.press(retry.getByRole("button", { name: "Try picture again" }));
    await waitFor(() => expect(onRetryImage).toHaveBeenCalledTimes(1));
  });

  it("keeps a retry error accessible", async () => {
    const failed = await renderView({
      details: { ...details, note: { ...details.note, imagePath: null } },
      imageError: "That didn't work either. Try again in a moment.",
    });
    expect(failed.getByText("That didn't work either. Try again in a moment.")
      .props.accessibilityRole).toBe("alert");
    expect(failed.getByText("That didn't work either. Try again in a moment."))
      .toHaveTextContent("That didn't work either. Try again in a moment.");
  });

  it("requires explicit confirmation before deleting a note", async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    const view = await renderView({ onDelete });

    expect(view.queryByRole("button", { name: "Delete note" })).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "More note actions" }));
    await fireEvent.press(buttonForText(view, "Delete note"));

    expect(view.getByText("Delete this note?")).toBeTruthy();
    expect(view.getByText(/cards, review history, picture, and pronunciation audio/))
      .toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.press(buttonForText(view, "Delete note"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("keeps note content present when deletion reports an error", async () => {
    const view = await renderView({ deleteError: "Couldn't delete this note." });

    expect(view.getByText("Couldn't delete this note.").props.accessibilityRole)
      .toBe("alert");
    expect(view.getByText("Couldn't delete this note.")).toHaveTextContent("Couldn't delete this note.");
    expect(view.getByRole("header", { name: details.note.sourceText })).toBeTruthy();
    expect(view.getByText("Haus")).toBeTruthy();
  });
});
