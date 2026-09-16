# mnimi Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end draft of an AI-assisted flashcard app where a user captures a word or concept, receives AI-generated aspect-tagged cards plus an image, and reviews them on an FSRS schedule.

**Architecture:** A Tauri v2 Android app hosting a React SPA. Supabase Postgres is the single source of truth (online-only, no local database). Two Supabase Edge Functions hold the OpenRouter key server-side and perform classification, card generation and image generation. FSRS scheduling is computed client-side by `ts-fsrs` and persisted back to Postgres.

**Tech Stack:** Tauri v2, React 19, Vite 7, TypeScript 5.8, TanStack Router / Form / Query, `@tanstack/ai` + `@tanstack/ai-openrouter`, Tailwind v4, shadcn/ui, `ts-fsrs` 5.4, Supabase (Postgres 17, Auth, Storage, Edge Functions on Deno), Zod.

**Spec:** `docs/superpowers/specs/2026-07-27-mnimi-draft-design.md`

## Global Constraints

- **Local Supabase ports are non-default and must never be changed back.** API `55321`, DB `55322`, Studio `55323`, Inbucket `55324`, Analytics `55327`, Pooler `55329`, Shadow DB `55320`. `project_id = "mnimi"`.
- **The OpenRouter API key must never appear in client code, client env vars, or the Tauri bundle.** It lives only in Supabase secrets and is read only inside Edge Functions.
- **This machine has no Docker.** Podman 5.8.4 is installed. Every `supabase` command needs `DOCKER_HOST` pointing at the podman socket.
- **`supabase`, `deno`, `java` and `android-sdk` are not on `PATH`.** They are installed via mise and must be pinned in a project `mise.toml`.
- **Gradle requires Java 17 or 21.** The system Java is 25 and will fail the Android build; mise must pin Java 17.
- Every database table has RLS enabled with `user_id = auth.uid()`.
- AI output is never persisted without user review. The capture flow always presents an editable draft.
- Node 24.15.0, npm 11.12.1.

## Interface Conventions

Two names recur across tasks; use exactly these spellings.

- FSRS mapping functions: `toFsrsCard`, `fromFsrsCard`, `gradeCard`. Never `toFSRSCard`.
- Rule pack selection: `selectRulePacks`. Never `getRulePacks`.

---

## Task 1: Project foundation — toolchain, Tailwind, Vitest

**Files:**
- Create: `mise.toml`
- Create: `src/index.css`
- Modify: `vite.config.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/lib/utils.ts`
- Create: `src/lib/utils.test.ts`
- Delete: `src/App.css`

**Interfaces:**
- Consumes: nothing.
- Produces: `cn(...inputs: ClassValue[]): string` from `src/lib/utils.ts`, used by every shadcn component. Path alias `@/*` → `src/*`. `npm test` runs Vitest.

- [ ] **Step 1: Pin the toolchain**

Create `mise.toml`:

```toml
[tools]
node = "24.15.0"
supabase = "2.109.1"
deno = "2.9.3"
java = "17.0.2"
android-sdk = "1.0"

[env]
DOCKER_HOST = "unix:///run/user/1000/podman/podman.sock"
```

- [ ] **Step 2: Enable the podman socket**

Run:

```bash
systemctl --user enable --now podman.socket
```

Verify:

```bash
mise x -- bash -c 'echo $DOCKER_HOST' && podman info --format '{{.Host.RemoteSocket.Path}}'
```

Expected: the socket path printed by podman matches `/run/user/1000/podman/podman.sock`. If the uid is not 1000, correct `mise.toml` to the value from `id -u`.

- [ ] **Step 3: Install dependencies**

```bash
npm install @tanstack/react-router @tanstack/react-query @tanstack/react-form @supabase/supabase-js ts-fsrs zod@4.4.3 clsx tailwind-merge class-variance-authority lucide-react
npm install -D tailwindcss @tailwindcss/vite @tanstack/router-plugin vitest jsdom @testing-library/react @testing-library/jest-dom @types/node
```

- [ ] **Step 4: Configure Vite**

Replace `vite.config.ts` with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  // tanstackRouter must come before react()
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
```

- [ ] **Step 5: Add the path alias to tsconfig.json**

Add to `compilerOptions`:

```json
"baseUrl": ".",
"paths": { "@/*": ["./src/*"] }
```

- [ ] **Step 6: Create the Tailwind entrypoint**

Create `src/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-border: hsl(240 5.9% 90%);
  --color-background: hsl(0 0% 100%);
  --color-foreground: hsl(240 10% 3.9%);
  --color-primary: hsl(240 5.9% 10%);
  --color-primary-foreground: hsl(0 0% 98%);
  --color-muted: hsl(240 4.8% 95.9%);
  --color-muted-foreground: hsl(240 3.8% 46.1%);
  --color-destructive: hsl(0 84.2% 60.2%);
}
```

Delete `src/App.css` and remove its import from `src/App.tsx`. In `src/main.tsx`, replace any existing CSS import with `import "@/index.css";`.

- [ ] **Step 7: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "supabase/functions/**/*.test.ts"],
  },
});
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 8: Write the failing test**

Create `src/lib/utils.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("lets later tailwind classes win over earlier conflicting ones", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("drops falsy values", () => {
    expect(cn("px-2", false && "hidden", undefined)).toBe("px-2");
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/utils`.

- [ ] **Step 10: Implement**

Create `src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 3 tests.

- [ ] **Step 12: Verify the dev server still builds**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "chore: add toolchain pins, tailwind v4, vitest and path aliases"
```

---

## Task 2: Routing skeleton

**Files:**
- Create: `src/routes/__root.tsx`
- Create: `src/routes/index.tsx`
- Create: `src/routes/login.tsx`
- Modify: `src/main.tsx`
- Delete: `src/App.tsx`

**Interfaces:**
- Consumes: `cn` from Task 1.
- Produces: a configured `router` instance and the file-based route tree. Later tasks add route files to `src/routes/` and rely on `routeTree.gen.ts` being auto-generated by the Vite plugin. The `Route` export name in every route file must be exactly `Route`.

- [ ] **Step 1: Create the root route**

Create `src/routes/__root.tsx`:

```tsx
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="pb-16">
        <Outlet />
      </main>
      <nav className="fixed bottom-0 inset-x-0 border-t border-border bg-background flex">
        <Link to="/" className="flex-1 p-4 text-center text-sm">
          Today
        </Link>
        <Link to="/login" className="flex-1 p-4 text-center text-sm">
          Account
        </Link>
      </nav>
    </div>
  );
}
```

- [ ] **Step 2: Create two placeholder routes**

Create `src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <h1 className="p-4 text-2xl font-bold">Today</h1>,
});
```

Create `src/routes/login.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  component: () => <h1 className="p-4 text-2xl font-bold">Login</h1>,
});
```

- [ ] **Step 3: Wire up the router**

Replace `src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import "@/index.css";

const queryClient = new QueryClient();
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

Delete `src/App.tsx`. Add `src/routeTree.gen.ts` to `.gitignore`.

- [ ] **Step 4: Verify the route tree generates and the build passes**

Run: `npm run build`
Expected: exit 0, and `src/routeTree.gen.ts` now exists containing `/` and `/login`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add tanstack router with file-based routing skeleton"
```

---

## Task 3: Local Supabase stack on non-default ports

**Files:**
- Create: `supabase/config.toml` (generated, then edited)
- Create: `.env.local`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `mise.toml` from Task 1.
- Produces: a running local Supabase stack reachable at `http://127.0.0.1:55321`, and `.env.local` containing `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for Task 4 onward.

- [ ] **Step 1: Initialise Supabase**

```bash
mise x -- supabase init
```

- [ ] **Step 2: Shift every port off the defaults**

Edit the generated `supabase/config.toml`. Set `project_id` and each port to the values below, leaving all other generated keys untouched. The generated file is the source of truth for key names — locate each existing key and change only its value.

```toml
project_id = "mnimi"

[api]
port = 55321

[db]
port = 55322
shadow_port = 55320

[db.pooler]
port = 55329

[studio]
port = 55323

[inbucket]
port = 55324

[analytics]
port = 55327
```

If `[studio]` contains an `api_url`, leave it as `http://127.0.0.1` — Studio derives the API port from `[api]`.

- [ ] **Step 3: Start the stack**

```bash
mise x -- supabase start
```

Expected: a summary block printing `API URL: http://127.0.0.1:55321`, `DB URL: postgresql://postgres:postgres@127.0.0.1:55322/postgres`, `Studio URL: http://127.0.0.1:55323`, plus an `anon key` and `service_role key`.

