import { type ReactElement } from "react";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import { PortalHost } from "@rn-primitives/portal";
import { View } from "react-native";
import type { NoteDetails, NoteUpdateResult } from "@/api/notes";

const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockGenerateImage = jest.fn();
const mockRefetch = jest.fn();
const mockUseNote = jest.fn();
const mockNavigation = {
  addListener: jest.fn(() => jest.fn()),
  dispatch: jest.fn(),
};
let mockSearchParams: Record<string, string | undefined> = {};

jest.mock("@/api/notes", () => ({
  isNoteNotFoundError: (error: { code?: string }) =>
    error?.code === "NOT_FOUND",
  noteMutationIssue: (error: {
    code?: string;
    message?: string;
    data?: { cardId?: string; clientKey?: string; field?: string };
  }) => {
    const message = error?.message ?? "Couldn't save this note.";
    if (error?.code === "CONFLICT") {
      return { kind: "conflict", message };
    }
    const cardKey = error?.data?.cardId ?? error?.data?.clientKey;
    if (cardKey && ["aspect", "front", "back"].includes(error.data?.field ?? "")) {
      return { kind: "card", cardKey, field: error.data?.field, message };
    }
    return { kind: "general", message };
  },
  useNote: (noteId: string) => mockUseNote(noteId),
  useUpdateNote: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useDeleteNote: () => ({ mutateAsync: mockDelete, isPending: false }),
  useGenerateNoteImage: () => ({
    mutateAsync: mockGenerateImage,
    isPending: false,
  }),
}));
jest.mock("@/components/generated-image", () => ({
  GeneratedImage: ({ id, present }: { id: string; present: boolean }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");
    if (!present) return null;
    return createElement(
      Text,
      { accessibilityLabel: `generated-image-${id}` },
      "Image",
    );
  },
}));
jest.mock("@/components/pronunciation-control", () => ({
  PronunciationControl: ({ card }: { card: { id: string } }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");
    return createElement(
      Text,
      { accessibilityLabel: `pronunciation-${card.id}` },
      "Play pronunciation",
    );
  },
}));
jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: ReactElement;
    href: unknown;
    asChild?: boolean;
  }) => asChild ? require("react").cloneElement(children, { href }) : children,
  router: { replace: jest.fn() },
  useLocalSearchParams: () => mockSearchParams,
  useNavigation: () => mockNavigation,
}));
jest.mock("expo-router/react-navigation", () => ({
  usePreventRemove: jest.fn(),
}));

import NoteRoute from "../app/notes/[noteId]";
import { NoteScreen } from "@/features/notes/note-screen";

const initialDetails: NoteDetails = {
  pronunciationSpeed: "normal",
  note: {
    id: "note-1",
    deckId: "deck-1",
    sourceText: "Ich wohne im Haus.",
    revision: 4,
    domain: "language",
    language: "de",
    imagePath: "/images/note.png",
    metadata: { imagePrompt: "a welcoming house" },
  },
  cards: [
    {
      id: "card-1",
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
      id: "card-2",
      cardType: "cloze",
      aspect: "sentence",
      front: "Ich wohne im {{c1::Haus::dom}}.",
      back: "I live in the house.",
      imageCue: true,
      audioEligible: true,
      hasAudio: false,
      audioStatus: "pending",
    },
  ],
  imageGenerating: false,
};

let currentDetails: NoteDetails;
let currentQuery: {
  data?: NoteDetails;
  isLoading: boolean;
  isError?: boolean;
  isRefetchError?: boolean;
  error?: Error;
  refetch: jest.Mock;
};

function cloneDetails(details: NoteDetails = initialDetails): NoteDetails {
  return structuredClone(details);
}

function loadedQuery(details: NoteDetails = currentDetails) {
  return {
    data: details,
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  };
}

function screenTree(noteId = "note-1") {
  return (
    <>
      <NoteScreen noteId={noteId} />
      <View pointerEvents="box-none">
        <PortalHost />
      </View>
    </>
  );
}

function renderScreen(noteId = "note-1") {
  return render(screenTree(noteId));
}

function buttonForText(
  view: Awaited<ReturnType<typeof render>>,
  text: string,
) {
  const button = view.getByText(text).parent;
  expect(button?.props.accessibilityRole).toBe("button");
  return button!;
}

