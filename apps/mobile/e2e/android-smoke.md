# Android development-build acceptance

Run this manual matrix on a physical Android device or a representative Android
emulator. Capture evidence against the exact build under test. A development
build is required: Expo Go cannot validate Android remote notifications.

## Evidence record

| Field | Value |
| --- | --- |
| Date and tester | Not run |
| Device or emulator | Not run |
| Android version | Not run |
| Development-build commit | Not run |
| API origin | Not run |
| Expo/EAS project id configured | Not run |
| Push delivery environment configured | Not run |
| Screenshot directory | Not run |
| Overall result | Not run |
| Notes and blockers | Not run |

Do not mark the overall result Pass without recording the target, commit, API
origin, and screenshots or screen recordings for the creation paths.

## Start the stack

1. Find a LAN address reachable from the device. Do not use `localhost`,
   `127.0.0.1`, or `0.0.0.0` as the mobile API host.
2. Prepare package-local configuration. Keep server secrets out of the mobile
   environment.
3. Build, install, and launch the development client:

   ```bash
   cp apps/mobile/.env.example apps/mobile/.env
   cp apps/server/.env.example apps/server/.env
   bun run db:migrate
   adb devices -l
   bun run mobile:android
   bun run mobile:smoke
   ```

The launcher validates `EXPO_PUBLIC_API_URL`, binds the API to all interfaces,
and starts the Expo development-client server. Stop it with Ctrl+C.

## Authentication and baseline navigation

- [ ] Sign up, sign out, and sign back in. Invalid credentials leave the form
      usable, and a valid session survives an application restart.
- [ ] Create, rename, open, and remove a disposable deck. Deck and due-card
      counts update without restarting.
- [ ] The tab bar says `Create`, exposes the Create tab accessibility label,
      and shows a badge only for choices, ready creations, and failures.

## Capture and Creation inbox

- [ ] An empty Creation inbox focuses the `What do you want to learn?` composer
      and explains background deck selection without technical queue language.
- [ ] Submit a short request. The composer clears only after durable local
      enqueue, the request appears immediately, and another request can be typed.
- [ ] Submit three requests rapidly. With two text jobs occupied, verify two are
      Creating and the next is Queued in accepted order.
- [ ] Submit a near-2,000-character multiline request with the keyboard open.
      The character count appears at 1,800, layout remains reachable, and an
      over-limit request stays in the field with a nearby error.
- [ ] Disable Wi-Fi before submit, restart the app, sign in as the same account,
      and reconnect. The exact request retries with one idempotency identity.
      A different account cannot see or send the first account's outbox.
- [ ] Inbox groups appear in this order when non-empty: Needs your choice,
      Ready to review, Creating, Queued, Needs attention. Rows show an excerpt,
      known deck, human state, and optional thumbnail only.

## Routing and creation detail

- [ ] An ambiguous request opens creation detail and asks `Where should this
      go?`. Each candidate shows deck name and learning angle, with no confidence
      or internal reasoning.
- [ ] Select a candidate and confirm generation resumes. Delete a candidate deck
      before selection and confirm routing safely refreshes.
- [ ] Exercise the editable new-deck proposal. Cancel leaves the choice pending;
      confirmation creates and selects the deck atomically. Verify choose-another
      and discard paths.
- [ ] Leave creation detail while work is active. The screen says work continues,
      navigation does not cancel generation, and returning rehydrates persisted
      progress rather than restarting it.
- [ ] Background and terminate the app during routing and card generation, then
      reopen through the inbox. Persisted complete cards and real status return.

## Honest generation and media

- [ ] Verify real stage copy only: Understanding your request, Choosing the best
      fit, Creating a picture, and Writing cards. No percentage, ETA, countdown,
      elapsed timer, fixed-card skeleton, or partial field is shown.
- [ ] Capture first-card and multiple-card arrival. Each complete card enters once
      and keeps its order across reconnect.
- [ ] A ready useful image is the largest content region. A slow image does not
      delay cards; no-image collapses its space; failed image retains usable cards
      and exposes `Try picture again`.
