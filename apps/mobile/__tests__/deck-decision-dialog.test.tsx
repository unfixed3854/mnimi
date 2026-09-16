import { act, fireEvent, render } from "@testing-library/react-native";

import { DeckDecisionDialog } from "@/features/create/deck-decision-dialog";

describe("DeckDecisionDialog", () => {
  it("shows deck names and learning angles without internal routing data", async () => {
    const resolve = jest.fn();
    const view = await render(
      <DeckDecisionDialog
        open
        routing={{
          kind: "ambiguous",
          candidates: [
            {
              deckId: "latin",
              deckName: "Latin",
              learningGoal: "Practice producing the Latin expression.",
            },
            {
              deckId: "philosophy",
              deckName: "Philosophy",
              learningGoal: "Learn the quotation, author, and idea.",
            },
          ],
        }}
        onResolve={resolve}
        onConfirmNewDeck={jest.fn()}
        onChooseExisting={jest.fn()}
        onDiscard={jest.fn()}
      />,
    );
    expect(view.getByText("Where should this go?")).toBeTruthy();
    expect(view.getByText(/Practice producing/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Choose a different deck" })).toBeTruthy();
    fireEvent.press(view.getByRole("button", { name: /Latin/ }));
    expect(resolve).toHaveBeenCalledWith("latin");
    expect(JSON.stringify(view.toJSON())).not.toMatch(/provider/i);
  });

  it("calls the full picker a different deck for ambiguous suggestions", async () => {
    const chooseExisting = jest.fn();
    const view = await render(
      <DeckDecisionDialog
        open
        routing={{
          kind: "ambiguous",
          candidates: [{
            deckId: "german",
            deckName: "German",
            learningGoal: "Translate 'glue stick' to German.",
          }],
        }}
        onResolve={jest.fn()}
        onConfirmNewDeck={jest.fn()}
        onChooseExisting={chooseExisting}
        onDiscard={jest.fn()}
      />,
    );

    fireEvent.press(view.getByRole("button", { name: "Choose a different deck" }));
    expect(chooseExisting).toHaveBeenCalledTimes(1);
  });

  it("keeps the proposed deck editable and offers a real existing-deck choice", async () => {
    const confirm = jest.fn();
    const chooseExisting = jest.fn();
    const view = await render(
      <DeckDecisionDialog
        open
        routing={{
          kind: "newDeck",
          proposedName: "Earth science",
          proposedDescription: "Natural systems and processes",
          learningGoal: "Understand volcano formation",
        }}
        onResolve={jest.fn()}
        onConfirmNewDeck={confirm}
        onChooseExisting={chooseExisting}
        onDiscard={jest.fn()}
      />,
    );
    expect(view.getByRole("header", { name: "Create a new deck?" })).toBeTruthy();
    expect(view.getByText("Mnimi couldn't find a clear match. Review this suggestion or choose an existing deck.")).toBeTruthy();
    await act(async () =>
      fireEvent.changeText(view.getByLabelText("Deck name"), "Geology")
    );
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Create deck" }))
    );
    expect(confirm).toHaveBeenCalledWith({
      name: "Geology",
      description: "Natural systems and processes",
    });
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Choose an existing deck" }))
    );
    expect(chooseExisting).toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(view.getByRole("button", { name: "Discard request" })).toBeTruthy();
  });

  it("does not promise an existing-deck choice when none is available", async () => {
    const view = await render(
      <DeckDecisionDialog
        open
        routing={{
          kind: "newDeck",
          proposedName: "Earth science",
          proposedDescription: "Natural systems and processes",
          learningGoal: "Understand volcano formation",
        }}
        onResolve={jest.fn()}
        onConfirmNewDeck={jest.fn()}
        onDiscard={jest.fn()}
      />,
    );

    expect(view.getByText("Mnimi couldn't find a clear match. Review this suggestion before creating the deck.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Choose an existing deck" })).toBeNull();
  });
});
