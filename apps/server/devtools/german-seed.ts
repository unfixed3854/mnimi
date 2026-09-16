import { parseCloze } from "@mnimi/shared";
import path from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clozeMarkupIsWellFormed,
  imageCueHasFallback,
  imageCuesMatchContext,
} from "../ai/card-rules.ts";
import { ttsTextForCard } from "../tts/eligibility.ts";

type GermanSeedCard = {
  aspect: "meaning" | "gender" | "plural";
  front: string;
  back: string;
  imageCue: boolean;
  audioAsset: string;
};

type GermanSeedNote = {
  sourceText: string;
  domain: "language";
  language: "de";
  imageAsset: string;
  imagePrompt: string;
  metadata: {
    partOfSpeech: "noun";
    imagePrompt: string;
  };
  cards: GermanSeedCard[];
};

export const GERMAN_SEED_NAME = "German";

const GERMAN_ASSET_ROOT = new URL("./seed-assets/german/", import.meta.url);
const MODULE_DIR = import.meta.dirname ??
  path.dirname(fileURLToPath(import.meta.url));

function requireAsset(asset: string, kind: "image" | "audio"): string {
  const extension = kind === "image" ? "png" : "mp3";
  if (!new RegExp(`^[a-z0-9-]+\\.${extension}$`).test(asset)) {
    throw new Error(`Invalid German seed ${kind} asset reference: ${asset}`);
  }

  try {
    const assetPath = GERMAN_ASSET_ROOT.protocol === "file:"
      ? new URL(asset, GERMAN_ASSET_ROOT)
      : path.join(MODULE_DIR, "seed-assets", "german", asset);
    const info = statSync(assetPath);
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw new Error(
      `Missing German seed ${kind} asset: ${asset}`,
      { cause: error },
    );
  }

  return asset;
}

function validateNote(note: GermanSeedNote): GermanSeedNote {
  requireAsset(note.imageAsset, "image");
  if (!note.imagePrompt.trim()) {
    throw new Error(`German seed note has an empty image prompt: ${note.sourceText}`);
  }

  if (
    !imageCuesMatchContext(
      note.cards,
      note.domain,
      note.imagePrompt,
    )
  ) {
    throw new Error(`German seed image cue context is invalid: ${note.sourceText}`);
  }

  for (const card of note.cards) {
    requireAsset(card.audioAsset, "audio");
    if (!clozeMarkupIsWellFormed(card) || parseCloze(card.front) === null) {
      throw new Error(`German seed card has invalid cloze markup: ${note.sourceText}/${card.aspect}`);
    }
    if (!imageCueHasFallback(card)) {
      throw new Error(`German seed image cue has no cloze hint: ${note.sourceText}/${card.aspect}`);
    }
    if (ttsTextForCard(note, card) === null) {
      throw new Error(`German seed card is not TTS eligible: ${note.sourceText}/${card.aspect}`);
    }
  }

  return note;
}

export const GERMAN_SEED = {
  domain: "language" as const,
  language: "de" as const,
  notes: [
    {
      sourceText: "die Banane",
      domain: "language",
      language: "de",
      imageAsset: "banana.png",
      imagePrompt: "a ripe yellow banana on a plain background, no text",
      metadata: {
        partOfSpeech: "noun",
        imagePrompt: "a ripe yellow banana on a plain background, no text",
      },
      cards: [
        {
          aspect: "meaning",
          front: "Das ist eine {{c1::Banane::banana}}.",
          back: "This is a banana.",
          imageCue: true,
          audioAsset: "banana-meaning.mp3",
        },
        {
          aspect: "gender",
          front: "{{c1::Die::feminine article}} Banane ist gelb.",
          back: "The banana is yellow.",
          imageCue: false,
          audioAsset: "banana-gender.mp3",
        },
        {
          aspect: "plural",
          front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
          back: "I see two bananas.",
          imageCue: true,
          audioAsset: "banana-plural.mp3",
        },
      ],
    },
    {
      sourceText: "der Apfel",
      domain: "language",
      language: "de",
      imageAsset: "apple.png",
      imagePrompt: "a shiny red apple on a plain background, no text",
      metadata: {
        partOfSpeech: "noun",
        imagePrompt: "a shiny red apple on a plain background, no text",
      },
      cards: [
        {
          aspect: "meaning",
          front: "Das ist ein {{c1::Apfel::apple}}.",
          back: "This is an apple.",
          imageCue: true,
          audioAsset: "apple-meaning.mp3",
        },
        {
          aspect: "gender",
          front: "{{c1::Der::masculine article}} Apfel ist rot.",
          back: "The apple is red.",
          imageCue: false,
          audioAsset: "apple-gender.mp3",
        },
        {
          aspect: "plural",
          front: "Ich sehe zwei {{c1::Äpfel::apples}}.",
          back: "I see two apples.",
          imageCue: true,
          audioAsset: "apple-plural.mp3",
        },
      ],
    },
    {
      sourceText: "das Haus",
      domain: "language",
      language: "de",
      imageAsset: "house.png",
      imagePrompt: "a small welcoming house with a red roof on a plain background, no text",
      metadata: {
        partOfSpeech: "noun",
        imagePrompt: "a small welcoming house with a red roof on a plain background, no text",
      },
      cards: [
        {
          aspect: "meaning",
          front: "Das ist ein {{c1::Haus::house}}.",
          back: "This is a house.",
          imageCue: true,
          audioAsset: "house-meaning.mp3",
        },
        {
          aspect: "gender",
          front: "{{c1::Das::neuter article}} Haus ist groß.",
          back: "The house is big.",
          imageCue: false,
          audioAsset: "house-gender.mp3",
        },
        {
          aspect: "plural",
          front: "Ich sehe zwei {{c1::Häuser::houses}}.",
          back: "I see two houses.",
          imageCue: true,
          audioAsset: "house-plural.mp3",
        },
      ],
    },
  ] satisfies GermanSeedNote[],
};

for (const note of GERMAN_SEED.notes) validateNote(note);
