import { expect, test } from "@playwright/test";
import type { CreationDetail } from "@/api/creations";
import type { NoteDetails } from "@/api/notes";

test("saved content uses consistent overflow actions and focused editing", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const account = await page.request.post("http://localhost:18787/api/auth/sign-up/email", {
    data: { name: "Consistency", email: "consistency@example.com", password: "browser-test-password" },
  });
  expect(account.ok()).toBe(true);
  await page.goto("/devtools");
  await page.getByRole("button", { name: "Seed German", exact: true }).click();
  await expect(page.getByText(/Created German seed/)).toBeVisible();

  async function inspect(name: string, heading: string, action?: string) {
    for (const { width, height } of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole("heading", { name: heading, exact: true }).scrollIntoViewIfNeeded();
      if (action) await expect(page.getByRole("button", { name: action }).first()).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`consistent-${name}-${width}.png`) });
    }
  }

  await page.goto("/decks");
  await page.getByRole("link", { name: "German", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove deck", exact: true })).toHaveCount(0);
  await inspect("deck", "German", "More deck actions");
  await page.getByRole("button", { name: "More deck actions" }).click();
  await page.getByRole("button", { name: "Pronunciation speed: Normal" }).click();
  await page.getByRole("button", { name: "Slow", exact: true }).click();
  await page.getByRole("button", { name: "More deck actions" }).click();
  await expect(page.getByRole("button", { name: "Pronunciation speed: Slow" })).toBeVisible();
  await page.getByRole("button", { name: "Remove deck", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: "die Banane", exact: true }).click();

  await expect(page.getByRole("button", { name: "Delete note", exact: true })).toHaveCount(0);
  await inspect("note", "die Banane", "More note actions");
  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  await expect(page.getByLabel("Learning focus", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete card", exact: true })).toHaveCount(0);
  await inspect("editor", "Edit note", "More card actions");
  await page.getByRole("button", { name: "More options", exact: true }).first().click();
  await expect(page.getByLabel("Learning focus", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fewer options", exact: true }).click();
  await page.getByRole("button", { name: "More card actions" }).first().click();
  await page.getByRole("button", { name: "Reset progress", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Reset progress", exact: true }).click();
  await expect(page.getByText("Progress will reset when you save.")).toBeVisible();
  await page.getByRole("button", { name: "Keep existing progress", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "More card actions" }).first().click();
  await page.getByRole("button", { name: "Delete card", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "die Banane", exact: true })).toBeVisible();

  await page.goto("/settings");
  await inspect("settings", "Settings");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("paragraph note headings leave the full phone width for source text", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const account = await page.request.post("http://localhost:18787/api/auth/sign-up/email", {
    data: { name: "Long note", email: "long-note@example.com", password: "browser-test-password" },
  });
  expect(account.ok()).toBe(true);
  const note: NoteDetails = {
    pronunciationSpeed: "normal",
    note: {
      id: "long-note", deckId: "long-deck", revision: 1,
      sourceText: "Why does reviewing at increasing intervals help us remember what we learn, and how can we put this into practice?",
      domain: "Learning", language: null, imagePath: null, metadata: {},
    },
    cards: [], imageGenerating: false,
  };
  await page.route("**/rpc/notes/get**", (route) => route.fulfill({ json: { json: note } }));
  await page.goto("/notes/long-note");
  const heading = page.getByRole("heading", { name: note.note.sourceText, exact: true });
  await expect(heading).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("long-note-320.png") });
  const bounds = await heading.boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(288);
  await expect(page.getByRole("button", { name: "More note actions" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("empty states keep first actions reachable on phones and tablets", async ({ page }, testInfo) => {
  const errors: string[] = [];
  // Tab screens can remain mounted underneath the selected screen.
  const emptyState = (title: string) => page.getByTestId("empty-state")
    .filter({ has: page.getByText(title, { exact: true }) });
  page.on("pageerror", (error) => errors.push(error.message));
  const account = await page.request.post("http://localhost:18787/api/auth/sign-up/email", {
    data: { name: "Empty states", email: "empty-states@example.com", password: "browser-test-password" },
  });
  expect(account.ok()).toBe(true);

  async function inspectLayout(name: string, title: string, action?: string) {
    for (const { width, height } of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize({ width, height });
      const empty = emptyState(title);
      await expect(empty).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const bounds = await empty.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      if (action) {
        await expect(empty.getByRole("button", { name: action, exact: true })).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`empty-${name}-${width}.png`) });
    }
  }

  await page.goto("/");
  await expect(page.getByText("You're all caught up", { exact: true })).toBeVisible();
  await inspectLayout("today", "You're all caught up");
  await page.getByRole("link", { name: "Browse decks", exact: true }).click();
  await inspectLayout("decks", "A little curiosity goes a long way", "New deck");
  await page.getByRole("button", { name: "New deck", exact: true }).click();
  await expect(emptyState("A little curiosity goes a long way")).toHaveCount(0);
  await page.getByLabel("New deck name", { exact: true }).fill("A new curiosity");
  await page.getByRole("button", { name: "Create deck", exact: true }).click();
  await page.getByRole("link", { name: "A new curiosity", exact: true }).click();
  await inspectLayout("notes", "Every deck starts with a thought", "Create a note");
  await page.getByRole("button", { name: "Create a note", exact: true }).click();
  await expect(page).toHaveURL(/\/add$/);

  await page.goto("/review");
  await inspectLayout("review", "You're all caught up");
  await expect(page.getByRole("heading")).toHaveCount(1);
  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  const note: NoteDetails = {
    note: {
      id: "empty-note", deckId: "empty-deck", sourceText: "Something worth remembering.",
      revision: 1, domain: "General", language: null, imagePath: null, metadata: {},
    },
    cards: [], imageGenerating: false,
  };
  await page.route("**/rpc/notes/get**", (route) => route.fulfill({ json: { json: note } }));
  await page.goto("/notes/empty-note");
  await inspectLayout("cards", "Give this thought a little practice", "Add card");
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Choose a card type" })
    .getByRole("button", { name: "Question and answer", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Edit note", exact: true })).toBeVisible();
  await inspectLayout("edit", "Give this thought a little practice", "Add card");
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await page.getByRole("button", { name: "Question and answer", exact: true }).click();
  await expect(emptyState("Give this thought a little practice")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Question", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("deck decisions keep one clear action hierarchy", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1024, height: 768 });
  const account = await page.request.post("http://localhost:18787/api/auth/sign-up/email", {
    data: {
      name: "Deck decision test",
      email: "deck-decision@example.com",
      password: "browser-test-password",
    },
  });
  expect(account.ok()).toBe(true);
  const decks = Array.from({ length: 12 }, (_, index) => ({
    id: `existing-deck-${index + 1}`,
    name: `Existing deck ${index + 1}`,
    description: null,
  }));
  await page.route("**/rpc/decks/list**", (route) =>
    route.fulfill({ json: { json: decks } })
  );

  const creation: CreationDetail = {
    id: "decision-creation",
    clientRequestId: "decision-request",
    sourceText: "Klej w języku niemieckim",
    status: "needs_choice",
    activity: null,
    revision: 1,
    attemptId: null,
    deck: null,
    learningGoal: null,
    routing: {
      kind: "newDeck",
      proposedName: "German",
      proposedDescription: "German vocabulary, expressions, and grammar",
      learningGoal: "Learn the German word for glue.",
    },
    cards: [],
    attemptCards: [],
    undoAvailable: false,
    imagePrompt: null,
    imageCueAllowed: false,
    imageStatus: "none",
    draftImageId: null,
    errorCategory: null,
    errorStage: null,
    error: null,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
  };
  await page.route("**/rpc/drafts/get**", (route) =>
    route.fulfill({ json: { json: creation } })
  );
  await page.route("**/rpc/drafts/watch", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "" })
  );
  await page.goto("/creations/decision-creation");

  await expect(page.getByRole("heading", { name: "Create a new deck?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create deck", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose an existing deck" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  await page.screenshot({
    path: testInfo.outputPath("deck-decision-desktop.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Choose an existing deck" }).click();
  const firstDeck = page.getByRole("button", { name: "Existing deck 1", exact: true });
  const lastDeck = page.getByRole("button", { name: "Existing deck 12", exact: true });
  await expect(firstDeck).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("deck-decision-picker.png") });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(firstDeck).toBeInViewport();
  await lastDeck.scrollIntoViewIfNeeded();
  await expect(lastDeck).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("deck-decision-picker-phone.png") });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Discard request", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByText("Discard request?", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("deck-decision-discard.png") });
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("creation preview keeps save visible and routes overflow actions safely", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 667 });
  const account = await page.request.post("http://localhost:18787/api/auth/sign-up/email", {
    data: { name: "Preview test", email: "preview@example.com", password: "browser-test-password" },
  });
  expect(account.ok()).toBe(true);
  const creation: CreationDetail = {
    id: "preview-creation", clientRequestId: "preview-request", sourceText: "die Paprika",
    status: "ready", activity: null, revision: 1, attemptId: "preview-attempt",
    deck: { id: "preview-deck", name: "German", description: null },
    learningGoal: null, routing: null,
    cards: [
      { key: "meaning", aspect: "meaning", front: "Das ist eine {{c1::Paprika::bell pepper}}.", back: "This is a bell pepper.", imageCue: true },
      { key: "gender", aspect: "gender", front: "{{c1::die::article}} Paprika", back: "Paprika is feminine.", imageCue: false },
      { key: "plural", aspect: "plural", front: "Ich habe zwei {{c1::Paprikas::bell peppers}} gekauft.", back: "I bought two bell peppers.", imageCue: false },
    ],
    attemptCards: [], undoAvailable: false, imagePrompt: null, imageCueAllowed: true,
    imageStatus: "failed", draftImageId: null, errorCategory: "provider", errorStage: "image",
    error: "We couldn't create the image. You can retry it.",
    createdAt: "2026-09-09T09:00:00Z", updatedAt: "2026-09-09T09:00:00Z",
  };
  await page.route("**/rpc/drafts/get**", (route) => route.fulfill({ json: { json: creation } }));
  await page.route("**/rpc/drafts/watch", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/rpc/drafts/retryImage", (route) => route.fulfill({ json: { json: creation } }));
  await page.goto("/creations/preview-creation");
  await expect(page.getByText("German · 3 cards", { exact: true })).toBeVisible();
  const save = page.getByRole("button", { name: "Save to German", exact: true });
  await expect(save).toBeInViewport();
  await expect(page.getByRole("link", { name: "Edit meaning card" })).toHaveAttribute("href", "/creations/preview-creation/card/meaning");
  await expect(page.getByText(creation.error!, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Picture cue", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("creation-preview-phone.png") });
  const savePosition = await save.boundingBox();
  await page.getByTestId("screen-scroll-content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole("button", { name: "Adjust with AI", exact: true })).toBeInViewport();
  expect(await save.boundingBox()).toEqual(savePosition);
  await page.screenshot({ path: testInfo.outputPath("creation-preview-actions.png") });

  await page.getByRole("button", { name: "More creation actions" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Change deck and regenerate", exact: true }).click();
  await expect(page.getByText("Choose a new deck", { exact: true })).toBeVisible();
  await expect(page.getByText(/A different deck changes the learning angle/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More creation actions" }).click();
  await page.screenshot({ path: testInfo.outputPath("creation-preview-overflow.png") });
  await page.getByRole("button", { name: "Discard creation", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/creations\/preview-creation$/);
  await page.getByRole("button", { name: "Try picture again" }).click();
  await expect(save).toBeEnabled();

  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByTestId("screen-scroll-content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole("button", { name: "Adjust with AI", exact: true })).toBeInViewport();
  await expect(save).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("creation-preview-small-phone.png") });

  // Resize the mounted screen across the tablet breakpoint and back to a phone.
  // Content and sticky actions must stay centered together without overflowing.
  for (const { width, height, contentWidth, x } of [
    { width: 767, height: 1024, contentWidth: 735, x: 16 },
    { width: 768, height: 1024, contentWidth: 720, x: 24 },
    { width: 1024, height: 768, contentWidth: 720, x: 152 },
    { width: 375, height: 667, contentWidth: 343, x: 16 },
  ]) {
    await page.setViewportSize({ width, height });
    const scroll = page.getByTestId("screen-scroll-content");
    for (const region of [scroll, page.getByTestId("screen-footer")]) {
      await expect.poll(async () => {
        const bounds = await region.boundingBox();
        return bounds && { x: bounds.x, width: bounds.width };
      }).toEqual({ x, width: contentWidth });
    }
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await expect(save).toBeInViewport();
    const position = await save.boundingBox();
    await page.screenshot({ path: testInfo.outputPath(`creation-preview-${width}.png`) });
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(page.getByRole("button", { name: "Adjust with AI", exact: true })).toBeInViewport();
    expect(await save.boundingBox()).toEqual(position);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  creation.status = "adjusting";
  creation.activity = "adjusting";
  creation.revision++;
  await page.reload();
  await expect(save).toBeDisabled();
  const disabledCard = page.getByRole("link", { name: "Edit meaning card" });
  await expect(disabledCard).toBeDisabled();
  const bounds = await disabledCard.boundingBox();
  expect(bounds).not.toBeNull();
  // A real pointer click on a child must not follow a disabled card's link.
  await page.mouse.click(bounds!.x + 30, bounds!.y + 50);
  await expect(disabledCard).not.toHaveAttribute("href");
  await expect(page).toHaveURL(/\/creations\/preview-creation$/);
  expect(errors).toEqual([]);
});

test("creation activity moves while waiting and respects reduced motion", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 667 });
  const account = await page.request.post("http://localhost:18787/api/auth/sign-up/email", {
    data: { name: "Generation test", email: "generation@example.com", password: "browser-test-password" },
  });
  expect(account.ok()).toBe(true);
  const creation: CreationDetail = {
    id: "visual-creation",
    clientRequestId: "visual-request",
    sourceText: "die Paprika",
    status: "generating",
    activity: null,
    revision: 1,
    attemptId: "visual-attempt",
    deck: { id: "visual-deck", name: "German", description: null },
    learningGoal: null,
    routing: null,
    cards: [],
    attemptCards: [],
    undoAvailable: false,
    imagePrompt: null,
    imageCueAllowed: false,
    imageStatus: "none",
    draftImageId: null,
    errorCategory: null,
    errorStage: null,
    error: null,
    createdAt: "2026-09-09T09:00:00Z",
    updatedAt: "2026-09-09T09:00:00Z",
  };
  // Hold real creation states without running a provider or changing app data.
  await page.route("**/rpc/drafts/get**", (route) => route.fulfill({ json: { json: creation } }));
  await page.route("**/rpc/drafts/watch", (route) => route.fulfill({
    contentType: "text/event-stream", body: "",
  }));
  await page.goto("/creations/visual-creation");
  await expect(page.getByRole("progressbar", { name: /Writing cards/ })).toBeVisible();
  const card = page.getByTestId("creation-activity-card");
  await expect(page.getByTestId("creation-activity-dot-0")).toBeVisible();
  const transform = await card.evaluate((element) => getComputedStyle(element).transform);
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(transform);
  // Drive the browser visibility events consumed by React Native's AppState.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const resumedTransform = await card.evaluate((element) => getComputedStyle(element).transform);
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(resumedTransform);
  await expect(page.getByRole("button", { name: "Cancel creation", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath("generation-iphone-se.png") });

  // Reanimated reads the OS preference at startup, as it does on a native launch.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(card).toBeVisible();
  const motionSamples = await card.evaluate(async (element) => {
    const samples: string[] = [];
    const started = performance.now();
    while (performance.now() - started < 350) {
      await new Promise(requestAnimationFrame);
      samples.push(getComputedStyle(element).transform);
    }
    return [...new Set(samples)];
  });
  expect(motionSamples).toHaveLength(1);
  await expect(page.getByRole("progressbar", { name: /Writing cards/ })).toBeVisible();

  creation.attemptCards = [{
    key: "pepper-meaning", aspect: "meaning", front: "die Paprika", back: "bell pepper", imageCue: false,
  }];
  creation.revision++;
  await page.reload();
  await expect(page.getByText("1 card created so far", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("bell pepper", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("generation-first-card.png") });
  expect(errors).toEqual([]);
});

test("explains missing cookie sessions after registration and sign-in, then allows retry", async ({ page }) => {
  // Reproduce a browser discarding Set-Cookie while the API accepts credentials.
  const authRequests = /\/api\/auth\/sign-(?:up|in)\/email$/;
  await page.route(authRequests, async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["set-cookie"];
    await page.context().clearCookies();
    await route.fulfill({ response, headers });
  });
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill("missing-cookie@example.com");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const signupAlert = page.getByRole("alert");
  await expect(signupAlert).toContainText("Account created, but sign-in failed");
  await expect(signupAlert).toContainText("Please sign in to continue");
  await expect(signupAlert).toContainText("cookies are allowed for this site");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("missing-cookie@example.com");

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("missing-cookie@example.com");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const signinAlert = page.getByRole("alert");
  await expect(signinAlert).toContainText("Couldn't sign you in");
  await expect(signinAlert).toContainText("Please try signing in again");
  await expect(signinAlert).toContainText("cookies are allowed for this site");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("browser-test-password");

  await page.unroute(authRequests);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

test("browser account, decks, settings, private media, and reloads", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const reachabilityProbes: string[] = [];
  const bearerRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("generate_204")) reachabilityProbes.push(request.url());
    if (request.headers().authorization) bearerRequests.push(request.url());
  });
  await page.route("**/generate_204", (route) => route.abort());
  await page.goto("/signup");
  await page.evaluate(() => localStorage.setItem("mnimi.bearer", "legacy-browser-token"));
  await page.getByLabel("Email", { exact: true }).fill("browser@example.com");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name.endsWith(".session_token"));
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  expect(await page.evaluate(() => localStorage.getItem("mnimi.bearer"))).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("today-desktop.png") });

  await page.getByRole("tab", { name: "Decks" }).click();
  await page.getByRole("button", { name: "New deck", exact: true }).click();
  await page.getByLabel("New deck name", { exact: true }).fill("Browser deck");
  await page.getByRole("button", { name: "Create deck", exact: true }).click();
  await page.getByText("Browser deck", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser deck", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Browser deck", exact: true })).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Native language: English" }).click();
  await page.getByRole("button", { name: "Polski", exact: true }).click();
  await expect(page.getByRole("button", { name: "Native language: Polski" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Native language: Polski" })).toBeVisible();

  await page.getByRole("button", { name: "Development tools" }).click();
  await page.getByRole("button", { name: "Seed German", exact: true }).click();
  await expect(page.getByText(/Created German seed/)).toBeVisible();
  await page.getByRole("button", { name: "Reset SRS", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();

  await page.goto("/decks");
  await page.getByText("German", { exact: true }).click();
  await page.getByText("die Banane", { exact: true }).click();
  const noteUrl = page.url();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Text cue", { exact: true }).first().fill("Browser cue");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
  const unloading = page.waitForEvent("dialog");
  const reload = page.evaluate(() => window.location.reload());
  const unloadDialog = await unloading;
  expect(unloadDialog.type()).toBe("beforeunload");
  await unloadDialog.dismiss();
  await reload;
  await expect(page.getByRole("heading", { name: "Edit note" })).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL(noteUrl);
  await expect(page.getByLabel("Text cue", { exact: true }).first()).toHaveValue("Browser cue");
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "German", exact: true })).toBeVisible();

  await page.goto("/review");
  await expect(page.getByRole("button", { name: "Show answer", exact: true })).toBeVisible();
  const pronunciation = page.waitForResponse((response) =>
    response.url().includes("/audio/cards/") && response.status() === 200
  );
  await page.getByRole("button", { name: "Show answer", exact: true }).click();
  await pronunciation;
  await expect(page.getByRole("button", { name: "Stop pronunciation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop pronunciation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play pronunciation", exact: true })).toBeVisible();
  await expect(page.locator('img[src^="blob:"]')).toBeVisible();
  await expect.poll(() => page.locator('img[src^="blob:"]').evaluate((image) =>
    (image as HTMLImageElement).naturalWidth
  )).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Good", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("review-narrow.png"), fullPage: true });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("browser@example.com");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(reachabilityProbes).toEqual([]);
  expect(bearerRequests).toEqual([]);
});

test("synchronizes sign-out and account changes across tabs", async ({ page, context }) => {
  async function createAccount(tab: typeof page, email: string) {
    await tab.goto("/signup");
    await tab.getByLabel("Email", { exact: true }).fill(email);
    await tab.getByLabel("Password", { exact: true }).fill("browser-test-password");
    await tab.getByLabel("Confirm password", { exact: true }).fill("browser-test-password");
    await tab.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(tab.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  }
  await createAccount(page, "tabs-a@example.com");
  await page.getByRole("tab", { name: "Decks" }).click();
  await page.getByRole("button", { name: "New deck", exact: true }).click();
  await page.getByLabel("New deck name", { exact: true }).fill("Account A deck");
  await page.getByRole("button", { name: "Create deck", exact: true }).click();
  await expect(page.getByText("Account A deck", { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/settings");
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await createAccount(other, "tabs-b@example.com");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Decks" }).click();
  await expect(page.getByText("A little curiosity goes a long way", { exact: true })).toBeVisible();
  await expect(page.getByText("Account A deck", { exact: true })).not.toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByText("tabs-b@example.com", { exact: true })).toBeVisible();
});

test("finishes an older cookie-writing preference response before another tab signs out", async ({ page, context }) => {
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill("ordered-cookies@example.com");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.goto("/settings");
  const other = await context.newPage();
  await other.goto("/settings");
  await expect(other.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  let release!: () => void;
  let received!: () => void;
  const heldResponse = new Promise<void>((resolve) => { release = resolve; });
  const responseReceived = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/auth/update-user", async (route) => {
    const response = await route.fetch();
    received();
    await heldResponse;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Native language: English" }).click();
  await page.getByRole("button", { name: "Polski", exact: true }).click();
  await responseReceived;
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  try {
    await expect.poll(() => other.evaluate(async () =>
      (await navigator.locks.query()).pending?.some((lock) => lock.name === "mnimi.cookie-session")
    )).toBe(true);
  } finally {
    release();
  }
  await expect(other.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name.endsWith(".session_token"))).toBe(false);
});

test("auth alert keeps session recovery visible and diagnostics collapsed", async ({ page }, testInfo) => {
  await page.route("**/api/auth/sign-up/email", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill("alert@example.com");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByLabel("Confirm password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Account created, but sign-in failed");
  await expect(alert).toContainText("Please sign in to continue");
  await expect(page.getByText(/Current API:/)).toHaveCount(0);
  for (const width of [375, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(alert).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`auth-alert-${width}.png`) });
  }
  const details = page.getByRole("button", { name: "Technical details" });
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(/Current API:/)).toBeVisible();
  await details.click();
  await expect(page.getByText(/Current API:/)).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("alert@example.com");
});
