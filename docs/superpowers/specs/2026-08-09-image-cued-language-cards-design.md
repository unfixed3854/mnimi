# Image-cued language cards

## Problem

The cloze-card change made language reviews production-first, but the generated
cards and the review screen do not yet agree on what cues that production.
Cards such as:

```text
Ich sehe zwei {{c1::Bananen}}.
Das ist eine {{c1::Banane}}.
```

force a grammatical shape but do not identify the intended lexeme. Hundreds of
answers fit. The language rule pack says to add a native-language hint whenever
the blank is otherwise ambiguous, yet its own plural example omits that cue and
models reproduce the omission.

The note may already have the best cue for a concrete word: a picture of its
referent. Review currently hides every picture until after reveal because a
picture would leak the answer on a target-language-to-native-language
recognition card. That blanket rule is wrong for production cards. When the
learner must produce German, the picture is the question rather than the
answer.

## Goals

- Use the note image as the default semantic cue when a new language card asks
  the learner to produce a vocabulary item or one of its inflected forms.
- Keep the native-language meaning as a guaranteed fallback without showing it
  alongside a successfully loaded image by default.
- Keep production as the only automatically generated retrieval direction.
- Preserve every existing saved card and its current review behavior.
- Keep image-cue policy explicit and persisted rather than inferred from
  open-ended aspect labels.
- Make the model's cue decision reviewable and editable before save.

## Non-goals

- Regenerating or rewriting existing cards.
- Automatically generating target-language-to-native-language recognition
  cards.
- Adding learner proficiency or deck-level direction settings.
- Remembering text-hint use between reviews or feeding it into FSRS grading.
- Automatically deciding that a successfully loaded image is semantically
  ambiguous.
- Redesigning note detail or the entire add flow.
- Removing the existing legacy `hint` column; inline cloze hints remain the
  source of text shown at the deletion.

## Chosen approach

Each card gains an explicit `imageCue` boolean. A true value means: use the
note's image as the preferred cue on the question side, and use the cloze's
native-language hint when the image is unavailable or the learner explicitly
requests text help.

This is preferable to deriving behavior from `aspect`. Aspect is model-written
open vocabulary, so `plural`, `inflection`, and `word form` could describe the
same job. It is also preferable to adding control tokens to cloze markup, which
would mix presentation policy into learner-visible, Anki-compatible content.

The database column is non-null with a default of false. Consequently all
existing rows remain legacy cards without a data backfill, regeneration, or
change to their scheduling history. Only cards generated after this feature
can opt into the new behavior.

## Generation policy

Automatic language-card generation stays production-only. The translated
sentence on the back lets the learner verify comprehension after retrieval; it
does not create a second reverse card and double the review load.

For a new language note, the model sets `imageCue` as follows:

- `true` when the deletion hides the vocabulary item or an inflected form and
  the note has a non-null `imagePrompt`. This includes the main lexical
  production card, plural forms, and imageable conjugated or declined forms.
- `false` when the target lexeme is already visible, such as a gender card that
  deletes only the article: `{{c1::Die}} Banane ist gelb.`
- `false` when the note has no intended image or when the classification is not
  `language`.

Every image-cued card also carries a nonempty native-language fallback inside
the deletion:

```text
Ich sehe zwei {{c1::Bananen::bananas}}.
```

The fallback is stored even though a working review image initially suppresses
it. The sentence should still force the grammatical form; the hint identifies
the lexeme. For example, `zwei` forces the plural while `bananas` distinguishes
the intended noun from every other plural noun.

The language rule pack must show image-cued lexical, plural, and gender
examples together so the distinction is explicit. It must continue to state
that every surrounding word should be simpler than the item under test.

## Validation and retry

`GeneratedCard`, the streaming draft representation, draft JSON, note-save
input, and the persisted card row all carry `imageCue`.

Validation covers relationships that a field-level schema cannot express:

- `imageCue: true` requires `classification.domain === "language"`.
- It requires a non-null `imagePrompt` in the same generated note.
- It requires exactly one well-formed cloze deletion.
- That deletion requires a nonempty inline hint.

Invalid generated output enters the existing validation-feedback retry path so
the model receives the precise consistency error and gets one correction
attempt. The note-save boundary repeats the important invariants rather than
trusting a draft assembled or edited in the browser.

An image generation or fetch failure after valid card generation does not make
the card invalid. The stored inline hint is specifically what makes that
failure recoverable.

## Draft and editing behavior

An editable generated card exposes a `Use picture as prompt` control. It is
shown only for a language draft with a non-null `imagePrompt` and reflects the
model's persisted `imageCue` value. A prompt remains non-null when image
generation later fails, so the learner can still inspect or disable the policy
while the card retains its text fallback. The learner can turn the control off
when an image is a poor cue or correct a model that applied it to the wrong
deletion.

