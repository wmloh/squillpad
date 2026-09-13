import type { KeyboardEvent, RefObject } from "react";

export interface MarkdownSearchControlProps {
  readonly activeMatchIndex: number;
  readonly className?: string;
  readonly matchCount: number;
  readonly onMove: (direction: number) => void;
  readonly onQueryChange: (query: string) => void;
  readonly query: string;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}

/** Renders the compact Markdown search input and match navigation controls. */
export function MarkdownSearchControl({
  activeMatchIndex,
  className,
  matchCount,
  onMove,
  onQueryChange,
  query,
  inputRef,
}: MarkdownSearchControlProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onMove(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      onQueryChange("");
    }
  };
  const status =
    query.trim().length === 0
      ? ""
      : matchCount === 0
        ? "No matches"
        : `${Math.min(activeMatchIndex, matchCount - 1) + 1} / ${matchCount}`;

  return (
    <div
      className={`markdown-search${className === undefined ? "" : ` ${className}`}`}
      role="search"
      aria-label="Markdown search"
    >
      <input
        ref={inputRef}
        type="search"
        aria-label="Search Markdown text"
        placeholder="Search Markdown"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        aria-label="Previous Markdown match"
        title="Previous Markdown match"
        disabled={matchCount === 0}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next Markdown match"
        title="Next Markdown match"
        disabled={matchCount === 0}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      <output aria-live="polite">{status}</output>
    </div>
  );
}
