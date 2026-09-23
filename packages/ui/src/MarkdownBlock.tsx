import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import "katex/dist/katex.min.css";
import {
  DEFAULT_MARKDOWN_FONT_SIZE,
  type MarkdownColorStyle,
} from "@squillpad/core-model";
import {
  useEffect,
  useLayoutEffect,
  memo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { markdownBlockHeightFromContent } from "./markdown-layout";
import { insertMarkdownLink, toggleMarkdownInlineFormatting } from "./markdown-formatting";
import { calculateMarkdownEditorKeyboardAdjustment } from "./markdown-keyboard";

const KATEX_OPTIONS = {
  errorColor: "#a3203e",
  output: "htmlAndMathml" as const,
  strict: "error" as const,
  throwOnError: false,
  trust: false,
};

const MARKDOWN_EDITOR_SETUP = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  syntaxHighlighting(
    HighlightStyle.define([{ tag: tags.meta, color: "var(--markdown-editor-markup-color)" }]),
  ),
  keymap.of([
    { key: "Shift-Enter", run: insertMarkdownHardBreak },
    { key: "Mod-b", run: (view) => toggleMarkdownInlineFormatting(view, "**") },
    { key: "Mod-i", run: (view) => toggleMarkdownInlineFormatting(view, "*") },
    { key: "Mod-Shift-x", run: (view) => toggleMarkdownInlineFormatting(view, "~~") },
    { key: "Mod-`", run: (view) => toggleMarkdownInlineFormatting(view, "`") },
    { key: "Mod-k", run: insertMarkdownLink },
    ...defaultKeymap,
    ...historyKeymap,
  ]),
];
const MARKDOWN_EDITOR_ENTER_DURATION_MS = 420;
const MARKDOWN_EDITOR_EXIT_DURATION_MS = 360;
const MARKDOWN_HARD_BREAK = "\\" + "\n";
const MARKDOWN_EDITOR_KEYBOARD_OFFSET_PROPERTY = "--markdown-editor-keyboard-offset-y";
const MARKDOWN_EDITOR_KEYBOARD_MAX_HEIGHT_PROPERTY = "--markdown-editor-keyboard-max-height";

function insertMarkdownHardBreak(view: EditorView): boolean {
  const selection = view.state.selection.main;
  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: MARKDOWN_HARD_BREAK,
    },
    selection: { anchor: selection.from + MARKDOWN_HARD_BREAK.length },
    userEvent: "input",
  });
  return true;
}

type MarkdownEditorPhase = "closed" | "opening" | "open" | "closing";

interface MarkdownSearchNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownSearchNode[];
}

interface MarkdownAstNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  data?: {
    hName?: string;
    hChildren?: MarkdownAstNode[];
    hProperties?: Record<string, unknown>;
  };
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: MarkdownAstNode[];
}

function remarkMarkdownHardBreaks() {
  return (tree: MarkdownAstNode, file: { readonly value: unknown }): void => {
    if (typeof file.value !== "string") return;
    normalizeMarkdownHardBreaks(tree, file.value);
  };
}

/** Adds explicit `{#id}` attributes to Markdown headings. */
function remarkMarkdownHeadingIds() {
  return (tree: MarkdownAstNode): void => {
    addMarkdownHeadingIds(tree);
  };
}

function addMarkdownHeadingIds(node: MarkdownAstNode): void {
  if (node.type === "heading" && node.children !== undefined && node.children.length > 0) {
    const lastIndex = node.children.length - 1;
    const last = node.children[lastIndex];
    if (last?.type === "text" && last.value !== undefined) {
      const match = last.value.match(/(?:^|\s)\{#([A-Za-z][A-Za-z0-9._:-]*)\}\s*$/u);
      const id = match?.[1];
      const matchIndex = match?.index;
      if (id !== undefined && matchIndex !== undefined) {
        const label = last.value.slice(0, matchIndex).replace(/\s+$/u, "");
        if (label.length === 0) node.children.splice(lastIndex, 1);
        else node.children[lastIndex] = { ...last, value: label };
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, id },
        };
      }
    }
  }
  node.children?.forEach(addMarkdownHeadingIds);
}