function hasAncestor(node: { parent: unknown } | null, ancestor: unknown) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent as typeof current;
  }
  return false;
}

async function enterEdit(view: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(buttonForText(view, "Edit"));
  expect(view.getByRole("header", { name: "Edit note" })).toBeTruthy();
  for (const disclosure of view.queryAllByRole("button", { name: "More options" })) {
    await fireEvent.press(disclosure);
  }
}

async function addBasicCard(
  view: Awaited<ReturnType<typeof render>>,
  question = "What is a home?",
  answer = "A place where someone lives.",
) {
  await fireEvent.press(view.getByRole("button", { name: "Add card" }));
  await fireEvent.press(
    view.getByRole("button", { name: "Question and answer" }),
  );
  for (const disclosure of view.queryAllByRole("button", { name: "More options" })) {
    await fireEvent.press(disclosure);
  }
  const questions = view.getAllByLabelText("Question");
  const answers = view.getAllByLabelText("Answer");
  await fireEvent.changeText(questions.at(-1)!, question);
  await fireEvent.changeText(answers.at(-1)!, answer);
}

async function deleteCard(
  view: Awaited<ReturnType<typeof render>>,
  index: number,
) {
  await fireEvent.press(
    within(view.getAllByLabelText("Card editor")[index]).getByRole(
      "button",
      { name: "More card actions" },
    ),
  );
  await fireEvent.press(view.getByRole("button", { name: "Delete card" }));
  await fireEvent.press(
    view.getAllByRole("button", { name: "Delete card" }).at(-1)!,
  );
}

