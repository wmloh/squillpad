import {
  elementsByZ,
  validateCanvasRecords,
  type CanvasRecord,
  type JsonValue,
} from "@squillpad/core-model";
import * as Y from "yjs";

const OBJECTS_KEY = "objects";
const MARKDOWN_KEY = "markdown";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The default maximum number of simultaneous host synchronization clients. */
export const DEFAULT_CLIENT_LIMIT = 5;
/** The smallest client limit a host can configure. */
export const MIN_CLIENT_LIMIT = 1;
/** The largest client limit a host can configure. */
export const MAX_CLIENT_LIMIT = 20;
/** Close code used when a connection loses a race for the last client slot. */
export const CLIENT_LIMIT_CLOSE_CODE = 4429;
export const CLIENT_LIMIT_CLOSE_REASON = "Client limit reached";

export function isClientLimit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= MIN_CLIENT_LIMIT &&
    (value as number) <= MAX_CLIENT_LIMIT
  );
}

export interface SynchronizedPageContent {
  readonly canvas: readonly CanvasRecord[];
  readonly markdown: Readonly<Record<string, string>>;
}

export interface PageRoomIdentity {
  readonly projectId: string;
  readonly pageId: string;
}

/** Creates a disposable page CRDT and optionally hydrates it from canonical content. */
export function createPageDocument(
  content: SynchronizedPageContent = { canvas: [], markdown: {} },
): Y.Doc {
  const document = new Y.Doc();
  hydratePageDocument(document, content);
  return document;
}

/** Hydrates an empty page document from validated canonical content. */
export function hydratePageDocument(document: Y.Doc, content: SynchronizedPageContent): boolean {
  if (!isPageDocumentEmpty(document)) return false;
  replacePageContent(document, content, "canonical-hydration");
  return true;
}

/** Reports whether a document has no synchronized page objects or Markdown text. */
export function isPageDocumentEmpty(document: Y.Doc): boolean {
  return objects(document).size === 0 && markdown(document).size === 0;
}

/** Reconciles a complete local page projection into its shared Yjs structures. */
export function replacePageContent(
  document: Y.Doc,
  content: SynchronizedPageContent,
  origin: unknown = "local-page-update",
): void {
  const valid = validateCanvasRecords(content.canvas);
  if (!valid.success) throw new Error(formatValidationIssues(valid.issues));
  const markdownIds = new Set(
    valid.data.filter((record) => record.kind === "markdown").map((record) => record.id),
  );
  if (
    Object.keys(content.markdown).some((id) => !markdownIds.has(id)) ||
    [...markdownIds].some((id) => typeof content.markdown[id] !== "string")
  ) {
    throw new Error("Markdown sources must exactly match synchronized Markdown objects");
  }

  document.transact(() => {
    const objectMap = objects(document);
    const nextIds = new Set(valid.data.map((record) => record.id));
    for (const id of objectMap.keys()) if (!nextIds.has(id)) objectMap.delete(id);
    for (const record of valid.data) {
      let shared = objectMap.get(record.id);
      if (shared === undefined) {
        shared = new Y.Map<unknown>();
        objectMap.set(record.id, shared);
      }
      reconcileMap(shared, record as unknown as Record<string, unknown>);
    }

    const textMap = markdown(document);
    for (const id of textMap.keys()) if (!markdownIds.has(id)) textMap.delete(id);
    for (const id of markdownIds) setMarkdownText(textMap, id, content.markdown[id] as string);
  }, origin);
}

/** Applies externally edited canonical content by stable ID while preserving unrelated Yjs data. */
export function reconcilePageContentById(
  document: Y.Doc,
  previous: SynchronizedPageContent,
  next: SynchronizedPageContent,
  origin: unknown = "external-canonical",
): void {
  const valid = validateCanvasRecords(next.canvas);
  if (!valid.success) throw new Error(formatValidationIssues(valid.issues));
  const nextRecords = new Map(valid.data.map((record) => [record.id, record]));
  const previousRecords = new Map(previous.canvas.map((record) => [record.id, record]));
  const nextMarkdownIds = new Set(
    valid.data.filter((record) => record.kind === "markdown").map((record) => record.id),
  );

  if (
    Object.keys(next.markdown).some((id) => !nextMarkdownIds.has(id)) ||
    [...nextMarkdownIds].some((id) => typeof next.markdown[id] !== "string")
  ) {
    throw new Error("Markdown sources must exactly match synchronized Markdown objects");
  }

  document.transact(() => {
    const objectMap = objects(document);
    const changedIds = new Set([...previousRecords.keys(), ...nextRecords.keys()]);
    for (const id of changedIds) {
      const before = previousRecords.get(id);
      const after = nextRecords.get(id);
      if (after === undefined) {
        if (before !== undefined) objectMap.delete(id);
        continue;
      }
      if (before !== undefined && equalJson(before, after)) continue;
      let shared = objectMap.get(id);
      if (shared === undefined) {
        shared = new Y.Map<unknown>();
        objectMap.set(id, shared);
      }
      reconcileMap(shared, after as unknown as Record<string, unknown>);
    }

    const textMap = markdown(document);
    const previousMarkdownIds = new Set(Object.keys(previous.markdown));
    const markdownIds = new Set([...previousMarkdownIds, ...nextMarkdownIds]);
    for (const id of markdownIds) {
      const before = previous.markdown[id];
      const after = next.markdown[id];
      if (after === undefined) {
        if (before !== undefined) textMap.delete(id);
      } else if (before !== after || textMap.get(id) === undefined) {
        setMarkdownText(textMap, id, after);
      }
    }
  }, origin);
}