/** Converts `==text==` spans to semantic HTML marks after Markdown parsing. */
function rehypeMarkdownHighlights() {
  return (tree: MarkdownAstNode): void => {
    transformMarkdownHighlights(tree, false);
  };
}

function transformMarkdownHighlights(node: MarkdownAstNode, insideCode: boolean): void {
  if (node.children === undefined) return;
  const skipChildren = insideCode || node.tagName === "code" || node.tagName === "pre";
  const children: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (!skipChildren && child.type === "text" && child.value !== undefined) {
      children.push(...highlightMarkdownText(child.value));
      continue;
    }
    transformMarkdownHighlights(child, skipChildren);
    children.push(child);
  }
  node.children = children;
}

function highlightMarkdownText(value: string): MarkdownAstNode[] {
  const pattern = /(^|[^\\=])==([^=\n]+)==/gu;
  const highlighted: MarkdownAstNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const content = match[2];
    const matchIndex = match.index;
    const markerStart = matchIndex + (match[1]?.length ?? 0);
    if (content === undefined || markerStart < cursor) continue;
    if (markerStart > cursor) {
      highlighted.push({ type: "text", value: value.slice(cursor, markerStart) });
    }
    highlighted.push({
      type: "element",
      tagName: "mark",
      properties: { className: ["markdown-highlight"] },
      children: [{ type: "text", value: content }],
    });
    cursor = markerStart + content.length + 4;
  }
  if (highlighted.length === 0) return [{ type: "text", value }];
  if (cursor < value.length) highlighted.push({ type: "text", value: value.slice(cursor) });
  return highlighted;
}

/** Promotes standalone same-line double-dollar math to the display-math AST shape. */
function remarkSingleLineDisplayMath() {
  return (tree: MarkdownAstNode, file: { readonly value: unknown }): void => {
    if (typeof file.value !== "string") return;
    promoteSingleLineDisplayMath(tree, file.value);
  };
}

function promoteSingleLineDisplayMath(node: MarkdownAstNode, source: string): void {
  if (node.children === undefined) return;
  node.children = node.children.map((child) => {
    const displayMath = singleLineDisplayMathNode(child, source);
    if (displayMath !== undefined) return displayMath;
    promoteSingleLineDisplayMath(child, source);
    return child;
  });
}

function singleLineDisplayMathNode(
  node: MarkdownAstNode,
  source: string,
): MarkdownAstNode | undefined {
  if (node.type !== "paragraph" || node.children?.length !== 1) return undefined;
  const child = node.children[0];
  if (child === undefined || child.type !== "inlineMath" || child.value === undefined) {
    return undefined;
  }
  const startOffset = child.position?.start?.offset;
  const endOffset = child.position?.end?.offset;
  if (startOffset === undefined || endOffset === undefined) return undefined;
  const raw = source.slice(startOffset, endOffset);
  if (!raw.startsWith("$$") || !raw.endsWith("$$")) return undefined;
  return {
    type: "math",
    value: child.value,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value: child.value }],
        },
      ],
    },
    ...(node.position === undefined ? {} : { position: node.position }),
  };
}

function normalizeMarkdownHardBreaks(node: MarkdownAstNode, source: string): void {
  if (node.children === undefined) return;
  const children: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (isTrailingMarkdownHardBreak(child, source)) {
      const value = child.value ?? "";
      if (value.length > 1) children.push({ ...child, value: value.slice(0, -1) });
      children.push({ type: "break" });
      continue;
    }
    normalizeMarkdownHardBreaks(child, source);
    children.push(child);
  }
  node.children = children;
}

