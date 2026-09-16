import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("root protected-route guard", () => {
  it("keeps every deep-linked app route behind the signed-in stack guard", () => {
    const layout = readFileSync(
      resolve(__dirname, "../app/_layout.tsx"),
      "utf8",
    );
    const protectedBlock = layout.match(
      /<Stack\.Protected guard=\{Boolean\(session\)\}>([\s\S]*?)<\/Stack\.Protected>/,
    )?.[1] ?? "";

    for (
      const route of [
        "(tabs)",
        "decks/[deckId]",
        "notes/[noteId]",
        "review/index",
        "review/[deckId]",
        "devtools",
      ]
    ) {
      expect(protectedBlock).toContain(`name=\"${route}\"`);
    }
  });
});
