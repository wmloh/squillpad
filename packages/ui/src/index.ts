export { AppShell } from "./AppShell";
export {
  CanvasFileMenu,
  type CanvasExportRegionMode,
  type CanvasFileMenuProps,
} from "./CanvasFileMenu";
export {
  SpatialCanvas,
  clampCanvasToolbarHeight,
  CANVAS_TOOLBAR_HEIGHT_MAX,
  CANVAS_TOOLBAR_HEIGHT_MIN,
  DEFAULT_CANVAS_TOOLBAR_HEIGHT,
  type CanvasBackground,
  type LaserPointer,
  type PictureInPictureCapture,
  type SpatialCanvasHandle,
  type SpatialCanvasProps,
} from "./SpatialCanvas";
export { MarkdownSearchControl, type MarkdownSearchControlProps } from "./MarkdownSearchControl";
export {
  ANIMATED_MENU_CLOSE,
  ANIMATED_MENU_OPEN,
  closeAnimatedMenu,
  dismissAnimatedMenuFromInteraction,
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
  refreshAnimatedMenuOrigin,
} from "./animated-menu";
export {
  MarkdownBlock,
  MarkdownPreview,
  type MarkdownBlockProps,
  type MarkdownPreviewProps,
} from "./MarkdownBlock";
export {
  acceptsDrawingPointer,
  createShapeRecord,
  eraseElements,
  eraseInk,
  insertVerticalSpace,
  lassoSelectElements,
  lassoSelectInk,
  updateSelectedInkStyle,
  updateSelectedShapeStyle,
  type EraserMode,
  type ShapeTool,
} from "./drawing-tools";
export {
  DEFAULT_DRAWING_PREFERENCES,
  DEFAULT_PROFILE_DRAWING_PALETTES,
  cloneProfileDrawingPalettes,
  defaultProfilePaletteSlot,
  DRAWING_PREFERENCES_KEY,
  normalizeProfileDrawingPalettes,
  INK_PALETTE,
  HIGHLIGHTER_WIDTH_MAX,
  HIGHLIGHTER_WIDTH_MIN,
  HIGHLIGHTER_WIDTH_STEP,
  INK_WIDTH_MAX,
  INK_WIDTH_MIN,
  loadDrawingPreferences,
  loadProfileDrawingPreferences,
  PEN_WIDTH_MIN,
  PEN_WIDTH_MAX,
  saveDrawingPreferences,
  SHAPE_WIDTH_MAX,
  type DrawingPreferences,
  type DrawingPaletteKind,
  type DrawingTool,
} from "./drawing-preferences";
export {
  countMarkdownMatches,
  searchMarkdown,
  type MarkdownSearchBlock,
  type MarkdownSearchMatch,
  type MarkdownSearchResult,
} from "./markdown-search";
export {
  DEFAULT_INK_STYLE,
  createInkRecord,
  decimateInkPoints,
  outlineToSvgPath,
  pointerSampleToWorld,
  renderInkPath,
  strokeOutline,
  type InkPointerSample,
} from "./ink-engine";
export {
  DEFAULT_CAMERA,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  clientToWorld,
  fitCamera,
  panCamera,
  viewportWorldBounds,
  viewportToWorld,
  worldToViewport,
  zoomCameraAt,
  type Bounds,
  type Camera,
  type Point,
} from "./canvas-camera";

export {
  createSyntheticStressPage,
  type SyntheticStressPage,
  type SyntheticStressPageOptions,
} from "./performance-fixture";
export {
  CanvasPerformanceInstrumentation,
  type CanvasPerformanceSnapshot,
  type PerformanceInstrumentationOptions,
  type PerformanceMetricSummary,
} from "./performance-instrumentation";

export {
  CanvasHistory,
  CanvasSession,
  type CanvasHistorySnapshot,
} from "./canvas-history";
export {
  applyGeometryPreviews,
  parseGeometryPreview,
  type GeometryPreview,
} from "./geometry-preview";
export {
  downloadExport,
  exportPageToSvg,
  readMarkdownFile,
  rasterizeSvgToPng,
  type MarkdownFileLike,
  type PngExportResult,
  type SvgExportOptions,
  type SvgExportResult,
} from "./visual-export";
