import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type RefObject,
} from "react";

import {
  DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS,
  MARKDOWN_COLOR_KEYS,
  type CanvasElement,
  type DrawingPalettePreferences,
  type DrawingPaletteSlot,
  type InkCanvasRecord,
  type InkStyle,
  type MarkdownColorKey,
  type MarkdownColors,
  type MarkdownColorStyle,
  type MarkdownColorStyleLibrary,
  type ShapeCanvasRecord,
  type ShapeStyle,
} from "@squillpad/core-model";

import { MarkdownSearchControl } from "./MarkdownSearchControl";
import {
  ANIMATED_MENU_CLOSE,
  closeAnimatedMenu,
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
  refreshAnimatedMenuOrigin,
} from "./animated-menu";
import { clampInkWidth, clampShapeWidth, DRAWING_WIDTH_MIN } from "./drawing-limits";
import {
  HIGHLIGHTER_WIDTH_MAX,
  HIGHLIGHTER_WIDTH_MIN,
  HIGHLIGHTER_WIDTH_STEP,
  INK_PALETTE,
  INK_WIDTH_MAX,
  INK_WIDTH_MIN,
  SHAPE_WIDTH_MAX,
  defaultProfilePaletteSlot,
  type DrawingPaletteKind,
  type DrawingPreferences,
  type DrawingTool,
} from "./drawing-preferences";
let nextPaletteInteractionId = 0;
let nextMarkdownColorInteractionId = 0;

type ShapeToolName = "line" | "arrow" | "rectangle" | "ellipse";

const SHAPE_TOOL_LABELS: Readonly<Record<ShapeToolName, string>> = {
  line: "Line",
  arrow: "Arrow",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
};

export interface CanvasToolbarProps {
  readonly fullscreen: boolean;
  readonly readOnly: boolean;
  readonly allowLaserPointer: boolean;
  readonly toolbarHeight: number;
  readonly tool: DrawingTool | "picture-in-picture";
  readonly preferences: DrawingPreferences;
  readonly selectedInk: readonly InkCanvasRecord[];
  readonly selectedShapes: readonly ShapeCanvasRecord[];
  readonly activeInkStyle: InkStyle;
  readonly activeShapeStyle: ShapeStyle;
  readonly inkPaletteKind: DrawingPaletteKind;
  readonly inkPaletteForControls: DrawingPalettePreferences;
  readonly shapePaletteForControls: DrawingPalettePreferences;
  readonly shapePaletteSlot: DrawingPaletteSlot;
  readonly shapeStyleForControls: ShapeStyle;
  readonly shapeStrokeWidthForControls: number;
  readonly inkWidthMin: number;
  readonly inkWidthMax: number;
  readonly inkWidthStep: number;
  readonly inkWidthForControls: number;
  readonly inkDimensionLabel: string;
  readonly inkDimensionAriaLabel: string;
  readonly hasGroupedSelection: boolean;
  readonly markdownColorStyles: MarkdownColorStyleLibrary;
  readonly markdownSearchControlled: boolean;
  readonly markdownSearchInputRef: RefObject<HTMLInputElement | null>;
  readonly markdownSearchQuery: string;
  readonly markdownSearchMatchCount: number;
  readonly markdownSearchActiveIndex: number;
  readonly history: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
  };
  readonly hasClipboard: boolean;
  readonly selectedCount: number;
  readonly shapeMenuRef: RefObject<HTMLDetailsElement | null>;
  readonly miscellaneousMenuRef: RefObject<HTMLDetailsElement | null>;
  readonly markdownStyleMenuRef: RefObject<HTMLDetailsElement | null>;
  readonly paletteEditorMenuRefs: MutableRefObject<
    Partial<Record<DrawingPaletteKind, HTMLDetailsElement | null>>
  >;
  readonly onToolChange: (tool: DrawingTool | "picture-in-picture") => void;
  readonly onMarkdownColorStylesChange: (
    library: MarkdownColorStyleLibrary,
    group?: string,
  ) => void;
  readonly onDeleteMarkdownStyle: (styleId: string) => void;
  readonly onMarkdownSearchQueryChange: (query: string) => void;
  readonly onMoveMarkdownSearch: (direction: number) => void;
  readonly onUpdatePreferences: (
    update: (current: DrawingPreferences) => DrawingPreferences,
  ) => void;
  readonly onSetPaletteCustom: (kind: DrawingPaletteKind, custom: boolean) => void;
  readonly onSelectPaletteSlot: (
    kind: DrawingPaletteKind,
    index: number,
    openEditor: boolean,
  ) => void;
  readonly onSetInkPreference: (
    patch: Partial<Pick<InkStyle, "color" | "width" | "opacity">>,
  ) => void;
  readonly onSetShapePreference: (
    patch: Partial<Pick<ShapeStyle, "strokeColor" | "strokeWidth" | "fillColor" | "opacity">>,
  ) => void;
  readonly onUpdatePaletteSlot: (
    kind: DrawingPaletteKind,
    index: number,
    patch: Partial<DrawingPaletteSlot>,
    group?: string,
  ) => DrawingPaletteSlot;
  readonly onClosePaletteEditorMenu: (kind: DrawingPaletteKind) => void;
  readonly onPositionPaletteEditor: (details: HTMLDetailsElement) => void;
  readonly onPositionShapeMenu: (details: HTMLDetailsElement) => void;
  readonly onPositionMiscellaneousMenu: (details: HTMLDetailsElement) => void;
  readonly onPositionMarkdownStyleMenu: (details: HTMLDetailsElement) => void;
  readonly onSendToBack: () => void;
  readonly onSendBackward: () => void;
  readonly onBringForward: () => void;
  readonly onBringToFront: () => void;
  readonly onGroupSelection: () => void;
  readonly onUngroupSelection: () => void;
  readonly onCopySelection: () => void | Promise<unknown>;
  readonly onPasteSelection: () => void | Promise<unknown>;
  readonly onTravelHistory: (redo: boolean) => void;
  readonly onFullscreenChange: (fullscreen: boolean) => void;
}

