import type { RefObject } from "react";

import type {
  CanvasElement,
  MarkdownBoxAppearance,
  MarkdownColorStyleLibrary,
  NotebookSection,
  PageManifest,
  ProfileDrawingPalettes,
} from "@squillpad/core-model";
import {
  CanvasFileMenu,
  CanvasSession,
  MarkdownSearchControl,
  searchMarkdown,
  SpatialCanvas,
  type CanvasExportRegionMode,
  type DrawingPreferences,
  type GeometryPreview,
  type LaserPointer,
  type PictureInPictureCapture,
  type SpatialCanvasHandle,
} from "@squillpad/ui";

import { EditableTitle } from "./AppChrome";
import type { PageData } from "./app-types";
import { PictureInPictureOverlay, type PictureInPictureView } from "./PictureInPictureOverlay";

export interface PageWorkspaceProps {
  readonly selectedSection: NotebookSection | undefined;
  readonly selectedPage: PageManifest | undefined;
  readonly selectedPageData: PageData | undefined;
  readonly pages: Readonly<Record<string, PageData>>;
  readonly pictureInPictures: readonly PictureInPictureView[];
  readonly session: CanvasSession;
  readonly pageReady: boolean;
  readonly mutationDisabled: boolean;
  readonly busy: boolean;
  readonly clientReadOnly: boolean;
  readonly pageBackground: "blank" | "ruled" | "grid";
  readonly theme: "light" | "dark";
  readonly canvasFullscreen: boolean;
  readonly canvasToolbarHeight: number;
  readonly exportRegionMode: CanvasExportRegionMode;
  readonly canvasSelectionCount: number;
  readonly laserPointerDecaySeconds: number;
  readonly keyboardPanSpeedMultiplier: number;
  readonly drawingPreferences: DrawingPreferences;
  readonly palmRejection: boolean;
  readonly profileDrawingPalettes: ProfileDrawingPalettes;
  readonly markdownSearchQuery: string;
  readonly markdownSearchActiveIndex: number;
  readonly markdownSearchInputRef: RefObject<HTMLInputElement | null>;
  readonly markdownBoxAppearance: MarkdownBoxAppearance;
  readonly markdownColorStyles: MarkdownColorStyleLibrary;
  readonly geometryPreviews: readonly GeometryPreview[];
  readonly laserPointers: readonly LaserPointer[];
  readonly canvasRef: RefObject<SpatialCanvasHandle | null>;
  readonly fileMenuRef: RefObject<HTMLDetailsElement | null>;
  readonly onPageTitleCommit: (title: string) => void;
  readonly onMarkdownSearchQueryChange: (query: string) => void;
  readonly onMarkdownSearchActiveIndexChange: (index: number) => void;
  readonly onMoveMarkdownSearch: (direction: number) => void;
  readonly onExportRegionModeChange: (mode: CanvasExportRegionMode) => void;
  readonly onFullscreenChange: (fullscreen: boolean) => void;
  readonly onSelectionChange: (selectedCount: number) => void;
  readonly onPictureInPictureCapture: (capture: PictureInPictureCapture) => void;
  readonly onPictureInPictureActivate: (id: string) => void;
  readonly onPictureInPictureChange: (id: string, patch: Partial<PictureInPictureView>) => void;
  readonly onPictureInPictureClose: (id: string) => void;
  readonly onDrawingPreferencesChange: (preferences: DrawingPreferences) => void;
  readonly onProfileDrawingPalettesChange: (palettes: ProfileDrawingPalettes) => void;
  readonly onMarkdownColorStylesChange: (library: MarkdownColorStyleLibrary) => void;
  readonly onMarkdownEditingChange: (editing: boolean) => void;
  readonly onGeometryPreviewChange: (preview: GeometryPreview | undefined) => void;
  readonly onLaserPointerChange: (pointers: readonly LaserPointer[]) => void;
  readonly onElementsChange: (elements: readonly CanvasElement[]) => void;
  readonly onMarkdownSourceChange: (elementId: string, source: string) => void;
  readonly onMarkdownCommit: (elementId: string, source: string) => void;
  readonly loadImageAsset: (asset: string) => Promise<Blob>;
  readonly saveImageAsset: (blob: Blob) => Promise<string>;
  readonly loadPictureInPictureImageAsset: (
    sectionId: string,
    pageId: string,
    asset: string,
  ) => Promise<Blob>;
}