If podman refuses to pull images, run `mise x -- supabase start --debug` and confirm `DOCKER_HOST` is exported. Do not fall back to default ports to work around a failure.

- [ ] **Step 4: Confirm nothing bound a default port**

A raw `ss -ltn | grep :543xx` is the wrong test: it is system-wide, so any *other*
Supabase project running on default ports makes it fail unconditionally and it can never
distinguish "mnimi bound a default port" from "something else did". Scope the check to
mnimi's own containers instead:

```bash
podman ps --format '{{.Names}}\t{{.Ports}}' | grep -i mnimi | grep -E '543[0-9]{2}' \
  && echo "COLLISION — mnimi bound a default port" \
  || echo "mnimi binds no default ports — correct"
```

Expected: `mnimi binds no default ports — correct`.

- [ ] **Step 5: Capture the client env**

Create `.env.local`, substituting the anon key printed in Step 3:

```
VITE_SUPABASE_URL=http://127.0.0.1:55321
VITE_SUPABASE_ANON_KEY=<anon key from supabase start>
```

Add to `.gitignore`:

```
.env.local
```

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml .gitignore mise.toml
git commit -m "feat: add local supabase stack on non-default 553xx ports"
```

---

## Task 4: Database schema, RLS and storage

**Files:**
- Create: `supabase/migrations/20260727000000_initial_schema.sql`
- Create: `src/types/database.ts` (generated)

**Interfaces:**
- Consumes: the running stack from Task 3.
- Produces: tables `profiles`, `decks`, `notes`, `cards`, `review_logs`; storage bucket `note-images`; and the generated `Database` type exported from `src/types/database.ts`, consumed by Task 6 onward.

**Note on `learning_steps`:** `ts-fsrs` v5 `Card` and `ReviewLog` both carry a `learning_steps: number` field. It is required — omitting the column will break `fromFsrsCard` round-tripping in Task 5.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260727000000_initial_schema.sql`:

```sql
-- profiles ------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  native_language text not null default 'en',
  ui_language text not null default 'en',
  created_at timestamptz not null default now()
);

-- decks ---------------------------------------------------------------------
create table public.decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

-- notes ---------------------------------------------------------------------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  deck_id uuid not null references public.decks(id) on delete cascade,
  source_text text not null,
  domain text not null,
  language text,
  metadata jsonb not null default '{}'::jsonb,
  image_path text,
  created_at timestamptz not null default now()
);

-- cards ---------------------------------------------------------------------
create table public.cards (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  aspect text not null,
  front text not null,
  back text not null,
  hint text,
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  -- inline ts-fsrs state
  due timestamptz not null default now(),
  stability real not null default 0,
  difficulty real not null default 0,
  elapsed_days integer not null default 0,
  scheduled_days integer not null default 0,
  learning_steps integer not null default 0,
  reps integer not null default 0,
  lapses integer not null default 0,
  state smallint not null default 0,
  last_review timestamptz
);

-- the hottest query in the app: this deck's due cards
create index cards_due_idx on public.cards (user_id, due) where suspended = false;
create index cards_note_id_idx on public.cards (note_id);
create index notes_deck_id_idx on public.notes (deck_id);

-- review_logs ---------------------------------------------------------------
create table public.review_logs (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null,
  state smallint not null,
  due timestamptz not null,
  stability real not null,
  difficulty real not null,
  elapsed_days integer not null,
  last_elapsed_days integer not null,
  scheduled_days integer not null,
  learning_steps integer not null default 0,
  review timestamptz not null
);

create index review_logs_card_id_idx on public.review_logs (card_id);

-- row level security --------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.decks enable row level security;
alter table public.notes enable row level security;
alter table public.cards enable row level security;
alter table public.review_logs enable row level security;

create policy "own profile" on public.profiles
  for all using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "own decks" on public.decks
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own notes" on public.notes
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own cards" on public.cards
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own review logs" on public.review_logs
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- create a profile automatically on signup ----------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- storage -------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('note-images', 'note-images', false);

-- objects are stored at <user_id>/<note_id>.png, so the first path segment
-- is the owner and is what the policy checks
create policy "own note images" on storage.objects
  for all using (
    bucket_id = 'note-images'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  ) with check (
    bucket_id = 'note-images'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
```

- [ ] **Step 2: Apply the migration**

```bash
mise x -- supabase db reset
```

Expected: `Applying migration 20260727000000_initial_schema.sql...` then `Finished supabase db reset.` with no errors.

- [ ] **Step 3: Verify RLS actually blocks cross-user reads**

```bash
mise x -- supabase db reset >/dev/null && \
psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -c \
"set role authenticated; select count(*) from public.cards;"
```

Expected: `0` rows and no error. An error mentioning `permission denied` means a policy is missing.

- [ ] **Step 4: Generate TypeScript types**

```bash
mise x -- supabase gen types typescript --local > src/types/database.ts
```

Verify the file exports `Database` and contains a `cards` entry with a `learning_steps` field:

```bash
grep -c "learning_steps" src/types/database.ts
```

Expected: a count of at least 3 (Row, Insert, Update).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations src/types/database.ts
git commit -m "feat: add schema, RLS policies and note-images storage bucket"
```

---

## Task 5: FSRS mapping module

**Files:**
- Create: `src/lib/fsrs.ts`
- Test: `src/lib/fsrs.test.ts`

**Interfaces:**
- Consumes: `Database` from Task 4.
- Produces:
  - `type CardRow = Database["public"]["Tables"]["cards"]["Row"]`
  - `toFsrsCard(row: CardRow): Card`
  - `fromFsrsCard(card: Card): FsrsColumns` where `FsrsColumns` is `Pick<CardRow, "due"|"stability"|"difficulty"|"elapsed_days"|"scheduled_days"|"learning_steps"|"reps"|"lapses"|"state"|"last_review">`
  - `gradeCard(row: CardRow, rating: Grade, now?: Date): { card: FsrsColumns; log: ReviewLogInsert }` where `ReviewLogInsert` is `Omit<Database["public"]["Tables"]["review_logs"]["Insert"], "card_id"|"user_id"|"id">`
  - `RATINGS: ReadonlyArray<{ value: Grade; label: string }>`

This is pure logic with no I/O — it is the most valuable thing in the codebase to have tested.

- [ ] **Step 1: Write the failing test**

Create `src/lib/fsrs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Rating, State, createEmptyCard } from "ts-fsrs";
import { toFsrsCard, fromFsrsCard, gradeCard, RATINGS } from "@/lib/fsrs";
import type { CardRow } from "@/lib/fsrs";

function makeRow(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    note_id: "22222222-2222-2222-2222-222222222222",
    user_id: "33333333-3333-3333-3333-333333333333",
    aspect: "meaning",
    front: "banana",
    back: "die Banane",
    hint: null,
    suspended: false,
    created_at: "2026-07-27T10:00:00.000Z",
    due: "2026-07-27T10:00:00.000Z",
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    last_review: null,
    ...overrides,
  } as CardRow;
}