function isTrailingMarkdownHardBreak(node: MarkdownAstNode, source: string): boolean {
  if (node.type !== "text" || node.value === undefined || !node.value.endsWith("\\")) {
    return false;
  }
  const endOffset = node.position?.end?.offset;
  if (endOffset === undefined) return false;
  const slashOffset = endOffset - 1;
  if (source[slashOffset] !== "\\") return false;
  if (source[slashOffset + 1] !== "\n" && source[slashOffset + 1] !== "\r") return false;

  let slashCount = 0;
  for (let offset = slashOffset; offset >= 0 && source[offset] === "\\"; offset -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:"]);

export interface MarkdownBlockProps {
  readonly activeSearchMatch?: number;
  readonly boxOpacity: number;
  readonly editing: boolean;
  readonly onChange: (source: string) => void;
  readonly onCommit: (source: string) => void;
  readonly onFinishEditing: () => void;
  readonly onHeightChange: (height: number) => void;
  readonly onAddTextGroupBlock?: () => void;
  readonly onCreateTextGroup?: () => void;
  readonly onDetachTextGroupBlock?: () => void;
  readonly editorPortalTarget?: HTMLElement | null;
  readonly searchMatchOffset?: number;
  readonly searchQuery?: string;
  readonly source: string;
  readonly textGroupId?: string;
  readonly fontSize?: number;
  readonly theme?: "light" | "dark";
  readonly colorStyle?: MarkdownColorStyle;
  readonly colorStyles?: readonly MarkdownColorStyle[];
  readonly markdownStyleId?: string;
  readonly onMarkdownStyleChange?: (styleId: string | undefined) => void;
}

/** Renders portable Markdown, GFM, and non-throwing KaTeX math. */
export interface MarkdownPreviewProps {
  readonly activeSearchMatch?: number;
  readonly contentRef?: RefObject<HTMLDivElement | null>;
  readonly searchMatchOffset?: number;
  readonly searchQuery?: string;
  readonly source: string;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  activeSearchMatch,
  contentRef,
  searchMatchOffset = 0,
  searchQuery = "",
  source,
}: MarkdownPreviewProps) {
  const searchPlugin =
    searchQuery.trim().length === 0
      ? undefined
      : createMarkdownSearchPlugin(searchQuery, searchMatchOffset, activeSearchMatch);
  return (
    <div ref={contentRef} className="markdown-content">
      {source.length === 0 ? (
        <p className="markdown-empty">Double-click to edit Markdown</p>
      ) : (
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            remarkMath,
            remarkMarkdownHeadingIds,
            remarkSingleLineDisplayMath,
            remarkMarkdownHardBreaks,
          ]}
          rehypePlugins={[
            [rehypeHighlight, { detect: true }],
            rehypeMarkdownHighlights,
            [rehypeKatex, KATEX_OPTIONS],
            ...(searchPlugin === undefined ? [] : [searchPlugin]),
          ]}
          skipHtml
          components={{ a: SafeMarkdownLink }}
        >
          {source}
        </ReactMarkdown>
      )}
    </div>
  );
});