/** Updates one Markdown source with a minimal Y.Text splice for concurrent typing. */
export function updateMarkdownSource(
  document: Y.Doc,
  objectId: string,
  source: string,
  origin: unknown = "local-markdown-update",
): void {
  if (!UUID_PATTERN.test(objectId)) throw new Error("Markdown object ID must be a stable UUID");
  document.transact(() => setMarkdownText(markdown(document), objectId, source), origin);
}

/** Projects shared state into the validated canonical page representation. */
export function materializePageDocument(document: Y.Doc): SynchronizedPageContent {
  const records = [...objects(document).values()].map((value) => fromShared(value));
  const valid = validateCanvasRecords(records);
  if (!valid.success) throw new Error(formatValidationIssues(valid.issues));
  const sources: Record<string, string> = {};
  for (const record of valid.data) {
    if (record.kind !== "markdown") continue;
    const text = markdown(document).get(record.id);
    if (text === undefined) throw new Error(`Missing synchronized Markdown source ${record.id}`);
    sources[record.id] = text.toJSON();
  }
  return { canvas: elementsByZ(valid.data), markdown: sources };
}

/** Observes any durable page content change. */
export function observePageDocument(document: Y.Doc, listener: () => void): () => void {
  const notify = () => listener();
  objects(document).observeDeep(notify);
  markdown(document).observeDeep(notify);
  return () => {
    objects(document).unobserveDeep(notify);
    markdown(document).unobserveDeep(notify);
  };
}

/** Builds a revision-fenced transport and IndexedDB key for one project page. */
export function pageRoomId(generation: string, projectId: string, pageId: string): string {
  if (
    !UUID_PATTERN.test(generation) ||
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(pageId)
  ) {
    throw new Error("Page rooms require lowercase RFC 4122 generation, project, and page UUIDs");
  }
  return `${generation}:${projectId}:${pageId}`;
}

/** Parses a stable page room ID without accepting titles or transient client IDs. */
export function parsePageRoomId(
  roomId: string,
): (PageRoomIdentity & { readonly generation: string }) | undefined {
  const [generation, projectId, pageId, extra] = roomId.split(":");
  if (
    extra !== undefined ||
    generation === undefined ||
    projectId === undefined ||
    pageId === undefined
  ) {
    return undefined;
  }
  if (
    !UUID_PATTERN.test(generation) ||
    !UUID_PATTERN.test(projectId) ||
    !UUID_PATTERN.test(pageId)
  ) {
    return undefined;
  }
  return { generation, projectId, pageId };
}

function objects(document: Y.Doc): Y.Map<Y.Map<unknown>> {
  return document.getMap<Y.Map<unknown>>(OBJECTS_KEY);
}

function markdown(document: Y.Doc): Y.Map<Y.Text> {
  return document.getMap<Y.Text>(MARKDOWN_KEY);
}

function reconcileMap(target: Y.Map<unknown>, source: Record<string, unknown>): void {
  for (const key of target.keys()) if (!(key in source)) target.delete(key);
  for (const [key, value] of Object.entries(source)) {
    const current = target.get(key);
    if (isPlainObject(value)) {
      let child = current instanceof Y.Map ? current : undefined;
      if (child === undefined) {
        child = new Y.Map<unknown>();
        target.set(key, child);
      }
      reconcileMap(child, value);
    } else if (Array.isArray(value)) {
      if (current instanceof Y.Array && equalJson(current.toJSON(), value)) continue;
      const child = new Y.Array<unknown>();
      child.push(value.map((item) => toShared(item)));
      target.set(key, child);
    } else if (current !== value) {
      target.set(key, value);
    }
  }
}

function toShared(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result = new Y.Array<unknown>();
    result.push(value.map((item) => toShared(item)));
    return result;
  }
  if (isPlainObject(value)) {
    const result = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value)) result.set(key, toShared(item));
    return result;
  }
  return value;
}

function fromShared(value: unknown): JsonValue {
  if (value instanceof Y.Map) {
    return Object.fromEntries([...value.entries()].map(([key, item]) => [key, fromShared(item)]));
  }
  if (value instanceof Y.Array) return value.toArray().map((item) => fromShared(item));
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error("Synchronized canvas data contains an unsupported value");
}

function setMarkdownText(textMap: Y.Map<Y.Text>, id: string, source: string): void {
  let text = textMap.get(id);
  if (text === undefined) {
    text = new Y.Text();
    textMap.set(id, text);
  }
  const current = text.toJSON();
  if (current === source) return;
  let prefix = 0;
  while (prefix < current.length && prefix < source.length && current[prefix] === source[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < source.length - prefix &&
    current[current.length - suffix - 1] === source[source.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const deleteLength = current.length - prefix - suffix;
  if (deleteLength > 0) text.delete(prefix, deleteLength);
  const insertion = source.slice(prefix, source.length - suffix);
  if (insertion.length > 0) text.insert(prefix, insertion);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatValidationIssues(
  issues: readonly { readonly path: string; readonly message: string }[],
): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}

export * from "./page-sync-client.js";