- [ ] With reduced motion enabled, verify reading order is unchanged and no
      translation, scale, or stagger motion remains.

## Notifications and deep links

- [ ] On the first attempt to leave active work, decline the in-context education.
      Intended navigation continues, no operating-system permission prompt opens,
      and routine creation does not repeat the education.
- [ ] On a clean account/build, accept the education. The Android permission prompt
      appears only after acceptance; deny and accept outcomes both remain usable.
- [ ] Background and terminate the app. Deliver a ready or needs-choice push and
      verify a single-item notification deep link opens that creation detail.
- [ ] Complete several creations close together. One grouped notification opens
      the Creation inbox with actionable groups first.
- [ ] Keep the matching creation detail visible in the foreground and confirm its
      notification is suppressed. Sign out and verify the installation no longer
      receives that account's creation notifications.

## Content-first preview and focused editing

- [ ] Ready preview has one title with a deck/card-count subtitle, followed by the
      picture and compact editable cards. `Save to [deck]` stays visible above the
      navigation inset while scrolling. Add card and Adjust with AI fit on narrow
      screens and with enlarged text.
- [ ] Picture failure shows one quiet status row with Retry. Picture cues appear
      only when the image can be displayed; no duplicate image error appears.
- [ ] Inspect a basic and a cloze card. Natural prompt, answer, full meaning,
      learning focus, visible cloze hint, and image-cue indication are correct;
      serialized cloze syntax is never visible.
- [ ] Tap one card. The focused card editor mounts only that card. Basic fields are
      Prompt and Answer. Cloze fields are Sentence, Hidden answer, Hint, and Full
      meaning. Learning focus and valid image cue remain under More options.
- [ ] Edit every field, close/reopen, and simulate offline save plus a revision
      conflict. Local fields survive; retry and explicit refresh are distinct.
- [ ] Add a basic and cloze card through the focused route, remove a non-final card,
      and confirm the final card cannot be removed.
- [ ] Repeat with enlarged Android text, TalkBack traversal, keyboard open, gesture
      navigation, and Android Back. Sticky Done and all fields remain reachable.

## Adjustment, regeneration, save, and removal

- [ ] `Adjust with AI` accepts a suggestion and a custom instruction. Existing
      cards remain readable while replacement runs, save explains why it is
      unavailable, and cancel restores immediate review.
- [ ] After adjustment, `Cards adjusted · Undo` survives navigation/restart and
      restores the exact prior complete set. A later manual or AI content change
      clears that Undo boundary.
- [ ] Open the header overflow menu. `Change deck and regenerate` explains that
      the learning angle changes. The prior deck/cards remain until a validated
      replacement arrives; failure and cancel keep them.
- [ ] Exercise routing, card, and image failures. Each retry targets only its failed
      stage. A useful partial card set remains editable and saveable.
- [ ] Save while image is ready, pending, absent, and failed. Only the selected
      creation disappears; other inbox work remains; confirmation offers
      `View note`; uncertain retry creates only one note.
- [ ] Force save failure and session renewal. Preview cards, deck, manual edits, and
      stable retry identity remain available.
- [ ] Queued removal says `Remove from queue` and offers brief Undo. Running work
      confirms `Cancel creation`. Ready work opens `Discard creation` from the
      header overflow menu, confirms the action, and names
      the unsaved loss. Failed removal retains the item and can be retried.

## Existing learning flows

- [ ] Open and edit a saved note with image, basic card, hinted cloze, and audio.
      Saved-note behavior and scheduling remain unchanged by the creation editor.
- [ ] Review a due deck, reveal and grade cards, and complete the session.
- [ ] Generate or play pronunciation audio; leaving the screen stops playback.
- [ ] Change Settings preferences, restart, and confirm they persist.
- [ ] Developer tools remain available only in a development build.

## Production transport boundary

Launch a production-mode build with an HTTP endpoint and confirm startup rejects
it because production API URLs require HTTPS. Then use a reachable HTTPS origin
and confirm startup succeeds. LAN HTTP is accepted only for development builds.
