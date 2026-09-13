import type {
  CanvasElement,
  MarkdownColorStyleLibrary,
  ProfileDrawingPalettes,
} from "@squillpad/core-model";

export interface PageSnapshot {
  readonly elements: readonly CanvasElement[];
  readonly sources: Readonly<Record<string, string>>;
  readonly imageData?: Readonly<Record<string, string>>;
}
interface Change {
  path: string[];
  before: unknown;
  after: unknown;
}
interface CanvasChange extends Change {
  /** Undefined applies to shared project/profile state; otherwise this is a page-local change. */
  pageId?: string;
}
interface CanvasEntry {
  changes: CanvasChange[];
  group?: string | undefined;
  time: number;
}
const serialize = (value: unknown) =>
  JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
    // Markdown height is derived from rendered content, not an editable field.
    return key === "height" && this.kind === "markdown" ? undefined : item;
  });
const equal = (a: unknown, b: unknown) => serialize(a) === serialize(b);
type MutableContainer = Record<string, unknown> | unknown[];
const container = (value: unknown): value is MutableContainer =>
  value !== null && typeof value === "object";
const valueAt = (value: MutableContainer, key: string): unknown =>
  Array.isArray(value) ? value[Number(key)] : value[key];
const setValueAt = (value: MutableContainer, key: string, item: unknown): void => {
  if (Array.isArray(value)) value[Number(key)] = item;
  else value[key] = item;
};
const deleteValueAt = (value: MutableContainer, key: string): void => {
  if (Array.isArray(value)) delete value[Number(key)];
  else delete value[key];
};

function diff(before: unknown, after: unknown, path: string[] = []): Change[] {
  if (equal(before, after)) return [];
  if (container(before) && container(after)) {
    if (Array.isArray(before) !== Array.isArray(after)) return [{ path, before, after }];
    if (Array.isArray(before) && before.length !== (after as unknown[]).length) {
      return [{ path, before, after }];
    }
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      diff(valueAt(before, key), valueAt(after, key), [...path, key]),
    );
  }
  return [{ path, before, after }];
}
function state(snapshot: PageSnapshot) {
  return {
    elements: Object.fromEntries(snapshot.elements.map((element) => [element.id, element])),
    sources: snapshot.sources,
  };
}

export interface CanvasHistorySnapshot extends PageSnapshot {
  readonly markdownColorStyles: MarkdownColorStyleLibrary;
  readonly profileDrawingPalettes: ProfileDrawingPalettes;
}

function canvasState(snapshot: CanvasHistorySnapshot) {
  return {
    page: state(snapshot),
    markdownColorStyles: snapshot.markdownColorStyles,
    profileDrawingPalettes: snapshot.profileDrawingPalettes,
  };
}

function canvasSnapshot(value: ReturnType<typeof canvasState>): CanvasHistorySnapshot {
  return {
    elements: Object.values(value.page.elements),
    sources: value.page.sources,
    markdownColorStyles: value.markdownColorStyles,
    profileDrawingPalettes: value.profileDrawingPalettes,
  };
}

function isGlobalCanvasPath(path: readonly string[]): boolean {
  return path[0] === "markdownColorStyles" || path[0] === "profileDrawingPalettes";
}

function canvasChanges(
  pageId: string,
  before: CanvasHistorySnapshot,
  after: CanvasHistorySnapshot,
): CanvasChange[] {
  return diff(canvasState(before), canvasState(after)).map((change) => ({
    ...change,
    ...(isGlobalCanvasPath(change.path) ? {} : { pageId }),
  }));
}

function entryAppliesToPage(entry: CanvasEntry, pageId: string): boolean {
  const pageIds = new Set(
    entry.changes
      .map((change) => change.pageId)
      .filter((value): value is string => value !== undefined),
  );
  return pageIds.size === 0 || (pageIds.size === 1 && pageIds.has(pageId));
}

function mergeCanvasChanges(target: CanvasChange[], changes: readonly CanvasChange[]): void {
  for (const change of changes) {
    const existing = target.find(
      (item) => item.pageId === change.pageId && equal(item.path, change.path),
    );
    if (existing) {
      if (!equal(existing.after, change.before)) existing.before = change.before;
      existing.after = change.after;
    } else target.push(change);
  }
}

/**
 * Session history combines the active page with shared project/profile settings.
 * Page changes remain scoped to their page, while style and palette changes are
 * available from every page in the same CanvasSession.
 */
export class CanvasHistory {
  private past: CanvasEntry[] = [];
  private future: CanvasEntry[] = [];

  canUndo(pageId: string): boolean {
    return this.findApplicableIndex(this.past, pageId) >= 0;
  }

  canRedo(pageId: string): boolean {
    return this.findApplicableIndex(this.future, pageId) >= 0;
  }

  record(
    pageId: string,
    before: CanvasHistorySnapshot,
    after: CanvasHistorySnapshot,
    group?: string,
    time = Date.now(),
  ): void {
    const changes = canvasChanges(pageId, before, after);
    if (changes.length === 0) return;
    const previous = this.past.at(-1);
    if (group !== undefined && previous?.group === group && time - previous.time < 750) {
      mergeCanvasChanges(previous.changes, changes);
      previous.time = time;
    } else {
      this.past.push({ changes, group, time });
    }
    if (changes.some((change) => change.pageId === undefined)) {
      this.future = [];
    } else {
      this.future = this.future.filter(
        (entry) =>
          !entry.changes.some(
            (change) => change.pageId === undefined || change.pageId === pageId,
          ),
      );
    }
  }

  undo(pageId: string, current: CanvasHistorySnapshot): CanvasHistorySnapshot {
    return this.apply(pageId, current, this.past, this.future);
  }

  redo(pageId: string, current: CanvasHistorySnapshot): CanvasHistorySnapshot {
    return this.apply(pageId, current, this.future, this.past);
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  private findApplicableIndex(entries: readonly CanvasEntry[], pageId: string): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entryAppliesToPage(entries[index]!, pageId)) return index;
    }
    return -1;
  }

  private apply(
    pageId: string,
    current: CanvasHistorySnapshot,
    from: CanvasEntry[],
    to: CanvasEntry[],
  ): CanvasHistorySnapshot {
    const index = this.findApplicableIndex(from, pageId);
    if (index < 0) return current;
    const [entry] = from.splice(index, 1);
    if (entry === undefined) return current;
    const next = structuredClone(canvasState(current));
    const applied: CanvasChange[] = [];
    for (const change of entry.changes) {
      let target: MutableContainer = next;
      let reachable = true;
      for (const key of change.path.slice(0, -1)) {
        const child = valueAt(target, key);
        if (!container(child)) {
          reachable = false;
          break;
        }
        target = child;
      }
      if (!reachable) continue;
      const key = change.path.at(-1)!;
      if (!equal(valueAt(target, key), change.after)) continue;
      if (change.before === undefined) deleteValueAt(target, key);
      else setValueAt(target, key, structuredClone(change.before));
      applied.push({ ...change, before: change.after, after: change.before });
    }
    if (applied.length > 0) to.push({ changes: applied, time: Date.now() });
    return canvasSnapshot(next);
  }
}

/** Transient project session state survives page component unmounts. */
export class CanvasSession {
  readonly history = new CanvasHistory();
  clipboard: PageSnapshot | undefined;
}
