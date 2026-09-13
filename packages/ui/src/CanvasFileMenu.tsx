import type { Ref } from "react";

import {
  closeAnimatedMenu,
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
} from "./animated-menu";

export type CanvasExportRegionMode = "content" | "visible" | "selection";

export interface CanvasFileMenuProps {
  readonly detailsRef?: Ref<HTMLDetailsElement>;
  readonly disabled?: boolean;
  readonly importDisabled?: boolean;
  readonly exportRegionMode: CanvasExportRegionMode;
  readonly onExportMarkdown: () => void;
  readonly onExportPng: () => void | Promise<void>;
  readonly onExportRegionModeChange: (mode: CanvasExportRegionMode) => void;
  readonly onExportSvg: () => void;
  readonly onImportMarkdown: () => void;
  readonly selectionAvailable: boolean;
}

export function CanvasFileMenu({
  detailsRef,
  disabled = false,
  importDisabled = false,
  exportRegionMode,
  onExportMarkdown,
  onExportPng,
  onExportRegionModeChange,
  onExportSvg,
  onImportMarkdown,
  selectionAvailable,
}: CanvasFileMenuProps) {
  return (
    <details
      ref={detailsRef}
      className="tool-group canvas-export-menu"
      aria-disabled={disabled}
      onToggle={(event) => prepareAnimatedMenu(event.currentTarget)}
      onAnimationEnd={(event) =>
        finishAnimatedMenu(event.currentTarget, event.animationName, event.target)
      }
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button") !== null) {
          closeAnimatedMenu(event.currentTarget);
        }
      }}
    >
      <summary
        title="Import and export Markdown and images"
        onClick={(event) => {
          if (disabled) event.preventDefault();
          else prepareAnimatedMenuFromSummary(event.currentTarget, event);
        }}
      >
        Page
      </summary>
      <div
        className="canvas-export-menu__content"
        data-animated-menu
        role="group"
        aria-label="Import and export"
      >
        <button
          type="button"
          disabled={disabled || importDisabled}
          title="Import a Markdown file"
          onClick={onImportMarkdown}
        >
          Import Markdown
        </button>
        <button
          type="button"
          disabled={disabled}
          title="Export Markdown in reading order"
          onClick={onExportMarkdown}
        >
          Export page Markdown
        </button>
        <select
          aria-label="Export region"
          disabled={disabled}
          value={exportRegionMode}
          onChange={(event) => {
            const mode = event.target.value;
            if (mode === "content" || mode === "visible" || mode === "selection") {
              onExportRegionModeChange(mode);
            }
          }}
        >
          <option value="content">Content bounds</option>
          <option value="visible">Visible viewport</option>
          <option value="selection" disabled={!selectionAvailable}>
            Selected objects
          </option>
        </select>
        <button
          type="button"
          disabled={disabled}
          title="Export the page as editable vector SVG"
          onClick={onExportSvg}
        >
          Export SVG
        </button>
        <button
          type="button"
          disabled={disabled}
          title="Export the page as a PNG image"
          onClick={() => void onExportPng()}
        >
          Export PNG
        </button>
      </div>
    </details>
  );
}
