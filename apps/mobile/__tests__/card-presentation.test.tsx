import { render } from "@testing-library/react-native";
import { View } from "react-native";
import {
  CardPresentation,
  formatAspectLabel,
} from "@/components/card-presentation";

function MockImage({ accessibilityLabel }: { accessibilityLabel: string }) {
  return <View accessibilityLabel={accessibilityLabel} />;
}

const cloze = {
  id: "card-1",
  cardType: "cloze" as const,
  aspect: "past_tense",
  front: "Ich wohne im {{c1::Haus::dom}}.",
  back: "Mieszkam w domu.",
  imageCue: true,
};

describe("CardPresentation", () => {
  it("formats an open aspect mechanically rather than through an enum", () => {
    expect(formatAspectLabel("  arbitrary_domain-focus  ")).toBe(
      "Arbitrary domain focus",
    );
  });

  it("shows prompt hint and full answer in inspection mode", async () => {
    const view = await render(
      <CardPresentation card={cloze} mode="inspection" />,
    );

    expect(view.getByText("Past tense")).toBeTruthy();
    expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
    expect(view.getByText("Haus")).toBeTruthy();
    expect(view.getByText("Mieszkam w domu.", { exact: false })).toBeTruthy();
    expect(view.getByText("Uses the note image as a cue")).toBeTruthy();
    expect(view.queryByText(/{{c1::Haus::dom}}/)).toBeNull();
  });

  it("keeps the hint visible beside an image slot", async () => {
    const view = await render(
      <CardPresentation
        card={cloze}
        image={<MockImage accessibilityLabel="House image cue" />}
        mode="review"
        revealed={false}
      />,
    );

    expect(view.getByLabelText("House image cue")).toBeTruthy();
    expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
    expect(view.queryByText("Haus")).toBeNull();
  });

  it("shows a basic card's separate question and answer in inspection mode", async () => {
    const view = await render(
      <CardPresentation
        card={{
          id: "card-2",
          cardType: "basic",
          aspect: "meaning",
          front: "der Apfel",
          back: "the apple",
          imageCue: false,
        }}
        mode="inspection"
      />,
    );

    expect(view.getByText("der Apfel", { exact: true })).toBeTruthy();
    expect(view.getByText("the apple", { exact: true })).toBeTruthy();
    expect(view.queryByText(/{{c\d+::/)).toBeNull();
  });

  it("stretches a lone footer control vertically to bound its replay actions", async () => {
    const view = await render(
      <CardPresentation
        card={cloze}
        footer={<View accessibilityLabel="Pronunciation replay controls" />}
        mode="inspection"
      />,
    );

    const footer = view.getByLabelText("Pronunciation replay controls").parent;
    expect(footer?.props.className).toContain("flex-col");
    expect(footer?.props.className).toContain("items-stretch");
  });
});
