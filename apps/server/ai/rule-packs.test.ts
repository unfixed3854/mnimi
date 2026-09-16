import { describe, expect, it } from "vitest";
import {
  BASE_PACK,
  buildSystemPrompt,
  LANGUAGE_PACK,
  selectRulePacks,
} from "./rule-packs.ts";
import type { Classification } from "./schemas.ts";

const languageNote: Classification = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};

const conceptNote: Classification = {
  domain: "concept",
  language: null,
  partOfSpeech: null,
};

describe("selectRulePacks", () => {
  it("loads base and language packs for a language note", () => {
    expect(selectRulePacks(languageNote)).toEqual(["base", "language"]);
  });

  it("loads only the base pack for a non-language note", () => {
    expect(selectRulePacks(conceptNote)).toEqual(["base"]);
  });

  it("always includes the base pack whatever the domain", () => {
    for (const domain of ["language", "concept", "person", "phrase"]) {
      const packs = selectRulePacks({ ...conceptNote, domain });
      expect(packs).toContain("base");
    }
  });
});

describe("buildSystemPrompt", () => {
  it("includes both base and language packs for a language note", () => {
    const prompt = buildSystemPrompt(languageNote);
    expect(prompt).toContain(BASE_PACK);
    expect(prompt).toContain(LANGUAGE_PACK);
  });

  it("does not leak vocabulary rules into a concept note", () => {
    const prompt = buildSystemPrompt(conceptNote);
    expect(prompt).not.toContain(LANGUAGE_PACK);
  });

  it("always states the minimum information principle", () => {
    expect(buildSystemPrompt(conceptNote).toLowerCase()).toContain(
      "minimum information",
    );
  });

  it("names the target language when one is known", () => {
    expect(buildSystemPrompt(languageNote)).toContain("de");
  });

  it("teaches the cloze markup to every domain, not just language notes", () => {
    for (const note of [conceptNote, languageNote]) {
      const prompt = buildSystemPrompt(note);
      expect(prompt).toContain("{{c1::");
      expect(prompt.toLowerCase()).toContain("cloze");
    }
  });

  it("asks for one deletion per card", () => {
    expect(buildSystemPrompt(conceptNote).toLowerCase()).toContain(
      "exactly one",
    );
  });

  it("no longer asks for isolated recognition and production pairs", () => {
    const prompt = buildSystemPrompt(languageNote).toLowerCase();
    expect(prompt).not.toContain("recognition goes");
    expect(prompt).toContain("test production");
  });

  it("shows the hint living inside the deletion", () => {
    expect(buildSystemPrompt(conceptNote)).toContain("{{c1::answer::hint}}");
  });

  it("defaults every card to a non-image cue in the base pack", () => {
    const prompt = buildSystemPrompt(conceptNote);
    expect(prompt).toContain("Every card has an imageCue boolean");
    expect(prompt).toContain("Set it to false");
  });

  it("keeps language generation production-only", () => {
    const prompt = buildSystemPrompt(languageNote);
    expect(prompt).toContain("Keep generation production-only");
    expect(prompt).toContain("Do not generate a reverse card");
  });

  it("keeps IPA and other pronunciation cards out of language generation", () => {
    const prompt = buildSystemPrompt(languageNote).toLowerCase();
    expect(prompt).toContain("do not generate pronunciation cards");
    expect(prompt).toContain("ipa or other phonetic transcription");
    expect(prompt).toContain("pronunciation is provided separately through audio");
    expect(prompt).not.toContain("add a pronunciation card");
  });

  it("marks lexical and plural language examples as image cues with inline hints", () => {
    const prompt = buildSystemPrompt(languageNote);
    expect(prompt).toContain("front: Das ist eine {{c1::Banane::banana}}.");
    expect(prompt).toContain("front: Ich sehe zwei {{c1::Bananen::bananas}}.");
    expect(prompt.match(/imageCue: true/g)).toHaveLength(2);
  });

  it("keeps the language gender example off the image cue", () => {
    const prompt = buildSystemPrompt(languageNote);
    expect(prompt).toContain("front: {{c1::Die::definite article}} Banane ist gelb.");
    expect(prompt).toContain("imageCue: false");
  });
});