export function CanvasToolbar({
  fullscreen,
  readOnly,
  allowLaserPointer,
  toolbarHeight,
  tool,
  preferences,
  selectedInk,
  selectedShapes,
  activeInkStyle,
  activeShapeStyle,
  inkPaletteKind,
  inkPaletteForControls,
  shapePaletteForControls,
  shapePaletteSlot,
  shapeStyleForControls,
  shapeStrokeWidthForControls,
  inkWidthMin,
  inkWidthMax,
  inkWidthStep,
  inkWidthForControls,
  inkDimensionLabel,
  inkDimensionAriaLabel,
  hasGroupedSelection,
  markdownColorStyles,
  markdownSearchControlled,
  markdownSearchInputRef,
  markdownSearchQuery,
  markdownSearchMatchCount,
  markdownSearchActiveIndex,
  history,
  hasClipboard,
  selectedCount,
  shapeMenuRef,
  miscellaneousMenuRef,
  markdownStyleMenuRef,
  paletteEditorMenuRefs,
  onToolChange,
  onMarkdownColorStylesChange,
  onDeleteMarkdownStyle,
  onMarkdownSearchQueryChange,
  onMoveMarkdownSearch,
  onUpdatePreferences,
  onSetPaletteCustom,
  onSelectPaletteSlot,
  onSetInkPreference,
  onSetShapePreference,
  onUpdatePaletteSlot,
  onClosePaletteEditorMenu,
  onPositionPaletteEditor,
  onPositionShapeMenu,
  onPositionMiscellaneousMenu,
  onPositionMarkdownStyleMenu,
  onSendToBack,
  onSendBackward,
  onBringForward,
  onBringToFront,
  onGroupSelection,
  onUngroupSelection,
  onCopySelection,
  onPasteSelection,
  onTravelHistory,
  onFullscreenChange,
}: CanvasToolbarProps) {
  const shapeToolButtons = (["line", "arrow", "rectangle", "ellipse"] as const).map((shapeTool) => (
    <button
      key={shapeTool}
      disabled={readOnly}
      className={tool === shapeTool ? "is-active" : ""}
      aria-pressed={tool === shapeTool}
      title={`${SHAPE_TOOL_LABELS[shapeTool]} tool`}
      onClick={() => onToolChange(shapeTool)}
    >
      <ShapeToolIcon shapeTool={shapeTool} />
      <span>{SHAPE_TOOL_LABELS[shapeTool]}</span>
    </button>
  ));
  const arrangementButtons = (
    <>
      <button
        className="canvas-icon-button"
        disabled={readOnly || selectedCount === 0}
        aria-label="Send selected objects to back"
        onClick={onSendToBack}
        title="Send to back"
      >
        ⇤
      </button>
      <button
        className="canvas-icon-button"
        disabled={readOnly || selectedCount === 0}
        aria-label="Send selected objects backward"
        onClick={onSendBackward}
        title="Send backward"
      >
        ←
      </button>
      <button
        className="canvas-icon-button"
        disabled={readOnly || selectedCount === 0}
        aria-label="Bring selected objects forward"
        onClick={onBringForward}
        title="Bring forward"
      >
        →
      </button>
      <button
        className="canvas-icon-button"
        disabled={readOnly || selectedCount === 0}
        aria-label="Bring selected objects to front"
        onClick={onBringToFront}
        title="Bring to front"
      >
        ⇥
      </button>
      <button
        className="canvas-icon-button"
        disabled={readOnly || (selectedCount < 2 && !hasGroupedSelection)}
        aria-label={hasGroupedSelection ? "Ungroup selection" : "Group selection"}
        title={hasGroupedSelection ? "Ungroup selection" : "Group selection"}
        onClick={hasGroupedSelection ? onUngroupSelection : onGroupSelection}
      >
        {hasGroupedSelection ? <BrokenChainIcon /> : <ChainIcon />}
      </button>
    </>
  );
  const clipboardButtons = (
    <>
      <button
        className="canvas-icon-button"
        disabled={selectedCount === 0}
        aria-label="Copy selected objects"
        title="Copy selected objects"
        onClick={onCopySelection}
      >
        <CopyIcon />
      </button>
      <button
        className="canvas-icon-button"
        disabled={readOnly || !hasClipboard}
        aria-label="Paste objects"
        title="Paste objects"
        onClick={onPasteSelection}
      >
        <PasteIcon />
      </button>
    </>
  );
  const actionButtons = (
    <>
      {clipboardButtons}
      {arrangementButtons}
      <button
        className="canvas-icon-button"
        aria-keyshortcuts="Control+Z Meta+Z"
        aria-label="Undo"
        disabled={readOnly || !history.canUndo}
        title="Undo (Ctrl/Cmd+Z)"
        onClick={() => onTravelHistory(false)}
      >
        <UndoIcon />
      </button>
      <button
        className="canvas-icon-button"
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y"
        aria-label="Redo"
        disabled={readOnly || !history.canRedo}
        title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
        onClick={() => onTravelHistory(true)}
      >
        <RedoIcon />
      </button>
    </>
  );

  return (
    <div
      className={`canvas-toolbar ${fullscreen ? "is-fullscreen" : ""} ${readOnly ? "is-read-only" : ""} ${readOnly && allowLaserPointer ? "is-read-only-laser" : ""}`}
      aria-label="Canvas controls"
      style={{ "--canvas-toolbar-height": `${toolbarHeight}px` } as CSSProperties}
    >
      <div className="tool-group" role="group" aria-label="Canvas tool">
        <button
          className={`tool-icon-button ${tool === "select" ? "is-active" : ""}`}
          disabled={readOnly}
          aria-pressed={tool === "select"}
          aria-keyshortcuts="S"
          aria-label="Select"
          title="Select or lasso (S)"
          onClick={() => onToolChange("select")}
        >
          <SelectToolIcon />
        </button>
        <button
          className={`tool-icon-button ${tool === "pan" ? "is-active" : ""}`}
          aria-pressed={tool === "pan"}
          aria-keyshortcuts="M"
          aria-label="Hand"
          title="Hand (M; hold Space temporarily)"
          onClick={() => onToolChange("pan")}
        >
          <HandToolIcon />
        </button>
        <button
          className={tool === "text" ? "is-active" : ""}
          disabled={readOnly}
          aria-pressed={tool === "text"}
          aria-keyshortcuts="T"
          title="Text (T)"
          onClick={() => onToolChange("text")}
        >
          Text
        </button>
        <button
          className={tool === "pen" ? "is-active" : ""}
          disabled={readOnly}
          aria-pressed={tool === "pen"}
          aria-keyshortcuts="P"
          title="Pen (P)"
          onClick={() => onToolChange("pen")}
        >
          Pen
        </button>
        <button
          className={tool === "highlighter" ? "is-active" : ""}
          disabled={readOnly}
          aria-pressed={tool === "highlighter"}
          aria-keyshortcuts="H"
          title="Highlighter (H)"
          onClick={() => onToolChange("highlighter")}
        >
          Highlight
        </button>
        <button
          className={tool === "eraser" ? "is-active" : ""}
          disabled={readOnly}
          aria-pressed={tool === "eraser"}
          aria-keyshortcuts="E"
          title="Erase (E)"
          onClick={() => onToolChange("eraser")}
        >
          Erase
        </button>
        <button
          className={tool === "laser" ? "is-active" : ""}
          disabled={readOnly && !allowLaserPointer}
          aria-pressed={tool === "laser"}
          aria-keyshortcuts="L"
          title="Laser pointer (L)"
          onClick={() => onToolChange("laser")}
        >
          Laser
        </button>
      </div>
      <details
        className="tool-group canvas-tool-menu canvas-shape-menu"
        ref={shapeMenuRef}
        onToggle={(event) => {
          const details = event.currentTarget;
          if (details.open) {
            onPositionShapeMenu(details);
            refreshAnimatedMenuOrigin(details);
          }
          prepareAnimatedMenu(details);
        }}
        onAnimationEnd={(event) => {
          finishAnimatedMenu(event.currentTarget, event.animationName, event.target);
          if (event.animationName === ANIMATED_MENU_CLOSE && !event.currentTarget.open) {
            event.currentTarget.style.removeProperty("--canvas-tool-menu-left");
            event.currentTarget.style.removeProperty("--canvas-tool-menu-top");
          }
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button") !== null) {
            closeAnimatedMenu(event.currentTarget);
          }
        }}
      >
        <summary
          className={isShapeTool(tool) ? "is-active" : ""}
          aria-disabled={readOnly}
          title="Choose a shape tool"
          onClick={(event) => {
            if (readOnly) {
              event.preventDefault();
              return;
            }
            const details = event.currentTarget.parentElement;
            if (details instanceof HTMLDetailsElement) onPositionShapeMenu(details);
            prepareAnimatedMenuFromSummary(event.currentTarget, event);
          }}
        >
          Shapes
        </summary>
        <div
          className="canvas-tool-menu__content"
          data-animated-menu
          role="group"
          aria-label="Shape tool options"
        >
          {shapeToolButtons}
        </div>
      </details>
      <details
        className="tool-group canvas-tool-menu canvas-miscellaneous-menu"
        ref={miscellaneousMenuRef}
        onToggle={(event) => {
          const details = event.currentTarget;
          if (details.open) {
            onPositionMiscellaneousMenu(details);
            refreshAnimatedMenuOrigin(details);
          }
          prepareAnimatedMenu(details);
        }}
        onAnimationEnd={(event) => {
          finishAnimatedMenu(event.currentTarget, event.animationName, event.target);
          if (event.animationName === ANIMATED_MENU_CLOSE && !event.currentTarget.open) {
            event.currentTarget.style.removeProperty("--canvas-tool-menu-left");
            event.currentTarget.style.removeProperty("--canvas-tool-menu-top");
          }
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button") !== null) {
            closeAnimatedMenu(event.currentTarget);
          }
        }}
      >
        <summary
          className={tool === "picture-in-picture" || tool === "insert-space" ? "is-active" : ""}
          aria-label="Miscellaneous tools"
          title="Miscellaneous tools"
          onClick={(event) => {
            const details = event.currentTarget.parentElement;
            if (details instanceof HTMLDetailsElement) onPositionMiscellaneousMenu(details);
            prepareAnimatedMenuFromSummary(event.currentTarget, event);
          }}
        >
          <span className="canvas-miscellaneous-menu__symbol" aria-hidden="true">
            <AsteriskIcon />
          </span>
        </summary>
        <div
          className="canvas-tool-menu__content"
          data-animated-menu
          role="group"
          aria-label="Miscellaneous canvas tools"
        >
          <button
            className={tool === "insert-space" ? "is-active" : ""}
            disabled={readOnly}
            aria-pressed={tool === "insert-space"}
            title="Insert or remove vertical space"
            onClick={() => onToolChange("insert-space")}
          >
            <InsertSpaceIcon />
            <span>Insert space</span>
          </button>
          <button
            className={tool === "picture-in-picture" ? "is-active" : ""}
            aria-pressed={tool === "picture-in-picture"}
            title="Picture in picture: draw a region to keep a live, read-only reference view"
            onClick={() => onToolChange("picture-in-picture")}
          >
            <PictureInPictureIcon />
            <span>Picture in picture</span>
          </button>
        </div>
      </details>
      {fullscreen && !readOnly && (
        <label className="radial-toolbar-toggle">
          <span>Radial toolbar</span>
          <input
            type="checkbox"
            checked={preferences.radialToolbarEnabled}
            aria-label="Enable long-press radial toolbar"
            onChange={(event) =>
              onUpdatePreferences((current) => ({
                ...current,
                radialToolbarEnabled: event.target.checked,
              }))
            }
          />
          <span className="radial-toolbar-toggle__track" aria-hidden="true">
            <span className="radial-toolbar-toggle__thumb" />
          </span>
        </label>
      )}
      {tool === "text" && (
        <details
          className="markdown-style-menu"
          ref={markdownStyleMenuRef}
          onToggle={(event) => {
            const details = event.currentTarget;
            if (details.open) onPositionMarkdownStyleMenu(details);
            prepareAnimatedMenu(details);
          }}
          onAnimationEnd={(event) => {
            finishAnimatedMenu(event.currentTarget, event.animationName, event.target);
            if (event.animationName === ANIMATED_MENU_CLOSE && !event.currentTarget.open) {
              event.currentTarget.style.removeProperty("--markdown-style-editor-left");
              event.currentTarget.style.removeProperty("--markdown-style-editor-top");
            }
          }}
        >
          <summary
            onClick={(event) => {
              const details = event.currentTarget.parentElement;
              if (details instanceof HTMLDetailsElement && !details.open) {
                onPositionMarkdownStyleMenu(details);
              }
              prepareAnimatedMenuFromSummary(event.currentTarget, event);
            }}
          >
            Edit styles
          </summary>
          <MarkdownColorStyleEditor
            library={markdownColorStyles}
            disabled={readOnly}
            onChange={onMarkdownColorStylesChange}
            onDelete={onDeleteMarkdownStyle}
          />
        </details>
      )}
      {!markdownSearchControlled && (
        <MarkdownSearchControl
          className="tool-group"
          inputRef={markdownSearchInputRef}
          query={markdownSearchQuery}
          matchCount={markdownSearchMatchCount}
          activeMatchIndex={markdownSearchActiveIndex}
          onQueryChange={onMarkdownSearchQueryChange}
          onMove={onMoveMarkdownSearch}
        />
      )}
      {(tool === "pen" || tool === "highlighter" || selectedInk.length > 0) && (
        <div className="tool-group tool-style" role="group" aria-label="Ink style">
          <PaletteModeToggle
            kind={inkPaletteKind}
            custom={inkPaletteForControls.custom}
            disabled={readOnly}
            onChange={(custom) => onSetPaletteCustom(inkPaletteKind, custom)}
          />
          {(inkPaletteForControls.custom
            ? inkPaletteForControls.slots.map((slot) => slot.color)
            : INK_PALETTE
          ).map((color, index) => (
            <button
              key={`${color}-${index}`}
              className="color-swatch"
              style={{ backgroundColor: color }}
              aria-label={`Use ink color ${color}`}
              aria-keyshortcuts={String(index + 1)}
              title={`Use ink color ${color} (${index + 1})`}
              aria-pressed={
                inkPaletteForControls.custom
                  ? inkPaletteForControls.selectedIndex === index
                  : (selectedInk[0]?.style.color ?? activeInkStyle.color) === color
              }
              disabled={readOnly}
              onClick={() => onSelectPaletteSlot(inkPaletteKind, index, true)}
            />
          ))}
          {inkPaletteForControls.custom && (
            <details
              className="palette-editor-menu"
              ref={(details) => {
                paletteEditorMenuRefs.current[inkPaletteKind] = details;
              }}
              onToggle={(event) => {
                const details = event.currentTarget;
                if (details.open) onPositionPaletteEditor(details);
                prepareAnimatedMenu(details);
              }}
              onAnimationEnd={(event) => {
                finishAnimatedMenu(event.currentTarget, event.animationName, event.target);
                if (event.animationName === ANIMATED_MENU_CLOSE && !event.currentTarget.open) {
                  event.currentTarget.style.removeProperty("--palette-editor-left");
                  event.currentTarget.style.removeProperty("--palette-editor-top");
                }
              }}
            >
              <summary className="palette-editor-menu__anchor" aria-hidden="true" tabIndex={-1} />
              <PaletteEditor
                kind={inkPaletteKind}
                slot={
                  inkPaletteForControls.slots[inkPaletteForControls.selectedIndex] ??
                  inkPaletteForControls.slots[0]!
                }
                defaultSlot={defaultProfilePaletteSlot(
                  inkPaletteKind,
                  inkPaletteForControls.selectedIndex,
                )}
                onChange={(patch, group) =>
                  onUpdatePaletteSlot(
                    inkPaletteKind,
                    inkPaletteForControls.selectedIndex,
                    patch,
                    group,
                  )
                }
                onReset={() =>
                  onUpdatePaletteSlot(
                    inkPaletteKind,
                    inkPaletteForControls.selectedIndex,
                    defaultProfilePaletteSlot(inkPaletteKind, inkPaletteForControls.selectedIndex),
                  )
                }
                onClose={() => onClosePaletteEditorMenu(inkPaletteKind)}
                disabled={readOnly}
              />
            </details>
          )}
          {!inkPaletteForControls.custom && (
            <label className="range-control">
              <span>{inkDimensionLabel}</span>
              <input
                aria-label={inkDimensionAriaLabel}
                title={inkDimensionAriaLabel}
                type="range"
                min={inkWidthMin}
                max={inkWidthMax}
                step={inkWidthStep}
                value={inkWidthForControls}
                disabled={readOnly}
                onChange={(event) => onSetInkPreference({ width: Number(event.target.value) })}
              />
              <output>{inkWidthForControls}px</output>
            </label>
          )}
        </div>
      )}
      {tool === "eraser" && (
        <div className="tool-group" role="group" aria-label="Eraser style">
          <select
            aria-label="Eraser mode"
            value={preferences.eraserMode}
            disabled={readOnly}
            onChange={(event) =>
              onUpdatePreferences((current) => ({
                ...current,
                eraserMode: event.target.value === "segment" ? "segment" : "stroke",
              }))
            }
          >
            <option value="stroke">Whole stroke</option>
            <option value="segment">Segment</option>
          </select>
        </div>
      )}
      {(isShapeTool(tool) || selectedShapes.length > 0) && (
        <div className="tool-group tool-style" role="group" aria-label="Shape style">
          <PaletteModeToggle
            kind="shape"
            custom={shapePaletteForControls.custom}
            disabled={readOnly}
            onChange={(custom) => onSetPaletteCustom("shape", custom)}
          />
          {(shapePaletteForControls.custom
            ? shapePaletteForControls.slots.map((slot) => slot.color)
            : INK_PALETTE
          ).map((color, index) => (
            <button
              key={`${color}-${index}`}
              className="color-swatch"
              style={{ backgroundColor: color }}
              aria-label={`Use shape color ${color}`}
              aria-keyshortcuts={String(index + 1)}
              title={`Use shape color ${color} (${index + 1})`}
              aria-pressed={
                shapePaletteForControls.custom
                  ? shapePaletteForControls.selectedIndex === index
                  : shapeStyleForControls.strokeColor === color
              }
              disabled={readOnly}
              onClick={() => onSelectPaletteSlot("shape", index, true)}
            />
          ))}
          {shapePaletteForControls.custom && (
            <details
              className="palette-editor-menu"
              ref={(details) => {
                paletteEditorMenuRefs.current.shape = details;
              }}
              onToggle={(event) => {
                const details = event.currentTarget;
                if (details.open) onPositionPaletteEditor(details);
                prepareAnimatedMenu(details);
              }}
              onAnimationEnd={(event) => {
                finishAnimatedMenu(event.currentTarget, event.animationName, event.target);
                if (event.animationName === ANIMATED_MENU_CLOSE && !event.currentTarget.open) {
                  event.currentTarget.style.removeProperty("--palette-editor-left");
                  event.currentTarget.style.removeProperty("--palette-editor-top");
                }
              }}
            >
              <summary className="palette-editor-menu__anchor" aria-hidden="true" tabIndex={-1} />
              <PaletteEditor
                kind="shape"
                slot={shapePaletteSlot}
                defaultSlot={defaultProfilePaletteSlot(
                  "shape",
                  shapePaletteForControls.selectedIndex,
                )}
                onChange={(patch, group) =>
                  onUpdatePaletteSlot("shape", shapePaletteForControls.selectedIndex, patch, group)
                }
                onReset={() =>
                  onUpdatePaletteSlot(
                    "shape",
                    shapePaletteForControls.selectedIndex,
                    defaultProfilePaletteSlot("shape", shapePaletteForControls.selectedIndex),
                  )
                }
                onClose={() => onClosePaletteEditorMenu("shape")}
                disabled={readOnly}
              />
            </details>
          )}
          {!shapePaletteForControls.custom && (
            <>
              <select
                aria-label="Shape stroke width"
                value={shapeStrokeWidthForControls}
                disabled={readOnly}
                onChange={(event) =>
                  onSetShapePreference({ strokeWidth: Number(event.target.value) })
                }
              >
                {[1, 3, 6, 9, 12, SHAPE_WIDTH_MAX].map((width) => (
                  <option key={width} value={width}>
                    {width}px
                  </option>
                ))}
              </select>
              <input
                aria-label="Shape opacity"
                type="range"
                min="0.1"
                max="1"
                step="0.1"
                value={shapeStyleForControls.opacity}
                disabled={readOnly}
                onChange={(event) => onSetShapePreference({ opacity: Number(event.target.value) })}
              />
            </>
          )}
          <button
            disabled={readOnly}
            aria-pressed={shapeStyleForControls.fillColor !== null}
            onClick={() =>
              onSetShapePreference({
                fillColor:
                  shapeStyleForControls.fillColor === null
                    ? shapeStyleForControls.strokeColor
                    : null,
              })
            }
          >
            Fill
          </button>
        </div>
      )}
      <div className="tool-group canvas-action-group" role="group" aria-label="Canvas actions">
        {actionButtons}
      </div>
      <button
        className="canvas-icon-button canvas-fullscreen-button"
        aria-pressed={fullscreen}
        aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={fullscreen ? "Exit fullscreen (Escape)" : "Enter fullscreen"}
        onClick={() => onFullscreenChange(!fullscreen)}
      >
        {fullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
      </button>
    </div>
  );
}

