import { render, screen } from "@testing-library/react-native";
import { Button, ButtonText } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

describe("UI primitives", () => {
  it("renders a destructive button with accessible text", async () => {
    await render(
      <Button variant="destructive">
        <ButtonText>Remove</ButtonText>
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("keeps the compact Button press target at least 48px high", async () => {
    await render(
      <Button size="sm">
        <ButtonText>Compact</ButtonText>
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Compact" }).props.className)
      .toContain("min-h-[48px]");
  });

  it.each(
    [
      ["tonal", "bg-primary-soft"],
      ["selection", "bg-surface"],
      ["selected", "bg-primary-soft"],
      ["destructiveQuiet", "bg-destructive-soft"],
    ] as const,
  )("renders the %s action treatment", async (variant, className) => {
    await render(
      <Button variant={variant}>
        <ButtonText>{variant}</ButtonText>
      </Button>,
    );

    expect(screen.getByRole("button", { name: variant }).props.className)
      .toContain(className);
  });

  it("exposes selected Button state with a non-color affordance", async () => {
    await render(
      <Button variant="selected">
        <ButtonText>German</ButtonText>
      </Button>,
    );

    const button = screen.getByRole("button", { name: "German" });
    expect(button.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(button.props.className).toContain("border-2");
  });

  it("renders text, input, and card composition", async () => {
    await render(
      <Card>
        <CardContent>
          <Text>Deck</Text>
          <Input accessibilityLabel="Deck name" />
        </CardContent>
      </Card>,
    );
    expect(screen.getByText("Deck")).toBeTruthy();
    expect(screen.getByLabelText("Deck name")).toBeTruthy();
  });

  it("merges project typography and semantic text color tokens independently", () => {
    expect(cn("text-body text-foreground")).toBe(
      "text-body text-foreground",
    );
    expect(
      cn("text-body font-semibold text-primary-foreground"),
    ).toBe("text-body font-semibold text-primary-foreground");
    expect(
      cn(
        "text-body font-semibold text-primary-foreground",
        "text-caption",
      ),
    ).toBe("font-semibold text-primary-foreground text-caption");
    expect(
      cn("text-body text-primary-foreground", "text-destructive-foreground"),
    ).toBe("text-body text-destructive-foreground");
  });
});
