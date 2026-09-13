import { elementsByZ, type CanvasElement } from "@squillpad/core-model";

export interface MarkdownSearchBlock {
  readonly elementId: string;
  readonly matchOffset: number;
  readonly matchCount: number;
}

export interface MarkdownSearchMatch {
  readonly elementId: string;
  readonly occurrence: number;
  readonly index: number;
}

export interface MarkdownSearchResult {
  readonly blocks: readonly MarkdownSearchBlock[];
  readonly matches: readonly MarkdownSearchMatch[];
}

/** Finds case-insensitive Markdown source matches in visual canvas order. */
export function searchMarkdown(
  elements: readonly CanvasElement[],
  sources: Readonly<Record<string, string>>,
  query: string,
): MarkdownSearchResult {
  const needle = normalizeQuery(query);
  if (needle.length === 0) return { blocks: [], matches: [] };

  const blocks: MarkdownSearchBlock[] = [];
  const matches: MarkdownSearchMatch[] = [];
  let matchOffset = 0;
  for (const element of elementsByZ(elements)) {
    if (element.kind !== "markdown") continue;
    const matchCount = countMarkdownMatches(sources[element.id] ?? "", needle);
    blocks.push({ elementId: element.id, matchOffset, matchCount });
    for (let occurrence = 0; occurrence < matchCount; occurrence += 1) {
      matches.push({ elementId: element.id, occurrence, index: matchOffset + occurrence });
    }
    matchOffset += matchCount;
  }
  return { blocks, matches };
}

/** Counts non-overlapping, case-insensitive occurrences in one Markdown source. */
export function countMarkdownMatches(source: string, query: string): number {
  const needle = normalizeQuery(query);
  if (needle.length === 0) return 0;
  const haystack = source.toLocaleLowerCase();
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}