function PaletteModeToggle({
  kind,
  custom,
  disabled,
  onChange,
}: {
  readonly kind: DrawingPaletteKind;
  readonly custom: boolean;
  readonly disabled: boolean;
  readonly onChange: (custom: boolean) => void;
}) {
  const label = kind === "highlighter" ? "highlight" : kind;
  return (
    <label className="radial-toolbar-toggle">
      <span>
        <strong>{custom ? "Custom" : "Default"}</strong>
      </span>
      <input
        type="checkbox"
        checked={custom}
        disabled={disabled}
        aria-label={`Use custom ${label} colors`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="radial-toolbar-toggle__track" aria-hidden="true">
        <span className="radial-toolbar-toggle__thumb" />
      </span>
    </label>
  );
}

function PaletteEditor({
  kind,
  slot,
  defaultSlot,
  onChange,
  onReset,
  onClose,
  disabled,
}: {
  readonly kind: DrawingPaletteKind;
  readonly slot: DrawingPaletteSlot;
  readonly defaultSlot: DrawingPaletteSlot;
  readonly onChange: (patch: Partial<DrawingPaletteSlot>, group?: string) => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
  readonly disabled: boolean;
}) {
  const [hexValue, setHexValue] = useState(slot.color);
  const [dragging, setDragging] = useState(false);
  const activeInteractionRef = useRef<string | undefined>(undefined);
  const highlighter = kind === "highlighter";
  const validHex = /^#[0-9a-fA-F]{6}$/u.test(hexValue);
  const widthMin =
    kind === "shape" ? DRAWING_WIDTH_MIN : highlighter ? HIGHLIGHTER_WIDTH_MIN : INK_WIDTH_MIN;
  const widthMax =
    kind === "shape" ? SHAPE_WIDTH_MAX : highlighter ? HIGHLIGHTER_WIDTH_MAX : INK_WIDTH_MAX;
  const widthStep = highlighter ? HIGHLIGHTER_WIDTH_STEP : 1;
  useEffect(() => setHexValue(slot.color), [slot.color]);
  useEffect(() => {
    const stopInteraction = () => {
      setDragging(false);
      window.setTimeout(() => {
        activeInteractionRef.current = undefined;
      });
    };
    window.addEventListener("pointerup", stopInteraction);
    window.addEventListener("pointercancel", stopInteraction);
    return () => {
      window.removeEventListener("pointerup", stopInteraction);
      window.removeEventListener("pointercancel", stopInteraction);
    };
  }, []);

  const beginInteraction = () => {
    const existing = activeInteractionRef.current;
    if (existing !== undefined) return existing;
    const next = `${kind}-palette-edit-${++nextPaletteInteractionId}`;
    activeInteractionRef.current = next;
    return next;
  };
  const endInteraction = () => {
    activeInteractionRef.current = undefined;
    setDragging(false);
  };
  const updateForInteraction = (patch: Partial<DrawingPaletteSlot>, finish = false) => {
    const started = activeInteractionRef.current === undefined;
    const group = beginInteraction();
    onChange(patch, group);
    if (finish || started) endInteraction();
  };

  const commitHex = () => {
    if (!validHex) {
      setHexValue(slot.color);
      endInteraction();
      return;
    }
    updateForInteraction({ color: hexValue }, true);
  };

  return (
    <div
      className="palette-editor"
      data-animated-menu
      role="dialog"
      aria-label={`${kind} custom palette editor`}
    >
      <div className="palette-editor__header">
        <strong>Edit palette color</strong>
        <button type="button" aria-label="Close palette editor" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="palette-editor__color-grid" aria-label="Common color palette">
        {PREDEFINED_COLOR_MATRIX.flat().map((color, index) => (
          <button
            key={`${color}-${index}`}
            type="button"
            className="palette-color-swatch"
            style={{ backgroundColor: color }}
            aria-label={`Select palette color ${color}`}
            aria-pressed={slot.color.toLowerCase() === color}
            disabled={disabled}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragging(true);
              onChange({ color }, beginInteraction());
            }}
            onPointerEnter={() => {
              if (dragging) onChange({ color }, beginInteraction());
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              updateForInteraction({ color }, true);
            }}
          />
        ))}
      </div>
      <div className="palette-editor__exact-color">
        <label>
          <span>Hex</span>
          <input
            type="text"
            value={hexValue}
            aria-label="Exact hex color"
            disabled={disabled}
            inputMode="text"
            spellCheck={false}
            onChange={(event) => setHexValue(event.target.value)}
            onBlur={commitHex}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitHex();
            }}
          />
        </label>
        <input
          type="color"
          value={slot.color}
          aria-label="Use color picker"
          disabled={disabled}
          onPointerDown={() => beginInteraction()}
          onPointerUp={() => window.setTimeout(endInteraction)}
          onChange={(event) => {
            setHexValue(event.target.value);
            const started = activeInteractionRef.current === undefined;
            onChange({ color: event.target.value }, beginInteraction());
            if (started) endInteraction();
          }}
        />
      </div>
      <label className="palette-editor__range">
        <span>{highlighter ? "Height" : "Thickness"}</span>
        <input
          type="range"
          min={widthMin}
          max={widthMax}
          step={widthStep}
          value={slot.width}
          aria-label={`Palette ${highlighter ? "height" : "thickness"}`}
          disabled={disabled}
          onPointerDown={() => beginInteraction()}
          onPointerUp={() => window.setTimeout(endInteraction)}
          onKeyDown={() => beginInteraction()}
          onKeyUp={endInteraction}
          onBlur={endInteraction}
          onChange={(event) => updateForInteraction({ width: Number(event.target.value) })}
        />
        <output>{slot.width}</output>
      </label>
      <label className="palette-editor__range">
        <span>Opacity</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={slot.opacity}
          aria-label="Palette opacity"
          disabled={disabled}
          onPointerDown={() => beginInteraction()}
          onPointerUp={() => window.setTimeout(endInteraction)}
          onKeyDown={() => beginInteraction()}
          onKeyUp={endInteraction}
          onBlur={endInteraction}
          onChange={(event) => updateForInteraction({ opacity: Number(event.target.value) })}
        />
        <output>{Math.round(slot.opacity * 100)}%</output>
      </label>
      <div className="palette-editor__actions">
        <button
          type="button"
          disabled={
            disabled ||
            (slot.color === defaultSlot.color &&
              slot.width === defaultSlot.width &&
              slot.opacity === defaultSlot.opacity)
          }
          onClick={onReset}
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}

