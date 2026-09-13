import type { EditorView } from "@codemirror/view";

export interface MarkdownEditorTextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface MarkdownEditorSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface MarkdownEditorEdit {
  readonly changes: readonly MarkdownEditorTextChange[];
  readonly selection: MarkdownEditorSelection;
}

/** Creates a Markdown edit that toggles an inline marker around the selection. */
export function createMarkdownInlineFormattingEdit(
  source: string,
  anchor: number,
  head: number,
  marker: string,
): MarkdownEditorEdit {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const markerLength = marker.length;
  if (markerLength === 0) {
    return { changes: [], selection: { anchor, head } };
  }

  const before = source.slice(Math.max(0, from - markerLength), from);
  const after = source.slice(to, to + markerLength);
  if (before === marker && after === marker) {
    return {
      changes: [
        { from: from - markerLength, to: from, insert: "" },
        { from: to, to: to + markerLength, insert: "" },
      ],
      selection: preserveSelectionDirection(anchor, head, from - markerLength, to - markerLength),
    };
  }

  const selected = source.slice(from, to);
  if (
    selected.length >= markerLength * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    return {
      changes: [
        { from, to: from + markerLength, insert: "" },
        { from: to - markerLength, to, insert: "" },
      ],
      selection: preserveSelectionDirection(anchor, head, from, to - markerLength * 2),
    };
  }

  if (from === to) {
    return {
      changes: [{ from, to, insert: marker + marker }],
      selection: { anchor: from + markerLength, head: from + markerLength },
    };
  }

  return {
    changes: [{ from, to, insert: marker + selected + marker }],
    selection: preserveSelectionDirection(anchor, head, from + markerLength, to + markerLength),
  };
}

/** Creates a Markdown link edit and selects the URL placeholder for replacement. */
export function createMarkdownLinkEdit(
  source: string,
  anchor: number,
  head: number,
): MarkdownEditorEdit {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const label = source.slice(from, to) || "link text";
  const url = "url";
  const insert = `[${label}](${url})`;
  const urlStart = from + 1 + label.length + 2;

  return {
    changes: [{ from, to, insert }],
    selection: { anchor: urlStart, head: urlStart + url.length },
  };
}

export function toggleMarkdownInlineFormatting(view: EditorView, marker: string): boolean {
  const selection = view.state.selection.main;
  const edit = createMarkdownInlineFormattingEdit(
    view.state.doc.toString(),
    selection.anchor,
    selection.head,
    marker,
  );
  view.dispatch({ changes: edit.changes, selection: edit.selection, userEvent: "input" });
  return true;
}

export function insertMarkdownLink(view: EditorView): boolean {
  const selection = view.state.selection.main;
  const edit = createMarkdownLinkEdit(view.state.doc.toString(), selection.anchor, selection.head);
  view.dispatch({ changes: edit.changes, selection: edit.selection, userEvent: "input" });
  return true;
}

function preserveSelectionDirection(
  anchor: number,
  head: number,
  from: number,
  to: number,
): MarkdownEditorSelection {
  return anchor <= head ? { anchor: from, head: to } : { anchor: to, head: from };
}