function createMarkdownSearchPlugin(
  query: string,
  matchOffset: number,
  activeMatch: number | undefined,
) {
  const needle = query.trim().toLocaleLowerCase();
  return () =>
    (tree: MarkdownSearchNode): void => {
      if (needle.length === 0) return;
      let nextMatch = matchOffset;
      transformChildren(tree);

      function transformChildren(node: MarkdownSearchNode): void {
        if (node.children === undefined) return;
        const children: MarkdownSearchNode[] = [];
        for (const child of node.children) {
          if (
            child.type === "text" &&
            typeof child.value === "string" &&
            node.tagName !== "script" &&
            node.tagName !== "style"
          ) {
            children.push(...highlightTextNode(child.value));
          } else {
            transformChildren(child);
            children.push(child);
          }
        }
        node.children = children;
      }

      function highlightTextNode(value: string): MarkdownSearchNode[] {
        const lowerValue = value.toLocaleLowerCase();
        const highlighted: MarkdownSearchNode[] = [];
        let cursor = 0;
        while (cursor < value.length) {
          const matchStart = lowerValue.indexOf(needle, cursor);
          if (matchStart < 0) break;
          if (matchStart > cursor) {
            highlighted.push({ type: "text", value: value.slice(cursor, matchStart) });
          }
          const matchIndex = nextMatch;
          nextMatch += 1;
          highlighted.push({
            type: "element",
            tagName: "mark",
            properties: {
              "data-markdown-search-match": String(matchIndex),
              className: [
                "markdown-search-match",
                ...(matchIndex === activeMatch ? ["is-active"] : []),
              ],
            },
            children: [
              { type: "text", value: value.slice(matchStart, matchStart + needle.length) },
            ],
          });
          cursor = matchStart + needle.length;
        }
        if (cursor === 0) return [{ type: "text", value }];
        if (cursor < value.length) highlighted.push({ type: "text", value: value.slice(cursor) });
        return highlighted;
      }
    };
}

