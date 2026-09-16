const mockListKey = ["drafts", "list", {}];
const mockDetailKey = (id: string) => ["drafts", "get", { creationId: id }];

jest.mock("@/api/orpc", () => ({
  client: { drafts: { watchInbox: jest.fn(), submit: jest.fn(), save: jest.fn() } },
  orpc: {
    drafts: {
      key: () => ["drafts"],
      list: { queryOptions: () => ({ queryKey: mockListKey, queryFn: jest.fn() }) },
      get: {
        queryOptions: ({ input }: any) => ({
          queryKey: mockDetailKey(input.creationId),
          queryFn: jest.fn(),
        }),
      },
    },
    notes: { key: () => ["notes"] },
    cards: { key: () => ["cards"] },
    decks: { key: () => ["decks"] },
  },
}));

import { QueryClient } from "@tanstack/react-query";
import {
  applyCreationInboxSnapshot,
  creationDetailKey,
  creationListKey,
  removeCreationFromCache,
  saveCreationWithCache,
  type CreationSummary,
} from "@/api/creations";

const mockSave = jest.mocked(require("@/api/orpc").client.drafts.save);

const summary = (id: string, revision: number): CreationSummary => ({
  id,
  clientRequestId: `request-${id}`,
  sourceText: id,
  deckName: null,
  group: "queued",
  stateLabel: "Queued",
  thumbnailId: null,
  revision,
  createdAt: new Date(0),
  updatedAt: new Date(revision),
});

describe("creation API cache", () => {
  it("uses stable list and isolated detail keys", () => {
    expect(creationListKey()).toEqual(mockListKey);
    expect(creationDetailKey("one")).toEqual(mockDetailKey("one"));
    expect(creationDetailKey("one")).not.toEqual(creationDetailKey("two"));
  });

  it("ignores an older inbox snapshot and accepts a newer revision", () => {
    const current = [summary("one", 3), summary("two", 1)];
    expect(applyCreationInboxSnapshot(current, [summary("one", 2)]))
      .toEqual(current);
    expect(applyCreationInboxSnapshot(current, [summary("one", 4)]))
      .toEqual([summary("one", 4)]);
  });

  it("removes only the consumed creation from list and detail caches", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(creationListKey(), [summary("one", 1), summary("two", 1)]);
    queryClient.setQueryData(creationDetailKey("one"), { id: "one" });
    queryClient.setQueryData(creationDetailKey("two"), { id: "two" });

    removeCreationFromCache(queryClient, "one");

    expect(queryClient.getQueryData<CreationSummary[]>(creationListKey()))
      .toEqual([summary("two", 1)]);
    expect(queryClient.getQueryData(creationDetailKey("one"))).toBeUndefined();
    expect(queryClient.getQueryData(creationDetailKey("two"))).toEqual({ id: "two" });
    queryClient.clear();
  });

  it("saves with the supplied stable request and evicts only that creation", async () => {
    mockSave.mockResolvedValue({
      noteId: "note-1",
      deckId: "deck-1",
      sourceText: "one",
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    queryClient.setQueryData(creationListKey(), [summary("one", 2), summary("two", 1)]);
    const input = {
      creationId: "one",
      expectedRevision: 2,
      saveRequestId: "stable-save-request",
    };
    await expect(saveCreationWithCache(queryClient, input)).resolves.toMatchObject({
      noteId: "note-1",
    });
    expect(mockSave).toHaveBeenCalledWith(input);
    expect(queryClient.getQueryData<CreationSummary[]>(creationListKey()))
      .toEqual([summary("two", 1)]);
    queryClient.clear();
  });
});