const PREDEFINED_COLOR_MATRIX = [
  [
    "#000000",
    "#7f1d1d",
    "#9a3412",
    "#854d0e",
    "#166534",
    "#115e59",
    "#164e63",
    "#1e3a8a",
    "#581c87",
    "#831843",
  ],
  [
    "#4b5563",
    "#b91c1c",
    "#ea580c",
    "#ca8a04",
    "#16a34a",
    "#0d9488",
    "#0891b2",
    "#2563eb",
    "#7e22ce",
    "#be185d",
  ],
  [
    "#6b7280",
    "#dc2626",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#14b8a6",
    "#06b6d4",
    "#3b82f6",
    "#a855f7",
    "#ec4899",
  ],
  [
    "#9ca3af",
    "#ef4444",
    "#fb923c",
    "#facc15",
    "#4ade80",
    "#2dd4bf",
    "#22d3ee",
    "#60a5fa",
    "#c084fc",
    "#f472b6",
  ],
  [
    "#d1d5db",
    "#f87171",
    "#fdba74",
    "#fde047",
    "#86efac",
    "#5eead4",
    "#67e8f9",
    "#93c5fd",
    "#c4b5fd",
    "#f9a8d4",
  ],
  [
    "#f3f4f6",
    "#fca5a5",
    "#ffedd5",
    "#fef9c3",
    "#dcfce7",
    "#ccfbf1",
    "#cffafe",
    "#dbeafe",
    "#f3e8ff",
    "#fce7f3",
  ],
] as const;

