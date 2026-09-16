import { decksRouter } from "./decks.ts";
import { draftsRouter } from "./drafts.ts";
import { notesRouter } from "./notes.ts";
import { cardsRouter } from "./cards.ts";
import { aiRouter } from "./ai.ts";
import { debugRouter } from "./debug.ts";
import { notificationsRouter } from "./notifications.ts";

export const router = {
  decks: decksRouter,
  drafts: draftsRouter,
  notes: notesRouter,
  cards: cardsRouter,
  ai: aiRouter,
  debug: debugRouter,
  notifications: notificationsRouter,
};

/** The single type the client consumes. */
export type AppRouter = typeof router;
