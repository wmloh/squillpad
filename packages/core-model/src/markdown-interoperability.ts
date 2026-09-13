import type { MarkdownCanvasRecord, CanvasRecord } from "./canonical-format.js";

/** A Markdown canvas record paired with the source held outside canvas.jsonl. */
export interface MarkdownExportBlock {
  readonly record: MarkdownCanvasRecord;
  readonly source: string;
}

/** Returns Markdown blocks in the documented reading order for a page export. */
export function orderMarkdownBlocks(
  elements: readonly CanvasRecord[],
): readonly MarkdownCanvasRecord[] {
  return elements
    .filter((element): element is MarkdownCanvasRecord => element.kind === "markdown")
    .sort(compareMarkdownPosition);
}

/**
 * Linearizes spatial Markdown blocks for a text-only export.
 *
 * The source of each block is kept unchanged and separated by two LF characters. Relative asset
 * links therefore remain relative links; the caller should export the file beside its assets.
 */
export function linearizeMarkdownBlocks(
  elements: readonly CanvasRecord[],
  markdownSources: Readonly<Record<string, string>>,
): string {
  return orderMarkdownBlocks(elements)
    .map((element) => markdownSources[element.id] ?? "")
    .join("\n\n");
}

/** Returns the exact current source for one Markdown block, without Markdown conversion. */
export function markdownSourceForElement(
  element: MarkdownCanvasRecord,
  markdownSources: Readonly<Record<string, string>>,
): string {
  return markdownSources[element.id] ?? "";
}

/** Pairs Markdown records with their source in deterministic top-to-bottom order. */
export function markdownExportBlocks(
  elements: readonly CanvasRecord[],
  markdownSources: Readonly<Record<string, string>>,
): readonly MarkdownExportBlock[] {
  return orderMarkdownBlocks(elements).map((record) => ({
    record,
    source: markdownSourceForElement(record, markdownSources),
  }));
}

function compareMarkdownPosition(left: MarkdownCanvasRecord, right: MarkdownCanvasRecord): number {
  return (
    left.position[1] - right.position[1] ||
    left.position[0] - right.position[0] ||
    left.z - right.z ||
    compareIds(left.id, right.id)
  );
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