const MARKDOWN_COLOR_LABELS: Readonly<Record<MarkdownColorKey, string>> = {
  text: "Body text",
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
  heading4: "Heading 4",
  heading5: "Heading 5",
  heading6: "Heading 6",
  bold: "Bold",
  italic: "Italic",
  link: "Links",
  inlineCode: "Inline code",
  codeBlock: "Code blocks",
  codeBackground: "Code background",
  blockquote: "Block quotes",
  math: "Math",
  footnote: "Footnotes",
  highlightBackground: "Highlight background",
};

const DEFAULT_NAMED_MARKDOWN_COLORS: MarkdownColors = {
  text: { light: "#27252b", dark: "#eceeea" },
  heading1: { light: "#27252b", dark: "#eceeea" },
  heading2: { light: "#27252b", dark: "#eceeea" },
  heading3: { light: "#27252b", dark: "#eceeea" },
  heading4: { light: "#27252b", dark: "#eceeea" },
  heading5: { light: "#27252b", dark: "#eceeea" },
  heading6: { light: "#27252b", dark: "#eceeea" },
  bold: { light: "#27252b", dark: "#eceeea" },
  italic: { light: "#27252b", dark: "#eceeea" },
  link: { light: "#573690", dark: "#afd0bb" },
  inlineCode: { light: "#27252b", dark: "#eceeea" },
  codeBlock: { light: "#27252b", dark: "#eceeea" },
  codeBackground: DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS,
  blockquote: { light: "#62596c", dark: "#a4a7a1" },
  math: { light: "#27252b", dark: "#eceeea" },
  footnote: { light: "#27252b", dark: "#eceeea" },
  highlightBackground: { light: "#fff1a8", dark: "#75651f" },
};

