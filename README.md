<p align="center">
  <img src="docs/assets/readme-hero.png" alt="mnimi — Make it stick. Cream and lavender flashcards on a deep purple background." width="960" />
</p>

<h1 align="center">Turn everyday discoveries into lasting knowledge.</h1>

<p align="center">
  AI-assisted flashcards for Android and the web.<br />
  Capture what you want to learn, shape it into cards, and build a review habit.
</p>

<p align="center">
  <a href="#why-mnimi">Why mnimi?</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Documentation</a>
</p>

## Why mnimi?

mnimi turns a word, idea, or topic into focused flashcards you can make your
own.

- **Start with a thought.** Describe what you want to learn and let AI draft a
  useful set of cards.
- **Stay in control.** Edit anything yourself or ask AI to simplify, add an
  example, or change the focus.
- **Review at the right time.** Spaced repetition works out what to show you
  next based on how well you remember it.
- **Learn your way.** Use fill-in-the-blank cards, images, and pronunciation
  cues on Android or in a browser.

## From curiosity to recall

1. **Capture.** Write down something you want to remember.
2. **Shape.** Generate cards, check them, and adjust the result.
3. **Review.** Recall the answer, reveal it, and rate how well you knew it.

Your work is saved as it is generated, so you can leave the screen, return
later, and retry anything that failed.

## Quick start

You will need [mise](https://mise.jdx.dev/), a browser or Android device, and
either an OpenRouter API key or an eligible ChatGPT plan for the private,
experimental Codex option.

```bash
mise install
bun install --frozen-lockfile
cp apps/mobile/.env.example apps/mobile/.env
cp apps/server/.env.example apps/server/.env
bun run db:migrate
bun run dev
```

Add your provider credentials to `apps/server/.env`. The
[development guide](docs/development.md) explains the remaining configuration
and how to connect a browser, emulator, or physical Android device.

## Documentation

- [Development guide](docs/development.md) — local setup, configuration,
  browser and Android workflows, tests, and project structure
- [Self-hosting guide](docs/self-hosting.md) — deploy the web app and API,
  configure an AI provider, and protect production data
- [Android smoke test](apps/mobile/e2e/android-smoke.md) — verify a release on
  a physical device

mnimi uses Expo and React Native for one Android-and-web client, with a Bun API
and SQLite database behind it. It is built for personal, self-hosted use and is
under active development.
