import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { Rating } from "ts-fsrs";

const firstCard = {
  id: "card-1",
  noteId: "note-1",
  aspect: "meaning",
  front: "der Apfel",
  back: "the apple",
  imageCue: false,
  hasImage: false,
  audioEligible: false,
  hasAudio: false,
  audioStatus: null,
  due: new Date("2026-01-01"),
  stability: 1,
  difficulty: 5,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  state: 0,
  lastReview: null,
};

let mockCards = [firstCard];
const mockMutateAsync = jest.fn();
const mockUseDueCards = jest.fn((
  _deckId?: string,
  _shuffleSeed?: number,
) => ({
  data: mockCards,
  isLoading: false,
  isError: false,
}));

jest.mock("@/api/review", () => ({
  useDueCards: (deckId?: string, shuffleSeed?: number) =>
    mockUseDueCards(deckId, shuffleSeed),
  useGradeCard: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
jest.mock("@/auth/session-store", () => ({
  useSession: () => ({ user: { ttsAutoplay: true } }),
}));
jest.mock("@/components/pronunciation-control", () => ({
  PronunciationControl: () => null,
}));
jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: any;
    href: unknown;
    asChild?: boolean;
  }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");

    return asChild
      ? react.cloneElement(children, { href })
      : createElement(Text, undefined, children);
  },
}));

import { ReviewScreen } from "@/features/review/review-screen";

describe("ReviewScreen", () => {
  beforeEach(() => {
    mockCards = [firstCard];
    mockMutateAsync.mockReset();
    mockUseDueCards.mockClear();
  });

  it("keeps one shuffle seed for the mounted review session", async () => {
    const random = jest.spyOn(Math, "random").mockReturnValue(0.25);
    const view = await render(<ReviewScreen deckId="deck-1" />);

    const firstSeed = mockUseDueCards.mock.calls[0]?.[1];
    view.rerender(<ReviewScreen deckId="deck-1" />);

    expect(firstSeed).toBe(1_073_741_824);
    expect(mockUseDueCards.mock.calls.at(-1)?.[1]).toBe(firstSeed);
    random.mockRestore();
  });

  it("keeps new due cards outside the mounted review session", async () => {
    const secondCard = {
      ...firstCard,
      id: "card-2",
      noteId: "note-2",
      front: "die Birne",
    };
    const outsideCard = {
      ...firstCard,
      id: "card-101",
      noteId: "note-101",
      front: "die Pflaume",
    };
    mockCards = [firstCard, secondCard];
    const view = await render(<ReviewScreen deckId="deck-1" />);

    mockCards = [outsideCard, secondCard];
    view.rerender(<ReviewScreen deckId="deck-1" />);

    await waitFor(() => {
      expect(view.getByText("die Birne", { exact: false })).toBeTruthy();
    });
    expect(view.queryByText("die Pflaume", { exact: false })).toBeNull();

    mockCards = [outsideCard];
    view.rerender(<ReviewScreen deckId="deck-1" />);

    await waitFor(() => {
      expect(view.getByText("You're all caught up")).toBeTruthy();
    });
  });

  it("withholds grades until the learner explicitly reveals the answer", async () => {
    const view = await render(<ReviewScreen deckId="deck-1" />);

    expect(view.getByText("1 left · meaning")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Good" })).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Show answer" }));
    expect(view.getByRole("button", { name: "Good" })).toBeTruthy();
  });

  it("shows an image-cued cloze hint before the answer is revealed", async () => {
    mockCards = [{
      ...firstCard,
      imageCue: true,
      front: "Ich mag {{c1::Bananen::fruit}}.",
    }];
    const view = await render(<ReviewScreen deckId="deck-1" />);

    expect(view.getByText("[fruit]", { exact: false })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Text hint" })).toBeNull();
  });

  it("replaces an ordinary cloze hint with its revealed answer and back", async () => {
    mockCards = [{
      ...firstCard,
      front: "Ich mag {{c1::Bananen::fruit}}.",
      back: "I like bananas.",
    }];
    const view = await render(<ReviewScreen deckId="deck-1" />);

    expect(view.getByText("[fruit]", { exact: false })).toBeTruthy();

    await fireEvent.press(view.getByRole("button", { name: "Show answer" }));

    expect(view.queryByText("[fruit]", { exact: false })).toBeNull();
    expect(view.getByText("Bananen")).toBeTruthy();
    expect(view.getByText("I like bananas.", { exact: false })).toBeTruthy();
  });

  it("keeps the first due card visible when grading fails", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("offline"));
    const view = await render(<ReviewScreen deckId="deck-1" />);

    await fireEvent.press(view.getByRole("button", { name: "Show answer" }));
    await fireEvent.press(view.getByRole("button", { name: "Good" }));

    await waitFor(() => {
      expect(view.getByText("der Apfel", { exact: false })).toBeTruthy();
    });
    expect(view.getByRole("alert")).toBeTruthy();
  });

  it("groups the revealed grades into two equal decision rows", async () => {
    const view = await render(<ReviewScreen deckId="deck-1" />);
    await fireEvent.press(view.getByRole("button", { name: "Show answer" }));

    expect(view.getByText("How well did you remember?")).toBeTruthy();
    expect(view.getByTestId("review-grade-row-again-hard").props.className)
      .toContain("flex-row");
    expect(view.getByTestId("review-grade-row-good-easy").props.className)
      .toContain("flex-row");
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(view.getByRole("button", { name: label }).props.className)
        .toContain("flex-1");
    }
  });

  it("keeps every grade wired to its existing FSRS value", async () => {
    const view = await render(<ReviewScreen deckId="deck-1" />);
    await fireEvent.press(view.getByRole("button", { name: "Show answer" }));
    await fireEvent.press(view.getByRole("button", { name: "Easy" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      card: firstCard,
      rating: Rating.Easy,
    });
  });

  it("provides a stable back destination to the reviewed deck", async () => {
    const view = await render(<ReviewScreen deckId="deck-1" />);

    expect(view.getByRole("link", { name: "Back to deck" })).toBeTruthy();
  });

  it("returns an all-decks review to Today", async () => {
    const view = await render(<ReviewScreen />);

    const back = view.getByRole("link", { name: "Back to Today" });
    expect(back.props.href).toBe("/(tabs)");
  });

  it("keeps Review as the only heading after the queue is complete", async () => {
    mockCards = [];
    const view = await render(<ReviewScreen deckId="deck-1" />);

    expect(view.getAllByRole("header")).toHaveLength(1);
    expect(view.getByRole("header", { name: "Review" })).toBeTruthy();
    expect(view.queryByRole("header", { name: "You're all caught up" }))
      .toBeNull();
    expect(view.getByText("You're all caught up")).toBeTruthy();
  });

  it("describes the all-decks queue when a Today review is complete", async () => {
    mockCards = [];
    const view = await render(<ReviewScreen />);

    expect(view.getByText("Nothing more to review right now. Take a moment to let it sink in.")).toBeTruthy();
  });
});