const MARKDOWN_COLOR_MODES = ["light", "dark"] as const;
type MarkdownColorMode = (typeof MARKDOWN_COLOR_MODES)[number];
const MARKDOWN_COLOR_MODE_LABELS: Readonly<Record<MarkdownColorMode, string>> = {
  light: "Light mode",
  dark: "Dark mode",
};

function MarkdownColorStyleEditor({
  library,
  disabled,
  onChange,
  onDelete,
}: {
  readonly library: MarkdownColorStyleLibrary;
  readonly disabled: boolean;
  readonly onChange: (library: MarkdownColorStyleLibrary, group?: string) => void;
  readonly onDelete: (styleId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const selected = library.styles.find((style) => style.id === selectedId);
  const [nameDraft, setNameDraft] = useState("");
  const activeColorInteractionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selectedId !== "" && selected === undefined) setSelectedId("");
  }, [selected, selectedId]);
  useEffect(() => setNameDraft(selected?.name ?? ""), [selected?.name]);
  useEffect(() => {
    const stopInteraction = () => {
      window.setTimeout(() => {
        activeColorInteractionRef.current = undefined;
      });
    };
    window.addEventListener("pointerup", stopInteraction);
    window.addEventListener("pointercancel", stopInteraction);
    return () => {
      window.removeEventListener("pointerup", stopInteraction);
      window.removeEventListener("pointercancel", stopInteraction);
    };
  }, []);

  const beginColorInteraction = () => {
    const existing = activeColorInteractionRef.current;
    if (existing !== undefined) return existing;
    const next = `markdown-style-color-edit-${++nextMarkdownColorInteractionId}`;
    activeColorInteractionRef.current = next;
    return next;
  };
  const endColorInteraction = () => {
    activeColorInteractionRef.current = undefined;
  };
  const colorInteractionGroup = () => {
    const started = activeColorInteractionRef.current === undefined;
    const group = beginColorInteraction();
    if (started) endColorInteraction();
    return group;
  };

  const updateSelected = (patch: Partial<MarkdownColorStyle>, group?: string) => {
    if (selected === undefined) return;
    onChange({
      ...library,
      styles: library.styles.map((style) =>
        style.id === selected.id ? { ...style, ...patch } : style,
      ),
    }, group);
  };
  const createStyle = () => {
    const id = crypto.randomUUID();
    const taken = new Set(library.styles.map((style) => style.name.toLowerCase()));
    let suffix = 1;
    let name = "New style";
    while (taken.has(name.toLocaleLowerCase())) name = `New style ${++suffix}`;
    onChange({
      ...library,
      styles: [...library.styles, { id, name, colors: DEFAULT_NAMED_MARKDOWN_COLORS }],
    });
    setSelectedId(id);
  };
  const commitName = () => {
    if (selected === undefined) return;
    const name = nameDraft.trim();
    const duplicate = library.styles.some(
      (style) => style.id !== selected.id && style.name.toLowerCase() === name.toLowerCase(),
    );
    if (name.length === 0 || name.length > 80 || duplicate) {
      setNameDraft(selected.name);
      return;
    }
    if (name !== selected.name) updateSelected({ name });
  };
  const displayColors = selected?.colors ?? DEFAULT_NAMED_MARKDOWN_COLORS;

  return (
    <div
      className="markdown-style-editor"
      data-animated-menu
      role="dialog"
      aria-label="Markdown color styles"
    >
      <div className="markdown-style-editor__sidebar">
        <strong>Markdown styles</strong>
        <button
          type="button"
          className={selectedId === "" ? "is-selected" : ""}
          onClick={() => setSelectedId("")}
        >
          Original
        </button>
        {library.styles.map((style) => (
          <button
            key={style.id}
            type="button"
            className={style.id === selectedId ? "is-selected" : ""}
            onClick={() => setSelectedId(style.id)}
          >
            {style.name}
          </button>
        ))}
        <button type="button" disabled={disabled} onClick={createStyle}>
          + New style
        </button>
      </div>
      <div className="markdown-style-editor__main">
        <div className="markdown-style-editor__header">
          {selected === undefined ? (
            <strong>Original</strong>
          ) : (
            <input
              aria-label="Style name"
              value={nameDraft}
              disabled={disabled}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitName();
                event.currentTarget.blur();
              }}
            />
          )}
          <label className="toggle-switch settings-toggle markdown-style-editor__default-toggle">
            <input
              className="toggle-switch__input"
              type="checkbox"
              aria-label="Default for new text boxes"
              checked={(library.defaultStyleId ?? "") === selectedId}
              disabled={disabled || selectedId === ""}
              onChange={(event) => {
                if (event.target.checked) onChange({ ...library, defaultStyleId: selectedId });
                else onChange({ styles: library.styles });
              }}
            />
            <span className="toggle-switch__track" aria-hidden="true">
              <span className="toggle-switch__thumb" />
            </span>
            <span className="toggle-switch__label">Default for new text boxes</span>
          </label>
          {selected !== undefined && (
            <button type="button" disabled={disabled} onClick={() => onDelete(selected.id)}>
              Delete
            </button>
          )}
        </div>
        {selected === undefined && <p>Original follows the active application theme.</p>}
        <div className="markdown-style-editor__colors">
          {MARKDOWN_COLOR_KEYS.map((key) => (
            <div className="markdown-style-editor__color-row" key={key}>
              <span>{MARKDOWN_COLOR_LABELS[key]}</span>
              <span className="markdown-style-editor__color-mode-label">light/dark</span>
              <div className="markdown-style-editor__color-pair">
                {MARKDOWN_COLOR_MODES.map((mode) => (
                  <input
                    key={mode}
                    type="color"
                    aria-label={`${MARKDOWN_COLOR_LABELS[key]} ${MARKDOWN_COLOR_MODE_LABELS[mode]} color`}
                    title={`${MARKDOWN_COLOR_LABELS[key]} ${MARKDOWN_COLOR_MODE_LABELS[mode]} color`}
                    value={displayColors[key][mode]}
                    disabled={disabled || selected === undefined}
                    onPointerDown={() => beginColorInteraction()}
                    onPointerUp={() => window.setTimeout(endColorInteraction)}
                    onKeyDown={() => beginColorInteraction()}
                    onKeyUp={endColorInteraction}
                    onBlur={endColorInteraction}
                    onChange={(event) => {
                      updateSelected(
                        {
                          colors: {
                            ...displayColors,
                            [key]: { ...displayColors[key], [mode]: event.target.value },
                          },
                        },
                        colorInteractionGroup(),
                      );
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function isShapeTool(value: DrawingTool | "picture-in-picture"): value is ShapeToolName {
  return value === "line" || value === "arrow" || value === "rectangle" || value === "ellipse";
}

function ShapeToolIcon({ shapeTool }: { readonly shapeTool: ShapeToolName }) {
  switch (shapeTool) {
    case "line":
      return <LineToolIcon />;
    case "arrow":
      return <ArrowToolIcon />;
    case "rectangle":
      return <RectangleToolIcon />;
    case "ellipse":
      return <EllipseToolIcon />;
  }
}

function LineToolIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="m5 19 14-14"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ArrowToolIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="m5 19 14-14m-8.5 0H19v8.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function RectangleToolIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="4.5"
        y="5.5"
        width="15"
        height="13"
        rx="1.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function EllipseToolIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <ellipse
        cx="12"
        cy="12"
        rx="7.5"
        ry="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function AsteriskIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <ellipse cx="12" cy="8.3" rx="1.8" ry="3.8" />
        <ellipse cx="12" cy="8.3" rx="1.8" ry="3.8" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="8.3" rx="1.8" ry="3.8" transform="rotate(120 12 12)" />
        <ellipse cx="12" cy="8.3" rx="1.8" ry="3.8" transform="rotate(180 12 12)" />
        <ellipse cx="12" cy="8.3" rx="1.8" ry="3.8" transform="rotate(240 12 12)" />
        <ellipse cx="12" cy="8.3" rx="1.8" ry="3.8" transform="rotate(300 12 12)" />
      </g>
    </svg>
  );
}

function InsertSpaceIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M7.25 2.25 1.85 7.65q-.5.5-.2 1.2.27.6.95.6h2.75V20.1q0 1.1 1.1 1.1h1.6q1.1 0 1.1-1.1V9.45h2.75q.68 0 .95-.6.3-.7-.2-1.2Z"
        fill="currentColor"
      />
      <path
        d="M15.25 3.4q0-1.05 1.05-1.05h.9q1.05 0 1.05 1.05v10.95h2.95q.68 0 .95.6.3.7-.2 1.2l-5.2 5.6-5.2-5.6q-.5-.5-.2-1.2.27-.6.95-.6h2.95v-10.95Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PictureInPictureIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="3.5"
        y="4.5"
        width="13"
        height="13"
        rx="1.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="10.5"
        y="10.5"
        width="10"
        height="9"
        rx="1.25"
        fill="var(--app-surface)"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function SelectToolIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m5.2 3.8 13.5 12.8-5.8.6 3.5 4.3-2.5 1.6-3.3-4.6-3 4.9Z" fill="currentColor" />
    </svg>
  );
}

function HandToolIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M7.2 11V6.3a1.3 1.3 0 1 1 2.6 0V11m0 0V4.8a1.3 1.3 0 1 1 2.6 0V11m0 0V6.1a1.3 1.3 0 1 1 2.6 0V12m0 0V8.2a1.3 1.3 0 1 1 2.6 0v6.4c0 3.5-2.8 6.3-6.3 6.3H10c-1.6 0-2.8-.7-3.7-1.9L4.4 16a1.5 1.5 0 0 1 2.3-1.9l.5.6V11Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 7 4 12l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m15 7 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M19.5 12H10a5.5 5.5 0 0 0-5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function ChainIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="m9.5 14.5 5-5M7.2 17.5l-1.1 1.1a3.3 3.3 0 0 1-4.7-4.7l3.2-3.2a3.3 3.3 0 0 1 4.7 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="m16.8 6.5 1.1-1.1a3.3 3.3 0 0 1 4.7 4.7l-3.2 3.2a3.3 3.3 0 0 1-4.7 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function BrokenChainIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="m8.5 15.5-2.4 2.4a3.3 3.3 0 0 1-4.7-4.7l3.2-3.2a3.3 3.3 0 0 1 4.7 0M15.5 8.5l2.4-2.4a3.3 3.3 0 0 1 4.7 4.7l-3.2 3.2a3.3 3.3 0 0 1-4.7 0M9.5 14.5l5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="m9 9 6 6"
        fill="none"
        stroke="currentColor"
        strokeDasharray="1.5 2"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="8"
        y="8"
        width="11"
        height="11"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function PasteIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 7h8v12H8z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 7V5h4v2M10 12h4M10 15h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function FullscreenEnterIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function FullscreenExitIcon() {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}