describe("toFsrsCard", () => {
  it("converts ISO strings to Dates", () => {
    const card = toFsrsCard(makeRow({ due: "2026-08-01T12:00:00.000Z" }));
    expect(card.due).toBeInstanceOf(Date);
    expect(card.due.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("maps a null last_review to undefined, not null", () => {
    expect(toFsrsCard(makeRow({ last_review: null })).last_review).toBeUndefined();
  });

  it("maps the numeric state column onto the State enum", () => {
    expect(toFsrsCard(makeRow({ state: 2 })).state).toBe(State.Review);
  });
});

describe("fromFsrsCard", () => {
  it("round-trips a card through both directions without loss", () => {
    const original = makeRow({
      due: "2026-08-01T12:00:00.000Z",
      stability: 4.5,
      difficulty: 6.25,
      elapsed_days: 3,
      scheduled_days: 7,
      learning_steps: 1,
      reps: 5,
      lapses: 2,
      state: 2,
      last_review: "2026-07-25T09:00:00.000Z",
    });

    const columns = fromFsrsCard(toFsrsCard(original));

    expect(columns).toEqual({
      due: "2026-08-01T12:00:00.000Z",
      stability: 4.5,
      difficulty: 6.25,
      elapsed_days: 3,
      scheduled_days: 7,
      learning_steps: 1,
      reps: 5,
      lapses: 2,
      state: 2,
      last_review: "2026-07-25T09:00:00.000Z",
    });
  });

  it("serialises an absent last_review back to null for Postgres", () => {
    const card = createEmptyCard(new Date("2026-07-27T10:00:00.000Z"));
    expect(fromFsrsCard(card).last_review).toBeNull();
  });
});

describe("gradeCard", () => {
  const now = new Date("2026-07-27T10:00:00.000Z");

  it("advances a new card out of the New state on Good", () => {
    const { card } = gradeCard(makeRow(), Rating.Good, now);
    expect(card.state).not.toBe(State.New);
    expect(card.reps).toBe(1);
  });

  it("schedules Again sooner than Easy", () => {
    const again = gradeCard(makeRow(), Rating.Again, now).card;
    const easy = gradeCard(makeRow(), Rating.Easy, now).card;
    expect(new Date(again.due).getTime()).toBeLessThan(new Date(easy.due).getTime());
  });

  it("produces a review log carrying the rating and review time", () => {
    const { log } = gradeCard(makeRow(), Rating.Hard, now);
    expect(log.rating).toBe(Rating.Hard);
    expect(log.review).toBe(now.toISOString());
  });

  it("produces a log whose fields are all serialisable for Postgres", () => {
    const { log } = gradeCard(makeRow(), Rating.Good, now);
    for (const value of Object.values(log)) {
      expect(value).not.toBeInstanceOf(Date);
    }
  });
});

describe("RATINGS", () => {
  it("offers the four gradeable ratings in escalating order", () => {
    expect(RATINGS.map((r) => r.value)).toEqual([
      Rating.Again,
      Rating.Hard,
      Rating.Good,
      Rating.Easy,
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/fsrs.test.ts`
Expected: FAIL — cannot resolve `@/lib/fsrs`.

- [ ] **Step 3: Implement**

Create `src/lib/fsrs.ts`:

```ts
import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";
import type { Database } from "@/types/database";

export type CardRow = Database["public"]["Tables"]["cards"]["Row"];

export type FsrsColumns = Pick<
  CardRow,
  | "due"
  | "stability"
  | "difficulty"
  | "elapsed_days"
  | "scheduled_days"
  | "learning_steps"
  | "reps"
  | "lapses"
  | "state"
  | "last_review"
>;

export type ReviewLogInsert = Omit<
  Database["public"]["Tables"]["review_logs"]["Insert"],
  "card_id" | "user_id" | "id"
>;

const scheduler = fsrs();

export const RATINGS = [
  { value: Rating.Again, label: "Again" },
  { value: Rating.Hard, label: "Hard" },
  { value: Rating.Good, label: "Good" },
  { value: Rating.Easy, label: "Easy" },
] as const satisfies ReadonlyArray<{ value: Grade; label: string }>;

export function toFsrsCard(row: CardRow): Card {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

export function fromFsrsCard(card: Card): FsrsColumns {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

export function gradeCard(
  row: CardRow,
  rating: Grade,
  now: Date = new Date(),
): { card: FsrsColumns; log: ReviewLogInsert } {
  const { card, log } = scheduler.next(toFsrsCard(row), now, rating);

  return {
    card: fromFsrsCard(card),
    log: {
      rating: log.rating,
      state: log.state,
      due: log.due.toISOString(),
      stability: log.stability,
      difficulty: log.difficulty,
      elapsed_days: log.elapsed_days,
      last_elapsed_days: log.last_elapsed_days,
      scheduled_days: log.scheduled_days,
      learning_steps: log.learning_steps,
      review: log.review.toISOString(),
    },
  };
}

/** FSRS columns for a brand new card, for insertion alongside a new note. */
export function newCardColumns(now: Date = new Date()): FsrsColumns {
  return fromFsrsCard(createEmptyCard(now));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/fsrs.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fsrs.ts src/lib/fsrs.test.ts
git commit -m "feat: add FSRS state mapping between ts-fsrs and postgres rows"
```

---

## Task 6: Rule packs and AI output schemas

**Files:**
- Create: `supabase/functions/_shared/rule-packs.ts`
- Create: `supabase/functions/_shared/schemas.ts`
- Test: `supabase/functions/_shared/rule-packs.test.ts`
- Test: `supabase/functions/_shared/schemas.test.ts`

**Interfaces:**
- Consumes: `zod` from Task 1.
- Produces:
  - `classificationSchema` — Zod schema for `{ domain, language, partOfSpeech }`
  - `generatedNoteSchema` — Zod schema for `{ imagePrompt, cards: [{ aspect, front, back, hint }] }`
  - `type Classification`, `type GeneratedNote`
  - `selectRulePacks(c: Classification): string[]` returning pack **names**
  - `buildSystemPrompt(c: Classification): string` returning the concatenated pack bodies
  - `BASE_PACK`, `LANGUAGE_PACK` string constants

These files must contain **no Deno globals** so Vitest can import them directly.

- [ ] **Step 1: Write the failing schema test**

Create `supabase/functions/_shared/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classificationSchema, generatedNoteSchema } from "./schemas";

describe("classificationSchema", () => {
  it("accepts a language classification", () => {
    const parsed = classificationSchema.parse({
      domain: "language",
      language: "de",
      partOfSpeech: "noun",
    });
    expect(parsed.domain).toBe("language");
  });

  it("defaults language and partOfSpeech to null when the model omits them", () => {
    const parsed = classificationSchema.parse({ domain: "concept" });
    expect(parsed.language).toBeNull();
    expect(parsed.partOfSpeech).toBeNull();
  });

  it("rejects a missing domain", () => {
    expect(() => classificationSchema.parse({ language: "de" })).toThrow();
  });
});

describe("generatedNoteSchema", () => {
  const valid = {
    imagePrompt: "a ripe yellow banana on a white background",
    cards: [
      { aspect: "meaning", front: "image", back: "die Banane", hint: null },
      { aspect: "gender", front: "___ Banane", back: "die", hint: null },
    ],
  };

  it("accepts a well-formed generation", () => {
    expect(generatedNoteSchema.parse(valid).cards).toHaveLength(2);
  });

  it("requires at least one card", () => {
    expect(() => generatedNoteSchema.parse({ ...valid, cards: [] })).toThrow();
  });

  it("rejects a card with an empty front", () => {
    expect(() =>
      generatedNoteSchema.parse({
        ...valid,
        cards: [{ aspect: "meaning", front: "", back: "x", hint: null }],
      }),
    ).toThrow();
  });

  it("treats a missing hint as null", () => {
    const parsed = generatedNoteSchema.parse({
      ...valid,
      cards: [{ aspect: "meaning", front: "a", back: "b" }],
    });
    expect(parsed.cards[0].hint).toBeNull();
  });

  it("allows an absent imagePrompt for non-visual concepts", () => {
    const parsed = generatedNoteSchema.parse({ cards: valid.cards });
    expect(parsed.imagePrompt).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing rule-pack test**

Create `supabase/functions/_shared/rule-packs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  selectRulePacks,
  buildSystemPrompt,
  BASE_PACK,
  LANGUAGE_PACK,
} from "./rule-packs";
import type { Classification } from "./schemas";

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
  // Assert against the pack CONSTANTS, never against phrases sampled from them.
  // The packs are prose and prose gets reworded; a phrase-coupled assertion
  // silently stops guarding the moment someone rewrites a line.
  it("gives a language note both the base and language packs", () => {
    const prompt = buildSystemPrompt(languageNote);
    expect(prompt).toContain(BASE_PACK);
    expect(prompt).toContain(LANGUAGE_PACK);
  });

  it("does not leak vocabulary rules into a concept note", () => {
    const prompt = buildSystemPrompt(conceptNote);
    expect(prompt).toContain(BASE_PACK);
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
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run supabase/functions/_shared`
Expected: FAIL — cannot resolve `./schemas` and `./rule-packs`.

- [ ] **Step 4: Implement the schemas**

Create `supabase/functions/_shared/schemas.ts`:

```ts
import { z } from "zod";

export const classificationSchema = z.object({
  /**
   * Open vocabulary. 'language' is the only value that changes behaviour;
   * everything else is descriptive and simply selects the base pack.
   */
  domain: z.string().min(1),
  /** BCP-47-ish target language code, null for non-language notes. */
  language: z.string().nullish().transform((v) => v ?? null),
  partOfSpeech: z.string().nullish().transform((v) => v ?? null),
});

export type Classification = z.infer<typeof classificationSchema>;

export const generatedCardSchema = z.object({
  aspect: z.string().min(1),
  front: z.string().min(1),
  back: z.string().min(1),
  hint: z.string().nullish().transform((v) => v ?? null),
});

export const generatedNoteSchema = z.object({
  imagePrompt: z.string().nullish().transform((v) => v ?? null),
  cards: z.array(generatedCardSchema).min(1),
});

export type GeneratedCard = z.infer<typeof generatedCardSchema>;
export type GeneratedNote = z.infer<typeof generatedNoteSchema>;
```

- [ ] **Step 5: Implement the rule packs**

Create `supabase/functions/_shared/rule-packs.ts`:

```ts
import type { Classification } from "./schemas";

export const BASE_PACK = `
You write flashcards that a human will actually be able to learn from.

Rules that always apply:
- Minimum information principle: one card tests exactly one fact. If a card
  needs "and" to describe what it asks, split it.
- The front must be answerable without seeing the back. Never write a prompt
  so vague that several answers are correct.
- Never write a card that can be answered by elimination or by the shape of
  the question.
- Prefer active recall over recognition where both are possible.
- Keep both sides short. A back longer than a sentence is a sign the card
  should be several cards.
- Do not invent facts. If you are unsure of a detail, leave it out rather
  than guessing.
- Each card carries an "aspect" label naming what it tests. Use a short
  lowercase noun such as meaning, definition, relation, cause, formula,
  origin, example.
`.trim();

export const LANGUAGE_PACK = `
This note is a language-learning item. Additional rules apply.

- Generate recognition and production as separate cards. Recognition goes
  from the target language to the learner's language; production goes the
  other way. Production is the harder and more valuable direction.
- If the language marks grammatical gender on this word, give the gender its
  own card. Test the article alone, not bundled with the meaning.
- If the word inflects in a way a learner must memorise (plural, irregular
  past, principal parts), give each irregular form its own card.
- The image represents the real-world thing the word denotes. It must never
  contain written words, and must never depict a translation. A picture of a
  banana teaches "die Banane"; the English word "banana" does not.
- Use the aspect labels: meaning, production, gender, plural, conjugation,
  pronunciation.
`.trim();

const PACKS: Record<string, string> = {
  base: BASE_PACK,
  language: LANGUAGE_PACK,
};

/**
 * Progressive disclosure: the base pack always applies, and domain packs are
 * layered on top only when the classifier says they are relevant. Adding a
 * domain is a new constant plus one line here — never a schema change.
 */
export function selectRulePacks(classification: Classification): string[] {
  const packs = ["base"];
  if (classification.domain === "language") packs.push("language");
  return packs;
}

export function buildSystemPrompt(classification: Classification): string {
  const body = selectRulePacks(classification)
    .map((name) => PACKS[name])
    .join("\n\n");

  const context: string[] = [`Domain: ${classification.domain}`];
  if (classification.language) {
    context.push(`Target language: ${classification.language}`);
  }
  if (classification.partOfSpeech) {
    context.push(`Part of speech: ${classification.partOfSpeech}`);
  }

  return `${body}\n\n${context.join("\n")}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run supabase/functions/_shared`
Expected: PASS, 12 tests.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared
git commit -m "feat: add rule packs with progressive disclosure and AI output schemas"
```

---

## Task 7: `generate-note` Edge Function

**Files:**
- Create: `supabase/functions/deno.json`
- Create: `supabase/functions/_shared/cors.ts`
- Create: `supabase/functions/_shared/auth.ts`
- Create: `supabase/functions/_shared/openrouter.ts`
- Create: `supabase/functions/_shared/generate.ts`
- Test: `supabase/functions/_shared/generate.test.ts`
- Create: `supabase/functions/generate-note/index.ts`
- Modify: `.env.local` — no, create `supabase/functions/.env`

**Interfaces:**
- Consumes: `classificationSchema`, `generatedNoteSchema`, `buildSystemPrompt` from Task 6.
- Produces:
  - `parseWithRetry<T>(schema, attempt: (feedback: string | null) => Promise<unknown>): Promise<T>` in `generate.ts` — pure, testable, no network.
  - HTTP endpoint `POST /functions/v1/generate-note` taking `{ text: string, nativeLanguage: string }` and returning `{ classification: Classification, generation: GeneratedNote }`.
  - `corsHeaders`, `getUser(req)`, `textAdapter(model)`, `imageAdapter(model)`.

- [ ] **Step 1: Configure Deno imports**

Create `supabase/functions/deno.json`:

The Zod version here **must match** the one installed via npm in Task 1. The files in
`_shared/` are imported both by Deno at runtime and by Vitest in tests; a version split
means the tests validate against a different library than production uses.

```json
{
  "imports": {
    "zod": "npm:zod@4.4.3",
    "@tanstack/ai": "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.110.8"
  }
}
```

- [ ] **Step 2: Add the local function secrets**

Create `supabase/functions/.env` (gitignored — add `supabase/functions/.env` to `.gitignore`):

```
OPENROUTER_API_KEY=<your openrouter key>
CLASSIFY_MODEL=google/gemini-2.5-flash
GENERATE_MODEL=anthropic/claude-sonnet-4.5
IMAGE_MODEL=google/gemini-2.5-flash-image
```

- [ ] **Step 3: Write the shared helpers**

Create `supabase/functions/_shared/cors.ts`:

```ts
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
```

Create `supabase/functions/_shared/auth.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

/**
 * Verifies the caller's JWT and returns both the user and a client scoped to
 * that user, so every query the function makes is subject to the same RLS
 * policies the app is subject to.
 */
export async function getUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Response("Missing authorization header", { status: 401 });

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Response("Invalid token", { status: 401 });

  return { user: data.user, client };
}
```

Create `supabase/functions/_shared/openrouter.ts`:

```ts
import { openRouterText, openRouterImage } from "@tanstack/ai-openrouter";

function apiKey(): string {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return key;
}

export const classifyModel = () =>
  Deno.env.get("CLASSIFY_MODEL") ?? "google/gemini-2.5-flash";
export const generateModel = () =>
  Deno.env.get("GENERATE_MODEL") ?? "anthropic/claude-sonnet-4.5";
export const imageModel = () =>
  Deno.env.get("IMAGE_MODEL") ?? "google/gemini-2.5-flash-image";

export const textAdapter = (model: string) =>
  openRouterText(model, { apiKey: apiKey() });

export const imageAdapter = (model: string) =>
  openRouterImage(model, { apiKey: apiKey() });
```

- [ ] **Step 4: Write the failing test for the retry logic**

Create `supabase/functions/_shared/generate.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { parseWithRetry } from "./generate";

const schema = z.object({ name: z.string() });

describe("parseWithRetry", () => {
  it("returns the parsed value when the first attempt is valid", async () => {
    const attempt = vi.fn().mockResolvedValue({ name: "ok" });
    await expect(parseWithRetry(schema, attempt)).resolves.toEqual({ name: "ok" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("passes null feedback on the first attempt", async () => {
    const attempt = vi.fn().mockResolvedValue({ name: "ok" });
    await parseWithRetry(schema, attempt);
    expect(attempt).toHaveBeenCalledWith(null);
  });

  it("retries once with the validation error as feedback", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ nome: "typo" })
      .mockResolvedValueOnce({ name: "fixed" });

    await expect(parseWithRetry(schema, attempt)).resolves.toEqual({
      name: "fixed",
    });
    expect(attempt).toHaveBeenCalledTimes(2);

    const feedback = attempt.mock.calls[1][0] as string;
    expect(feedback).toContain("name");
  });

  it("throws after a second failure rather than retrying forever", async () => {
    const attempt = vi.fn().mockResolvedValue({ wrong: true });
    await expect(parseWithRetry(schema, attempt)).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run supabase/functions/_shared/generate.test.ts`
Expected: FAIL — cannot resolve `./generate`.

- [ ] **Step 6: Implement the retry helper**

Create `supabase/functions/_shared/generate.ts`:

```ts
import type { z } from "zod";

/**
 * Runs an attempt, validates it, and on failure retries exactly once with the
 * validation error fed back so the model can correct itself. Two failures is
 * a real failure — the caller falls back to a hand-editable empty draft
 * rather than looping and burning tokens.
 */
export async function parseWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => Promise<unknown>,
): Promise<T> {
  const first = schema.safeParse(await attempt(null));
  if (first.success) return first.data;

  const feedback =
    `Your previous response failed validation with these errors:\n` +
    JSON.stringify(first.error.issues, null, 2) +
    `\nReturn corrected JSON matching the schema exactly.`;

  const second = schema.safeParse(await attempt(feedback));
  if (second.success) return second.data;

  throw new Error(
    `Model output failed validation twice: ${JSON.stringify(second.error.issues)}`,
  );
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run supabase/functions/_shared/generate.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Implement the function**

Create `supabase/functions/generate-note/index.ts`:

```ts
import { chat } from "@tanstack/ai";
import { z } from "zod";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getUser } from "../_shared/auth.ts";
import { classifyModel, generateModel, textAdapter } from "../_shared/openrouter.ts";
import { buildSystemPrompt } from "../_shared/rule-packs.ts";
import { classificationSchema, generatedNoteSchema } from "../_shared/schemas.ts";
import { parseWithRetry } from "../_shared/generate.ts";

const requestSchema = z.object({
  text: z.string().min(1).max(200),
  nativeLanguage: z.string().min(2).max(10),
});

const CLASSIFY_PROMPT = `
You classify a single thing a learner wants to remember.

Decide whether it is a language-learning item — a word, phrase or grammatical
form in a language the learner is studying — or something else entirely, such
as a person, a scientific concept, a historical event or a quotation.

Set domain to "language" only for language-learning items. Otherwise use a
short lowercase label describing what it is: concept, person, place, event,
phrase, formula.

For language items set language to the target language code and partOfSpeech
to the word class. For everything else leave both null.
`.trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    await getUser(req);

    const body = requestSchema.parse(await req.json());

    // Pass 1 — classify, which selects the rule packs.
    const classification = await parseWithRetry(classificationSchema, (feedback) =>
      chat({
        adapter: textAdapter(classifyModel()),
        systemPrompts: [CLASSIFY_PROMPT],
        messages: [
          {
            role: "user",
            content: feedback
              ? `${body.text}\n\n${feedback}`
              : body.text,
          },
        ],
        outputSchema: classificationSchema,
        stream: false,
      }),
    );

    // Pass 2 — generate under base + any domain packs.
    const generation = await parseWithRetry(generatedNoteSchema, (feedback) =>
      chat({
        adapter: textAdapter(generateModel()),
        systemPrompts: [buildSystemPrompt(classification)],
        messages: [
          {
            role: "user",
            content: [
              `Create flashcards for: ${body.text}`,
              `The learner's native language is ${body.nativeLanguage}.`,
              `Write the learner-facing side in their native language where that makes sense.`,
              `If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.`,
              feedback ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        outputSchema: generatedNoteSchema,
        stream: false,
      }),
    );

    return jsonResponse({ classification, generation });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("generate-note failed", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});
```

- [ ] **Step 9: Serve and exercise the function end to end**

In one terminal:

```bash
mise x -- supabase functions serve --env-file supabase/functions/.env
```

In another, create a test user and call it:

```bash
curl -s -X POST 'http://127.0.0.1:55321/auth/v1/signup' \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"password123"}' | tee /tmp/signup.json

TOKEN=$(node -p "require('/tmp/signup.json').access_token")

curl -s -X POST 'http://127.0.0.1:55321/functions/v1/generate-note' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"die Banane","nativeLanguage":"pl"}' | jq
```

Expected: `classification.domain` is `"language"`, `classification.language` is `"de"`, and `generation.cards` contains several cards including one with aspect `gender`.

- [ ] **Step 10: Verify progressive disclosure holds for a non-language note**

```bash
curl -s -X POST 'http://127.0.0.1:55321/functions/v1/generate-note' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"Poseidon","nativeLanguage":"pl"}' | jq '.classification, [.generation.cards[].aspect]'
```

Expected: `domain` is not `"language"`, and no card has aspect `gender` or `plural`.

- [ ] **Step 11: Verify an unauthenticated call is rejected**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'http://127.0.0.1:55321/functions/v1/generate-note' \
  -H 'Content-Type: application/json' -d '{"text":"x","nativeLanguage":"pl"}'
```

Expected: `401`.

- [ ] **Step 12: Commit**

```bash
git add supabase/functions .gitignore
git commit -m "feat: add generate-note edge function with classify and generate passes"
```

---

## Task 8: `generate-image` Edge Function

**Files:**
- Create: `supabase/functions/generate-image/index.ts`

**Interfaces:**
- Consumes: `getUser`, `imageAdapter`, `jsonResponse` from Task 7.
- Produces: HTTP endpoint `POST /functions/v1/generate-image` taking `{ noteId: string, prompt: string }` and returning `{ imagePath: string }`. Called **after** the note is saved, because it writes `image_path` onto the existing row.

- [ ] **Step 1: Implement**

Create `supabase/functions/generate-image/index.ts`:

```ts
import { generateImage } from "@tanstack/ai";
import { z } from "zod";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getUser } from "../_shared/auth.ts";
import { imageAdapter, imageModel } from "../_shared/openrouter.ts";

const requestSchema = z.object({
  noteId: z.string().uuid(),
  prompt: z.string().min(1).max(1000),
});

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { user, client } = await getUser(req);
    const body = requestSchema.parse(await req.json());

    const result = await generateImage({
      adapter: imageAdapter(imageModel()),
      prompt: `${body.prompt}. Photographic, plain background, no text, no letters, no words anywhere in the image.`,
      size: "1024x1024",
    });

    const image = result.images[0];
    if (!image) throw new Error("Model returned no image");

    const bytes = image.b64Json
      ? decodeBase64(image.b64Json)
      : new Uint8Array(await (await fetch(image.url!)).arrayBuffer());

    // The first path segment is the owner — the storage RLS policy checks it.
    const imagePath = `${user.id}/${body.noteId}.png`;

    const { error: uploadError } = await client.storage
      .from("note-images")
      .upload(imagePath, bytes, { contentType: "image/png", upsert: true });
    if (uploadError) throw uploadError;

    const { error: updateError } = await client
      .from("notes")
      .update({ image_path: imagePath })
      .eq("id", body.noteId);
    if (updateError) throw updateError;

    return jsonResponse({ imagePath });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("generate-image failed", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});
```

- [ ] **Step 2: Verify a user cannot write into another user's folder**

The storage policy keys on the first path segment, and `imagePath` is built from the verified JWT rather than from request input, so a caller cannot target another user. Confirm by reading the code: `body.noteId` only ever forms the filename, never the folder.

- [ ] **Step 3: Exercise it against a real note**

With `supabase functions serve` running and `$TOKEN` from Task 7, insert a deck and note through the REST API, then:

```bash
curl -s -X POST 'http://127.0.0.1:55321/functions/v1/generate-image' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"noteId\":\"$NOTE_ID\",\"prompt\":\"a ripe yellow banana\"}" | jq
```

Expected: `{ "imagePath": "<user-id>/<note-id>.png" }`, and the object appears in Studio at `http://127.0.0.1:55323` under Storage → note-images.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/generate-image
git commit -m "feat: add generate-image edge function writing to private storage"
```

---

## Task 9: Supabase client, auth and the login screen

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/lib/auth.ts`
- Modify: `src/routes/login.tsx`
- Modify: `src/routes/__root.tsx`

**Interfaces:**
- Consumes: `Database` from Task 4.
- Produces:
  - `supabase` — typed `SupabaseClient<Database>` singleton
  - `useSession(): { session: Session | null; loading: boolean }`
  - `useProfile()` — TanStack Query hook returning the profile row
  - A `/login` route handling both sign-up and sign-in

- [ ] **Step 1: Create the client**

Create `src/lib/supabase.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env.local",
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
```

- [ ] **Step 2: Create the auth hooks**

Create `src/lib/auth.ts`:

```ts
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email: string, password: string) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}
```

- [ ] **Step 3: Handle expired sessions**

`autoRefreshToken: true` in Step 1 covers the ordinary refresh. What it cannot cover is a
refresh token that has itself expired — supabase-js then emits `SIGNED_OUT` and every
subsequent Edge Function call would 401 silently.

Append to `src/lib/auth.ts`:

```ts
/**
 * supabase-js refreshes access tokens on its own. When the refresh token is
 * also dead it emits SIGNED_OUT, and the app must stop pretending it has a
 * session — otherwise queries fail with an unexplained 401.
 */
export function onSignedOut(handler: () => void) {
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") handler();
  });
  return () => data.subscription.unsubscribe();
}
```

Wire it into `src/routes/__root.tsx`:

```tsx
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { onSignedOut } from "@/lib/auth";
```

and inside `RootLayout`:

```tsx
const navigate = useNavigate();
useEffect(() => onSignedOut(() => navigate({ to: "/login" })), [navigate]);
```

- [ ] **Step 4: Build the login screen**

Replace `src/routes/login.tsx`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { signIn, signUp, signOut, useSession } from "@/lib/auth";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        if (mode === "signin") await signIn(value.email, value.password);
        else await signUp(value.email, value.password);
        navigate({ to: "/" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sign in failed");
      }
    },
  });

  if (session) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Signed in as {session.user.email}
        </p>
        <button
          className="w-full rounded-md border border-border p-3"
          onClick={() => signOut()}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <form
      className="p-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <h1 className="text-2xl font-bold">
        {mode === "signin" ? "Sign in" : "Create an account"}
      </h1>

      <form.Field name="email">
        {(field) => (
          <input
            className="w-full rounded-md border border-border p-3"
            type="email"
            placeholder="Email"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </form.Field>

      <form.Field name="password">
        {(field) => (
          <input
            className="w-full rounded-md border border-border p-3"
            type="password"
            placeholder="Password"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </form.Field>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        className="w-full rounded-md bg-primary p-3 text-primary-foreground"
      >
        {mode === "signin" ? "Sign in" : "Sign up"}
      </button>

      <button
        type="button"
        className="w-full text-sm text-muted-foreground"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Need an account?" : "Already have an account?"}
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Verify sign-up works against the local stack**

Run `npm run dev`, open `http://localhost:1420/login`, sign up with `you@example.com` / `password123`.

Expected: the screen switches to "Signed in as you@example.com". Confirm the trigger fired:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -c "select count(*) from public.profiles;"
```

Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase.ts src/lib/auth.ts src/routes/login.tsx src/routes/__root.tsx
git commit -m "feat: add supabase client, auth hooks and login screen"
```

---

## Task 10: Decks

**Files:**
- Create: `src/lib/api/decks.ts`
- Create: `src/routes/decks.index.tsx`
- Modify: `src/routes/__root.tsx`

**Interfaces:**
- Consumes: `supabase` from Task 9.
- Produces:
  - `useDecks()` — query returning `Deck[]`
  - `useCreateDeck()` — mutation taking `{ name: string; description?: string }`
  - `type Deck = Database["public"]["Tables"]["decks"]["Row"]`
  - Route `/decks`

- [ ] **Step 1: Write the data layer**

Create `src/lib/api/decks.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

export type Deck = Database["public"]["Tables"]["decks"]["Row"];

export function useDecks() {
  return useQuery({
    queryKey: ["decks"],
    queryFn: async (): Promise<Deck[]> => {
      const { data, error } = await supabase
        .from("decks")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateDeck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { name: string; description?: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("decks")
        .insert({
          name: input.name,
          description: input.description ?? null,
          user_id: userData.user.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["decks"] }),
  });
}
```

- [ ] **Step 2: Build the deck list route**

Create `src/routes/decks.index.tsx`:

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useDecks, useCreateDeck } from "@/lib/api/decks";

export const Route = createFileRoute("/decks/")({ component: DecksPage });

function DecksPage() {
  const { data: decks, isLoading } = useDecks();
  const createDeck = useCreateDeck();
  const [name, setName] = useState("");

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">Decks</h1>

      <div className="flex gap-2">
        <input
          className="flex-1 rounded-md border border-border p-3"
          placeholder="New deck name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
          disabled={!name.trim() || createDeck.isPending}
          onClick={() => {
            createDeck.mutate({ name: name.trim() });
            setName("");
          }}
        >
          Add
        </button>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}

      <ul className="space-y-2">
        {decks?.map((deck) => (
          <li key={deck.id}>
            <Link
              to="/decks/$deckId"
              params={{ deckId: deck.id }}
              className="block rounded-md border border-border p-4"
            >
              {deck.name}
            </Link>
          </li>
        ))}
      </ul>

      {decks?.length === 0 && (
        <p className="text-muted-foreground">
          No decks yet. Create one to start adding cards.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add Decks to the bottom navigation**

In `src/routes/__root.tsx`, add between the Today and Account links:

```tsx
<Link to="/decks" className="flex-1 p-4 text-center text-sm">
  Decks
</Link>
<Link to="/add" className="flex-1 p-4 text-center text-sm">
  Add
</Link>
```

- [ ] **Step 4: Verify**

With `npm run dev` running and signed in, visit `/decks`, create a deck named "German". Expected: it appears in the list and survives a page reload.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/decks.ts src/routes/decks.index.tsx src/routes/__root.tsx
git commit -m "feat: add deck list and creation"
```

---

## Task 11: Capture flow

**Files:**
- Create: `src/lib/api/ai.ts`
- Create: `src/lib/api/notes.ts`
- Create: `src/routes/add.tsx`

**Interfaces:**
- Consumes: `useDecks` (Task 10), `newCardColumns` (Task 5), the two Edge Functions (Tasks 7–8).
- Produces:
  - `generateNote(text, nativeLanguage): Promise<{ classification, generation }>`
  - `generateNoteImage(noteId, prompt): Promise<{ imagePath: string }>`
  - `useSaveNote()` — mutation taking `{ deckId, sourceText, classification, cards, imagePrompt }`, inserting the note and all cards, then firing image generation in the background
  - Route `/add`

**Ordering note:** the note is saved first and the image is generated afterwards against the saved `noteId`. Image generation is deliberately not awaited — a note with no image is valid.

- [ ] **Step 1: Write the Edge Function client**

Create `src/lib/api/ai.ts`:

```ts
import { supabase } from "@/lib/supabase";

export type Classification = {
  domain: string;
  language: string | null;
  partOfSpeech: string | null;
};

export type GeneratedCard = {
  aspect: string;
  front: string;
  back: string;
  hint: string | null;
};

export type GeneratedNote = {
  imagePrompt: string | null;
  cards: GeneratedCard[];
};

export async function generateNote(
  text: string,
  nativeLanguage: string,
): Promise<{ classification: Classification; generation: GeneratedNote }> {
  const { data, error } = await supabase.functions.invoke("generate-note", {
    body: { text, nativeLanguage },
  });
  if (error) throw error;
  return data;
}

export async function generateNoteImage(noteId: string, prompt: string) {
  const { data, error } = await supabase.functions.invoke("generate-image", {
    body: { noteId, prompt },
  });
  if (error) throw error;
  return data as { imagePath: string };
}
```

- [ ] **Step 2: Write the note persistence layer**

Create `src/lib/api/notes.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { newCardColumns } from "@/lib/fsrs";
import { generateNoteImage, type Classification, type GeneratedCard } from "@/lib/api/ai";
import type { Database } from "@/types/database";

export type Note = Database["public"]["Tables"]["notes"]["Row"];

export function useNotes(deckId: string) {
  return useQuery({
    queryKey: ["notes", deckId],
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase
        .from("notes")
        .select("*")
        .eq("deck_id", deckId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useSaveNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      deckId: string;
      sourceText: string;
      classification: Classification;
      cards: GeneratedCard[];
      imagePrompt: string | null;
    }) => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const userId = userData.user.id;

      const { data: note, error: noteError } = await supabase
        .from("notes")
        .insert({
          user_id: userId,
          deck_id: input.deckId,
          source_text: input.sourceText,
          domain: input.classification.domain,
          language: input.classification.language,
          metadata: { partOfSpeech: input.classification.partOfSpeech },
        })
        .select()
        .single();
      if (noteError) throw noteError;

      const now = new Date();
      const { error: cardsError } = await supabase.from("cards").insert(
        input.cards.map((card) => ({
          note_id: note.id,
          user_id: userId,
          aspect: card.aspect,
          front: card.front,
          back: card.back,
          hint: card.hint,
          ...newCardColumns(now),
        })),
      );
      if (cardsError) throw cardsError;

      // Fire and forget: a note without an image is still a valid note.
      if (input.imagePrompt) {
        generateNoteImage(note.id, input.imagePrompt)
          .then(() => queryClient.invalidateQueries({ queryKey: ["notes"] }))
          .catch((e) => console.error("Image generation failed", e));
      }

      return note;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["due"] });
    },
  });
}
```

- [ ] **Step 3: Build the capture route**

Create `src/routes/add.tsx`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDecks } from "@/lib/api/decks";
import { useSaveNote } from "@/lib/api/notes";
import { useProfile } from "@/lib/auth";
import {
  generateNote,
  type Classification,
  type GeneratedCard,
} from "@/lib/api/ai";

export const Route = createFileRoute("/add")({ component: AddPage });

function AddPage() {
  const navigate = useNavigate();
  const { data: decks } = useDecks();
  const { data: profile } = useProfile();
  const saveNote = useSaveNote();

  const [text, setText] = useState("");
  const [deckId, setDeckId] = useState("");
  const [status, setStatus] = useState<"idle" | "generating" | "review">("idle");
  const [error, setError] = useState<string | null>(null);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [imagePrompt, setImagePrompt] = useState<string | null>(null);
  const [cards, setCards] = useState<GeneratedCard[]>([]);

  async function handleGenerate() {
    setStatus("generating");
    setError(null);
    try {
      const result = await generateNote(text, profile?.native_language ?? "en");
      setClassification(result.classification);
      setImagePrompt(result.generation.imagePrompt);
      setCards(result.generation.cards);
      setStatus("review");
    } catch (e) {
      // Never a dead end: fall through to a hand-editable empty card.
      setError(
        e instanceof Error
          ? `${e.message} — you can still write the card yourself.`
          : "Generation failed",
      );
      setClassification({ domain: "concept", language: null, partOfSpeech: null });
      setImagePrompt(null);
      setCards([{ aspect: "meaning", front: text, back: "", hint: null }]);
      setStatus("review");
    }
  }

  function updateCard(index: number, patch: Partial<GeneratedCard>) {
    setCards((prev) =>
      prev.map((card, i) => (i === index ? { ...card, ...patch } : card)),
    );
  }

  if (status === "review") {
    return (
      <div className="p-4 space-y-4">
        <h1 className="text-2xl font-bold">Review cards</h1>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {classification && (
          <p className="text-sm text-muted-foreground">
            Detected: {classification.domain}
            {classification.language ? ` · ${classification.language}` : ""}
          </p>
        )}

        {cards.map((card, index) => (
          <div key={index} className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {card.aspect}
              </span>
              <button
                className="text-xs text-destructive"
                onClick={() => setCards(cards.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
            <input
              className="w-full rounded-md border border-border p-2"
              value={card.front}
              onChange={(e) => updateCard(index, { front: e.target.value })}
            />
            <input
              className="w-full rounded-md border border-border p-2"
              value={card.back}
              onChange={(e) => updateCard(index, { back: e.target.value })}
            />
          </div>
        ))}

        <button
          className="w-full rounded-md bg-primary p-3 text-primary-foreground disabled:opacity-50"
          disabled={cards.length === 0 || saveNote.isPending}
          onClick={async () => {
            await saveNote.mutateAsync({
              deckId,
              sourceText: text,
              classification: classification!,
              cards,
              imagePrompt,
            });
            navigate({ to: "/decks/$deckId", params: { deckId } });
          }}
        >
          {saveNote.isPending ? "Saving…" : `Save ${cards.length} cards`}
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">Add</h1>

      <select
        className="w-full rounded-md border border-border p-3"
        value={deckId}
        onChange={(e) => setDeckId(e.target.value)}
      >
        <option value="">Choose a deck…</option>
        {decks?.map((deck) => (
          <option key={deck.id} value={deck.id}>
            {deck.name}
          </option>
        ))}
      </select>

      <input
        className="w-full rounded-md border border-border p-3"
        placeholder="die Banane, Poseidon, entropy…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <button
        className="w-full rounded-md bg-primary p-3 text-primary-foreground disabled:opacity-50"
        disabled={!text.trim() || !deckId || status === "generating"}
        onClick={handleGenerate}
      >
        {status === "generating" ? "Generating…" : "Generate cards"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Verify the happy path**

With `supabase functions serve` and `npm run dev` both running, signed in, with a deck created: go to `/add`, choose the deck, enter `die Banane`, generate.

Expected: several editable cards appear including a gender card. Edit one back field, save. Expected: navigation to the deck page, and:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -c \
  "select aspect, front, back from public.cards order by aspect;"
```

shows the cards including your edit.

- [ ] **Step 5: Verify the failure path is not a dead end**

Stop `supabase functions serve`. Go to `/add`, enter a word, generate.

Expected: an error message plus one empty editable card prefilled with the entered text — not a blank screen or a crash.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api src/routes/add.tsx
git commit -m "feat: add capture flow with editable AI-generated cards"
```

---

## Task 12: Review session

**Files:**
- Create: `src/lib/api/review.ts`
- Create: `src/routes/review.$deckId.tsx`
- Create: `src/routes/decks.$deckId.tsx`
- Modify: `src/routes/index.tsx`

**Interfaces:**
- Consumes: `gradeCard`, `RATINGS`, `CardRow` from Task 5.
- Produces:
  - `useDueCards(deckId?: string)` — query returning `CardRow[]` due now
  - `useGradeCard()` — mutation taking `{ card: CardRow; rating: Grade }`
  - Routes `/review/$deckId`, `/decks/$deckId`, and a real `/` showing the due count

- [ ] **Step 1: Write the review data layer**

Create `src/lib/api/review.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Grade } from "ts-fsrs";
import { supabase } from "@/lib/supabase";
import { gradeCard, type CardRow } from "@/lib/fsrs";

export function useDueCards(deckId?: string) {
  return useQuery({
    queryKey: ["due", deckId ?? "all"],
    queryFn: async (): Promise<CardRow[]> => {
      let query = supabase
        .from("cards")
        .select("*, notes!inner(deck_id)")
        .eq("suspended", false)
        .lte("due", new Date().toISOString())
        .order("due", { ascending: true })
        .limit(100);

      if (deckId) query = query.eq("notes.deck_id", deckId);

      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as CardRow[];
    },
  });
}

export function useGradeCard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ card, rating }: { card: CardRow; rating: Grade }) => {
      const { card: columns, log } = gradeCard(card, rating);

      const { error: updateError } = await supabase
        .from("cards")
        .update(columns)
        .eq("id", card.id);
      if (updateError) throw updateError;

      const { error: logError } = await supabase.from("review_logs").insert({
        ...log,
        card_id: card.id,
        user_id: card.user_id,
      });
      if (logError) throw logError;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["due"] }),
  });
}
```

- [ ] **Step 2: Build the review screen**

Create `src/routes/review.$deckId.tsx`:

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { RATINGS } from "@/lib/fsrs";
import { useDueCards, useGradeCard } from "@/lib/api/review";

export const Route = createFileRoute("/review/$deckId")({ component: ReviewPage });

function ReviewPage() {
  const { deckId } = Route.useParams();
  const { data: cards, isLoading, isError } = useDueCards(deckId);
  const grade = useGradeCard();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  if (isLoading) return <p className="p-4 text-muted-foreground">Loading…</p>;

  if (isError) {
    return (
      <div className="p-4 space-y-2">
        <p className="text-destructive">Lost connection.</p>
        <p className="text-sm text-muted-foreground">
          Reviews are not being saved, so grading is disabled until the
          connection comes back.
        </p>
      </div>
    );
  }

  const card = cards?.[index];

  if (!card) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-lg">Nothing due. Well done.</p>
        <Link to="/" className="text-sm underline">
          Back to today
        </Link>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6">
      <p className="text-sm text-muted-foreground">
        {index + 1} of {cards.length} · {card.aspect}
      </p>

      <div className="rounded-md border border-border p-6 text-center text-xl">
        {card.front}
      </div>

      {revealed ? (
        <>
          <div className="rounded-md border border-border bg-muted p-6 text-center text-xl">
            {card.back}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {RATINGS.map((rating) => (
              <button
                key={rating.value}
                className="rounded-md border border-border p-3 text-sm disabled:opacity-50"
                disabled={grade.isPending}
                onClick={async () => {
                  await grade.mutateAsync({ card, rating: rating.value });
                  setRevealed(false);
                  setIndex(index + 1);
                }}
              >
                {rating.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <button
          className="w-full rounded-md bg-primary p-3 text-primary-foreground"
          onClick={() => setRevealed(true)}
        >
          Show answer
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the deck detail screen**

Create `src/routes/decks.$deckId.tsx`:

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useNotes } from "@/lib/api/notes";
import { useDueCards } from "@/lib/api/review";

export const Route = createFileRoute("/decks/$deckId")({ component: DeckPage });

function DeckPage() {
  const { deckId } = Route.useParams();
  const { data: notes } = useNotes(deckId);
  const { data: due } = useDueCards(deckId);

  return (
    <div className="p-4 space-y-4">
      <Link
        to="/review/$deckId"
        params={{ deckId }}
        className="block rounded-md bg-primary p-4 text-center text-primary-foreground"
      >
        Review {due?.length ?? 0} due
      </Link>

      <h2 className="font-semibold">Notes</h2>
      <ul className="space-y-2">
        {notes?.map((note) => (
          <li key={note.id} className="rounded-md border border-border p-3">
            <span>{note.source_text}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {note.domain}
            </span>
          </li>
        ))}
      </ul>

      {notes?.length === 0 && (
        <p className="text-muted-foreground">
          Nothing here yet. Add a word or concept.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Make the Today screen real**

Replace `src/routes/index.tsx`:

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useDueCards } from "@/lib/api/review";
import { useSession } from "@/lib/auth";

export const Route = createFileRoute("/")({ component: TodayPage });

function TodayPage() {
  const { session, loading } = useSession();
  const { data: due } = useDueCards();

  if (loading) return <p className="p-4 text-muted-foreground">Loading…</p>;

  if (!session) {
    return (
      <div className="p-4 space-y-4">
        <h1 className="text-2xl font-bold">mnimi</h1>
        <Link
          to="/login"
          className="block rounded-md bg-primary p-3 text-center text-primary-foreground"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">Today</h1>
      <p className="text-5xl font-bold">{due?.length ?? 0}</p>
      <p className="text-muted-foreground">cards due</p>
      <Link to="/decks" className="block text-sm underline">
        Choose a deck to review
      </Link>
    </div>
  );
}
```

- [ ] **Step 5: Verify scheduling actually persists**

Signed in with cards saved from Task 11: review a card and press Good. Then:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -c \
  "select aspect, state, reps, due from public.cards where reps > 0;"
```

Expected: the graded card has `reps = 1`, `state` no longer `0`, and `due` in the future.

```bash
psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -c \
  "select count(*) from public.review_logs;"
```

Expected: `1`.

- [ ] **Step 6: Verify it survives a restart**

Reload the app and open `/`. Expected: the due count has dropped by one, confirming state came from the database and not from memory.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api/review.ts src/routes/review.\$deckId.tsx src/routes/decks.\$deckId.tsx src/routes/index.tsx
git commit -m "feat: add FSRS review session with persisted scheduling"
```

---

## Task 13: Settings

**Files:**
- Create: `src/routes/settings.tsx`
- Modify: `src/routes/__root.tsx`

**Interfaces:**
- Consumes: `useProfile` from Task 9.
- Produces: route `/settings` where the native language is set. This matters — `generateNote` sends `profile.native_language` to the Edge Function, so a wrong value produces cards in the wrong language.

- [ ] **Step 1: Build the settings screen**

Create `src/routes/settings.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useProfile, signOut } from "@/lib/auth";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "pl", label: "Polski" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
];

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const { data: profile } = useProfile();
  const queryClient = useQueryClient();

  const updateLanguage = useMutation({
    mutationFn: async (nativeLanguage: string) => {
      const { error } = await supabase
        .from("profiles")
        .update({ native_language: nativeLanguage })
        .eq("id", profile!.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profile"] }),
  });

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="space-y-2">
        <label className="text-sm font-medium">Native language</label>
        <p className="text-sm text-muted-foreground">
          Cards are written against this language.
        </p>
        <select
          className="w-full rounded-md border border-border p-3"
          value={profile?.native_language ?? "en"}
          onChange={(e) => updateLanguage.mutate(e.target.value)}
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>

      <button
        className="w-full rounded-md border border-border p-3"
        onClick={() => signOut()}
      >
        Sign out
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Point the Account nav link at settings**

In `src/routes/__root.tsx`, change the Account link's `to="/login"` to `to="/settings"`.

- [ ] **Step 3: Verify the setting reaches generation**

Set the native language to Polski. Go to `/add` and generate cards for `die Banane`.

Expected: the learner-facing sides are in Polish rather than English.

- [ ] **Step 4: Commit**

```bash
git add src/routes/settings.tsx src/routes/__root.tsx
git commit -m "feat: add settings with native language selection"
```

---

## Task 14: Out-of-scope documentation

**Files:**
- Create: `docs/OUT-OF-SCOPE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the reference document the spec requires, so deferred decisions need not be re-argued.

- [ ] **Step 1: Write the document**

Create `docs/OUT-OF-SCOPE.md` covering, with reasoning for each, every item listed in section 12 of the spec:

- Language-learning practice: cloze deletion and sentence mining; TTS audio and listening cards; example sentences in context; verb conjugation tables, separable verbs, case governance; cognate and false-friend warnings relative to the learner's native language; sibling burying; leech handling.
- Architecture: offline-first SQLite plus sync, with the migration path spelled out — what changes, what does not, and where conflict resolution would live; FSRS parameter optimisation from `review_logs`; per-user OpenRouter keys; Edge Function rate limiting and cost controls.
- Product: shared and importable decks, Anki import/export; statistics and retention graphs; bulk capture by word list or book-photo OCR.

Each entry states what it is, why it was deferred, and what would need to change to add it.

- [ ] **Step 2: Rewrite the README**

Replace the Tauri boilerplate `README.md` with mnimi's actual setup: prerequisites, the podman socket step, `mise install`, `supabase start`, the non-default ports table, where to put `OPENROUTER_API_KEY`, and how to run the dev server, tests and Edge Functions.

- [ ] **Step 3: Verify against the spec**

Re-read section 12 of `docs/superpowers/specs/2026-07-27-mnimi-draft-design.md` and confirm every bullet has a corresponding entry.

- [ ] **Step 4: Commit**

```bash
git add docs/OUT-OF-SCOPE.md README.md
git commit -m "docs: record deferred scope and rewrite readme for mnimi"
```

---

## Task 15: Android build

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `mise.toml`
- Create: `src-tauri/gen/android/` (generated)

**Interfaces:**
- Consumes: the working web app from Tasks 1–13.
- Produces: an APK running on a device or emulator.

**This task depends on Android SDK/NDK state that may need your intervention.** If the NDK is missing, stop and report rather than guessing at a download.

- [ ] **Step 1: Establish the Android environment**

```bash
mise x -- bash -c 'echo "SDK=$ANDROID_HOME"; ls $ANDROID_HOME/ndk 2>/dev/null || echo "NDK MISSING"'
```

If the NDK is missing, install it:

```bash
mise x -- sdkmanager "ndk;27.0.12077973" "platforms;android-34" "build-tools;34.0.0"
```

Then add to `mise.toml` under `[env]`:

```toml
NDK_HOME = "{{env.ANDROID_HOME}}/ndk/27.0.12077973"
```

- [ ] **Step 2: Add the Rust Android targets**

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

- [ ] **Step 3: Set the app identifier**

In `src-tauri/tauri.conf.json`, set `identifier` to `dev.magmast.mnimi` and `productName` to `mnimi`.

- [ ] **Step 4: Initialise the Android project**

```bash
mise x -- npm run tauri android init
```

Expected: `src-tauri/gen/android/` is created. Add it to `.gitignore`.

- [ ] **Step 5: Point the app at a reachable Supabase**

`127.0.0.1` on an Android device is the device itself, not your machine. For a physical device on the same network, set `.env.local` to your host's LAN address:

```
VITE_SUPABASE_URL=http://192.168.1.X:55321
```

and start the dev server with `TAURI_DEV_HOST=192.168.1.X`. For an emulator use `http://10.0.2.2:55321`.

Also add the LAN URL to `[auth] additional_redirect_urls` in `supabase/config.toml` and restart the stack.

- [ ] **Step 6: Run on device**

```bash
mise x -- npm run tauri android dev
```

Expected: the app installs and launches, and you can sign in, add `die Banane`, and review a card on the device.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json mise.toml .gitignore
git commit -m "build: configure android target"
```

---

## Verification checklist

Run before declaring the draft done. Every line must actually be executed.

- [ ] `npm test` — all Vitest suites pass
- [ ] `npm run build` — exit 0
- [ ] `podman ps --format '{{.Names}}\t{{.Ports}}' | grep -i mnimi | grep -E '543[0-9]{2}'` — no output, i.e. mnimi binds no default ports
- [ ] `grep -ri "openrouter" src/ --include=*.ts --include=*.tsx` — no key material in client code
- [ ] Sign up, set native language, create a deck
- [ ] `die Banane` produces an image and multiple aspect-tagged cards including gender
- [ ] `Poseidon` produces cards with no gender or plural aspect forced onto it
- [ ] A card can be edited before saving
- [ ] Grading persists — `reps` increments and `review_logs` gains a row
- [ ] Due count survives an app restart
- [ ] `docs/OUT-OF-SCOPE.md` covers every bullet in spec section 12