/** Keeps Markdown links in the unprivileged renderer and rejects active URL schemes. */
function SafeMarkdownLink({
  href,
  children,
  node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  void node;
  const safeHref = href === undefined ? undefined : sanitizeMarkdownHref(href);
  if (href !== undefined && safeHref === undefined) return <span {...props}>{children}</span>;

  const external = safeHref !== undefined && isExternalHttpUrl(safeHref);
  return (
    <a
      {...props}
      {...(safeHref === undefined ? {} : { href: safeHref })}
      {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}
    >
      {children}
    </a>
  );
}

function sanitizeMarkdownHref(value: string): string | undefined {
  try {
    const parsed = new URL(value, "https://squillpad.invalid");
    if (parsed.origin === "https://squillpad.invalid") return value;
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function isExternalHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

/** Source editor and rendered view for one spatial Markdown object. */
export function MarkdownBlock({
  activeSearchMatch,
  boxOpacity,
  editing,
  onChange,
  onCommit,
  onFinishEditing,
  onHeightChange,
  onAddTextGroupBlock,
  onCreateTextGroup,
  onDetachTextGroupBlock,
  editorPortalTarget,
  searchMatchOffset = 0,
  searchQuery = "",
  source,
  textGroupId,
  fontSize = DEFAULT_MARKDOWN_FONT_SIZE,
  theme = "light",
  colorStyle,
  colorStyles = [],
  markdownStyleId,
  onMarkdownStyleChange,
}: MarkdownBlockProps) {
  const blockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;
  const [editorPhase, setEditorPhase] = useState<MarkdownEditorPhase>(
    editing ? "opening" : "closed",
  );

  useEffect(() => {
    if (editing) {
      setEditorPhase((current) =>
        current === "closed" || current === "closing" ? "opening" : current,
      );
      const timer = window.setTimeout(
        () => setEditorPhase("open"),
        MARKDOWN_EDITOR_ENTER_DURATION_MS,
      );
      return () => window.clearTimeout(timer);
    }
    setEditorPhase((current) => (current === "closed" ? current : "closing"));
    return undefined;
  }, [editing]);

  useEffect(() => {
    if (editorPhase !== "closing") return;
    const timer = window.setTimeout(
      () => setEditorPhase("closed"),
      MARKDOWN_EDITOR_EXIT_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [editorPhase]);

  useLayoutEffect(() => {
    const block = blockRef.current;
    const content = contentRef.current;
    if (block === null || content === null) return;
    const style = getComputedStyle(block);
    const verticalPadding = cssPixels(style.paddingTop) + cssPixels(style.paddingBottom);
    const verticalBorder = cssPixels(style.borderTopWidth) + cssPixels(style.borderBottomWidth);
    const report = () => {
      const height = markdownBlockHeightFromContent(
        content.scrollHeight,
        verticalPadding,
        verticalBorder,
      );
      if (height !== undefined) onHeightChangeRef.current(height);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(content);
    return () => observer.disconnect();
  }, [editing, fontSize, source]);

  useLayoutEffect(() => {
    if (editorPhase === "closed") return;
    const block = blockRef.current;
    const editor = editorRef.current;
    if (block === null || editor === null) return;
    const containingBlock =
      editor.offsetParent instanceof HTMLElement
        ? editor.offsetParent
        : (editorPortalTarget ?? block.parentElement);
    if (containingBlock === null || containingBlock === undefined) return;

    // Measure the settled editor so both animation endpoints use painted coordinates.
    const previousAnimation = editor.style.animation;
    const previousTransform = editor.style.transform;
    editor.style.animation = "none";
    editor.style.transform =
      "translate3d(var(--markdown-editor-anchor-x), calc(-50% + var(--markdown-editor-keyboard-offset-y)), 0) scale(1)";
    const blockRect = block.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    editor.style.animation = previousAnimation;
    editor.style.transform = previousTransform;
    if (editorRect.width <= 0 || editorRect.height <= 0) return;
    const editorCenterX = editorRect.left + editorRect.width / 2;
    const editorCenterY = editorRect.top + editorRect.height / 2;
    editor.style.setProperty(
      "--markdown-editor-origin-x",
      `${blockRect.left + blockRect.width / 2 - editorCenterX}px`,
    );
    editor.style.setProperty(
      "--markdown-editor-origin-y",
      `${blockRect.top + blockRect.height / 2 - editorCenterY}px`,
    );
    editor.style.setProperty(
      "--markdown-editor-origin-scale-x",
      String(blockRect.width / editorRect.width),
    );
    editor.style.setProperty(
      "--markdown-editor-origin-scale-y",
      String(blockRect.height / editorRect.height),
    );
  }, [editorPhase, editorPortalTarget]);

  useEffect(() => {
    if (editorPhase === "closed") return;
    const block = blockRef.current;
    const editor = editorRef.current;
    if (block === null || editor === null) return;
    const surface =
      editorPortalTarget ??
      (editor.offsetParent instanceof HTMLElement ? editor.offsetParent : block.parentElement);
    if (surface === null || surface === undefined) return;

    const visualViewport = window.visualViewport ?? null;
    const virtualKeyboard = getVirtualKeyboard();
    let frame: number | undefined;

    const update = () => {
      frame = undefined;
      const currentEditor = editorRef.current;
      if (currentEditor === null) return;
      const currentBlock = blockRef.current;
      const currentSurface =
        editorPortalTarget ??
        (currentEditor.offsetParent instanceof HTMLElement
          ? currentEditor.offsetParent
          : currentBlock?.parentElement);
      if (currentBlock === null || currentBlock === undefined) return;
      if (currentSurface === null || currentSurface === undefined) return;

      const viewportRect = visibleViewportRect(visualViewport, virtualKeyboard);
      const surfaceRect = currentSurface.getBoundingClientRect();
      const currentOffsetY = cssPixels(
        currentEditor.style.getPropertyValue(MARKDOWN_EDITOR_KEYBOARD_OFFSET_PROPERTY),
      );
      const sizeAdjustment = calculateMarkdownEditorKeyboardAdjustment(
        currentEditor.getBoundingClientRect(),
        surfaceRect,
        viewportRect,
        currentOffsetY,
      );
      if (sizeAdjustment.maxHeight === undefined) {
        currentEditor.style.removeProperty(MARKDOWN_EDITOR_KEYBOARD_MAX_HEIGHT_PROPERTY);
      } else {
        currentEditor.style.setProperty(
          MARKDOWN_EDITOR_KEYBOARD_MAX_HEIGHT_PROPERTY,
          `${sizeAdjustment.maxHeight}px`,
        );
      }
      const adjustment = calculateMarkdownEditorKeyboardAdjustment(
        currentEditor.getBoundingClientRect(),
        surfaceRect,
        viewportRect,
        currentOffsetY,
      );
      currentEditor.style.setProperty(
        MARKDOWN_EDITOR_KEYBOARD_OFFSET_PROPERTY,
        `${adjustment.offsetY}px`,
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    const delayedUpdate = window.setTimeout(scheduleUpdate, MARKDOWN_EDITOR_ENTER_DURATION_MS);

    scheduleUpdate();
    editor.addEventListener("focusin", scheduleUpdate);
    visualViewport?.addEventListener("resize", scheduleUpdate);
    visualViewport?.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    virtualKeyboard?.addEventListener("geometrychange", scheduleUpdate);

    return () => {
      window.clearTimeout(delayedUpdate);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      editor.removeEventListener("focusin", scheduleUpdate);
      visualViewport?.removeEventListener("resize", scheduleUpdate);
      visualViewport?.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      virtualKeyboard?.removeEventListener("geometrychange", scheduleUpdate);
      editor.style.removeProperty(MARKDOWN_EDITOR_KEYBOARD_OFFSET_PROPERTY);
      editor.style.removeProperty(MARKDOWN_EDITOR_KEYBOARD_MAX_HEIGHT_PROPERTY);
    };
  }, [editorPhase, editorPortalTarget]);

  const editor = (
    <div
      ref={editorRef}
      className={`markdown-editor-popover is-${editorPhase}`}
      role="dialog"
      aria-label="Markdown source editor"
      data-canvas-editor="active"
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName === "markdown-editor-close" &&
          editorPhase === "closing" &&
          !editing
        ) {
          setEditorPhase("closed");
        }
      }}
    >
      <CodeMirrorEditor
        source={source}
        onChange={onChange}
        onCommit={onCommit}
        onFinishEditing={onFinishEditing}
        {...(onAddTextGroupBlock === undefined ? {} : { onAddTextGroupBlock })}
        {...(onCreateTextGroup === undefined ? {} : { onCreateTextGroup })}
        {...(onDetachTextGroupBlock === undefined ? {} : { onDetachTextGroupBlock })}
        {...(textGroupId === undefined ? {} : { textGroupId })}
        colorStyles={colorStyles}
        {...(markdownStyleId === undefined ? {} : { markdownStyleId })}
        {...(onMarkdownStyleChange === undefined ? {} : { onMarkdownStyleChange })}
      />
    </div>
  );

  return (
    <div
      ref={blockRef}
      className={`markdown-block ${editing ? "is-editing" : ""} ${colorStyle === undefined ? "" : "has-color-style"}`}
      data-canvas-editor={editing ? "active" : undefined}
      style={
        {
          "--markdown-box-opacity": boxOpacity,
          "--markdown-font-size": `${fontSize}px`,
          ...(colorStyle === undefined
            ? {}
            : Object.fromEntries(
                Object.entries(colorStyle.colors).map(([key, value]) => [
                  `--markdown-color-${key}`,
                  value[theme],
                ]),
              )),
        } as CSSProperties
      }
    >
      <div className="markdown-preview-layer" aria-hidden={editing || undefined}>
        <MarkdownPreview
          contentRef={contentRef}
          source={source}
          searchMatchOffset={searchMatchOffset}
          searchQuery={searchQuery}
          {...(activeSearchMatch === undefined ? {} : { activeSearchMatch })}
        />
      </div>
      {editorPhase !== "closed" &&
        (editorPortalTarget === null || editorPortalTarget === undefined
          ? editor
          : createPortal(editor, editorPortalTarget))}
    </div>
  );
}

interface VirtualKeyboardLike extends EventTarget {
  readonly boundingRect?: DOMRectReadOnly;
}

function getVirtualKeyboard(): VirtualKeyboardLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  const candidate = (navigator as Navigator & { virtualKeyboard?: unknown }).virtualKeyboard;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as EventTarget).addEventListener !== "function"
  ) {
    return undefined;
  }
  return candidate as VirtualKeyboardLike;
}

function visibleViewportRect(
  visualViewport: VisualViewport | null,
  virtualKeyboard: VirtualKeyboardLike | undefined,
): { top: number; bottom: number } {
  if (visualViewport !== null) {
    const keyboardRect = virtualKeyboard?.boundingRect;
    const keyboardBottom =
      keyboardRect !== undefined && keyboardRect.height > 0 && keyboardRect.top > 0
        ? keyboardRect.top
        : Number.POSITIVE_INFINITY;
    return {
      top: visualViewport.offsetTop,
      bottom: Math.min(visualViewport.offsetTop + visualViewport.height, keyboardBottom),
    };
  }

  const keyboardRect = virtualKeyboard?.boundingRect;
  return {
    top: 0,
    bottom:
      keyboardRect !== undefined && keyboardRect.height > 0 ? keyboardRect.top : window.innerHeight,
  };
}

function cssPixels(value: string): number {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : 0;
}

function MarkdownUndoIcon() {
  return (
    <svg className="markdown-editor-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function MarkdownRedoIcon() {
  return (
    <svg className="markdown-editor-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="m15 7 5 5-5 5M20 12H10a6 6 0 0 0-6 6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function MarkdownCloseIcon() {
  return (
    <svg
      className="markdown-editor-icon markdown-editor-close-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m7 7 10 10M17 7 7 17"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CodeMirrorEditor({
  onChange,
  onCommit,
  onFinishEditing,
  onAddTextGroupBlock,
  onCreateTextGroup,
  onDetachTextGroupBlock,
  source,
  textGroupId,
  colorStyles,
  markdownStyleId,
  onMarkdownStyleChange,
}: {
  readonly onChange: (source: string) => void;
  readonly onCommit: (source: string) => void;
  readonly onFinishEditing: () => void;
  readonly onAddTextGroupBlock?: () => void;
  readonly onCreateTextGroup?: () => void;
  readonly onDetachTextGroupBlock?: () => void;
  readonly source: string;
  readonly textGroupId?: string;
  readonly colorStyles: readonly MarkdownColorStyle[];
  readonly markdownStyleId?: string;
  readonly onMarkdownStyleChange?: (styleId: string | undefined) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initialSourceRef = useRef(source);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const destroyingRef = useRef(false);
  const footerPointerDownRef = useRef(false);
  const callbacksRef = useRef({ onChange, onCommit, onFinishEditing });
  const [historyAvailability, setHistoryAvailability] = useState({
    canRedo: false,
    canUndo: false,
  });
  callbacksRef.current = { onChange, onCommit, onFinishEditing };

  useEffect(() => {
    const view = viewRef.current;
    if (view === undefined || view.state.doc.toString() === source) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
  }, [source]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialSourceRef.current,
        extensions: [
          MARKDOWN_EDITOR_SETUP,
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              callbacksRef.current.onChange(update.state.doc.toString());
              const historyCommand = update.transactions.some(
                (transaction) => transaction.isUserEvent("undo") || transaction.isUserEvent("redo"),
              );
              if (historyCommand) {
                setHistoryAvailability({
                  canRedo: redoDepth(update.state) > 0,
                  canUndo: undoDepth(update.state) > 0,
                });
                return;
              }
              setHistoryAvailability({ canRedo: false, canUndo: true });
              return;
            }
            setHistoryAvailability({
              canRedo: redoDepth(update.state) > 0,
              canUndo: undoDepth(update.state) > 0,
            });
          }),
          EditorView.domEventHandlers({
            blur: (event, currentView) => {
              if (destroyingRef.current) return false;
              const editor = currentView.dom.closest(".markdown-editor-popover");
              if (
                footerPointerDownRef.current ||
                (event.relatedTarget instanceof Node && editor?.contains(event.relatedTarget))
              ) {
                return false;
              }
              if (currentView.state.doc.toString().trim().length === 0) {
                callbacksRef.current.onCommit(currentView.state.doc.toString());
                callbacksRef.current.onFinishEditing();
              }
              return false;
            },
            keydown: (event, currentView) => {
              if (
                event.key === "Escape" ||
                (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              ) {
                event.preventDefault();
                callbacksRef.current.onCommit(currentView.state.doc.toString());
                callbacksRef.current.onFinishEditing();
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    setHistoryAvailability({
      canRedo: redoDepth(view.state) > 0,
      canUndo: undoDepth(view.state) > 0,
    });
    view.focus();
    return () => {
      destroyingRef.current = true;
      viewRef.current = undefined;
      view.destroy();
      destroyingRef.current = false;
    };
  }, []);

  const finishEditing = () => {
    onCommit(viewRef.current?.state.doc.toString() ?? source);
    onFinishEditing();
  };
  const runTextGroupAction = (action: (() => void) | undefined) => {
    if (action === undefined) return;
    const currentSource = viewRef.current?.state.doc.toString() ?? source;
    if (currentSource.trim().length > 0) onCommit(currentSource);
    action();
  };
  const keepEditorOpenForFooterInteraction = () => {
    footerPointerDownRef.current = true;
    window.setTimeout(() => {
      footerPointerDownRef.current = false;
    }, 0);
  };
  const runHistoryCommand = (command: typeof undo) => {
    const view = viewRef.current;
    if (view === undefined || !command(view)) return;
    view.focus();
    setHistoryAvailability({
      canRedo: redoDepth(view.state) > 0,
      canUndo: undoDepth(view.state) > 0,
    });
  };

  return (
    <>
      <div className="markdown-editor-heading">
        <span>Markdown source</span>
        <div className="markdown-editor-actions">
          <button
            className="markdown-editor-history-button"
            type="button"
            aria-keyshortcuts="Control+Z Meta+Z"
            aria-label="Undo Markdown changes"
            title="Undo Markdown changes (Ctrl/Cmd+Z)"
            disabled={!historyAvailability.canUndo}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runHistoryCommand(undo)}
          >
            <MarkdownUndoIcon />
          </button>
          <button
            className="markdown-editor-history-button"
            type="button"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y"
            aria-label="Redo Markdown changes"
            title="Redo Markdown changes (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
            disabled={!historyAvailability.canRedo}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runHistoryCommand(redo)}
          >
            <MarkdownRedoIcon />
          </button>
          <button
            className="markdown-editor-close"
            type="button"
            aria-label="Close Markdown editor"
            title="Close Markdown editor"
            onClick={finishEditing}
          >
            <MarkdownCloseIcon />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="markdown-source-editor" data-canvas-editor="active" />
      <div
        className="markdown-editor-group-bar"
        role="group"
        aria-label="Text box group controls"
        onPointerDownCapture={keepEditorOpenForFooterInteraction}
      >
        <label className="markdown-editor-style-select">
          <span>Color style</span>
          <select
            aria-label="Markdown color style"
            value={markdownStyleId ?? ""}
            onChange={(event) => onMarkdownStyleChange?.(event.target.value || undefined)}
          >
            <option value="">Original</option>
            {colorStyles.map((style) => (
              <option key={style.id} value={style.id}>{style.name}</option>
            ))}
          </select>
        </label>
        {textGroupId === undefined ? (
          <button
            type="button"
            disabled={onCreateTextGroup === undefined}
            onClick={() => runTextGroupAction(onCreateTextGroup)}
          >
            Create text box group
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={onAddTextGroupBlock === undefined}
              onClick={() => runTextGroupAction(onAddTextGroupBlock)}
            >
              Add text box below
            </button>
            <button
              type="button"
              disabled={onDetachTextGroupBlock === undefined}
              onClick={() => runTextGroupAction(onDetachTextGroupBlock)}
            >
              Detach
            </button>
          </>
        )}
      </div>
    </>
  );
}
