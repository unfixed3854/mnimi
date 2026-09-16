import { act, fireEvent, render } from "@testing-library/react-native";
import { AdjustCreationDialog } from "@/features/create/adjust-creation-dialog";

describe("AdjustCreationDialog", () => {
  it("offers useful suggestions and submits one cards-only instruction", async () => {
    const submit = jest.fn();
    const view = await render(
      <AdjustCreationDialog open onSubmit={submit} onCancel={jest.fn()} />,
    );
    for (const suggestion of [
      "Make these simpler",
      "Focus on the translation",
      "Use fewer cards",
      "Add an example",
    ]) expect(view.getByRole("button", { name: suggestion })).toBeTruthy();
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Make these simpler" }))
    );
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Adjust cards" }))
    );
    expect(submit).toHaveBeenCalledWith("Make these simpler");
  });

  it("keeps an overlong instruction and shows the 500-character boundary", async () => {
    const submit = jest.fn();
    const view = await render(
      <AdjustCreationDialog open onSubmit={submit} onCancel={jest.fn()} />,
    );
    const instruction = "x".repeat(501);
    await act(async () =>
      fireEvent.changeText(view.getByLabelText("How should the cards change?"), instruction)
    );
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Adjust cards" }))
    );
    expect(view.getByRole("alert")).toHaveTextContent(/500 characters/);
    expect(view.getByLabelText("How should the cards change?").props.value)
      .toBe(instruction);
    expect(submit).not.toHaveBeenCalled();
  });
});
