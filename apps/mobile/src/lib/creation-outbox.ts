import AsyncStorage from "@react-native-async-storage/async-storage";

export type CreationOutboxItem = {
  clientRequestId: string;
  sourceText: string;
  createdAt: number;
  state: "pending" | "sending" | "failed";
  error: string | null;
};

export type CreationOutboxDocument = {
  composer: string;
  items: CreationOutboxItem[];
};

export type CreationRequestValidation =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function emptyCreationOutbox(): CreationOutboxDocument {
  return { composer: "", items: [] };
}

export function normalizeCreationRequest(value: string): CreationRequestValidation {
  const text = value.trim();
  if (!text) return { ok: false, error: "Describe what you want to learn." };
  if (text.length > 2_000) {
    return { ok: false, error: "Keep your request to 2,000 characters." };
  }
  return { ok: true, text };
}

function opaqueRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function enqueueRequest(
  document: CreationOutboxDocument,
  options: { clientRequestId?: string; createdAt?: number } = {},
):
  | { ok: false; error: string; document: CreationOutboxDocument }
  | {
    ok: true;
    document: CreationOutboxDocument;
    item: CreationOutboxItem;
    submissionText: string;
  } {
  const validation = normalizeCreationRequest(document.composer);
  if (!validation.ok) return { ...validation, document };
  const item: CreationOutboxItem = {
    clientRequestId: options.clientRequestId ?? opaqueRequestId(),
    sourceText: document.composer,
    createdAt: options.createdAt ?? Date.now(),
    state: "pending",
    error: null,
  };
  return {
    ok: true,
    item,
    submissionText: validation.text,
    document: { composer: "", items: [...document.items, item] },
  };
}

function updateItem(
  document: CreationOutboxDocument,
  clientRequestId: string,
  update: (item: CreationOutboxItem) => CreationOutboxItem,
): CreationOutboxDocument {
  return {
    ...document,
    items: document.items.map((item) =>
      item.clientRequestId === clientRequestId ? update(item) : item
    ),
  };
}

export function markSending(
  document: CreationOutboxDocument,
  clientRequestId: string,
): CreationOutboxDocument {
  return updateItem(document, clientRequestId, (item) => ({
    ...item,
    state: "sending",
    error: null,
  }));
}

export function markFailed(
  document: CreationOutboxDocument,
  clientRequestId: string,
  error: string,
): CreationOutboxDocument {
  return updateItem(document, clientRequestId, (item) => ({
    ...item,
    state: "failed",
    error,
  }));
}

export function acknowledgeRequest(
  document: CreationOutboxDocument,
  clientRequestId: string,
): CreationOutboxDocument {
  return {
    ...document,
    items: document.items.filter((item) =>
      item.clientRequestId !== clientRequestId
    ),
  };
}

export function shouldShowCreationCharacterCount(value: string): boolean {
  return value.length >= 1_800;
}

export function creationOutboxKey(userId: string): string {
  return `mnimi:creation-outbox:${userId}`;
}

function isDocument(value: unknown): value is CreationOutboxDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CreationOutboxDocument>;
  return typeof candidate.composer === "string" &&
    Array.isArray(candidate.items) && candidate.items.every((item) =>
      item && typeof item === "object" &&
      typeof (item as CreationOutboxItem).clientRequestId === "string" &&
      typeof (item as CreationOutboxItem).sourceText === "string" &&
      typeof (item as CreationOutboxItem).createdAt === "number" &&
      ["pending", "sending", "failed"].includes(
        (item as CreationOutboxItem).state,
      )
    );
}

export async function loadCreationOutbox(
  userId: string,
): Promise<CreationOutboxDocument> {
  const stored = await AsyncStorage.getItem(creationOutboxKey(userId));
  if (!stored) return emptyCreationOutbox();
  try {
    const parsed: unknown = JSON.parse(stored);
    return isDocument(parsed) ? parsed : emptyCreationOutbox();
  } catch {
    return emptyCreationOutbox();
  }
}

export async function saveCreationOutbox(
  userId: string,
  document: CreationOutboxDocument,
): Promise<void> {
  await AsyncStorage.setItem(creationOutboxKey(userId), JSON.stringify(document));
}