The raw front remains the authoritative editable value:

```text
Ich sehe zwei {{c1::Bananen::bananas}}.
```

The rendered preview follows the intended question state:

- With picture prompting on, the inline hint is suppressed and the preview is
  labelled as picture-cued.
- With picture prompting off, the normal inline `[bananas]` hint appears.
- Removing the inline hint while picture prompting is on makes the draft
  unsavable and produces a targeted error beside that card.

The add screen's existing note-level generated image remains the visual image
preview. It is not duplicated inside every editable card. Streaming may render
partial fields as it does today; final validation and the editable state are
authoritative once generation settles.

## Review behavior

Only `imageCue: true` cards use the new image-first transforming review card.
Existing cards default to false and therefore keep the current question card,
separate revealed-answer card, and post-reveal image. New language cards that
do not use an image cue also retain that existing presentation.

### Before reveal

The image and sentence appear inside one card, with the image above the text on
the primary Android layout. The image is not a separate hero or a side-by-side
thumbnail: keeping it in the prompt card makes its relationship to the cloze
clear without shrinking either the image or a longer sentence on a narrow
screen.

When the image loads successfully, the inline native-language hint is hidden:

```text
[picture of bananas]
Ich sehe zwei ____.
```

A quiet `Text hint` action reveals the stored hint inside the deletion. This
affects only the current attempt. It neither persists a preference nor changes
the eventual FSRS rating automatically.

If the server reports no attached image, the image request fails, or the image
element cannot display the returned data, the hint appears automatically and
the redundant `Text hint` action is omitted. While an expected image is still
loading, the existing fixed-size skeleton prevents layout movement and the
text-hint action remains available so the learner need not wait.

The prompt image's accessible alternative text is the native-language fallback
meaning parsed from the cloze, never the hidden target-language answer. A screen
reader therefore receives an equivalent semantic cue without hearing the
answer.

### After reveal

The same card transforms in place. The image stays stationary, the blank is
replaced by the emphasized answer, the translated sentence appears underneath,
and the grading controls appear below the card. The question card, answer card,
and image are not duplicated.

Temporary state, including whether `Text hint` was opened, resets whenever the
card id at the head of the review queue changes.

## Component boundaries and data flow

The cards table adds `image_cue integer not null default 0`. The migration must
preserve every FSRS field, the partial due-card index, and the note-id index in
addition to defaulting existing rows to false.

The due-card query already joins cards to notes and returns `hasImage`; the
persisted `imageCue` travels with the card row, so no aspect inference or extra
request is needed.

A focused `ImageCueReviewCard` owns the new presentation state:

- loading and displaying the note image;
- distinguishing successful load from absent, fetch-error, and display-error
  states;
- controlling temporary text-hint visibility;
- transforming the prompt into the revealed answer; and
- resetting its local state when the card changes.

The review route continues to own the due queue, grading mutation, connection
errors, and navigation. Existing `CardFront`, `CardBack`, and `GeneratedImage`
paths remain available for legacy and non-image-cued cards. `ClozeText` receives
only the smallest reusable option required to suppress a stored hint while
keeping its current default behavior everywhere else.

The card editor receives the card's cue value and an update callback but does
not own note-image loading. Draft validity remains centralized with the other
saveability rules, and the server independently enforces the same invariants at
save.

## Error handling

- A model consistency error is retried through the existing AI validation loop.
- A hand-edited invalid combination is blocked before save with a card-local
  explanation.
- A forged or stale invalid save is rejected at the server boundary.
- A missing or failed image degrades to the stored native-language hint rather
  than to an unanswerable blank.
- A requested text hint is ordinary local review state; no extra server write
  can fail and no review history is created until the learner grades the card.

## Testing

Tests must establish the behavior at each boundary:

- Migration replay: an existing card becomes `imageCue: false` while all FSRS
  values and both indexes survive.
- AI rule packs: language generation remains production-only; examples mark
  lexical and plural deletions for image cues, leave gender unmarked, and keep
  native-language fallback hints.
- Generated-note validation: true is rejected for non-language notes, null
  image prompts, malformed/non-cloze fronts, and empty/missing cloze hints.
- Draft state and editor: cue values survive streaming and editing, the control
  toggles them, preview hint suppression is correct, and invalid combinations
  cannot be saved.
- Note save and due API: the value persists and is returned with `hasImage`;
  false remains the default for legacy inserts.
- Review component: successful images appear before recall; hints start hidden;
  `Text hint` reveals them; missing, fetch-failed, and display-failed images
  reveal them automatically; reveal transforms one card in place; the image
  stays present; and all temporary state resets for the next card.
- Regressions: gender, non-language, non-image-cued, and existing cards retain
  their behavior, while grading and review-log writes remain unchanged.
- Documentation: README examples describe image-first production and no longer
  promise automatically generated recognition cards.