describe("NoteScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentDetails = cloneDetails();
    currentQuery = loadedQuery();
    mockUseNote.mockImplementation(() => currentQuery);
    mockRefetch.mockImplementation(async () => ({
      isSuccess: true,
      data: currentDetails,
    }));
    mockUpdate.mockImplementation(async () => ({
      ...currentDetails,
      createdIds: [],
    }));
    mockDelete.mockResolvedValue({ id: "note-1", deckId: "deck-1" });
    mockGenerateImage.mockResolvedValue({ imagePath: "/images/note.png" });
    require("expo-router").router.replace.mockClear();
    mockSearchParams = {};
  });

  it("uses the note source as the heading in read mode", async () => {
    const view = await renderScreen();

    expect(view.getByRole("header", { name: currentDetails.note.sourceText })).toBeTruthy();
    expect(view.queryAllByRole("textbox")).toHaveLength(0);
    expect(view.queryByText(/{{c1::Haus::dom}}/)).toBeNull();
  });

  it("enters a local edit session and submits one explicit atomic diff", async () => {
    const view = await renderScreen();
    await enterEdit(view);
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "grammar",
    );
    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({
      noteId: "note-1",
      expectedRevision: 4,
      creates: [],
      updates: [{
        cardId: "card-1",
        card: {
          aspect: "grammar",
          front: "What does Haus mean?",
          back: "house",
          imageCue: false,
        },
      }],
      deleteCardIds: [],
      resetCardIds: [],
    }));
  });

  it("does not let polling replace local fields, keys, deletion, or reset state", async () => {
    const view = await renderScreen();
    await enterEdit(view);
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "local grammar",
    );
    await addBasicCard(view, "Local question", "Local answer");
    await fireEvent.press(
      within(view.getAllByLabelText("Card editor")[0]).getByRole(
        "button",
        { name: "More card actions" },
      ),
    );
    await fireEvent.press(view.getByRole("button", { name: "Reset progress" }));
    await fireEvent.press(
      view.getAllByRole("button", { name: "Reset progress" }).at(-1)!,
    );
    await deleteCard(view, 1);

    const fresh = cloneDetails();
    currentDetails = {
      ...fresh,
      note: { ...fresh.note, sourceText: "Server replacement", revision: 9 },
      cards: [{
        ...fresh.cards[0],
        aspect: "server grammar",
        front: "Server question",
      }],
    };
    currentQuery = loadedQuery();
    await view.rerender(screenTree());

    expect(view.getAllByLabelText("Learning focus").map((field) =>
      field.props.value
    )).toEqual(["local grammar", "Question and answer"]);
    expect(view.getAllByLabelText("Question").at(-1)?.props.value)
      .toBe("Local question");
    expect(view.getAllByLabelText("Answer").at(-1)?.props.value)
      .toBe("Local answer");
    expect(view.getAllByLabelText("Card editor")).toHaveLength(2);
    expect(view.getByRole("button", { name: "Keep existing progress" }))
      .toBeTruthy();

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        creates: [expect.objectContaining({ clientKey: "new-1" })],
        deleteCardIds: ["card-2"],
        resetCardIds: ["card-1"],
      }),
    ));
  });

  it("opens card type selection immediately from an empty note", async () => {
    currentDetails = { ...cloneDetails(), cards: [] };
    currentQuery = loadedQuery();
    const view = await renderScreen();

    await fireEvent.press(buttonForText(view, "Add card"));

    expect(view.getByRole("header", { name: "Edit note" })).toBeTruthy();
    expect(view.getByText("Choose a card type")).toBeTruthy();
  });

  it.each([
    ["Question and answer", "basic"],
    ["Fill in the blank", "cloze"],
  ] as const)("creates a %s card with a stable local identity", async (label, kind) => {
    currentDetails = { ...cloneDetails(), cards: [] };
    currentQuery = loadedQuery();
    const view = await renderScreen();
    await fireEvent.press(buttonForText(view, "Add card"));
    await fireEvent.press(view.getByRole("button", { name: label }));

    if (kind === "basic") {
      await fireEvent.changeText(view.getByLabelText("Question"), "Question");
      await fireEvent.changeText(view.getByLabelText("Answer"), "Answer");
    } else {
      const sentence = view.getByLabelText("Sentence");
      await fireEvent.changeText(sentence, "Haus steht dort.");
      await fireEvent(
        sentence,
        "selectionChange",
        { nativeEvent: { selection: { start: 0, end: 4 } } },
      );
      await fireEvent.press(
        view.getByRole("button", { name: "Hide selection" }),
      );
    }
    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        creates: [{
          clientKey: "new-1",
          card: expect.objectContaining({
            front: kind === "basic" ? "Question" : "{{c1::Haus}} steht dort.",
          }),
        }],
      }),
    ));
  });

  it("saves deletion of the last persisted card", async () => {
    currentDetails = { ...cloneDetails(), cards: [cloneDetails().cards[0]] };
    currentQuery = loadedQuery();
    const view = await renderScreen();
    await enterEdit(view);
    await deleteCard(view, 0);
    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({
      noteId: "note-1",
      expectedRevision: 4,
      creates: [],
      updates: [],
      deleteCardIds: ["card-1"],
      resetCardIds: [],
    }));
  });

  it("blocks invalid cards locally and preserves every entered field", async () => {
    const view = await renderScreen();
    await enterEdit(view);
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "  ",
    );
    await fireEvent.changeText(view.getByLabelText("Question"), "");
    await fireEvent.changeText(view.getByLabelText("Answer"), "kept answer");
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[1],
      "kept cloze focus",
    );

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    expect(mockUpdate).not.toHaveBeenCalled();
    const firstCard = view.getAllByLabelText("Card editor")[0];
    expect(within(firstCard).getByText("Describe what this card practises."))
      .toBeTruthy();
    expect(within(firstCard).getByText("Enter a question.")).toBeTruthy();
    expect(view.getByLabelText("Answer").props.value).toBe("kept answer");
    expect(view.getAllByLabelText("Learning focus")[1].props.value)
      .toBe("kept cloze focus");
    expect(view.getAllByLabelText("Card editor")).toHaveLength(2);
  });

  it.each([
    ["persisted ID", { cardId: "card-1", field: "front" }],
    ["client key", { clientKey: "new-1", field: "front" }],
  ])("attaches a server error by %s to the matching card", async (_label, data) => {
    const view = await renderScreen();
    await enterEdit(view);
    if ("clientKey" in data) {
      await addBasicCard(view);
    } else {
      await fireEvent.changeText(view.getByLabelText("Question"), "Changed");
    }
    mockUpdate.mockRejectedValueOnce({
      message: "This card was rejected.",
      data,
    });

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    const matchingIndex = "clientKey" in data ? 2 : 0;
    await waitFor(() => expect(
      within(view.getAllByLabelText("Card editor")[matchingIndex]).getByText(
        "This card was rejected.",
      ),
    ).toBeTruthy());
    view.getAllByLabelText("Card editor").forEach((editor, index) => {
      if (index !== matchingIndex) {
        expect(within(editor).queryByText("This card was rejected.")).toBeNull();
      }
    });
  });

  it("retries a network failure with the exact draft and stable client keys", async () => {
    currentDetails = { ...cloneDetails(), cards: [] };
    currentQuery = loadedQuery();
    mockUpdate
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValueOnce({ ...currentDetails, createdIds: [] });
    const view = await renderScreen();
    await fireEvent.press(buttonForText(view, "Add card"));
    await fireEvent.press(
      view.getByRole("button", { name: "Question and answer" }),
    );
    await fireEvent.changeText(view.getByLabelText("Question"), "Kept question");
    await fireEvent.changeText(view.getByLabelText("Answer"), "Kept answer");

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(view.getByText("Network request failed"))
      .toBeTruthy());
    expect(view.getByLabelText("Question").props.value).toBe("Kept question");
    expect(view.getByLabelText("Answer").props.value).toBe("Kept answer");
    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls[0][0]).toEqual(mockUpdate.mock.calls[1][0]);
    expect(mockUpdate.mock.calls[1][0].creates[0].clientKey).toBe("new-1");
  });

  it("keeps a conflict draft until a refetch succeeds", async () => {
    mockUpdate.mockRejectedValue({
      code: "CONFLICT",
      message: "A newer revision is available.",
    });
    mockRefetch
      .mockResolvedValueOnce({ isSuccess: false, data: undefined })
      .mockImplementationOnce(async () => {
        const latest = cloneDetails();
        currentDetails = {
          ...latest,
          note: {
            ...latest.note,
            sourceText: "Latest server source",
            revision: 5,
          },
        };
        currentQuery = loadedQuery();
        return { isSuccess: true, data: currentDetails };
      });
    const view = await renderScreen();
    await enterEdit(view);
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "local focus",
    );

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(view.getByText("This note changed elsewhere"))
      .toBeTruthy());
    await fireEvent.press(view.getByRole("button", { name: "Keep editing" }));
    expect(view.getAllByLabelText("Learning focus")[0].props.value)
      .toBe("local focus");
    expect(mockRefetch).not.toHaveBeenCalled();

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );
    await fireEvent.press(view.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(view.getByText(
      "Couldn't load the latest note. Your changes are still here.",
    )).toBeTruthy());
    expect(view.getAllByLabelText("Learning focus")[0].props.value)
      .toBe("local focus");

    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );
    await fireEvent.press(view.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(view.getByText("Latest server source"))
      .toBeTruthy());
    expect(view.getByRole("header", { name: currentDetails.note.sourceText })).toBeTruthy();
    expect(view.queryByLabelText("Learning focus")).toBeNull();
  });

  it("returns to read mode with the successful update snapshot", async () => {
    const updated: NoteUpdateResult = {
      ...cloneDetails(),
      note: {
        ...cloneDetails().note,
        sourceText: "Updated source snapshot",
        revision: 5,
      },
      cards: [{
        ...cloneDetails().cards[0],
        aspect: "saved grammar",
      }],
      createdIds: [],
    };
    mockUpdate.mockImplementationOnce(async () => {
      currentDetails = updated;
      currentQuery = loadedQuery();
      return updated;
    });
    const view = await renderScreen();
    await enterEdit(view);
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "saved grammar",
    );
    await fireEvent.press(
      view.getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(view.getByText("Updated source snapshot"))
      .toBeTruthy());
    expect(view.getByRole("header", { name: currentDetails.note.sourceText })).toBeTruthy();
    expect(view.queryByLabelText("Learning focus")).toBeNull();
  });

  it("keeps an authoritative cached snapshot visible when its refetch fails", async () => {
    const cached = cloneDetails();
    currentDetails = {
      ...cached,
      note: {
        ...cached.note,
        sourceText: "Saved authoritative snapshot",
        revision: 5,
      },
    };
    currentQuery = {
      data: currentDetails,
      isLoading: false,
      isError: true,
      isRefetchError: true,
      error: new Error("Background refresh failed"),
      refetch: mockRefetch,
    };
    const view = await renderScreen();

    expect(view.getByText("Saved authoritative snapshot")).toBeTruthy();
    expect(view.queryByText("Something went wrong")).toBeNull();
    expect(view.getByText(
      "Couldn't refresh this note. Background refresh failed",
    ).props.accessibilityRole).toBe("alert");
    await fireEvent.press(
      view.getByRole("button", { name: "Retry refresh" }),
    );
    await waitFor(() => expect(mockRefetch).toHaveBeenCalledTimes(1));
  });

  it("hides retained detail data after an authoritative not-found response", async () => {
    currentQuery = {
      data: currentDetails,
      isLoading: false,
      isError: true,
      isRefetchError: true,
      error: Object.assign(new Error("Note not found"), {
        code: "NOT_FOUND",
      }),
      refetch: mockRefetch,
    };
    const view = await renderScreen();

    expect(view.getByText("This note no longer exists.")).toBeTruthy();
    expect(view.queryByText("Ich wohne im Haus.")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.queryByRole("button", { name: "Retry refresh" })).toBeNull();
  });

  it("keeps an active local editor visible when polling refetch fails", async () => {
    const view = await renderScreen();
    await enterEdit(view);
    await fireEvent.changeText(
      view.getAllByLabelText("Learning focus")[0],
      "local focus survives",
    );
    currentQuery = {
      data: currentDetails,
      isLoading: false,
      isError: true,
      isRefetchError: true,
      error: new Error("Polling failed"),
      refetch: mockRefetch,
    };
    await view.rerender(screenTree());

    expect(view.getByRole("header", { name: "Edit note" })).toBeTruthy();
    expect(view.getAllByLabelText("Learning focus")[0].props.value)
      .toBe("local focus survives");
    expect(view.queryByText("Something went wrong")).toBeNull();
    expect(view.getByText("Couldn't refresh this note. Polling failed"))
      .toBeTruthy();
    await fireEvent.press(
      view.getByRole("button", { name: "Retry refresh" }),
    );
    await waitFor(() => expect(mockRefetch).toHaveBeenCalledTimes(1));
  });

  it("replaces the route to the owning deck only after deletion succeeds", async () => {
    const replace = require("expo-router").router.replace as jest.Mock;
    let resolveDelete!: (result: { id: string; deckId: string }) => void;
    mockDelete.mockReturnValueOnce(new Promise((resolve) => {
      resolveDelete = resolve;
    }));
    const view = await renderScreen();
    await fireEvent.press(view.getByRole("button", { name: "More note actions" }));
    await fireEvent.press(buttonForText(view, "Delete note"));
    await fireEvent.press(buttonForText(view, "Delete note"));

    expect(mockDelete).toHaveBeenCalledWith({
      noteId: "note-1",
      expectedRevision: 4,
    });
    expect(replace).not.toHaveBeenCalled();
    await act(async () =>
      resolveDelete({ id: "note-1", deckId: "deck-1" })
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith({
      pathname: "/decks/[deckId]",
      params: { deckId: "deck-1" },
    }));
  });

  it("keeps read mode and does not navigate when deletion fails", async () => {
    const replace = require("expo-router").router.replace as jest.Mock;
    mockDelete.mockRejectedValueOnce(new Error("Deletion failed"));
    const view = await renderScreen();
    await fireEvent.press(view.getByRole("button", { name: "More note actions" }));
    await fireEvent.press(buttonForText(view, "Delete note"));
    await fireEvent.press(buttonForText(view, "Delete note"));

    await waitFor(() => expect(view.getByText("Deletion failed")).toBeTruthy());
    expect(replace).not.toHaveBeenCalled();
    expect(view.getByRole("header", { name: currentDetails.note.sourceText })).toBeTruthy();
  });

  it("reloads a delete conflict and requires a fresh confirmation", async () => {
    const replace = require("expo-router").router.replace as jest.Mock;
    const latest = cloneDetails();
    latest.note.sourceText = "Latest server source before deletion";
    latest.note.revision = 5;
    mockDelete
      .mockRejectedValueOnce({
        code: "CONFLICT",
        message: "A newer revision is available.",
      })
      .mockResolvedValueOnce({ id: "note-1", deckId: "deck-1" });
    mockRefetch.mockImplementationOnce(async () => {
      currentDetails = latest;
      currentQuery = loadedQuery();
      return { isSuccess: true, data: latest };
    });
    const view = await renderScreen();

    await fireEvent.press(view.getByRole("button", { name: "More note actions" }));
    await fireEvent.press(buttonForText(view, "Delete note"));
    await fireEvent.press(buttonForText(view, "Delete note"));

    await waitFor(() => expect(view.getByText(
      "This note changed elsewhere. Review the latest version, then confirm deletion again.",
    )).toBeTruthy());
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenLastCalledWith({
      noteId: "note-1",
      expectedRevision: 4,
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(view.getByText("Latest server source before deletion")).toBeTruthy();
    expect(view.queryByText("Delete this note?")).toBeNull();
    expect(replace).not.toHaveBeenCalled();

    await fireEvent.press(view.getByRole("button", { name: "More note actions" }));
    await fireEvent.press(buttonForText(view, "Delete note"));
    expect(mockDelete).toHaveBeenCalledTimes(1);
    await fireEvent.press(buttonForText(view, "Delete note"));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(2));
    expect(mockDelete).toHaveBeenLastCalledWith({
      noteId: "note-1",
      expectedRevision: 5,
    });
    expect(replace).toHaveBeenCalledWith({
      pathname: "/decks/[deckId]",
      params: { deckId: "deck-1" },
    });
  });

  it("keeps a heading and safe return while the note loads", async () => {
    currentQuery = {
      data: undefined,
      isLoading: true,
      refetch: mockRefetch,
    };
    const view = await renderScreen();

    expect(view.getByRole("header", { name: "Note" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByLabelText("Loading note")).toBeTruthy();
  });

  it("keeps a heading and safe return when the note is missing", async () => {
    currentQuery = {
      data: undefined,
      isLoading: false,
      refetch: mockRefetch,
    };
    const view = await renderScreen();

    expect(view.getByRole("header", { name: "Note" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByText("This note no longer exists.")).toBeTruthy();
  });

  it("offers an explicit retry when fetching the note fails", async () => {
    currentQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("No connection"),
      refetch: mockRefetch,
    };
    const view = await renderScreen();

    expect(view.getByRole("header", { name: "Note" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByText("No connection")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockRefetch).toHaveBeenCalledTimes(1));
  });

  it("retries a failed image generation without leaving read mode", async () => {
    currentDetails = {
      ...cloneDetails(),
      note: { ...cloneDetails().note, imagePath: null },
      cards: [],
    };
    currentQuery = loadedQuery();
    const view = await renderScreen();
    await fireEvent.press(view.getByRole("button", { name: "Try picture again" }));

    await waitFor(() => expect(mockGenerateImage).toHaveBeenCalledWith({
      noteId: "note-1",
      prompt: "a welcoming house",
    }));
    expect(view.getByRole("header", { name: currentDetails.note.sourceText })).toBeTruthy();
  });

  it("keeps pronunciation controls with their owning card", async () => {
    const view = await renderScreen();

    expect(hasAncestor(
      view.getByLabelText("pronunciation-card-1"),
      view.getByLabelText("Meaning card"),
    )).toBe(true);
    expect(hasAncestor(
      view.getByLabelText("pronunciation-card-2"),
      view.getByLabelText("Sentence card"),
    )).toBe(true);
  });
});

describe("NoteRoute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const routeDetails = cloneDetails();
    currentDetails = {
      ...routeDetails,
      note: { ...routeDetails.note, id: "note-route" },
    };
    currentQuery = loadedQuery();
    mockUseNote.mockImplementation(() => currentQuery);
  });

  it("uses the note ID as its only route input", async () => {
    mockSearchParams = { noteId: "note-route" };
    const view = await render(
      <>
        <NoteRoute />
        <View pointerEvents="box-none">
          <PortalHost />
        </View>
      </>,
    );

    expect(mockUseNote).toHaveBeenCalledWith("note-route");
    expect(view.getByRole("header", { name: currentDetails.note.sourceText })).toBeTruthy();
    expect(view.queryAllByRole("textbox")).toHaveLength(0);
  });
});