export function PageWorkspace({
  selectedSection,
  selectedPage,
  selectedPageData,
  pages,
  pictureInPictures,
  session,
  pageReady,
  mutationDisabled,
  busy,
  clientReadOnly,
  pageBackground,
  theme,
  canvasFullscreen,
  canvasToolbarHeight,
  exportRegionMode,
  canvasSelectionCount,
  laserPointerDecaySeconds,
  keyboardPanSpeedMultiplier,
  drawingPreferences,
  palmRejection,
  profileDrawingPalettes,
  markdownSearchQuery,
  markdownSearchActiveIndex,
  markdownSearchInputRef,
  markdownBoxAppearance,
  markdownColorStyles,
  geometryPreviews,
  laserPointers,
  canvasRef,
  fileMenuRef,
  onPageTitleCommit,
  onMarkdownSearchQueryChange,
  onMarkdownSearchActiveIndexChange,
  onMoveMarkdownSearch,
  onExportRegionModeChange,
  onFullscreenChange,
  onSelectionChange,
  onPictureInPictureCapture,
  onPictureInPictureActivate,
  onPictureInPictureChange,
  onPictureInPictureClose,
  onDrawingPreferencesChange,
  onProfileDrawingPalettesChange,
  onMarkdownColorStylesChange,
  onMarkdownEditingChange,
  onGeometryPreviewChange,
  onLaserPointerChange,
  onElementsChange,
  onMarkdownSourceChange,
  onMarkdownCommit,
  loadImageAsset,
  saveImageAsset,
  loadPictureInPictureImageAsset,
}: PageWorkspaceProps) {
  const markdownSearch = searchMarkdownForPage(selectedPageData, markdownSearchQuery);

  return (
    <section className="page-workspace" aria-label="Active page">
      {selectedSection !== undefined && selectedPage !== undefined ? (
        <>
          <div className="page-heading">
            <EditableTitle
              ariaLabel="Page title"
              value={selectedPage.title}
              disabled={mutationDisabled}
              onCommit={onPageTitleCommit}
            />
            <MarkdownSearchControl
              className="page-markdown-search"
              inputRef={markdownSearchInputRef}
              query={markdownSearchQuery}
              matchCount={markdownSearch.matches.length}
              activeMatchIndex={markdownSearchActiveIndex}
              onQueryChange={(query) => {
                onMarkdownSearchQueryChange(query);
                onMarkdownSearchActiveIndexChange(0);
              }}
              onMove={onMoveMarkdownSearch}
            />
            <CanvasFileMenu
              detailsRef={fileMenuRef}
              disabled={busy || selectedPageData === undefined || !pageReady}
              importDisabled={clientReadOnly}
              exportRegionMode={exportRegionMode}
              selectionAvailable={canvasSelectionCount > 0}
              onImportMarkdown={() => canvasRef.current?.openMarkdownImport()}
              onExportMarkdown={() => canvasRef.current?.exportMarkdownPage()}
              onExportRegionModeChange={onExportRegionModeChange}
              onExportSvg={() => canvasRef.current?.exportSvg()}
              onExportPng={() => canvasRef.current?.exportPng()}
            />
          </div>
          {selectedPageData === undefined || !pageReady ? (
            <div className="canvas-placeholder">
              <p>Preparing synchronized page…</p>
            </div>
          ) : (
            <SpatialCanvas
              ref={canvasRef}
              fullscreen={canvasFullscreen}
              session={session}
              pageId={selectedPage.id}
              pageBackground={pageBackground}
              theme={theme}
              toolbarHeight={canvasToolbarHeight}
              exportRegionMode={exportRegionMode}
              onExportRegionModeChange={onExportRegionModeChange}
              laserPointerDecaySeconds={laserPointerDecaySeconds}
              keyboardPanSpeedMultiplier={keyboardPanSpeedMultiplier}
              drawingPreferences={drawingPreferences}
              onDrawingPreferencesChange={onDrawingPreferencesChange}
              palmRejection={palmRejection}
              profileDrawingPalettes={profileDrawingPalettes}
              onProfileDrawingPalettesChange={onProfileDrawingPalettesChange}
              markdownSearchQuery={markdownSearchQuery}
              markdownSearchActiveIndex={markdownSearchActiveIndex}
              markdownSearchInputRef={markdownSearchInputRef}
              onMarkdownSearchQueryChange={(query) => {
                onMarkdownSearchQueryChange(query);
                onMarkdownSearchActiveIndexChange(0);
              }}
              onMarkdownSearchActiveIndexChange={onMarkdownSearchActiveIndexChange}
              markdownBoxAppearance={markdownBoxAppearance}
              markdownColorStyles={markdownColorStyles}
              onMarkdownColorStylesChange={onMarkdownColorStylesChange}
              onMarkdownEditingChange={onMarkdownEditingChange}
              readOnly={clientReadOnly}
              allowLaserPointer={clientReadOnly}
              onFullscreenChange={onFullscreenChange}
              onSelectionChange={onSelectionChange}
              onPictureInPictureCapture={onPictureInPictureCapture}
              elements={selectedPageData.canvas}
              markdownSources={selectedPageData.markdown}
              loadImageAsset={loadImageAsset}
              saveImageAsset={saveImageAsset}
              remoteGeometryPreviews={geometryPreviews}
              remoteLaserPointers={laserPointers}
              onGeometryPreviewChange={onGeometryPreviewChange}
              onLaserPointerChange={onLaserPointerChange}
              onElementsChange={onElementsChange}
              onMarkdownSourceChange={onMarkdownSourceChange}
              onMarkdownCommit={onMarkdownCommit}
            />
          )}
          <PictureInPictureOverlay
            views={pictureInPictures}
            pages={pages}
            pageBackground={pageBackground}
            theme={theme}
            markdownBoxAppearance={markdownBoxAppearance}
            markdownColorStyles={markdownColorStyles}
            onActivate={onPictureInPictureActivate}
            onChange={onPictureInPictureChange}
            onClose={onPictureInPictureClose}
            loadImageAsset={loadPictureInPictureImageAsset}
          />
        </>
      ) : (
        <div className="canvas-placeholder">
          <p>Create a page to begin.</p>
        </div>
      )}
    </section>
  );
}

function searchMarkdownForPage(page: PageData | undefined, query: string) {
  if (page === undefined) return { blocks: [], matches: [] };
  return searchMarkdown(page.canvas, page.markdown, query);
}
