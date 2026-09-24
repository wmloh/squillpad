import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ForwardedRef,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";

import {
  DEFAULT_MARKDOWN_BOX_APPEARANCE,
  EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
  DEFAULT_LASER_POINTER_SETTINGS,
  DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER,
  attachTextBoxGroupBlock,
  boundsContainPoint,
  boundsOverlap,
  bringForward,
  bringToFront,
  canonicalCoordinate,
  CanvasSpatialIndex,
  deleteElements,
  detachTextBoxGroupBlock,
  duplicateElements,
  elementBounds,
  elementsByZ,
  expandGroupedSelection,
  groupElements,
  insertElement,
  insertTextBoxGroupBlock,
  resizeElement,
  readKeyboardPanSpeedMultiplier,
  sendBackward,
  sendToBack,
  setMarkdownColorStyle,
  assignTextBoxGroup,
  textBoxGroupBounds,
  ungroupElements,
  type CanvasBounds,
  type CanvasElement,
  type InkCanvasRecord,
  type InkPoint,
  type InkStyle,
  type DrawingPalettePreferences,
  type DrawingPaletteSlot,
  type MarkdownBoxAppearance,
  type MarkdownColorStyleLibrary,
  type ProfileDrawingPalettes,
  type ShapeCanvasRecord,
  type ShapeStyle,
} from "@squillpad/core-model";
import { linearizeMarkdownBlocks } from "@squillpad/core-model";

import {
  DEFAULT_CAMERA,
  fitCamera,
  panCamera,
  viewportToWorld,
  viewportWorldBounds,
  zoomCameraAt,
  type Bounds,
  type Camera,
  type Point,
} from "./canvas-camera";
import { randomId } from "./random-id";
import type { CanvasExportRegionMode } from "./CanvasFileMenu";
import {
  decodeClipboard,
  encodeClipboard,
  isSupportedClipboardImageType,
  readClipboardImage,
  type ClipboardImage,
} from "./canvas-clipboard";
import { CanvasSession, type CanvasHistorySnapshot } from "./canvas-history";
import { MarkdownSearchControl } from "./MarkdownSearchControl";
import {
  closeAnimatedMenu,
  dismissAnimatedMenuFromInteraction,
  prepareAnimatedMenu,
  refreshAnimatedMenuOrigin,
} from "./animated-menu";
import { clampInkWidth, clampShapeWidth, DRAWING_WIDTH_MIN } from "./drawing-limits";
import {
  acceptsDrawingPointer,
  createShapeRecord,
  eraseElements,
  lassoSelectElements,
  updateSelectedInkStyle,
  updateSelectedShapeStyle,
  type ShapeTool,
} from "./drawing-tools";
import {
  HIGHLIGHTER_WIDTH_MAX,
  HIGHLIGHTER_WIDTH_MIN,
  HIGHLIGHTER_WIDTH_STEP,
  DEFAULT_PROFILE_DRAWING_PALETTES,
  defaultProfilePaletteSlot,
  INK_PALETTE,
  INK_WIDTH_MAX,
  INK_WIDTH_MIN,
  loadDrawingPreferences,
  saveDrawingPreferences,
  SHAPE_WIDTH_MAX,
  type DrawingPreferences,
  type DrawingPaletteKind,
  type DrawingTool,
} from "./drawing-preferences";
import { searchMarkdown } from "./markdown-search";
import { applyGeometryPreviews, type GeometryPreview } from "./geometry-preview";
import { createInkRecord, pointerSampleToWorld, renderInkPath } from "./ink-engine";
import {
  CanvasPerformanceInstrumentation,
  type CanvasPerformanceSnapshot,
} from "./performance-instrumentation";
import {
  CanvasElementLayer,
  InkToolCursor as CanvasInkToolCursor,
  pointsToSvgPath as canvasPointsToSvgPath,
} from "./CanvasElementLayer";
import {
  CanvasRadialToolbar,
  RADIAL_HOLD_CANCEL_DISTANCE_SCREEN_PX,
  RADIAL_LONG_PRESS_MS,
  RADIAL_MENU_EXTENT_SCREEN_PX,
  type RadialMenuState,
  type RadialSectorGlow,
} from "./CanvasRadialToolbar";
import { CanvasToolbar } from "./CanvasToolbar";
import type { LaserPointer } from "./canvas-types";
import {
  downloadExport,
  exportPageToSvg,
  readMarkdownFile,
  rasterizeSvgToPng,
  type SvgExportResult,
} from "./visual-export";

export interface SpatialCanvasProps {
  readonly pageBackground?: CanvasBackground;
  readonly session?: CanvasSession;
  readonly children?: ReactNode;
  readonly camera?: Camera;
  readonly contentBounds?: Bounds;
  /** Element IDs to render at reduced opacity for visual comparison views. */
  readonly dimmedElementIds?: ReadonlySet<string>;
  readonly elements?: readonly CanvasElement[];
  readonly fullscreen?: boolean;
  readonly exportRegionMode?: CanvasExportRegionMode;
  readonly markdownSearchActiveIndex?: number;
  readonly markdownSearchInputRef?: RefObject<HTMLInputElement | null>;
  readonly markdownSearchQuery?: string;
  readonly markdownBoxAppearance?: MarkdownBoxAppearance;
  readonly markdownColorStyles?: MarkdownColorStyleLibrary;
  readonly markdownSources?: Readonly<Record<string, string>>;
  readonly loadImageAsset?: (asset: string) => Promise<Blob>;
  readonly saveImageAsset?: (blob: Blob) => Promise<string>;
  readonly laserPointerDecaySeconds?: number;
  readonly keyboardPanSpeedMultiplier?: number;
  readonly remoteGeometryPreviews?: readonly GeometryPreview[];
  readonly remoteLaserPointers?: readonly LaserPointer[];
  readonly theme?: "light" | "dark";
  readonly onElementsChange?: (elements: readonly CanvasElement[]) => void;
  readonly onCameraChange?: (camera: Camera) => void;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
  readonly onExportRegionModeChange?: (mode: CanvasExportRegionMode) => void;
  readonly onMarkdownCommit?: (elementId: string, source: string) => void;
  readonly onMarkdownSearchActiveIndexChange?: (index: number) => void;
  readonly onMarkdownSearchQueryChange?: (query: string) => void;
  readonly onMarkdownSourceChange?: (elementId: string, source: string) => void;
  readonly onMarkdownEditingChange?: (editing: boolean) => void;
  readonly onMarkdownColorStylesChange?: (library: MarkdownColorStyleLibrary) => void;
  readonly onGeometryPreviewChange?: (preview: GeometryPreview | undefined) => void;
  readonly onLaserPointerChange?: (pointers: readonly LaserPointer[]) => void;
  readonly onSelectionChange?: (selectedCount: number) => void;
  readonly onPictureInPictureCapture?: (capture: PictureInPictureCapture) => void;
  readonly onPerformanceMetrics?: (metrics: CanvasPerformanceSnapshot) => void;
  readonly drawingPreferences?: DrawingPreferences;
  readonly onDrawingPreferencesChange?: (preferences: DrawingPreferences) => void;
  readonly profileDrawingPalettes?: ProfileDrawingPalettes;
  readonly onProfileDrawingPalettesChange?: (palettes: ProfileDrawingPalettes) => void;
  readonly performanceInstrumentation?: CanvasPerformanceInstrumentation;
  readonly palmRejection?: boolean;
  readonly penDrawsTouchNavigates?: boolean;
  /** Render a non-interactive camera view without canvas controls. */
  readonly presentationOnly?: boolean;
  readonly readOnly?: boolean;
  readonly allowLaserPointer?: boolean;
  readonly toolbarHeight?: number;
  readonly pageId: string;
}

export interface PictureInPictureCapture {
  readonly bounds: Bounds;
  readonly viewportSize: Readonly<{ width: number; height: number }>;
}

export type CanvasBackground = "blank" | "ruled" | "grid";
type Tool = DrawingTool | "picture-in-picture";

export const DEFAULT_CANVAS_TOOLBAR_HEIGHT = 44;
export const CANVAS_TOOLBAR_HEIGHT_MIN = 24;
export const CANVAS_TOOLBAR_HEIGHT_MAX = 120;

export interface SpatialCanvasHandle {
  readonly exportMarkdownPage: () => void;
  readonly exportPng: () => Promise<void>;
  readonly exportSvg: () => void;
  readonly openMarkdownImport: () => void;
}

export function clampCanvasToolbarHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CANVAS_TOOLBAR_HEIGHT;
  return Math.min(
    CANVAS_TOOLBAR_HEIGHT_MAX,
    Math.max(CANVAS_TOOLBAR_HEIGHT_MIN, Math.round(value)),
  );
}

export type { LaserPointer } from "./canvas-types";

interface PointerSample extends Point {
  readonly pointerType: string;
}

interface ElementDrag {
  readonly ids: ReadonlySet<string>;
  readonly pointerId: number;
  readonly point: Point;
  readonly attachableMarkdownId?: string;
  readonly textGroupMarkdownId?: string;
}

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

interface ResizeDrag {
  readonly bounds: CanvasBounds;
  readonly elementId: string;
  readonly handle: ResizeHandle;
  readonly pointerId: number;
  readonly point: Point;
}

interface ActiveInkStroke {
  readonly id: string;
  readonly pointerId: number;
  readonly samples: readonly InkPoint[];
  readonly style: InkStyle;
}

interface ActivePath {
  readonly additive?: boolean;
  readonly kind: "eraser" | "lasso";
  readonly pointerId: number;
  readonly points: readonly Point[];
}

interface ActiveSpace {
  readonly cutY: number;
  readonly distance: number;
  readonly pointerId: number;
}

interface ActiveShape {
  readonly id: string;
  readonly pointerId: number;
  readonly kind: ShapeTool;
  readonly start: Point;
  readonly end: Point;
  readonly constrained: boolean;
}

interface ActivePictureInPicture {
  readonly pointerId: number;
  readonly start: Point;
  readonly end: Point;
  readonly viewportStart: Point;
  readonly viewportEnd: Point;
}

interface PendingRadialHold {
  readonly pointerId: number;
  readonly point: Point;
  readonly timer: number;
}

const CULLING_MARGIN_SCREEN_PX = 320;
const MAX_LASER_TRACE_POINTS = 4096;
const KEYBOARD_PAN_SPEED_PX_PER_SECOND = 960;
const ELEMENT_DRAG_THRESHOLD_SCREEN_PX = 4;

/** World-space canvas with editing controls or a read-only pan and zoom surface. */
export const SpatialCanvas = forwardRef<SpatialCanvasHandle, SpatialCanvasProps>(SpatialCanvasImpl);

function SpatialCanvasImpl(
  {
    pageBackground = "grid",
    theme = "light",
    session,
    children,
    camera: controlledCamera,
    contentBounds,
    dimmedElementIds,
    elements = [],
    fullscreen = false,
    exportRegionMode: controlledExportRegionMode,
    markdownSearchActiveIndex: controlledMarkdownSearchActiveIndex,
    markdownSearchInputRef: providedMarkdownSearchInputRef,
    markdownSearchQuery: controlledMarkdownSearchQuery,
    markdownSources = {},
    loadImageAsset,
    saveImageAsset,
    laserPointerDecaySeconds = DEFAULT_LASER_POINTER_SETTINGS.decaySeconds,
    keyboardPanSpeedMultiplier = DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER,
    remoteGeometryPreviews = [],
    remoteLaserPointers = [],
    onElementsChange: emitElements,
    onCameraChange,
    onFullscreenChange,
    onExportRegionModeChange,
    markdownBoxAppearance,
    markdownColorStyles: controlledMarkdownColorStyles,
    onMarkdownCommit: emitMarkdownCommit,
    onMarkdownSearchActiveIndexChange,
    onMarkdownSearchQueryChange,
    onMarkdownSourceChange: emitSource,
    onMarkdownEditingChange,
    onMarkdownColorStylesChange,
    onGeometryPreviewChange,
    onLaserPointerChange,
    onPerformanceMetrics,
    drawingPreferences: controlledDrawingPreferences,
    onDrawingPreferencesChange,
    profileDrawingPalettes: controlledProfileDrawingPalettes,
    onProfileDrawingPalettesChange,
    performanceInstrumentation,
    palmRejection = false,
    penDrawsTouchNavigates: controlledPenDrawsTouchNavigates,
    presentationOnly = false,
    readOnly = false,
    allowLaserPointer = false,
    onSelectionChange,
    onPictureInPictureCapture,
    toolbarHeight = DEFAULT_CANVAS_TOOLBAR_HEIGHT,
    pageId,
  }: SpatialCanvasProps,
  ref: ForwardedRef<SpatialCanvasHandle>,
) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editorOverlayRef = useRef<HTMLDivElement>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const markdownImportRef = useRef<HTMLInputElement>(null);
  const shapeMenuRef = useRef<HTMLDetailsElement>(null);
  const miscellaneousMenuRef = useRef<HTMLDetailsElement>(null);
  const markdownStyleMenuRef = useRef<HTMLDetailsElement>(null);
  const internalMarkdownSearchInputRef = useRef<HTMLInputElement>(null);
  const markdownSearchInputRef = providedMarkdownSearchInputRef ?? internalMarkdownSearchInputRef;
  const activeInkPreviewRef = useRef<HTMLDivElement>(null);
  const activeInkPreviewSvgRef = useRef<SVGSVGElement>(null);
  const activeInkPreviewPathRef = useRef<SVGPathElement>(null);
  const cameraRef = useRef<Camera>(DEFAULT_CAMERA);
  const pointersRef = useRef(new Map<number, PointerSample>());
  const touchOverridePointerIdRef = useRef<number | undefined>(undefined);
  const touchOverrideHeldRef = useRef(false);
  const gestureRef = useRef<{ camera: Camera; center: Point; distance: number } | undefined>(
    undefined,
  );
  const dragRef = useRef<{ pointerId: number; point: Point } | undefined>(undefined);
  const pendingElementDragRef = useRef<ElementDrag | undefined>(undefined);
  const elementDragRef = useRef<ElementDrag | undefined>(undefined);
  const resizeDragRef = useRef<ResizeDrag | undefined>(undefined);
  const manualMarkdownHeightRef = useRef(new Set<string>());
  const activeInkRef = useRef<ActiveInkStroke | undefined>(undefined);
  const activePathRef = useRef<ActivePath | undefined>(undefined);
  const activeShapeRef = useRef<ActiveShape | undefined>(undefined);
  const activePictureInPictureRef = useRef<ActivePictureInPicture | undefined>(undefined);
  const activeSpaceRef = useRef<ActiveSpace | undefined>(undefined);
  const activeLaserRef = useRef<LaserPointer | undefined>(undefined);
  const activeLaserPointerIdRef = useRef<number | undefined>(undefined);
  const laserClearTimersRef = useRef(new Map<string, number>());
  const activePenPointerRef = useRef<number | undefined>(undefined);
  const keyboardPanKeysRef = useRef(new Set<string>());
  const keyboardPanSpeedMultiplierRef = useRef(
    readKeyboardPanSpeedMultiplier(keyboardPanSpeedMultiplier),
  );
  keyboardPanSpeedMultiplierRef.current = readKeyboardPanSpeedMultiplier(
    keyboardPanSpeedMultiplier,
  );
  const keyboardPanFrameRef = useRef<number | undefined>(undefined);
  const keyboardPanLastTimestampRef = useRef<number | undefined>(undefined);
  const pendingTextTapRef = useRef<{ pointerId: number; point: Point; world: Point } | undefined>(
    undefined,
  );
  const radialHoldRef = useRef<PendingRadialHold | undefined>(undefined);
  const radialMenuRef = useRef<RadialMenuState | undefined>(undefined);
  const radialMenuPointerReleasedRef = useRef<number | undefined>(undefined);
  const closeRadialMenuRef = useRef<() => void>(() => undefined);
  const cameraFrameRef = useRef<number | undefined>(undefined);
  const cameraFrameStartedAtRef = useRef<number | undefined>(undefined);
  const performanceRef = useRef<CanvasPerformanceInstrumentation | undefined>(undefined);
  if (performanceRef.current === undefined) {
    performanceRef.current = performanceInstrumentation ?? new CanvasPerformanceInstrumentation();
  }
  const elementsRef = useRef(elements);
  const imageBlobsRef = useRef(new Map<string, Blob>());
  const spaceHeldRef = useRef(false);
  const [preferences, setPreferences] = useState<DrawingPreferences>(
    () =>
      controlledDrawingPreferences ??
      loadDrawingPreferences(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const effectiveEraserWidth = clampInkWidth(preferences.eraserWidth, false);
  const lastControlledDrawingPreferencesRef = useRef(controlledDrawingPreferences);
  const updatePreferences = useCallback(
    (update: (current: DrawingPreferences) => DrawingPreferences) => {
      const current = preferencesRef.current;
      const next = update(current);
      if (next === current) return;
      preferencesRef.current = next;
      setPreferences(next);
      onDrawingPreferencesChange?.(next);
    },
    [onDrawingPreferencesChange],
  );
  const [localProfileDrawingPalettes, setLocalProfileDrawingPalettes] = useState(
    () => controlledProfileDrawingPalettes ?? DEFAULT_PROFILE_DRAWING_PALETTES,
  );
  const profileDrawingPalettes = localProfileDrawingPalettes;
  const profileDrawingPalettesRef = useRef<ProfileDrawingPalettes>(profileDrawingPalettes);
  profileDrawingPalettesRef.current = profileDrawingPalettes;
  const lastControlledProfileDrawingPalettesRef = useRef(controlledProfileDrawingPalettes);
  const updateProfileDrawingPalettes = useCallback(
    (next: ProfileDrawingPalettes) => {
      profileDrawingPalettesRef.current = next;
      setLocalProfileDrawingPalettes(next);
      onProfileDrawingPalettesChange?.(next);
    },
    [onProfileDrawingPalettesChange],
  );
  useEffect(() => {
    if (
      controlledProfileDrawingPalettes !== undefined &&
      controlledProfileDrawingPalettes !== lastControlledProfileDrawingPalettesRef.current
    ) {
      lastControlledProfileDrawingPalettesRef.current = controlledProfileDrawingPalettes;
      setLocalProfileDrawingPalettes(controlledProfileDrawingPalettes);
    }
  }, [controlledProfileDrawingPalettes]);
  const [localMarkdownColorStyles, setLocalMarkdownColorStyles] = useState(
    () => controlledMarkdownColorStyles ?? EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
  );
  const markdownColorStyles = controlledMarkdownColorStyles ?? localMarkdownColorStyles;
  const lastControlledMarkdownColorStylesRef = useRef(controlledMarkdownColorStyles);
  useEffect(() => {
    if (
      controlledMarkdownColorStyles !== undefined &&
      controlledMarkdownColorStyles !== lastControlledMarkdownColorStylesRef.current
    ) {
      lastControlledMarkdownColorStylesRef.current = controlledMarkdownColorStyles;
      setLocalMarkdownColorStyles(controlledMarkdownColorStyles);
    }
  }, [controlledMarkdownColorStyles]);
  const markdownColorStylesRef = useRef<MarkdownColorStyleLibrary>(markdownColorStyles);
  markdownColorStylesRef.current = markdownColorStyles;
  const [localCamera, setCameraState] = useState<Camera>(DEFAULT_CAMERA);
  const camera = controlledCamera ?? localCamera;
  cameraRef.current = camera;
  useEffect(() => {
    if (controlledCamera === undefined) return;
    setCameraState((current) => (current === controlledCamera ? current : controlledCamera));
  }, [controlledCamera]);
  const [tool, setToolState] = useState<Tool>(() => preferences.lastTool);
  const previousDrawingToolRef = useRef<DrawingTool>(preferences.lastTool);
  useEffect(() => {
    if (
      controlledDrawingPreferences !== undefined &&
      controlledDrawingPreferences !== lastControlledDrawingPreferencesRef.current
    ) {
      lastControlledDrawingPreferencesRef.current = controlledDrawingPreferences;
      preferencesRef.current = controlledDrawingPreferences;
      setPreferences(controlledDrawingPreferences);
      setToolState(controlledDrawingPreferences.lastTool);
    }
  }, [controlledDrawingPreferences]);
  const [isPanning, setIsPanning] = useState(false);
  const [touchOverrideHeld, setTouchOverrideHeld] = useState(false);
  const [cursorViewport, setCursorViewport] = useState<Point>({ x: 0, y: 0 });
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorWorld, setCursorWorld] = useState<Point>({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [hoveredId, setHoveredId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedTextGroupId, setSelectedTextGroupId] = useState<string>();
  const [textGroupDropTargetId, setTextGroupDropTargetId] = useState<string>();
  const [editingMarkdownId, setEditingMarkdownId] = useState<string>();
  const [activePath, setActivePath] = useState<ActivePath>();
  const [activeShape, setActiveShape] = useState<ShapeCanvasRecord>();
  const [activePictureInPicture, setActivePictureInPicture] = useState<ActivePictureInPicture>();
  const [activeSpace, setActiveSpace] = useState<ActiveSpace>();
  const [radialMenu, setRadialMenu] = useState<RadialMenuState>();
  const [radialSectorGlow, setRadialSectorGlow] = useState<RadialSectorGlow>();
  const paletteEditorMenuRefs = useRef<
    Partial<Record<DrawingPaletteKind, HTMLDetailsElement | null>>
  >({});
  const [localLaserPointers, setLocalLaserPointers] = useState<readonly LaserPointer[]>([]);
  const localLaserPointersRef = useRef<readonly LaserPointer[]>([]);
  const [localGeometryPreview, setLocalGeometryPreview] = useState<GeometryPreview>();
  const localGeometryPreviewRef = useRef<GeometryPreview | undefined>(undefined);
  const textGroupDropTargetRef = useRef<string | undefined>(undefined);
  const [, setClipboardRevision] = useState(0);
  const pendingClipboardCopyRef = useRef<Promise<void> | undefined>(undefined);
  const [localExportRegionMode, setLocalExportRegionMode] =
    useState<CanvasExportRegionMode>("content");
  const exportRegionMode = controlledExportRegionMode ?? localExportRegionMode;
  const setExportRegionMode = useCallback(
    (next: CanvasExportRegionMode) => {
      if (controlledExportRegionMode === undefined) setLocalExportRegionMode(next);
      onExportRegionModeChange?.(next);
    },
    [controlledExportRegionMode, onExportRegionModeChange],
  );
  const [localMarkdownSearchQuery, setLocalMarkdownSearchQuery] = useState("");
  const [localMarkdownSearchActiveIndex, setLocalMarkdownSearchActiveIndex] = useState(0);
  const effectiveEditingMarkdownId = readOnly ? undefined : editingMarkdownId;
  const markdownSearchQuery = controlledMarkdownSearchQuery ?? localMarkdownSearchQuery;
  const activeMarkdownSearchIndex =
    controlledMarkdownSearchActiveIndex ?? localMarkdownSearchActiveIndex;
  const setMarkdownSearchQuery = useCallback(
    (query: string) => {
      if (onMarkdownSearchQueryChange === undefined) setLocalMarkdownSearchQuery(query);
      else onMarkdownSearchQueryChange(query);
    },
    [onMarkdownSearchQueryChange],
  );
  const setActiveMarkdownSearchIndex = useCallback(
    (index: number) => {
      if (onMarkdownSearchActiveIndexChange === undefined) {
        setLocalMarkdownSearchActiveIndex(index);
      } else {
        onMarkdownSearchActiveIndexChange(index);
      }
    },
    [onMarkdownSearchActiveIndexChange],
  );
  const activeInkStyle = useMemo(() => {
    const key = tool === "highlighter" ? "highlighter" : "pen";
    const palette = profileDrawingPalettes[key];
    const slot = palette.custom
      ? (palette.slots[palette.selectedIndex] ?? palette.slots[0]!)
      : defaultProfilePaletteSlot(key, palette.selectedIndex);
    if (!palette.custom) return { ...preferences[key], color: slot.color };
    return {
      ...preferences[key],
      color: slot.color,
      width: slot.width,
      opacity: slot.opacity,
    };
  }, [preferences, profileDrawingPalettes, tool]);
  const activeShapeStyle = useMemo(() => {
    const palette = profileDrawingPalettes.shape;
    const slot = palette.custom
      ? (palette.slots[palette.selectedIndex] ?? palette.slots[0]!)
      : defaultProfilePaletteSlot("shape", palette.selectedIndex);
    if (!palette.custom) {
      return {
        ...preferences.shape,
        strokeColor: slot.color,
        fillColor: preferences.shape.fillColor === null ? null : slot.color,
      };
    }
    return {
      ...preferences.shape,
      strokeColor: slot.color,
      strokeWidth: slot.width,
      opacity: slot.opacity,
      fillColor: preferences.shape.fillColor === null ? null : slot.color,
    };
  }, [preferences.shape, profileDrawingPalettes]);
  const penDrawsTouchNavigates =
    controlledPenDrawsTouchNavigates ??
    controlledDrawingPreferences?.penDrawsTouchNavigates ??
    preferences.penDrawsTouchNavigates;
  const effectiveMarkdownBoxAppearance = markdownBoxAppearance ?? DEFAULT_MARKDOWN_BOX_APPEARANCE;
  const effectiveMarkdownColorStyles = markdownColorStyles;
  const setTool = useCallback(
    (next: Tool) => {
      if (next === "picture-in-picture") {
        if (tool !== "picture-in-picture") previousDrawingToolRef.current = tool;
        setToolState(next);
        return;
      }
      setToolState(next);
      previousDrawingToolRef.current = next;
      updatePreferences((current) =>
        current.lastTool === next ? current : { ...current, lastTool: next },
      );
    },
    [tool, updatePreferences],
  );
  const finishPictureInPictureTool = useCallback(() => {
    setToolState(previousDrawingToolRef.current);
  }, []);
  const palmRejectionActive = palmRejection && fullscreen;
  const releaseTouchOverride = useCallback((pointerId?: number) => {
    if (
      pointerId !== undefined &&
      touchOverridePointerIdRef.current !== undefined &&
      touchOverridePointerIdRef.current !== pointerId
    ) {
      return;
    }
    touchOverridePointerIdRef.current = undefined;
    touchOverrideHeldRef.current = false;
    setTouchOverrideHeld(false);
  }, []);
  elementsRef.current = elements;
  const sourcesRef = useRef(markdownSources);
  sourcesRef.current = markdownSources;
  const onLaserPointerChangeRef = useRef(onLaserPointerChange);
  onLaserPointerChangeRef.current = onLaserPointerChange;
  const publishLocalLaserPointers = useCallback((pointers: readonly LaserPointer[]) => {
    localLaserPointersRef.current = pointers;
    setLocalLaserPointers(pointers);
    onLaserPointerChangeRef.current?.(pointers);
  }, []);
  const onGeometryPreviewChangeRef = useRef(onGeometryPreviewChange);
  onGeometryPreviewChangeRef.current = onGeometryPreviewChange;
  const localSessionRef = useRef(new CanvasSession());
  const canvasSession = session ?? localSessionRef.current;
  const reportPerformance = useCallback(() => {
    onPerformanceMetrics?.(performanceRef.current!.snapshot());
  }, [onPerformanceMetrics]);
  const renderActiveInkPreview = useCallback((stroke: ActiveInkStroke | undefined) => {
    const container = activeInkPreviewRef.current;
    const svg = activeInkPreviewSvgRef.current;
    const path = activeInkPreviewPathRef.current;
    if (container === null || svg === null || path === null) return;
    if (stroke === undefined) {
      container.hidden = true;
      return;
    }
    if (stroke.style.highlighter && stroke.samples.length < 2) {
      container.hidden = true;
      return;
    }

    const record = createInkRecord(
      stroke.id,
      elementsRef.current.length,
      stroke.samples,
      stroke.style,
    );
    const bounds = elementBounds(record);
    container.hidden = false;
    container.style.left = `${bounds.x}px`;
    container.style.top = `${bounds.y}px`;
    container.style.width = `${Math.max(1, bounds.width)}px`;
    container.style.height = `${Math.max(1, bounds.height)}px`;
    container.style.zIndex = String(record.z);
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    path.setAttribute(
      "d",
      renderInkPath(record, bounds, 0.15 / Math.max(0.1, cameraRef.current.zoom)),
    );
    path.setAttribute("fill", record.style.color);
    path.setAttribute("opacity", String(record.style.opacity));
  }, []);
  const canvasHistory = canvasSession.history;
  const gestureHistoryRef = useRef<string | undefined>(undefined);
  const snapshot = (): CanvasHistorySnapshot => ({
    elements: elementsRef.current,
    sources: sourcesRef.current,
    markdownColorStyles: markdownColorStylesRef.current,
    profileDrawingPalettes: profileDrawingPalettesRef.current,
  });
  const setElementRefs = (next: readonly CanvasElement[]) => {
    elementsRef.current = next;
    sourcesRef.current = Object.fromEntries(
      next
        .filter((element) => element.kind === "markdown")
        .map((element) => [element.id, sourcesRef.current[element.id] ?? ""]),
    );
  };
  const setMarkdownColorStylesValue = (next: MarkdownColorStyleLibrary) => {
    markdownColorStylesRef.current = next;
    if (controlledMarkdownColorStyles === undefined) setLocalMarkdownColorStyles(next);
    onMarkdownColorStylesChange?.(next);
  };
  const commitCanvasChange = (
    before: CanvasHistorySnapshot,
    next: {
      readonly elements?: readonly CanvasElement[];
      readonly markdownColorStyles?: MarkdownColorStyleLibrary;
      readonly profileDrawingPalettes?: ProfileDrawingPalettes;
    },
    group?: string,
  ) => {
    if (next.elements !== undefined) setElementRefs(next.elements);
    if (next.markdownColorStyles !== undefined) {
      setMarkdownColorStylesValue(next.markdownColorStyles);
    }
    if (next.profileDrawingPalettes !== undefined) {
      updateProfileDrawingPalettes(next.profileDrawingPalettes);
    }
    canvasHistory.record(
      pageId,
      before,
      snapshot(),
      group,
      group === undefined ? Date.now() : 0,
    );
    if (next.elements !== undefined) emitElements?.(next.elements);
  };
  const onElementsChange = (next: readonly CanvasElement[]) => {
    if (readOnlyRef.current) return;
    const before = snapshot();
    setElementRefs(next);
    canvasHistory.record(
      pageId,
      before,
      snapshot(),
      gestureHistoryRef.current,
      gestureHistoryRef.current ? 0 : Date.now(),
    );
    emitElements?.(next);
  };
  useEffect(() => {
    if (readOnly || controlledMarkdownColorStyles === undefined) return;
    const validStyleIds = new Set(effectiveMarkdownColorStyles.styles.map((style) => style.id));
    if (
      !elements.some(
        (element) =>
          element.kind === "markdown" &&
          element.markdownStyleId !== undefined &&
          !validStyleIds.has(element.markdownStyleId),
      )
    ) {
      return;
    }
    const next = elements.map((element) => {
      if (
        element.kind !== "markdown" ||
        element.markdownStyleId === undefined ||
        validStyleIds.has(element.markdownStyleId)
      ) {
        return element;
      }
      const { markdownStyleId: _removed, ...original } = element;
      return original;
    });
    setElementRefs(next);
    emitElements?.(next);
  }, [
    controlledMarkdownColorStyles,
    effectiveMarkdownColorStyles.styles,
    elements,
    emitElements,
    readOnly,
  ]);
  const updateGeometryPreview = (preview: GeometryPreview | undefined) => {
    if (readOnlyRef.current && preview !== undefined) return;
    localGeometryPreviewRef.current = preview;
    setLocalGeometryPreview(preview);
    onGeometryPreviewChangeRef.current?.(preview);
  };
  const setTextGroupDropTarget = useCallback((groupId: string | undefined) => {
    if (textGroupDropTargetRef.current === groupId) return;
    textGroupDropTargetRef.current = groupId;
    setTextGroupDropTargetId(groupId);
  }, []);
  const updateTextGroupDropTarget = (markdownId: string | undefined, point: Point) => {
    if (markdownId === undefined) {
      setTextGroupDropTarget(undefined);
      return;
    }
    const source = elementsRef.current.find((element) => element.id === markdownId);
    if (!isAttachableTextBox(source)) {
      setTextGroupDropTarget(undefined);
      return;
    }
    setTextGroupDropTarget(textBoxGroupAtPoint(textBoxGroups, point));
  };
  const commitGeometryPreview = () => {
    const preview = localGeometryPreviewRef.current;
    if (preview === undefined) return;
    onElementsChange(applyGeometryPreviews(elementsRef.current, [preview]));
    updateGeometryPreview(undefined);
  };
  const updateMarkdownColorStyles = (next: MarkdownColorStyleLibrary, group?: string) => {
    if (readOnlyRef.current) return;
    const before = snapshot();
    setMarkdownColorStylesValue(next);
    canvasHistory.record(pageId, before, snapshot(), group, group === undefined ? Date.now() : 0);
  };
  const onMarkdownSourceChange = (id: string, source: string) => {
    if (readOnlyRef.current) return;
    const before = snapshot();
    sourcesRef.current = { ...sourcesRef.current, [id]: source };
    canvasHistory.record(pageId, before, snapshot(), `typing:${id}`);
    emitSource?.(id, source);
  };
  const removeMarkdown = (id: string) => {
    if (readOnlyRef.current) return;
    if (!elementsRef.current.some((element) => element.id === id)) return;
    const current = elementsRef.current.find((element) => element.id === id);
    const compacted =
      current?.kind === "markdown" && current.textGroupId !== undefined
        ? detachTextBoxGroupBlock(elementsRef.current, id)
        : elementsRef.current;
    onElementsChange(deleteElements(compacted, new Set([id])));
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const commitMarkdown = (id: string, source: string) => {
    if (readOnlyRef.current) return;
    if (source.trim().length === 0) {
      sourcesRef.current = { ...sourcesRef.current, [id]: source };
      emitSource?.(id, source);
      removeMarkdown(id);
      return;
    }
    emitMarkdownCommit?.(id, source);
  };
  const addMarkdownSource = (source: string, position: Point) => {
    if (readOnlyRef.current) return;
    const id = randomId();
    const before = snapshot();
    const element = createElement(
      "markdown",
      id,
      position,
      effectiveMarkdownColorStyles.defaultStyleId,
    );
    const next = insertElement(elementsRef.current, element);
    elementsRef.current = next;
    sourcesRef.current = { ...sourcesRef.current, [id]: source };
    canvasHistory.record(pageId, before, snapshot());
    emitElements?.(next);
    emitSource?.(id, source);
    if (fullscreen) centerCanvasElement(element, false);
    setSelectedIds(new Set([id]));
    setEditingMarkdownId(id);
    setTool("select");
  };
  const handleMarkdownImport = async (event: ChangeEvent<HTMLInputElement>) => {
    if (readOnlyRef.current) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    try {
      const source = await readMarkdownFile(file);
      if (readOnlyRef.current) return;
      addMarkdownSource(source, cursorWorld);
    } catch {
      // Ignore malformed local files without adding transient UI text.
    }
  };
  const finishGesture = () => {
    gestureHistoryRef.current = undefined;
  };
  const travelHistory = (redo: boolean) => {
    if (readOnlyRef.current) return;
    finishGesture();
    const before = snapshot();
    const next = redo
      ? canvasHistory.redo(pageId, before)
      : canvasHistory.undo(pageId, before);
    const stylesChanged =
      JSON.stringify(before.markdownColorStyles) !== JSON.stringify(next.markdownColorStyles);
    const palettesChanged =
      JSON.stringify(before.profileDrawingPalettes) !== JSON.stringify(next.profileDrawingPalettes);
    sourcesRef.current = next.sources;
    elementsRef.current = next.elements;
    markdownColorStylesRef.current = stylesChanged
      ? next.markdownColorStyles
      : before.markdownColorStyles;
    profileDrawingPalettesRef.current = palettesChanged
      ? next.profileDrawingPalettes
      : before.profileDrawingPalettes;
    if (stylesChanged && controlledMarkdownColorStyles === undefined) {
      setLocalMarkdownColorStyles(next.markdownColorStyles);
    }
    if (palettesChanged) setLocalProfileDrawingPalettes(next.profileDrawingPalettes);
    for (const [id, source] of Object.entries(next.sources)) emitSource?.(id, source);
    emitElements?.(next.elements);
    if (stylesChanged) onMarkdownColorStylesChange?.(next.markdownColorStyles);
    if (palettesChanged) onProfileDrawingPalettesChange?.(next.profileDrawingPalettes);
    setSelectedIds(new Set());
    setSelectedTextGroupId(undefined);
    surfaceRef.current?.focus();
  };

  const derivedContentBounds = useMemo(
    () => contentBounds ?? combinedBounds(elements),
    [contentBounds, elements],
  );

  const setCamera = useCallback(
    (next: Camera | ((camera: Camera) => Camera)) => {
      const value = typeof next === "function" ? next(cameraRef.current) : next;
      cameraRef.current = value;
      setCameraState(value);
      onCameraChange?.(value);
      cameraFrameStartedAtRef.current ??= performanceRef.current!.now();
      if (cameraFrameRef.current !== undefined) return;
      cameraFrameRef.current = requestAnimationFrame(() => {
        cameraFrameRef.current = undefined;
        const startedAt = cameraFrameStartedAtRef.current;
        cameraFrameStartedAtRef.current = undefined;
        if (startedAt === undefined) return;
        performanceRef.current!.recordPanZoomFrame(startedAt);
        reportPerformance();
      });
    },
    [onCameraChange, reportPerformance],
  );
  const centerCanvasElement = useCallback(
    (element: CanvasElement | undefined, centerVertically = true) => {
      const surface = surfaceRef.current;
      if (surface === null || element === undefined) return;
      const bounds = elementBounds(element);
      setCamera((current) => ({
        ...current,
        x: surface.clientWidth / 2 - (bounds.x + bounds.width / 2) * current.zoom,
        y: centerVertically
          ? surface.clientHeight / 2 - (bounds.y + bounds.height / 2) * current.zoom
          : current.y,
      }));
    },
    [setCamera],
  );
  const animateKeyboardPan = useCallback(
    (timestamp: number) => {
      const keys = keyboardPanKeysRef.current;
      if (keys.size === 0) {
        keyboardPanFrameRef.current = undefined;
        keyboardPanLastTimestampRef.current = undefined;
        return;
      }

      const previousTimestamp = keyboardPanLastTimestampRef.current ?? timestamp;
      const elapsed = Math.min(50, Math.max(0, timestamp - previousTimestamp));
      keyboardPanLastTimestampRef.current = timestamp;
      let x = 0;
      let y = 0;
      for (const key of keys) {
        const direction = keyboardPanDelta(key);
        if (direction === undefined) continue;
        x += direction.x;
        y += direction.y;
      }
      if (x !== 0 || y !== 0) {
        const distance =
          (KEYBOARD_PAN_SPEED_PX_PER_SECOND * keyboardPanSpeedMultiplierRef.current * elapsed) /
          1000;
        setCamera((current) => panCamera(current, { x: x * distance, y: y * distance }));
      }
      keyboardPanFrameRef.current = requestAnimationFrame(animateKeyboardPan);
    },
    [setCamera],
  );
  const stopKeyboardPan = useCallback(() => {
    keyboardPanKeysRef.current.clear();
    const frame = keyboardPanFrameRef.current;
    if (frame !== undefined) cancelAnimationFrame(frame);
    keyboardPanFrameRef.current = undefined;
    keyboardPanLastTimestampRef.current = undefined;
  }, []);
  const startKeyboardPan = useCallback(
    (key: string) => {
      const direction = keyboardPanDelta(key);
      if (direction === undefined) return;
      const keys = keyboardPanKeysRef.current;
      const wasIdle = keys.size === 0;
      keys.add(key);
      if (wasIdle) {
        keyboardPanLastTimestampRef.current = performanceRef.current!.now();
        const initialDistance =
          (KEYBOARD_PAN_SPEED_PX_PER_SECOND * keyboardPanSpeedMultiplierRef.current) / 60;
        setCamera((current) =>
          panCamera(current, {
            x: direction.x * initialDistance,
            y: direction.y * initialDistance,
          }),
        );
      }
      if (keyboardPanFrameRef.current === undefined) {
        keyboardPanFrameRef.current = requestAnimationFrame(animateKeyboardPan);
      }
    },
    [animateKeyboardPan, setCamera],
  );
  const releaseKeyboardPanKey = useCallback(
    (key: string) => {
      if (!keyboardPanKeysRef.current.delete(key)) return;
      if (keyboardPanKeysRef.current.size === 0) stopKeyboardPan();
    },
    [stopKeyboardPan],
  );

  const home = useCallback(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    setCamera(
      fitCamera(derivedContentBounds, {
        width: surface.clientWidth,
        height: surface.clientHeight,
      }),
    );
  }, [derivedContentBounds, setCamera]);
  const homeRef = useRef(home);
  homeRef.current = home;
  const centerMarkdownSearchMatch = useCallback(
    (match: { readonly elementId: string } | undefined) => {
      const element =
        match === undefined
          ? undefined
          : elementsRef.current.find((candidate) => candidate.id === match.elementId);
      centerCanvasElement(element);
    },
    [centerCanvasElement],
  );
  const moveMarkdownSearch = (direction: number) => {
    const count = markdownSearch.matches.length;
    if (count === 0) return;
    const next = (activeMarkdownSearchIndex + direction + count) % count;
    setActiveMarkdownSearchIndex(next);
    centerMarkdownSearchMatch(markdownSearch.matches[next]);
  };

  useEffect(() => {
    const laserClearTimers = laserClearTimersRef.current;
    stopKeyboardPan();
    gestureHistoryRef.current = undefined;
    performanceRef.current?.beginPage();
    pointersRef.current.clear();
    dragRef.current = undefined;
    pendingElementDragRef.current = undefined;
    elementDragRef.current = undefined;
    resizeDragRef.current = undefined;
    manualMarkdownHeightRef.current.clear();
    activeInkRef.current = undefined;
    activePathRef.current = undefined;
    activeShapeRef.current = undefined;
    activeSpaceRef.current = undefined;
    activeLaserRef.current = undefined;
    activeLaserPointerIdRef.current = undefined;
    for (const timer of laserClearTimers.values()) {
      window.clearTimeout(timer);
    }
    laserClearTimers.clear();
    activePenPointerRef.current = undefined;
    gestureRef.current = undefined;
    releaseTouchOverride();
    setHoveredId(undefined);
    setSelectedIds(new Set());
    setEditingMarkdownId(undefined);
    setMarkdownSearchQuery("");
    setActiveMarkdownSearchIndex(0);
    renderActiveInkPreview(undefined);
    setActivePath(undefined);
    setActiveShape(undefined);
    setActiveSpace(undefined);
    setTextGroupDropTarget(undefined);
    publishLocalLaserPointers([]);
    localGeometryPreviewRef.current = undefined;
    setLocalGeometryPreview(undefined);
    onGeometryPreviewChangeRef.current?.(undefined);
    setIsPanning(false);
    const frame = requestAnimationFrame(() => homeRef.current());
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of laserClearTimers.values()) {
        window.clearTimeout(timer);
      }
      laserClearTimers.clear();
    };
  }, [
    pageId,
    publishLocalLaserPointers,
    releaseTouchOverride,
    renderActiveInkPreview,
    stopKeyboardPan,
    setTextGroupDropTarget,
  ]);

  useEffect(() => {
    if (!readOnly) return;
    stopKeyboardPan();
    pointersRef.current.clear();
    dragRef.current = undefined;
    pendingElementDragRef.current = undefined;
    elementDragRef.current = undefined;
    resizeDragRef.current = undefined;
    gestureHistoryRef.current = undefined;
    activeInkRef.current = undefined;
    activePathRef.current = undefined;
    activeShapeRef.current = undefined;
    activeSpaceRef.current = undefined;
    activePenPointerRef.current = undefined;
    setEditingMarkdownId(undefined);
    setActivePath(undefined);
    setActiveShape(undefined);
    setActiveSpace(undefined);
    setTextGroupDropTarget(undefined);
    localGeometryPreviewRef.current = undefined;
    setLocalGeometryPreview(undefined);
    onGeometryPreviewChangeRef.current?.(undefined);
    renderActiveInkPreview(undefined);
    releaseTouchOverride();
    setIsPanning(false);
  }, [
    readOnly,
    releaseTouchOverride,
    renderActiveInkPreview,
    stopKeyboardPan,
    setTextGroupDropTarget,
  ]);

  useEffect(() => {
    if (effectiveEditingMarkdownId !== undefined) stopKeyboardPan();
  }, [effectiveEditingMarkdownId, stopKeyboardPan]);

  useEffect(() => {
    if (readOnly && tool !== "pan" && !(allowLaserPointer && tool === "laser")) {
      setTool("pan");
    }
  }, [allowLaserPointer, readOnly, setTool, tool]);

  useEffect(() => {
    if (!palmRejectionActive) releaseTouchOverride();
  }, [palmRejectionActive, releaseTouchOverride]);

  useEffect(() => {
    if (!fullscreen || readOnly || !preferences.radialToolbarEnabled) {
      closeRadialMenuRef.current();
    }
  }, [fullscreen, preferences.radialToolbarEnabled, readOnly]);

  useEffect(
    () => () => {
      const pending = radialHoldRef.current;
      if (pending !== undefined) window.clearTimeout(pending.timer);
      radialHoldRef.current = undefined;
      radialMenuRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    onMarkdownEditingChange?.(!readOnly && editingMarkdownId !== undefined);
    return () => onMarkdownEditingChange?.(false);
  }, [editingMarkdownId, onMarkdownEditingChange, readOnly]);

  useEffect(() => () => onFullscreenChange?.(false), [onFullscreenChange]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const updateSize = () => {
      const next = { width: surface.clientWidth, height: surface.clientHeight };
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (controlledDrawingPreferences !== undefined) return;
    saveDrawingPreferences(
      preferences,
      typeof window === "undefined" ? undefined : window.localStorage,
    );
  }, [preferences]);

  useEffect(() => {
    if (
      controlledPenDrawsTouchNavigates === undefined ||
      controlledDrawingPreferences !== undefined
    ) {
      return;
    }
    updatePreferences((current) =>
      current.penDrawsTouchNavigates === controlledPenDrawsTouchNavigates
        ? current
        : { ...current, penDrawsTouchNavigates: controlledPenDrawsTouchNavigates },
    );
  }, [controlledDrawingPreferences, controlledPenDrawsTouchNavigates, updatePreferences]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const canTravelHistoryFromControl =
        command &&
        (key === "z" || key === "y") &&
        isCanvasHistoryControl(event.target);
      if (
        (isEditableTarget(event.target) && !canTravelHistoryFromControl) ||
        event.defaultPrevented
      )
        return;
      if (event.key === "Escape" && radialMenuRef.current !== undefined) {
        event.preventDefault();
        closeRadialMenuRef.current();
        return;
      }
      if (event.key === "Escape" && fullscreen) {
        event.preventDefault();
        onFullscreenChange?.(false);
        return;
      }
      if (event.code === "Space") {
        spaceHeldRef.current = true;
        if (surfaceRef.current?.contains(document.activeElement) === true) event.preventDefault();
        return;
      }
      if (command && key === "f") {
        event.preventDefault();
        markdownSearchInputRef.current?.focus();
        markdownSearchInputRef.current?.select();
        return;
      }
      const keyboardPan =
        effectiveEditingMarkdownId !== undefined || command || event.altKey
          ? undefined
          : keyboardPanDelta(event.key);
      if (keyboardPan !== undefined) {
        event.preventDefault();
        startKeyboardPan(event.key);
        return;
      }
      if (readOnlyRef.current) {
        const nextTool = toolForShortcut(key);
        if (nextTool !== "pan" && !(allowLaserPointer && nextTool === "laser")) return;
        event.preventDefault();
        setTool(nextTool);
        surfaceRef.current?.focus({ preventScroll: true });
        return;
      }
      if (command && (key === "z" || key === "y")) {
        event.preventDefault();
        travelHistory(key === "y" || event.shiftKey);
        surfaceRef.current?.focus({ preventScroll: true });
        return;
      }
      if (command || event.altKey) return;
      if (/^[1-6]$/u.test(key)) {
        const paletteKind: DrawingPaletteKind = isShapeTool(tool)
          ? "shape"
          : tool === "highlighter"
            ? "highlighter"
            : "pen";
        const palette = profileDrawingPalettesRef.current[paletteKind];
        const color = palette.custom
          ? palette.slots[Number(key) - 1]?.color
          : INK_PALETTE[Number(key) - 1];
        if (color !== undefined && selectPaletteColor(color)) {
          event.preventDefault();
          surfaceRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      const nextTool = toolForShortcut(key);
      if (nextTool === undefined) return;
      event.preventDefault();
      setTool(nextTool);
      surfaceRef.current?.focus({ preventScroll: true });
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = false;
      releaseKeyboardPanKey(event.key);
    };
    const blur = () => {
      spaceHeldRef.current = false;
      stopKeyboardPan();
      releaseTouchOverride();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  });

  const localPoint = useCallback((clientX: number, clientY: number): Point => {
    const surface = surfaceRef.current;
    const rect = surface?.getBoundingClientRect();
    const scale = surfacePointScale(surface, rect);
    return {
      x: (clientX - (rect?.left ?? 0)) * scale.x,
      y: (clientY - (rect?.top ?? 0)) * scale.y,
    };
  }, []);

  const updateCursor = useCallback((point: Point, pointerType?: string) => {
    if (pointerType === "touch") return;
    setCursorViewport(point);
    setCursorWorld(viewportToWorld(point, cameraRef.current));
    setCursorVisible(true);
  }, []);

  const handleReadOnlyPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (allowLaserPointer && tool === "laser" && !spaceHeldRef.current) {
      if (isEditableTarget(event.target) || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      const point = localPoint(event.clientX, event.clientY);
      updateCursor(point, event.pointerType);
      const world = viewportToWorld(point, cameraRef.current);
      const pointer = {
        active: true,
        color: "#ef3e58",
        id: randomId(),
        points: [world],
      };
      activeLaserRef.current = pointer;
      activeLaserPointerIdRef.current = event.pointerId;
      publishLocalLaserPointers([...localLaserPointersRef.current, pointer]);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      return;
    }
    if (isEditableTarget(event.target) || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    const point = localPoint(event.clientX, event.clientY);
    pointersRef.current.set(event.pointerId, { ...point, pointerType: event.pointerType });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const touchPointers = [...pointersRef.current.values()].filter(
      (pointer) => pointer.pointerType === "touch",
    );
    if (touchPointers.length === 2) {
      gestureRef.current = gestureStart(touchPointers, cameraRef.current);
      dragRef.current = undefined;
    } else {
      dragRef.current = { pointerId: event.pointerId, point };
    }
    setIsPanning(true);
  };

  const handleReadOnlyPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && palmRejectionActive && !touchOverrideHeldRef.current) {
      event.preventDefault();
      return;
    }
    const point = localPoint(event.clientX, event.clientY);
    updateCursor(point, event.pointerType);
    const laser = activeLaserRef.current;
    if (laser !== undefined && activeLaserPointerIdRef.current === event.pointerId) {
      event.preventDefault();
      const world = viewportToWorld(point, cameraRef.current);
      const previous = laser.points[laser.points.length - 1];
      if (previous?.x !== world.x || previous.y !== world.y) {
        const next = { ...laser, points: appendLaserPoint(laser.points, world) };
        activeLaserRef.current = next;
        publishLocalLaserPointers(
          localLaserPointersRef.current.map((pointer) => (pointer.id === next.id ? next : pointer)),
        );
      }
      return;
    }
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { ...point, pointerType: event.pointerType });
    const touchPointers = [...pointersRef.current.values()].filter(
      (pointer) => pointer.pointerType === "touch",
    );
    if (touchPointers.length === 2 && gestureRef.current !== undefined) {
      event.preventDefault();
      const nextCenter = midpoint(touchPointers[0] as Point, touchPointers[1] as Point);
      const nextDistance = distance(touchPointers[0] as Point, touchPointers[1] as Point);
      const start = gestureRef.current;
      const zoomed = zoomCameraAt(
        start.camera,
        start.center,
        start.camera.zoom * (nextDistance / Math.max(1, start.distance)),
      );
      setCamera(
        panCamera(zoomed, { x: nextCenter.x - start.center.x, y: nextCenter.y - start.center.y }),
      );
      return;
    }
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      event.preventDefault();
      setCamera((current) =>
        panCamera(current, { x: point.x - drag.point.x, y: point.y - drag.point.y }),
      );
      dragRef.current = { pointerId: event.pointerId, point };
    }
  };

  const addMarkdownAt = (position: Point) => {
    if (readOnlyRef.current) return;
    const id = randomId();
    const element = createElement(
      "markdown",
      id,
      position,
      effectiveMarkdownColorStyles.defaultStyleId,
    );
    onElementsChange?.(insertElement(elementsRef.current, element));
    if (fullscreen) centerCanvasElement(element, false);
    setSelectedIds(new Set([id]));
    setEditingMarkdownId(id);
    setTool("select");
  };
  const beginMarkdownEditing = (id: string) => {
    if (readOnlyRef.current) return;
    const element = elementsRef.current.find((candidate) => candidate.id === id);
    if (fullscreen) centerCanvasElement(element, false);
    setSelectedIds(new Set([id]));
    setEditingMarkdownId(id);
  };

  const createTextGroup = (markdownId: string) => {
    if (readOnlyRef.current) return;
    const next = assignTextBoxGroup(elementsRef.current, markdownId, randomId());
    onElementsChange(next);
  };

  const changeMarkdownStyle = (markdownId: string, markdownStyleId: string | undefined) => {
    if (readOnlyRef.current) return;
    onElementsChange(setMarkdownColorStyle(elementsRef.current, markdownId, markdownStyleId));
  };

  const deleteMarkdownStyle = (styleId: string) => {
    if (readOnlyRef.current) return;
    const currentLibrary = markdownColorStylesRef.current;
    if (!currentLibrary.styles.some((style) => style.id === styleId)) return;
    const before = snapshot();
    const styles = currentLibrary.styles.filter((style) => style.id !== styleId);
    const nextLibrary =
      currentLibrary.defaultStyleId === styleId
        ? { styles }
        : { ...currentLibrary, styles };
    const nextElements = elementsRef.current.map((element) => {
      if (element.kind !== "markdown" || element.markdownStyleId !== styleId) return element;
      const { markdownStyleId: _removed, ...original } = element;
      return original;
    });
    commitCanvasChange(before, {
      markdownColorStyles: nextLibrary,
      elements: nextElements,
    });
  };

  const addTextGroupBlock = (afterId: string) => {
    if (readOnlyRef.current) return;
    const id = randomId();
    const after = elementsRef.current.find((element) => element.id === afterId);
    const block = createElement(
      "markdown",
      id,
      { x: 0, y: 0 },
      after?.kind === "markdown" ? after.markdownStyleId : undefined,
    );
    if (block.kind !== "markdown") return;
    const next = insertTextBoxGroupBlock(elementsRef.current, afterId, block);
    const inserted = next.find((element) => element.id === id);
    if (inserted === undefined) return;
    onElementsChange(next);
    if (fullscreen) centerCanvasElement(inserted, false);
    emitSource?.(id, "");
    setSelectedTextGroupId(undefined);
    setSelectedIds(new Set([id]));
    setEditingMarkdownId(id);
  };

  const detachTextGroupBlock = (markdownId: string) => {
    if (readOnlyRef.current) return;
    const next = detachTextBoxGroupBlock(elementsRef.current, markdownId);
    onElementsChange(next);
    setSelectedTextGroupId(undefined);
    setSelectedIds(new Set([markdownId]));
  };

  const addImageFromClipboard = async (file: Blob) => {
    if (readOnlyRef.current) return;
    const position = cursorWorld;
    try {
      const image = await readClipboardImage(file);
      if (readOnlyRef.current) return;
      if (saveImageAsset === undefined) throw new Error("Image asset storage is unavailable");
      const asset = await saveImageAsset(image.blob);
      const id = randomId();
      const element = createImageElement(id, position, image, asset);
      onElementsChange?.(insertElement(elementsRef.current, element));
      setSelectedIds(new Set([id]));
      setTool("select");
    } catch {
      // Ignore clipboard data that is not a decodable image.
    }
  };

  const eventInkSamples = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): readonly InkPoint[] => {
      const native = event.nativeEvent;
      const coalesced = native.getCoalescedEvents?.() ?? [];
      const events = coalesced.length > 0 ? coalesced : [native];
      const surface = surfaceRef.current;
      const rect = surface?.getBoundingClientRect();
      const viewportOrigin = { x: rect?.left ?? 0, y: rect?.top ?? 0 };
      const scale = surfacePointScale(surface, rect);
      return events.map((sample) =>
        pointerSampleToWorld(sample, viewportOrigin, cameraRef.current, scale),
      );
    },
    [],
  );

  const updateActiveInk = useCallback(
    (stroke: ActiveInkStroke) => {
      const startedAt = performanceRef.current!.now();
      activeInkRef.current = stroke;
      renderActiveInkPreview(stroke);
      performanceRef.current!.recordActiveInkLatency(startedAt);
    },
    [renderActiveInkPreview],
  );

  const updateActivePath = useCallback((path: ActivePath) => {
    activePathRef.current = path;
    setActivePath(path);
  }, []);

  const updateActiveShape = useCallback(
    (shape: ActiveShape) => {
      activeShapeRef.current = shape;
      setActiveShape(
        createShapeRecord(
          shape.id,
          elementsRef.current.length,
          shape.kind,
          shape.start,
          shape.end,
          activeShapeStyle,
          shape.constrained,
        ),
      );
    },
    [activeShapeStyle],
  );

  const beginCapturedPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };

  const handleTouchOverridePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (touchOverridePointerIdRef.current !== undefined) return;
    touchOverridePointerIdRef.current = event.pointerId;
    touchOverrideHeldRef.current = true;
    setTouchOverrideHeld(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleTouchOverridePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    releaseTouchOverride(event.pointerId);
  };

  const handleTouchOverrideKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || touchOverridePointerIdRef.current !== undefined) return;
    touchOverrideHeldRef.current = true;
    setTouchOverrideHeld(true);
  };

  const handleTouchOverrideKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (touchOverridePointerIdRef.current === undefined) releaseTouchOverride();
  };

  const preventTouchOverrideSelection = (event: React.SyntheticEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleTouchOverrideTouchStart = (event: React.TouchEvent<HTMLButtonElement>) => {
    preventTouchOverrideSelection(event);
    if (touchOverridePointerIdRef.current !== undefined) return;
    touchOverrideHeldRef.current = true;
    setTouchOverrideHeld(true);
  };

  const handleTouchOverrideTouchEnd = (event: React.TouchEvent<HTMLButtonElement>) => {
    preventTouchOverrideSelection(event);
    if (touchOverridePointerIdRef.current === undefined) releaseTouchOverride();
  };

  const handleBlockedTouchCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType === "touch" &&
      palmRejectionActive &&
      !touchOverrideHeldRef.current &&
      !(event.target instanceof Element && event.target.closest(".canvas-touch-override") !== null)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const isShapeTool = (value: Tool): value is ShapeTool =>
    value === "line" || value === "arrow" || value === "rectangle" || value === "ellipse";

  const finishLaserPointer = (laser: LaserPointer) => {
    const finished = { ...laser, active: false };
    activeLaserRef.current = undefined;
    activeLaserPointerIdRef.current = undefined;
    publishLocalLaserPointers(
      localLaserPointersRef.current.map((pointer) =>
        pointer.id === finished.id ? finished : pointer,
      ),
    );
    const previousTimer = laserClearTimersRef.current.get(finished.id);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      laserClearTimersRef.current.delete(finished.id);
      publishLocalLaserPointers(
        localLaserPointersRef.current.filter((pointer) => pointer.id !== finished.id),
      );
    }, laserPointerDecaySeconds * 1000);
    laserClearTimersRef.current.set(finished.id, timer);
  };

  const clearRadialHold = (pointerId?: number) => {
    const pending = radialHoldRef.current;
    if (pending === undefined || (pointerId !== undefined && pending.pointerId !== pointerId)) {
      return;
    }
    window.clearTimeout(pending.timer);
    radialHoldRef.current = undefined;
  };

  const closeRadialMenu = () => {
    clearRadialHold();
    radialMenuRef.current = undefined;
    radialMenuPointerReleasedRef.current = undefined;
    setRadialSectorGlow(undefined);
    setRadialMenu(undefined);
  };
  closeRadialMenuRef.current = closeRadialMenu;

  const cancelActiveLaser = (pointerId: number) => {
    if (activeLaserPointerIdRef.current !== pointerId) return;
    const activeLaser = activeLaserRef.current;
    activeLaserRef.current = undefined;
    activeLaserPointerIdRef.current = undefined;
    if (activeLaser !== undefined) {
      publishLocalLaserPointers(
        localLaserPointersRef.current.filter((pointer) => pointer.id !== activeLaser.id),
      );
    }
  };

  const cancelPointerGestureForRadial = (pointerId: number) => {
    if (activeInkRef.current?.pointerId === pointerId) {
      activeInkRef.current = undefined;
      renderActiveInkPreview(undefined);
    }
    if (activePathRef.current?.pointerId === pointerId) {
      activePathRef.current = undefined;
      setActivePath(undefined);
    }
    if (activeShapeRef.current?.pointerId === pointerId) {
      activeShapeRef.current = undefined;
      setActiveShape(undefined);
    }
    if (activeSpaceRef.current?.pointerId === pointerId) {
      activeSpaceRef.current = undefined;
      setActiveSpace(undefined);
    }
    cancelActiveLaser(pointerId);
    if (pendingTextTapRef.current?.pointerId === pointerId) {
      pendingTextTapRef.current = undefined;
    }
    if (pendingElementDragRef.current?.pointerId === pointerId) {
      pendingElementDragRef.current = undefined;
    }
    if (elementDragRef.current?.pointerId === pointerId) elementDragRef.current = undefined;
    if (resizeDragRef.current?.pointerId === pointerId) resizeDragRef.current = undefined;
    if (dragRef.current?.pointerId === pointerId) dragRef.current = undefined;
    pointersRef.current.delete(pointerId);
    gestureRef.current = undefined;
    finishGesture();
    setTextGroupDropTarget(undefined);
    updateGeometryPreview(undefined);
    activePenPointerRef.current = undefined;
    setCursorVisible(false);
    setIsPanning(false);
  };

  const radialAnchorForPoint = (point: Point): Point => {
    const surface = surfaceRef.current;
    const width = surface?.clientWidth ?? viewportSize.width;
    const height = surface?.clientHeight ?? viewportSize.height;
    const clampAxis = (value: number, size: number) => {
      if (size <= RADIAL_MENU_EXTENT_SCREEN_PX * 2) return size / 2;
      return Math.min(
        size - RADIAL_MENU_EXTENT_SCREEN_PX,
        Math.max(RADIAL_MENU_EXTENT_SCREEN_PX, value),
      );
    };
    return {
      x: width > 0 ? clampAxis(point.x, width) : point.x,
      y: height > 0 ? clampAxis(point.y, height) : point.y,
    };
  };

  const openRadialMenu = (pending: PendingRadialHold) => {
    if (!fullscreen || readOnlyRef.current || !preferences.radialToolbarEnabled) {
      clearRadialHold(pending.pointerId);
      return;
    }
    clearRadialHold(pending.pointerId);
    cancelPointerGestureForRadial(pending.pointerId);
    const next = { anchor: radialAnchorForPoint(pending.point), pointerId: pending.pointerId };
    radialMenuPointerReleasedRef.current = undefined;
    radialMenuRef.current = next;
    setRadialMenu(next);
  };

  const scheduleRadialHold = (event: React.PointerEvent<HTMLDivElement>, point: Point) => {
    if (
      !fullscreen ||
      readOnlyRef.current ||
      !preferences.radialToolbarEnabled ||
      event.button !== 0 ||
      !event.isPrimary ||
      spaceHeldRef.current
    ) {
      return;
    }
    clearRadialHold();
    const pointerId = event.pointerId;
    const timer = window.setTimeout(() => {
      const pending = radialHoldRef.current;
      if (pending?.pointerId === pointerId) openRadialMenu(pending);
    }, RADIAL_LONG_PRESS_MS);
    radialHoldRef.current = { pointerId, point, timer };
  };

  const handleRadialPointerMove = (event: React.PointerEvent<HTMLDivElement>, point: Point) => {
    const menu = radialMenuRef.current;
    if (menu?.pointerId === event.pointerId) {
      event.preventDefault();
      return true;
    }
    const pending = radialHoldRef.current;
    if (pending?.pointerId === event.pointerId) {
      const distance = Math.hypot(point.x - pending.point.x, point.y - pending.point.y);
      if (distance > RADIAL_HOLD_CANCEL_DISTANCE_SCREEN_PX) clearRadialHold(event.pointerId);
    }
    return false;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (radialMenuRef.current !== undefined) {
      event.preventDefault();
      closeRadialMenu();
      return;
    }
    if (radialHoldRef.current?.pointerId !== event.pointerId) clearRadialHold();
    if (
      tool === "picture-in-picture" &&
      event.button === 0 &&
      (event.isPrimary || event.pointerType === "touch") &&
      !(event.pointerType === "touch" && palmRejectionActive && !touchOverrideHeldRef.current) &&
      !isEditableTarget(event.target)
    ) {
      const viewportPoint = localPoint(event.clientX, event.clientY);
      const worldPoint = viewportToWorld(viewportPoint, cameraRef.current);
      const capture = {
        pointerId: event.pointerId,
        start: worldPoint,
        end: worldPoint,
        viewportStart: viewportPoint,
        viewportEnd: viewportPoint,
      };
      beginCapturedPointer(event);
      activePictureInPictureRef.current = capture;
      setActivePictureInPicture(capture);
      return;
    }
    if (readOnlyRef.current) {
      handleReadOnlyPointerDown(event);
      return;
    }
    if (event.pointerType === "touch" && palmRejectionActive && !touchOverrideHeldRef.current) {
      event.preventDefault();
      return;
    }
    if (isEditableTarget(event.target)) return;
    const point = localPoint(event.clientX, event.clientY);
    updateCursor(point, event.pointerType);
    const world = viewportToWorld(point, cameraRef.current);
    const elementHost =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-canvas-element-id]")
        : null;
    const elementId = elementHost?.dataset.canvasElementId;
    const element = elementsRef.current.find((candidate) => candidate.id === elementId);
    if (
      tool === "text" &&
      event.button === 0 &&
      (event.isPrimary || event.pointerType === "touch") &&
      element?.kind === "markdown" &&
      !spaceHeldRef.current
    ) {
      event.preventDefault();
      beginMarkdownEditing(element.id);
      return;
    }
    scheduleRadialHold(event, point);
    const penEraser = event.pointerType === "pen" && event.button === 5;
    const drawingPointer =
      !spaceHeldRef.current &&
      acceptsDrawingPointer(
        event.pointerType,
        event.button,
        event.isPrimary,
        penDrawsTouchNavigates,
      );
    if (event.pointerType === "touch" && activePenPointerRef.current !== undefined) {
      event.preventDefault();
      return;
    }
    if (
      tool === "select" &&
      event.button === 0 &&
      (event.isPrimary || event.pointerType === "touch") &&
      !spaceHeldRef.current
    ) {
      pointersRef.current.set(event.pointerId, { ...point, pointerType: event.pointerType });
      const touchPointers = [...pointersRef.current.values()].filter(
        (pointer) => pointer.pointerType === "touch",
      );
      if (touchPointers.length === 2) {
        beginCapturedPointer(event);
        if (activePathRef.current?.kind === "lasso") {
          activePathRef.current = undefined;
          setActivePath(undefined);
        }
        pendingElementDragRef.current = undefined;
        commitGeometryPreview();
        elementDragRef.current = undefined;
        gestureRef.current = gestureStart(touchPointers, cameraRef.current);
        dragRef.current = undefined;
        setIsPanning(true);
        return;
      }

      if (element !== undefined) {
        setTextGroupDropTarget(undefined);
        const wasTextGroupSelected = selectedTextGroupId !== undefined;
        setSelectedTextGroupId(undefined);
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        const next = new Set(effectiveSelectedIds);
        const groupMemberIds = new Set(
          elementsRef.current
            .filter(
              (candidate) =>
                candidate.id === element.id ||
                (element.groupId !== undefined && candidate.groupId === element.groupId),
            )
            .map((candidate) => candidate.id),
        );
        if (additive) {
          const removeGroup = [...groupMemberIds].every((id) => next.has(id));
          for (const id of groupMemberIds) {
            if (removeGroup) next.delete(id);
            else next.add(id);
          }
        } else if (wasTextGroupSelected || !next.has(element.id)) {
          next.clear();
          next.add(element.id);
        }
        // Text boxes can only move vertically relative to their text-box group.
        const nextSelection =
          element.kind === "markdown" && element.textGroupId !== undefined
            ? expandGroupedSelection(elementsRef.current, next)
            : withoutGroupedTextBoxes(
                elementsRef.current,
                expandGroupedSelection(elementsRef.current, next),
              );
        setSelectedIds(nextSelection);
        if (nextSelection.has(element.id)) {
          const nextDrag = {
            ids: nextSelection,
            pointerId: event.pointerId,
            point: world,
            ...(isAttachableTextBox(element) &&
            event.target instanceof Element &&
            event.target.closest(".canvas-markdown-drag-handle") !== null
              ? { attachableMarkdownId: element.id }
              : {}),
            ...(element.kind === "markdown" && element.textGroupId !== undefined
              ? { textGroupMarkdownId: element.id }
              : {}),
          };
          if (element.kind === "markdown") {
            if (event.pointerType !== "mouse") {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            event.currentTarget.focus({ preventScroll: true });
            pendingElementDragRef.current = nextDrag;
          } else {
            beginCapturedPointer(event);
            gestureHistoryRef.current = randomId();
            elementDragRef.current = nextDrag;
          }
        }
        return;
      }

      setSelectedTextGroupId(undefined);
      beginCapturedPointer(event);
      updateActivePath({
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        kind: "lasso",
        pointerId: event.pointerId,
        points: [world],
      });
      return;
    }
    if ((tool === "pen" || tool === "highlighter") && drawingPointer && !penEraser) {
      beginCapturedPointer(event);
      setSelectedIds(new Set());
      if (event.pointerType === "pen") activePenPointerRef.current = event.pointerId;
      updateActiveInk({
        id: randomId(),
        pointerId: event.pointerId,
        samples: eventInkSamples(event),
        style: activeInkStyle,
      });
      setCursorVisible(false);
      return;
    }
    if ((tool === "eraser" || penEraser) && drawingPointer) {
      beginCapturedPointer(event);
      if (event.pointerType === "pen") activePenPointerRef.current = event.pointerId;
      updateActivePath({ kind: "eraser", pointerId: event.pointerId, points: [world] });
      return;
    }
    if (tool === "insert-space" && event.button === 0 && event.isPrimary && !spaceHeldRef.current) {
      beginCapturedPointer(event);
      const space = {
        cutY: world.y,
        distance: 0,
        pointerId: event.pointerId,
      };
      gestureHistoryRef.current = randomId();
      activeSpaceRef.current = space;
      setActiveSpace(space);
      setSelectedIds(new Set());
      return;
    }
    if (tool === "laser" && event.button === 0 && event.isPrimary && !spaceHeldRef.current) {
      beginCapturedPointer(event);
      const pointer = {
        active: true,
        color: "#ef3e58",
        id: randomId(),
        points: [world],
      };
      activeLaserRef.current = pointer;
      activeLaserPointerIdRef.current = event.pointerId;
      publishLocalLaserPointers([...localLaserPointersRef.current, pointer]);
      return;
    }
    if (isShapeTool(tool) && drawingPointer) {
      beginCapturedPointer(event);
      setSelectedIds(new Set());
      if (event.pointerType === "pen") activePenPointerRef.current = event.pointerId;
      updateActiveShape({
        id: randomId(),
        pointerId: event.pointerId,
        kind: tool,
        start: world,
        end: world,
        constrained: event.shiftKey,
      });
      return;
    }
    if (
      tool === "text" &&
      event.button === 0 &&
      event.target instanceof Element &&
      event.target.closest("[data-canvas-element-id]") === null &&
      !spaceHeldRef.current
    ) {
      event.preventDefault();
      beginCapturedPointer(event);
      pendingTextTapRef.current = { pointerId: event.pointerId, point, world };
      return;
    }
    pointersRef.current.set(event.pointerId, { ...point, pointerType: event.pointerType });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });

    const touchPointers = [...pointersRef.current.values()].filter(
      (pointer) => pointer.pointerType === "touch",
    );
    if (touchPointers.length === 2) {
      event.preventDefault();
      gestureRef.current = gestureStart(touchPointers, cameraRef.current);
      dragRef.current = undefined;
      setIsPanning(true);
    } else if (
      (event.pointerType === "touch" && tool !== "select") ||
      event.button === 1 ||
      (event.button === 0 && (tool === "pan" || spaceHeldRef.current))
    ) {
      event.preventDefault();
      dragRef.current = { pointerId: event.pointerId, point };
      setIsPanning(true);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pictureInPicture = activePictureInPictureRef.current;
    if (pictureInPicture?.pointerId === event.pointerId) {
      event.preventDefault();
      const viewportPoint = localPoint(event.clientX, event.clientY);
      const next = {
        ...pictureInPicture,
        end: viewportToWorld(viewportPoint, cameraRef.current),
        viewportEnd: viewportPoint,
      };
      activePictureInPictureRef.current = next;
      setActivePictureInPicture(next);
      return;
    }
    if (readOnlyRef.current) {
      handleReadOnlyPointerMove(event);
      return;
    }
    if (event.pointerType === "touch" && palmRejectionActive && !touchOverrideHeldRef.current) {
      event.preventDefault();
      return;
    }
    const point = localPoint(event.clientX, event.clientY);
    if (handleRadialPointerMove(event, point)) return;
    const pendingTextTap = pendingTextTapRef.current;
    if (pendingTextTap?.pointerId === event.pointerId) {
      const distance = Math.hypot(
        point.x - pendingTextTap.point.x,
        point.y - pendingTextTap.point.y,
      );
      if (distance > ELEMENT_DRAG_THRESHOLD_SCREEN_PX) pendingTextTapRef.current = undefined;
      return;
    }
    const activeStroke = activeInkRef.current;
    if (activeStroke?.pointerId === event.pointerId) {
      event.preventDefault();
      updateActiveInk({
        ...activeStroke,
        samples: appendDistinctSamples(activeStroke.samples, eventInkSamples(event)),
      });
      return;
    }
    updateCursor(point, event.pointerType);
    const world = viewportToWorld(point, cameraRef.current);
    const space = activeSpaceRef.current;
    if (space?.pointerId === event.pointerId) {
      event.preventDefault();
      const next = { ...space, distance: world.y - space.cutY };
      activeSpaceRef.current = next;
      setActiveSpace(next);
      updateGeometryPreview({
        kind: "vertical-space",
        cutY: space.cutY,
        distance: next.distance,
      });
      return;
    }
    const laser = activeLaserRef.current;
    if (laser !== undefined && activeLaserPointerIdRef.current === event.pointerId) {
      event.preventDefault();
      const previous = laser.points[laser.points.length - 1];
      if (previous?.x !== world.x || previous.y !== world.y) {
        const next = { ...laser, points: appendLaserPoint(laser.points, world) };
        activeLaserRef.current = next;
        publishLocalLaserPointers(
          localLaserPointersRef.current.map((pointer) => (pointer.id === next.id ? next : pointer)),
        );
      }
      return;
    }
    const path = activePathRef.current;
    if (path?.pointerId === event.pointerId) {
      event.preventDefault();
      const previous = path.points[path.points.length - 1];
      if (previous?.x !== world.x || previous.y !== world.y) {
        updateActivePath({ ...path, points: [...path.points, world] });
      }
      return;
    }
    const shape = activeShapeRef.current;
    if (shape?.pointerId === event.pointerId) {
      event.preventDefault();
      updateActiveShape({ ...shape, end: world, constrained: event.shiftKey });
      return;
    }
    const resizeDrag = resizeDragRef.current;
    if (resizeDrag?.pointerId === event.pointerId) {
      event.preventDefault();
      const delta = { x: world.x - resizeDrag.point.x, y: world.y - resizeDrag.point.y };
      const resizedElement = elementsRef.current.find(
        (element) => element.id === resizeDrag.elementId,
      );
      if (resizedElement?.kind === "markdown" && Math.abs(delta.y) > 1) {
        manualMarkdownHeightRef.current.add(resizeDrag.elementId);
      }
      const resizedBounds = resizeBoundsForHandle(
        resizeDrag.bounds,
        resizeDrag.handle,
        delta,
        resizedElement?.kind === "markdown" ? 72 : 24,
      );
      updateGeometryPreview({
        kind: "resize",
        elementId: resizeDrag.elementId,
        bounds: resizedBounds,
      });
      return;
    }
    const pendingElementDrag = pendingElementDragRef.current;
    if (pendingElementDrag?.pointerId === event.pointerId) {
      const delta = {
        x: world.x - pendingElementDrag.point.x,
        y: world.y - pendingElementDrag.point.y,
      };
      const threshold = ELEMENT_DRAG_THRESHOLD_SCREEN_PX / Math.max(0.1, cameraRef.current.zoom);
      if (Math.hypot(delta.x, delta.y) > threshold) {
        event.preventDefault();
        beginCapturedPointer(event);
        gestureHistoryRef.current = randomId();
        pendingElementDragRef.current = undefined;
        updateGeometryPreview(
          pendingElementDrag.textGroupMarkdownId === undefined
            ? { kind: "move", elementIds: [...pendingElementDrag.ids], delta }
            : {
                kind: "text-group-move",
                elementId: pendingElementDrag.textGroupMarkdownId,
                deltaY: delta.y,
              },
        );
        elementDragRef.current = { ...pendingElementDrag, point: world };
        updateTextGroupDropTarget(pendingElementDrag.attachableMarkdownId, world);
        return;
      }
    }
    const elementDrag = elementDragRef.current;
    if (elementDrag?.pointerId === event.pointerId) {
      const preview = localGeometryPreviewRef.current;
      const delta = { x: world.x - elementDrag.point.x, y: world.y - elementDrag.point.y };
      if (elementDrag.textGroupMarkdownId === undefined) {
        const previousDelta = preview?.kind === "move" ? preview.delta : { x: 0, y: 0 };
        updateGeometryPreview({
          kind: "move",
          elementIds: [...elementDrag.ids],
          delta: { x: previousDelta.x + delta.x, y: previousDelta.y + delta.y },
        });
      } else {
        const previousDeltaY = preview?.kind === "text-group-move" ? preview.deltaY : 0;
        updateGeometryPreview({
          kind: "text-group-move",
          elementId: elementDrag.textGroupMarkdownId,
          deltaY: previousDeltaY + delta.y,
        });
      }
      elementDragRef.current = { ...elementDrag, point: world };
      updateTextGroupDropTarget(elementDrag.attachableMarkdownId, world);
      return;
    }
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { ...point, pointerType: event.pointerType });

    const touchPointers = [...pointersRef.current.values()].filter(
      (pointer) => pointer.pointerType === "touch",
    );
    if (touchPointers.length === 2 && gestureRef.current !== undefined) {
      const nextCenter = midpoint(touchPointers[0] as Point, touchPointers[1] as Point);
      const nextDistance = distance(touchPointers[0] as Point, touchPointers[1] as Point);
      const start = gestureRef.current;
      const zoomed = zoomCameraAt(
        start.camera,
        start.center,
        start.camera.zoom * (nextDistance / Math.max(1, start.distance)),
      );
      setCamera(
        panCamera(zoomed, { x: nextCenter.x - start.center.x, y: nextCenter.y - start.center.y }),
      );
      return;
    }

    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      setCamera((current) =>
        panCamera(current, { x: point.x - drag.point.x, y: point.y - drag.point.y }),
      );
      dragRef.current = { pointerId: event.pointerId, point };
    }
  };

  const endNavigationPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    finishGesture();
    setTextGroupDropTarget(undefined);
    pointersRef.current.delete(event.pointerId);
    if (pendingElementDragRef.current?.pointerId === event.pointerId) {
      pendingElementDragRef.current = undefined;
    }
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined;
    if (elementDragRef.current?.pointerId === event.pointerId) elementDragRef.current = undefined;
    if (resizeDragRef.current?.pointerId === event.pointerId) resizeDragRef.current = undefined;
    gestureRef.current = undefined;
    const remaining = [...pointersRef.current.entries()];
    if (tool !== "select" && remaining.length === 1 && remaining[0]?.[1].pointerType === "touch") {
      const [pointerId, point] = remaining[0];
      dragRef.current = { pointerId, point };
    }
    setIsPanning((readOnly || tool !== "select") && remaining.length > 0);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (radialMenuRef.current?.pointerId === event.pointerId) {
      event.preventDefault();
      clearRadialHold(event.pointerId);
      radialMenuPointerReleasedRef.current = event.pointerId;
      pointersRef.current.delete(event.pointerId);
      return;
    }
    clearRadialHold(event.pointerId);
    const pictureInPicture = activePictureInPictureRef.current;
    if (pictureInPicture?.pointerId === event.pointerId) {
      const viewportPoint = localPoint(event.clientX, event.clientY);
      const end = viewportToWorld(viewportPoint, cameraRef.current);
      const viewportWidth = Math.abs(viewportPoint.x - pictureInPicture.viewportStart.x);
      const viewportHeight = Math.abs(viewportPoint.y - pictureInPicture.viewportStart.y);
      activePictureInPictureRef.current = undefined;
      setActivePictureInPicture(undefined);
      if (viewportWidth >= 8 && viewportHeight >= 8) {
        onPictureInPictureCapture?.({
          bounds: normalizedBounds(pictureInPicture.start, end),
          viewportSize: { width: viewportWidth, height: viewportHeight },
        });
      }
      finishPictureInPictureTool();
      endNavigationPointer(event);
      return;
    }
    const pendingTextTap = pendingTextTapRef.current;
    if (pendingTextTap?.pointerId === event.pointerId) {
      pendingTextTapRef.current = undefined;
      addMarkdownAt(pendingTextTap.world);
      endNavigationPointer(event);
      return;
    }
    if (readOnlyRef.current) {
      if (allowLaserPointer && activeLaserPointerIdRef.current === event.pointerId) {
        const laser = activeLaserRef.current;
        if (laser !== undefined) finishLaserPointer(laser);
        return;
      }
      if (touchOverridePointerIdRef.current === event.pointerId) {
        releaseTouchOverride(event.pointerId);
        return;
      }
      endNavigationPointer(event);
      return;
    }
    if (touchOverridePointerIdRef.current === event.pointerId) {
      releaseTouchOverride(event.pointerId);
      return;
    }
    const space = activeSpaceRef.current;
    if (space?.pointerId === event.pointerId) {
      const world = viewportToWorld(localPoint(event.clientX, event.clientY), cameraRef.current);
      updateGeometryPreview({
        kind: "vertical-space",
        cutY: space.cutY,
        distance: world.y - space.cutY,
      });
      commitGeometryPreview();
      activeSpaceRef.current = undefined;
      setActiveSpace(undefined);
      finishGesture();
      return;
    }
    const elementDrag = elementDragRef.current;
    if (elementDrag?.pointerId === event.pointerId) {
      const point = localPoint(event.clientX, event.clientY);
      const world = viewportToWorld(point, cameraRef.current);
      const attachableMarkdownId = elementDrag.attachableMarkdownId;
      const targetGroupId =
        attachableMarkdownId === undefined ? undefined : textBoxGroupAtPoint(textBoxGroups, world);
      if (targetGroupId === undefined || attachableMarkdownId === undefined) {
        commitGeometryPreview();
      } else {
        const preview = localGeometryPreviewRef.current;
        const previewed =
          preview === undefined
            ? elementsRef.current
            : applyGeometryPreviews(elementsRef.current, [preview]);
        const attached = attachTextBoxGroupBlock(
          previewed,
          attachableMarkdownId,
          targetGroupId,
          world.y,
        );
        onElementsChange(attached);
        updateGeometryPreview(undefined);
      }
      setTextGroupDropTarget(undefined);
      endNavigationPointer(event);
      return;
    }
    if (resizeDragRef.current?.pointerId === event.pointerId) {
      commitGeometryPreview();
      endNavigationPointer(event);
      return;
    }
    const laser = activeLaserRef.current;
    if (laser !== undefined && activeLaserPointerIdRef.current === event.pointerId) {
      finishLaserPointer(laser);
      return;
    }
    const activeStroke = activeInkRef.current;
    if (activeStroke?.pointerId === event.pointerId) {
      const point = localPoint(event.clientX, event.clientY);
      const samples = appendMovedSamples(activeStroke.samples, eventInkSamples(event));
      const record = createInkRecord(
        activeStroke.id,
        elementsRef.current.length,
        samples,
        activeStroke.style,
      );
      activeInkRef.current = undefined;
      activePenPointerRef.current = undefined;
      renderActiveInkPreview(undefined);
      updateCursor(point, event.pointerType);
      onElementsChange?.(insertElement(elementsRef.current, record));
      reportPerformance();
      return;
    }
    const path = activePathRef.current;
    if (path?.pointerId === event.pointerId) {
      const point = viewportToWorld(localPoint(event.clientX, event.clientY), cameraRef.current);
      const points = appendDistinctPoints(path.points, [point]);
      activePathRef.current = undefined;
      activePenPointerRef.current = undefined;
      setActivePath(undefined);
      if (path.kind === "eraser") {
        onElementsChange?.(
          eraseElements(
            elementsRef.current,
            points,
            effectiveEraserWidth / 2,
            preferences.eraserMode,
          ),
        );
        setSelectedIds(new Set());
        endNavigationPointer(event);
      } else {
        const lassoSelection = lassoSelectElements(elementsRef.current, points);
        const lassoIds = expandLassoSelection(elementsRef.current, lassoSelection);
        const nextSelection = path.additive
          ? filterMixedTextBoxSelection(
              elementsRef.current,
              new Set([...effectiveSelectedIds, ...lassoIds]),
            )
          : lassoIds;
        setSelectedIds(nextSelection);
        endNavigationPointer(event);
      }
      return;
    }
    const shape = activeShapeRef.current;
    if (shape?.pointerId === event.pointerId) {
      const point = viewportToWorld(localPoint(event.clientX, event.clientY), cameraRef.current);
      const record = createShapeRecord(
        shape.id,
        elementsRef.current.length,
        shape.kind,
        shape.start,
        point,
        activeShapeStyle,
        event.shiftKey,
      );
      activeShapeRef.current = undefined;
      activePenPointerRef.current = undefined;
      setActiveShape(undefined);
      onElementsChange?.(insertElement(elementsRef.current, record));
      return;
    }
    endNavigationPointer(event);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (radialMenuRef.current?.pointerId === event.pointerId) {
      if (radialMenuPointerReleasedRef.current === event.pointerId) return;
      closeRadialMenu();
      return;
    }
    clearRadialHold(event.pointerId);
    if (activePictureInPictureRef.current?.pointerId === event.pointerId) {
      activePictureInPictureRef.current = undefined;
      setActivePictureInPicture(undefined);
      finishPictureInPictureTool();
      return;
    }
    if (pendingTextTapRef.current?.pointerId === event.pointerId) {
      pendingTextTapRef.current = undefined;
    }
    if (readOnlyRef.current) {
      if (allowLaserPointer && activeLaserPointerIdRef.current === event.pointerId) {
        const laser = activeLaserRef.current;
        if (laser !== undefined) finishLaserPointer(laser);
        return;
      }
      if (touchOverridePointerIdRef.current === event.pointerId) {
        releaseTouchOverride(event.pointerId);
        return;
      }
      endNavigationPointer(event);
      return;
    }
    if (touchOverridePointerIdRef.current === event.pointerId) {
      releaseTouchOverride(event.pointerId);
      return;
    }
    if (
      elementDragRef.current?.pointerId === event.pointerId ||
      resizeDragRef.current?.pointerId === event.pointerId
    ) {
      commitGeometryPreview();
    }
    if (activeSpaceRef.current?.pointerId === event.pointerId) {
      commitGeometryPreview();
      activeSpaceRef.current = undefined;
      setActiveSpace(undefined);
      finishGesture();
    }
    if (activeLaserPointerIdRef.current === event.pointerId) {
      const laser = activeLaserRef.current;
      if (laser !== undefined) {
        finishLaserPointer(laser);
      }
    }
    if (activeInkRef.current?.pointerId === event.pointerId) {
      activeInkRef.current = undefined;
      renderActiveInkPreview(undefined);
      setCursorVisible(false);
    }
    if (activePathRef.current?.pointerId === event.pointerId) {
      activePathRef.current = undefined;
      setActivePath(undefined);
    }
    if (activeShapeRef.current?.pointerId === event.pointerId) {
      activeShapeRef.current = undefined;
      setActiveShape(undefined);
    }
    if (activePenPointerRef.current === event.pointerId) activePenPointerRef.current = undefined;
    endNavigationPointer(event);
  };

  const handleMarkdownFragmentClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (anchor === null || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute("href");
    if (href === null || !href.startsWith("#")) return;
    const target = findMarkdownFragmentTarget(anchor, event.currentTarget, href);
    if (target === undefined) return;

    event.preventDefault();
    event.currentTarget.scrollLeft = 0;
    event.currentTarget.scrollTop = 0;
    const surfaceRect = event.currentTarget.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setCamera((current) =>
      panCamera(current, {
        x: surfaceRect.left + surfaceRect.width / 2 - (targetRect.left + targetRect.width / 2),
        y: surfaceRect.top + surfaceRect.height / 2 - (targetRect.top + targetRect.height / 2),
      }),
    );
  };

  const gridSize = 24 * camera.zoom;
  const backgroundSize =
    pageBackground === "grid"
      ? `${gridSize}px ${gridSize}px`
      : pageBackground === "ruled"
        ? `100% ${32 * camera.zoom}px`
        : undefined;
  const transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  const effectiveSelectedIds = useMemo(
    () => expandGroupedSelection(elements, selectedIds),
    [elements, selectedIds],
  );
  const effectiveSelectionSignature = [...effectiveSelectedIds].sort().join("\u0000");
  useEffect(() => {
    const shapeMenu = shapeMenuRef.current;
    if (shapeMenu !== null) closeAnimatedMenu(shapeMenu);
    const miscellaneousMenu = miscellaneousMenuRef.current;
    if (miscellaneousMenu !== null) closeAnimatedMenu(miscellaneousMenu);
    const markdownStyleMenu = markdownStyleMenuRef.current;
    if (markdownStyleMenu !== null) closeAnimatedMenu(markdownStyleMenu);
    for (const paletteMenu of Object.values(paletteEditorMenuRefs.current)) {
      if (paletteMenu !== null && paletteMenu !== undefined) closeAnimatedMenu(paletteMenu);
    }
    onSelectionChange?.(effectiveSelectedIds.size);
  }, [effectiveSelectedIds.size, effectiveSelectionSignature, onSelectionChange, pageId]);
  useEffect(() => {
    const dismissCanvasMenus = (event: Event) => {
      dismissAnimatedMenuFromInteraction(shapeMenuRef.current, event.target);
      dismissAnimatedMenuFromInteraction(miscellaneousMenuRef.current, event.target);
      dismissAnimatedMenuFromInteraction(markdownStyleMenuRef.current, event.target);
      for (const paletteMenu of Object.values(paletteEditorMenuRefs.current)) {
        dismissAnimatedMenuFromInteraction(paletteMenu ?? null, event.target);
      }
    };
    document.addEventListener("pointerdown", dismissCanvasMenus, true);
    document.addEventListener("focusin", dismissCanvasMenus, true);
    return () => {
      document.removeEventListener("pointerdown", dismissCanvasMenus, true);
      document.removeEventListener("focusin", dismissCanvasMenus, true);
    };
  }, []);
  const selectedElements = elements.filter((element) => effectiveSelectedIds.has(element.id));
  const markdownSearch = useMemo(
    () => searchMarkdown(elements, markdownSources, markdownSearchQuery),
    [elements, markdownSearchQuery, markdownSources],
  );
  const activeMarkdownSearchMatch =
    markdownSearch.matches[activeMarkdownSearchIndex] ?? markdownSearch.matches[0];
  const activeMarkdownSearchElementId = activeMarkdownSearchMatch?.elementId;
  const markdownSearchBlocks = useMemo(
    () => new Map(markdownSearch.blocks.map((block) => [block.elementId, block])),
    [markdownSearch.blocks],
  );
  useEffect(() => {
    const nextIndex =
      markdownSearch.matches.length === 0
        ? 0
        : Math.min(activeMarkdownSearchIndex, markdownSearch.matches.length - 1);
    if (nextIndex !== activeMarkdownSearchIndex) setActiveMarkdownSearchIndex(nextIndex);
  }, [activeMarkdownSearchIndex, markdownSearch.matches.length, setActiveMarkdownSearchIndex]);
  useEffect(() => {
    if (markdownSearchQuery.trim().length === 0) return;
    centerMarkdownSearchMatch(activeMarkdownSearchMatch);
  }, [activeMarkdownSearchMatch?.index, centerMarkdownSearchMatch, markdownSearchQuery]);
  const displayElements = useMemo(
    () =>
      applyGeometryPreviews(elements, [
        ...remoteGeometryPreviews,
        ...(localGeometryPreview === undefined ? [] : [localGeometryPreview]),
      ]),
    [elements, localGeometryPreview, remoteGeometryPreviews],
  );
  const textBoxGroups = useMemo(() => {
    const ids = new Set(
      displayElements.flatMap((element) =>
        element.kind === "markdown" && element.textGroupId !== undefined
          ? [element.textGroupId]
          : [],
      ),
    );
    return [...ids].flatMap((id) => {
      const bounds = textBoxGroupBounds(displayElements, id);
      return bounds === undefined ? [] : [{ bounds, id }];
    });
  }, [displayElements]);
  useEffect(() => {
    if (
      selectedTextGroupId !== undefined &&
      !elements.some(
        (element) => element.kind === "markdown" && element.textGroupId === selectedTextGroupId,
      )
    ) {
      setSelectedTextGroupId(undefined);
    }
  }, [elements, selectedTextGroupId]);
  const spatialIndex = useMemo(() => new CanvasSpatialIndex(displayElements), [displayElements]);
  const effectiveViewportSize = useMemo(
    () => ({
      width: viewportSize.width || surfaceRef.current?.clientWidth || 0,
      height: viewportSize.height || surfaceRef.current?.clientHeight || 0,
    }),
    [viewportSize],
  );
  const visibleWorldBounds = useMemo(
    () =>
      viewportWorldBounds(
        camera,
        effectiveViewportSize,
        CULLING_MARGIN_SCREEN_PX / Math.max(0.1, camera.zoom),
      ),
    [camera, effectiveViewportSize],
  );
  const visibleTextBoxGroups = useMemo(
    () =>
      effectiveViewportSize.width <= 0 || effectiveViewportSize.height <= 0
        ? textBoxGroups
        : textBoxGroups.filter((group) => boundsOverlap(group.bounds, visibleWorldBounds)),
    [effectiveViewportSize, textBoxGroups, visibleWorldBounds],
  );
  const visibleElements = useMemo(() => {
    if (effectiveViewportSize.width <= 0 || effectiveViewportSize.height <= 0) {
      return elementsByZ(displayElements);
    }
    const byId = new Map(
      spatialIndex.query(visibleWorldBounds).map((element) => [element.id, element]),
    );
    for (const element of displayElements) {
      if (
        element.id === effectiveEditingMarkdownId ||
        element.id === activeMarkdownSearchElementId
      ) {
        byId.set(element.id, element);
      }
    }
    return elementsByZ([...byId.values()]);
  }, [
    activeMarkdownSearchElementId,
    displayElements,
    effectiveEditingMarkdownId,
    effectiveViewportSize,
    spatialIndex,
    visibleWorldBounds,
  ]);
  const visibleSelectedElements = visibleElements.filter((element) =>
    effectiveSelectedIds.has(element.id),
  );
  const selectionZIndex = useMemo(
    () => Math.max(0, ...displayElements.map((element) => element.z)) + 1,
    [displayElements],
  );
  const laserZIndex = selectionZIndex + 1;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      performanceRef.current!.markPageOpened(elements.length, visibleElements.length);
      reportPerformance();
    });
    return () => cancelAnimationFrame(frame);
  }, [elements.length, pageId, reportPerformance, visibleElements.length]);
  const selectedInk = selectedElements.filter(
    (element): element is InkCanvasRecord => element.kind === "ink",
  );
  const selectedShapes = selectedElements.filter(
    (element): element is ShapeCanvasRecord => element.kind === "shape",
  );
  const inkHighlighterForControls = selectedInk[0]?.style.highlighter ?? tool === "highlighter";
  const inkPaletteKind: DrawingPaletteKind = inkHighlighterForControls ? "highlighter" : "pen";
  const inkPaletteForControls = profileDrawingPalettes[inkPaletteKind];
  const shapePaletteForControls = profileDrawingPalettes.shape;
  const shapePaletteSlot =
    shapePaletteForControls.slots[shapePaletteForControls.selectedIndex] ??
    shapePaletteForControls.slots[0]!;
  const shapeStyleForControls = selectedShapes[0]?.style ?? activeShapeStyle;
  const shapeStrokeWidthForControls = clampShapeWidth(shapeStyleForControls.strokeWidth);
  const inkWidthMin = inkHighlighterForControls ? HIGHLIGHTER_WIDTH_MIN : INK_WIDTH_MIN;
  const inkWidthMax = inkHighlighterForControls ? HIGHLIGHTER_WIDTH_MAX : INK_WIDTH_MAX;
  const inkWidthStep = inkHighlighterForControls ? HIGHLIGHTER_WIDTH_STEP : 1;
  const inkWidthForControls = clampInkWidth(
    selectedInk[0]?.style.width ?? activeInkStyle.width,
    inkHighlighterForControls,
  );
  const inkDimensionLabel = inkHighlighterForControls ? "Height" : "Thickness";
  const inkDimensionAriaLabel = inkHighlighterForControls ? "Ink height" : "Ink thickness";
  const hasGroupedSelection = selectedElements.some((element) => element.groupId !== undefined);

  const renderedMarkdownHtml = (): Readonly<Record<string, string>> => {
    const rendered: Record<string, string> = {};
    for (const element of elementsRef.current) {
      if (element.kind !== "markdown") continue;
      const node = surfaceRef.current?.querySelector(
        `[data-canvas-element-id="${element.id}"] .markdown-content`,
      );
      if (node instanceof HTMLElement) rendered[element.id] = node.innerHTML;
    }
    return rendered;
  };
  const createVisualExport = async (): Promise<SvgExportResult> => {
    const selected = exportRegionMode === "selection" ? effectiveSelectedIds : undefined;
    const region =
      exportRegionMode === "visible"
        ? viewportWorldBounds(cameraRef.current, effectiveViewportSize)
        : undefined;
    const imageSources = Object.fromEntries(
      await Promise.all(
        elementsRef.current
          .filter((element) => element.kind === "image")
          .map(
            async (element) =>
              [
                element.asset,
                loadImageAsset === undefined
                  ? element.asset
                  : await blobDataUrl(await loadImageForCanvas(element.asset)),
              ] as const,
          ),
      ),
    );
    return exportPageToSvg({
      elements: elementsRef.current,
      imageSources,
      markdownSources: sourcesRef.current,
      markdownHtml: renderedMarkdownHtml(),
      markdownFontSize: effectiveMarkdownBoxAppearance.fontSize,
      theme,
      ...(selected === undefined ? {} : { selectedIds: selected }),
      ...(region === undefined ? {} : { region }),
    });
  };
  const exportMarkdownPage = () => {
    downloadExport(
      `page-${pageId}.md`,
      linearizeMarkdownBlocks(elementsRef.current, sourcesRef.current),
      "text/markdown;charset=utf-8",
    );
  };
  const exportSvg = async () => {
    const exported = await createVisualExport();
    downloadExport(`page-${pageId}.svg`, exported.svg, "image/svg+xml;charset=utf-8");
  };
  const exportPng = async () => {
    try {
      const exported = await rasterizeSvgToPng(await createVisualExport());
      downloadExport(`page-${pageId}.png`, exported.blob, "image/png");
    } catch {
      // Keep failed exports quiet; the download itself is the user-facing action.
    }
  };
  const effectiveToolbarHeight = clampCanvasToolbarHeight(toolbarHeight);
  useImperativeHandle(
    ref,
    () => ({
      exportMarkdownPage,
      exportPng,
      exportSvg,
      openMarkdownImport: () => {
        if (!readOnlyRef.current) markdownImportRef.current?.click();
      },
    }),
    [exportMarkdownPage, exportPng, exportSvg, readOnly],
  );

  const updateLayers = (operation: typeof bringForward) => {
    if (readOnlyRef.current) return;
    onElementsChange?.(operation(elementsRef.current, effectiveSelectedIds));
  };

  const groupSelection = () => {
    if (readOnlyRef.current || effectiveSelectedIds.size < 2) return;
    const next = groupElements(elementsRef.current, effectiveSelectedIds, randomId());
    onElementsChange?.(next);
    setSelectedIds(expandGroupedSelection(next, effectiveSelectedIds));
  };

  const ungroupSelection = () => {
    if (readOnlyRef.current || !hasGroupedSelection) return;
    const next = ungroupElements(elementsRef.current, effectiveSelectedIds);
    onElementsChange?.(next);
    setSelectedIds(new Set(effectiveSelectedIds));
  };

  const setInkPreference = (
    patch: Partial<Pick<InkStyle, "color" | "width" | "opacity">>,
    kind: Extract<DrawingPaletteKind, "pen" | "highlighter"> = inkPaletteKind,
  ) => {
    if (readOnlyRef.current) return;
    const key = kind;
    const normalizedPatch: Partial<Pick<InkStyle, "color" | "width" | "opacity">> = {
      ...patch,
      ...(patch.width === undefined
        ? {}
        : { width: clampInkWidth(patch.width, kind === "highlighter") }),
    };
    updatePreferences((current) => ({
      ...current,
      [key]: { ...current[key], ...normalizedPatch },
    }));
    if (selectedInk.length > 0) {
      onElementsChange?.(
        updateSelectedInkStyle(elementsRef.current, effectiveSelectedIds, normalizedPatch),
      );
    }
  };

  const setShapePreference = (
    patch: Partial<Pick<ShapeStyle, "strokeColor" | "strokeWidth" | "fillColor" | "opacity">>,
  ) => {
    if (readOnlyRef.current) return;
    const normalizedPatch =
      patch.strokeWidth === undefined
        ? patch
        : { ...patch, strokeWidth: clampShapeWidth(patch.strokeWidth) };
    updatePreferences((current) => ({
      ...current,
      shape: { ...current.shape, ...normalizedPatch },
    }));
    if (selectedShapes.length > 0) {
      onElementsChange?.(
        updateSelectedShapeStyle(elementsRef.current, effectiveSelectedIds, normalizedPatch),
      );
    }
  };

  const positionPaletteEditor = (details: HTMLDetailsElement) => {
    const summary = details.firstElementChild;
    const menu = [...details.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.animatedMenu !== undefined,
    );
    if (!(summary instanceof HTMLElement) || menu === undefined || !fullscreen) return;
    const summaryBounds = summary.getBoundingClientRect();
    const menuWidth =
      menu.getBoundingClientRect().width || Math.min(24 * 16, window.innerWidth - 24);
    const left = Math.max(8, Math.min(summaryBounds.left, window.innerWidth - menuWidth - 8));
    details.style.setProperty("--palette-editor-left", `${left}px`);
    details.style.setProperty("--palette-editor-top", `${summaryBounds.bottom + 6}px`);
  };

  const openPaletteEditorMenu = (kind: DrawingPaletteKind) => {
    const details = paletteEditorMenuRefs.current[kind];
    if (details === null || details === undefined) return;
    if (!details.open) details.open = true;
    positionPaletteEditor(details);
    prepareAnimatedMenu(details, "opening");
  };

  const closePaletteEditorMenu = (kind: DrawingPaletteKind) => {
    const details = paletteEditorMenuRefs.current[kind];
    if (details !== null && details !== undefined) closeAnimatedMenu(details);
  };

  const togglePaletteEditorMenu = (kind: DrawingPaletteKind) => {
    const details = paletteEditorMenuRefs.current[kind];
    if (details?.open) closePaletteEditorMenu(kind);
    else openPaletteEditorMenu(kind);
  };

  const updatePalette = (
    kind: DrawingPaletteKind,
    updater: (palette: DrawingPalettePreferences) => DrawingPalettePreferences,
  ): ProfileDrawingPalettes => {
    const current = profileDrawingPalettesRef.current;
    return { ...current, [kind]: updater(current[kind]) };
  };

  const elementsForPaletteSlot = (
    kind: DrawingPaletteKind,
    slot: DrawingPaletteSlot,
  ): readonly CanvasElement[] | undefined => {
    if (kind === "pen" || kind === "highlighter") {
      return selectedInk.length === 0
        ? undefined
        : updateSelectedInkStyle(elementsRef.current, effectiveSelectedIds, {
            color: slot.color,
            width: slot.width,
            opacity: slot.opacity,
          });
    }
    const shapePatch = {
      strokeColor: slot.color,
      strokeWidth: clampShapeWidth(slot.width),
      opacity: slot.opacity,
    } satisfies Pick<ShapeStyle, "strokeColor" | "strokeWidth" | "opacity">;
    if (selectedShapes.length === 0) return undefined;
    const filledShapeIds = new Set(
      selectedShapes.filter((shape) => shape.style.fillColor !== null).map((shape) => shape.id),
    );
    let next = updateSelectedShapeStyle(elementsRef.current, effectiveSelectedIds, shapePatch);
    if (filledShapeIds.size > 0) {
      next = updateSelectedShapeStyle(next, filledShapeIds, { fillColor: slot.color });
    }
    return next;
  };

  const elementsForDefaultPaletteColor = (
    kind: DrawingPaletteKind,
    color: string,
  ): readonly CanvasElement[] | undefined => {
    if (kind === "pen" || kind === "highlighter") {
      return selectedInk.length === 0
        ? undefined
        : updateSelectedInkStyle(elementsRef.current, effectiveSelectedIds, { color });
    }
    if (selectedShapes.length === 0) return undefined;
    const filledShapeIds = new Set(
      selectedShapes.filter((shape) => shape.style.fillColor !== null).map((shape) => shape.id),
    );
    let next = updateSelectedShapeStyle(elementsRef.current, effectiveSelectedIds, {
      strokeColor: color,
    });
    if (filledShapeIds.size > 0) {
      next = updateSelectedShapeStyle(next, filledShapeIds, { fillColor: color });
    }
    return next;
  };

  const updatePreferenceForDefaultPaletteColor = (
    kind: DrawingPaletteKind,
    color: string,
  ): void => {
    if (kind === "shape") {
      updatePreferences((current) => ({
        ...current,
        shape: {
          ...current.shape,
          strokeColor: color,
          fillColor: current.shape.fillColor === null ? null : color,
        },
      }));
      return;
    }
    updatePreferences((current) => ({
      ...current,
      [kind]: { ...current[kind], color },
    }));
  };

  const updatePaletteSlot = (
    kind: DrawingPaletteKind,
    index: number,
    patch: Partial<DrawingPaletteSlot>,
    group?: string,
  ): DrawingPaletteSlot => {
    const before = snapshot();
    const nextPalettes = updatePalette(kind, (palette) => {
      const currentSlot = palette.slots[index] ?? palette.slots[0]!;
      const nextSlot: DrawingPaletteSlot = {
        color:
          patch.color !== undefined && /^#[0-9a-fA-F]{6}$/u.test(patch.color)
            ? patch.color.toLowerCase()
            : currentSlot.color,
        width:
          patch.width === undefined || !Number.isFinite(patch.width)
            ? currentSlot.width
            : kind === "shape"
              ? clampShapeWidth(patch.width)
              : clampInkWidth(patch.width, kind === "highlighter"),
        opacity:
          patch.opacity === undefined || !Number.isFinite(patch.opacity)
            ? currentSlot.opacity
            : Math.min(1, Math.max(0, patch.opacity)),
      };
      return {
        ...palette,
        slots: palette.slots.map((slot, slotIndex) => (slotIndex === index ? nextSlot : slot)),
      };
    });
    const nextPalette = nextPalettes[kind];
    const nextSlot = nextPalette.slots[index] ?? nextPalette.slots[0]!;
    const nextElements =
      nextPalette.selectedIndex === index && nextPalette.custom
        ? elementsForPaletteSlot(kind, nextSlot)
        : undefined;
    commitCanvasChange(
      before,
      {
        profileDrawingPalettes: nextPalettes,
        ...(nextElements === undefined ? {} : { elements: nextElements }),
      },
      group,
    );
    return nextSlot;
  };

  const selectPaletteSlot = (kind: DrawingPaletteKind, index: number, openEditor: boolean) => {
    if (readOnlyRef.current) return;
    const before = snapshot();
    const current = profileDrawingPalettesRef.current;
    const palette = current[kind];
    const boundedIndex = Math.min(palette.slots.length - 1, Math.max(0, Math.round(index)));
    const wasSelected = palette.selectedIndex === boundedIndex;
    const nextPalettes = updatePalette(kind, (value) => ({
      ...value,
      selectedIndex: boundedIndex,
    }));
    const nextPalette = nextPalettes[kind];
    const slot = nextPalette.slots[boundedIndex] ?? nextPalette.slots[0]!;
    let nextElements: readonly CanvasElement[] | undefined;
    if (nextPalette.custom) {
      nextElements = elementsForPaletteSlot(kind, slot);
      if (openEditor && wasSelected) togglePaletteEditorMenu(kind);
      else if (!wasSelected) closePaletteEditorMenu(kind);
    } else {
      const defaultSlot = defaultProfilePaletteSlot(kind, boundedIndex);
      updatePreferenceForDefaultPaletteColor(kind, defaultSlot.color);
      nextElements = elementsForDefaultPaletteColor(kind, defaultSlot.color);
      closePaletteEditorMenu(kind);
    }
    commitCanvasChange(
      before,
      {
        profileDrawingPalettes: nextPalettes,
        ...(nextElements === undefined ? {} : { elements: nextElements }),
      },
    );
  };

  const setPaletteCustom = (kind: DrawingPaletteKind, custom: boolean) => {
    if (readOnlyRef.current) return;
    const before = snapshot();
    const current = profileDrawingPalettesRef.current;
    const palette = current[kind];
    if (palette.custom === custom) return;
    const nextPalettes = updatePalette(kind, (value) => ({ ...value, custom }));
    const nextPalette = nextPalettes[kind];
    const selectedIndex = nextPalette.selectedIndex;
    closePaletteEditorMenu(kind);
    let nextElements: readonly CanvasElement[] | undefined;
    if (custom) {
      nextElements = elementsForPaletteSlot(
        kind,
        nextPalette.slots[selectedIndex] ?? nextPalette.slots[0]!,
      );
    } else {
      const defaultSlot = defaultProfilePaletteSlot(kind, selectedIndex);
      updatePreferenceForDefaultPaletteColor(kind, defaultSlot.color);
      nextElements = elementsForDefaultPaletteColor(kind, defaultSlot.color);
    }
    commitCanvasChange(
      before,
      {
        profileDrawingPalettes: nextPalettes,
        ...(nextElements === undefined ? {} : { elements: nextElements }),
      },
    );
  };

  const selectPaletteColor = (color: string): boolean => {
    const inkContext =
      tool === "pen" ||
      tool === "highlighter" ||
      (selectedInk.length > 0 && selectedShapes.length === 0);
    const shapeContext =
      isShapeTool(tool) || (selectedShapes.length > 0 && selectedInk.length === 0);
    const kind: DrawingPaletteKind | undefined = inkContext
      ? tool === "highlighter" || selectedInk[0]?.style.highlighter === true
        ? "highlighter"
        : "pen"
      : shapeContext
        ? "shape"
        : undefined;
    if (kind === undefined) return false;
    const palette = profileDrawingPalettesRef.current[kind];
    const colors = palette.custom ? palette.slots.map((slot) => slot.color) : INK_PALETTE;
    const index = colors.findIndex((candidate) => candidate.toLowerCase() === color.toLowerCase());
    if (index < 0) return false;
    selectPaletteSlot(kind, index, false);
    return true;
  };

  const selectRadialPaletteColor = (color: string) => {
    if (readOnlyRef.current) return;
    if (!selectPaletteColor(color)) {
      setInkPreference({ color }, "pen");
    }
    closeRadialMenu();
  };

  const radialActiveColor =
    selectedInk[0]?.style.color ??
    (selectedShapes.length > 0 ? shapeStyleForControls.strokeColor : activeInkStyle.color);

  const radialPalette = (tool === "highlighter"
    ? profileDrawingPalettes.highlighter
    : profileDrawingPalettes.pen
  ).custom
    ? (tool === "highlighter"
        ? profileDrawingPalettes.highlighter.slots
        : profileDrawingPalettes.pen.slots
      ).map((slot) => slot.color)
    : INK_PALETTE;

  const loadImageForCanvas = useCallback(
    async (asset: string): Promise<Blob> => {
      const cached = imageBlobsRef.current.get(asset);
      if (cached !== undefined) return cached;
      if (loadImageAsset === undefined) throw new Error("Image asset loading is unavailable");
      const blob = await loadImageAsset(asset);
      imageBlobsRef.current.set(asset, blob);
      return blob;
    },
    [loadImageAsset],
  );

  const copySelection = async (): Promise<string> => {
    const copyIds = expandGroupedSelection(elementsRef.current, selectedIds);
    const copiedElements = elementsByZ(elementsRef.current).filter((element) =>
      copyIds.has(element.id),
    );
    const imageData = Object.fromEntries(
      await Promise.all(
        copiedElements
          .filter((element) => element.kind === "image")
          .map(
            async (element) =>
              [element.id, await blobDataUrl(await loadImageForCanvas(element.asset))] as const,
          ),
      ),
    );
    canvasSession.clipboard = structuredClone({
      elements: copiedElements,
      sources: Object.fromEntries(
        elementsRef.current
          .filter((element) => element.kind === "markdown" && copyIds.has(element.id))
          .map((element) => [element.id, sourcesRef.current[element.id] ?? ""]),
      ),
      ...(Object.keys(imageData).length === 0 ? {} : { imageData }),
    });
    setClipboardRevision((current) => current + 1);
    return encodeClipboard(canvasSession.clipboard);
  };
  const pasteSelection = async () => {
    if (readOnlyRef.current) return;
    const copied = canvasSession.clipboard;
    if (!copied || copied.elements.length === 0) return;
    const before = snapshot();
    const result = duplicateElements(
      copied.elements,
      new Set(copied.elements.map((element) => element.id)),
      () => randomId(),
    );
    let next = elementsRef.current;
    const duplicatedIds = [...result.duplicatedIds];
    for (let index = 0; index < duplicatedIds.length; index += 1) {
      const id = duplicatedIds[index] as string;
      let copy = result.elements.find((element) => element.id === id)!;
      const original = copied.elements[index]!;
      if (original.kind === "markdown") {
        const source = copied.sources[original.id] ?? "";
        sourcesRef.current = { ...sourcesRef.current, [id]: source };
        emitSource?.(id, source);
      }
      if (original.kind === "image" && copy.kind === "image") {
        const data = copied.imageData?.[original.id];
        if (data !== undefined) {
          if (saveImageAsset === undefined) throw new Error("Image asset storage is unavailable");
          copy = { ...copy, asset: await saveImageAsset(await (await fetch(data)).blob()) };
        }
      }
      next = insertElement(next, copy);
    }
    elementsRef.current = next;
    canvasHistory.record(pageId, before, snapshot());
    emitElements?.(next);
    setSelectedIds(result.duplicatedIds);
  };
  const handlePaste = (event: ClipboardEvent) => {
    if (readOnlyRef.current || isEditableTarget(event.target)) return;
    const pendingCopy = pendingClipboardCopyRef.current;
    const clipboardData = event.clipboardData;
    if (clipboardData === null) {
      if (pendingCopy !== undefined || canvasSession.clipboard !== undefined) {
        event.preventDefault();
        void (pendingCopy ?? Promise.resolve()).then(() => pasteSelection()).catch(() => undefined);
      }
      return;
    }
    const clipboardText = clipboardData.getData("text/plain");
    if (pendingCopy !== undefined) {
      event.preventDefault();
      void pendingCopy.then(() => pasteSelection()).catch(() => undefined);
      return;
    }
    const copied = decodeClipboard(clipboardText);
    if (copied !== undefined) {
      event.preventDefault();
      canvasSession.clipboard = copied;
      void pasteSelection();
      return;
    }
    const item = [...clipboardData.items].find(
      (candidate) => candidate.kind === "file" && isSupportedClipboardImageType(candidate.type),
    );
    const file =
      item?.getAsFile() ??
      [...clipboardData.files].find((candidate) => isSupportedClipboardImageType(candidate.type));
    if (file !== undefined) {
      event.preventDefault();
      void addImageFromClipboard(file);
      return;
    }
    if (
      pendingCopy !== undefined ||
      (clipboardText === "" && canvasSession.clipboard !== undefined)
    ) {
      event.preventDefault();
      void (pendingCopy ?? Promise.resolve()).then(() => pasteSelection()).catch(() => undefined);
    }
  };
  useEffect(() => {
    const handleWindowPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      handlePaste(event);
    };
    window.addEventListener("paste", handleWindowPaste);
    return () => window.removeEventListener("paste", handleWindowPaste);
  });
  const duplicateSelection = () => {
    if (readOnlyRef.current) return;
    const saved = canvasSession.clipboard;
    void copySelection()
      .then(() => pasteSelection())
      .finally(() => {
        canvasSession.clipboard = saved;
      });
  };
  const cutSelection = async (): Promise<string | undefined> => {
    if (readOnlyRef.current) return;
    const text = await copySelection();
    onElementsChange(deleteElements(elementsRef.current, effectiveSelectedIds));
    setSelectedIds(new Set());
    return text;
  };

  const positionShapeMenu = (details: HTMLDetailsElement) => {
    const bounds = details.getBoundingClientRect();
    const menuWidth = 13 * 16;
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - menuWidth - 8));
    details.style.setProperty("--canvas-tool-menu-left", `${left}px`);
    details.style.setProperty("--canvas-tool-menu-top", `${bounds.bottom + 6}px`);
  };
  const positionMiscellaneousMenu = (details: HTMLDetailsElement) => {
    const bounds = details.getBoundingClientRect();
    const menuWidth = 13 * 16;
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - menuWidth - 8));
    details.style.setProperty("--canvas-tool-menu-left", `${left}px`);
    details.style.setProperty("--canvas-tool-menu-top", `${bounds.bottom + 6}px`);
  };
  useEffect(() => {
    const repositionMiscellaneousMenu = () => {
      const details = miscellaneousMenuRef.current;
      if (details === null || !details.open) return;
      positionMiscellaneousMenu(details);
      refreshAnimatedMenuOrigin(details);
    };
    window.addEventListener("resize", repositionMiscellaneousMenu);
    window.visualViewport?.addEventListener("resize", repositionMiscellaneousMenu);
    return () => {
      window.removeEventListener("resize", repositionMiscellaneousMenu);
      window.visualViewport?.removeEventListener("resize", repositionMiscellaneousMenu);
    };
  }, []);
  const positionMarkdownStyleMenu = useCallback((details: HTMLDetailsElement) => {
    const summary = details.firstElementChild;
    const menu = [...details.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.animatedMenu !== undefined,
    );
    if (!(summary instanceof HTMLElement) || menu === undefined) return;

    const summaryBounds = summary.getBoundingClientRect();
    const previousAnimation = menu.style.animation;
    const previousTransform = menu.style.transform;
    menu.style.animation = "none";
    menu.style.transform = "none";
    const menuWidth =
      menu.getBoundingClientRect().width || Math.min(46 * 16, window.innerWidth - 24);
    menu.style.animation = previousAnimation;
    menu.style.transform = previousTransform;
    const left = Math.max(8, Math.min(summaryBounds.left, window.innerWidth - menuWidth - 8));
    details.style.setProperty("--markdown-style-editor-left", `${left}px`);
    details.style.setProperty("--markdown-style-editor-top", `${summaryBounds.bottom + 6}px`);
  }, []);
  useEffect(() => {
    const repositionMarkdownStyleMenu = () => {
      const details = markdownStyleMenuRef.current;
      if (details === null || !details.open) return;
      positionMarkdownStyleMenu(details);
      refreshAnimatedMenuOrigin(details);
    };
    window.addEventListener("resize", repositionMarkdownStyleMenu);
    window.addEventListener("scroll", repositionMarkdownStyleMenu, true);
    window.visualViewport?.addEventListener("resize", repositionMarkdownStyleMenu);
    window.visualViewport?.addEventListener("scroll", repositionMarkdownStyleMenu);
    return () => {
      window.removeEventListener("resize", repositionMarkdownStyleMenu);
      window.removeEventListener("scroll", repositionMarkdownStyleMenu, true);
      window.visualViewport?.removeEventListener("resize", repositionMarkdownStyleMenu);
      window.visualViewport?.removeEventListener("scroll", repositionMarkdownStyleMenu);
    };
  }, [positionMarkdownStyleMenu]);
  const handleMarkdownHeightChange = (
    element: Extract<CanvasElement, { kind: "markdown" }>,
    bounds: CanvasBounds,
    height: number,
  ) => {
    if (
      readOnlyRef.current ||
      manualMarkdownHeightRef.current.has(element.id) ||
      height <= element.height + 1
    ) {
      return;
    }
    emitElements?.(
      resizeElement(elementsRef.current, element.id, {
        ...bounds,
        height,
      }),
    );
  };
  const radialMenuOverlay = (
    <CanvasRadialToolbar
      radialMenu={radialMenu}
      overlayZIndex={laserZIndex + 2}
      readOnly={readOnly}
      tool={tool === "picture-in-picture" ? previousDrawingToolRef.current : tool}
      radialPalette={radialPalette}
      radialActiveColor={radialActiveColor}
      radialSectorGlow={radialSectorGlow}
      onSectorGlowChange={setRadialSectorGlow}
      onToolChange={setTool}
      onColorChange={selectRadialPaletteColor}
      onClose={closeRadialMenu}
    />
  );
  return (
    <div className="spatial-canvas-frame">
      <input
        ref={markdownImportRef}
        className="visually-hidden"
        type="file"
        accept=".md,text/markdown,text/plain"
        onChange={(event) => void handleMarkdownImport(event)}
      />
      {!presentationOnly && (
        <CanvasToolbar
          fullscreen={fullscreen}
          readOnly={readOnly}
          allowLaserPointer={allowLaserPointer}
          toolbarHeight={effectiveToolbarHeight}
          tool={tool}
          preferences={preferences}
          selectedInk={selectedInk}
          selectedShapes={selectedShapes}
          activeInkStyle={activeInkStyle}
          activeShapeStyle={activeShapeStyle}
          inkPaletteKind={inkPaletteKind}
          inkPaletteForControls={inkPaletteForControls}
          shapePaletteForControls={shapePaletteForControls}
          shapePaletteSlot={shapePaletteSlot}
          shapeStyleForControls={shapeStyleForControls}
          shapeStrokeWidthForControls={shapeStrokeWidthForControls}
          inkWidthMin={inkWidthMin}
          inkWidthMax={inkWidthMax}
          inkWidthStep={inkWidthStep}
          inkWidthForControls={inkWidthForControls}
          inkDimensionLabel={inkDimensionLabel}
          inkDimensionAriaLabel={inkDimensionAriaLabel}
          eraserWidthForControls={effectiveEraserWidth}
          hasGroupedSelection={hasGroupedSelection}
          markdownColorStyles={effectiveMarkdownColorStyles}
          markdownSearchControlled={controlledMarkdownSearchQuery !== undefined}
          markdownSearchInputRef={markdownSearchInputRef}
          markdownSearchQuery={markdownSearchQuery}
          markdownSearchMatchCount={markdownSearch.matches.length}
          markdownSearchActiveIndex={activeMarkdownSearchIndex}
          history={{
            canUndo: canvasHistory.canUndo(pageId),
            canRedo: canvasHistory.canRedo(pageId),
          }}
          hasClipboard={canvasSession.clipboard !== undefined}
          selectedCount={effectiveSelectedIds.size}
          shapeMenuRef={shapeMenuRef}
          miscellaneousMenuRef={miscellaneousMenuRef}
          markdownStyleMenuRef={markdownStyleMenuRef}
          paletteEditorMenuRefs={paletteEditorMenuRefs}
          onToolChange={setTool}
          onMarkdownColorStylesChange={updateMarkdownColorStyles}
          onDeleteMarkdownStyle={deleteMarkdownStyle}
          onMarkdownSearchQueryChange={(query) => {
            setMarkdownSearchQuery(query);
            setActiveMarkdownSearchIndex(0);
          }}
          onMoveMarkdownSearch={moveMarkdownSearch}
          onUpdatePreferences={updatePreferences}
          onSetPaletteCustom={setPaletteCustom}
          onSelectPaletteSlot={selectPaletteSlot}
          onSetInkPreference={(patch) => setInkPreference(patch)}
          onSetShapePreference={setShapePreference}
          onUpdatePaletteSlot={updatePaletteSlot}
          onClosePaletteEditorMenu={closePaletteEditorMenu}
          onPositionPaletteEditor={positionPaletteEditor}
          onPositionShapeMenu={positionShapeMenu}
          onPositionMiscellaneousMenu={positionMiscellaneousMenu}
          onPositionMarkdownStyleMenu={positionMarkdownStyleMenu}
          onSendToBack={() => updateLayers(sendToBack)}
          onSendBackward={() => updateLayers(sendBackward)}
          onBringForward={() => updateLayers(bringForward)}
          onBringToFront={() => updateLayers(bringToFront)}
          onGroupSelection={groupSelection}
          onUngroupSelection={ungroupSelection}
          onCopySelection={copySelection}
          onPasteSelection={pasteSelection}
          onTravelHistory={travelHistory}
          onFullscreenChange={(next) => onFullscreenChange?.(next)}
        />
      )}
      <div className="canvas-viewport">
      <div
        ref={surfaceRef}
        className={`spatial-canvas page-background-${pageBackground} ${fullscreen ? "is-fullscreen" : ""} ${isPanning ? "is-panning" : ""} ${radialMenu !== undefined ? "is-radial-menu-open" : ""} ${palmRejectionActive ? "is-palm-rejection" : ""} ${palmRejectionActive && touchOverrideHeld ? "is-touch-unlocked" : ""} ${readOnly ? `read-only ${tool === "laser" ? "tool-laser" : "tool-pan"}` : `tool-${tool}`}`}
        style={{
          backgroundPosition:
            pageBackground === "ruled" ? `0 ${camera.y}px` : `${camera.x}px ${camera.y}px`,
          ...(backgroundSize === undefined ? {} : { backgroundSize }),
        }}
        tabIndex={presentationOnly ? -1 : 0}
        aria-label={
          presentationOnly
            ? "Picture-in-picture canvas view"
            : readOnly
              ? "Read-only page canvas"
              : "Infinite page canvas"
        }
        onKeyDown={(event) => {
          if (readOnlyRef.current || isEditableTarget(event.target)) return;
          const command = event.ctrlKey || event.metaKey;
          const key = event.key.toLowerCase();
          if (command && ["z", "y", "a"].includes(key)) {
            event.preventDefault();
            if (key === "z" || key === "y") travelHistory(key === "y" || event.shiftKey);
            if (key === "a")
              setSelectedIds(new Set(elementsRef.current.map((element) => element.id)));
            return;
          }
          const selectedId =
            effectiveSelectedIds.size === 1 ? [...effectiveSelectedIds][0] : undefined;
          const selected = elementsRef.current.find((element) => element.id === selectedId);
          if (event.key === "Enter" && selected?.kind === "markdown") {
            event.preventDefault();
            setEditingMarkdownId(selected.id);
          } else if (
            (event.key === "Delete" || event.key === "Backspace") &&
            effectiveSelectedIds.size > 0
          ) {
            event.preventDefault();
            onElementsChange?.(deleteElements(elementsRef.current, effectiveSelectedIds));
            setSelectedIds(new Set());
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
            event.preventDefault();
            duplicateSelection();
          }
        }}
        onCopy={(event) => {
          if (isEditableTarget(event.target) || effectiveSelectedIds.size === 0) return;
          event.preventDefault();
          const copy = copySelection()
            .then((text) => navigator.clipboard.writeText(text))
            .catch(() => undefined);
          pendingClipboardCopyRef.current = copy;
          void copy.finally(() => {
            if (pendingClipboardCopyRef.current === copy) {
              pendingClipboardCopyRef.current = undefined;
            }
          });
        }}
        onCut={(event) => {
          if (
            readOnlyRef.current ||
            isEditableTarget(event.target) ||
            effectiveSelectedIds.size === 0
          )
            return;
          event.preventDefault();
          void cutSelection().then((text) =>
            text === undefined ? undefined : navigator.clipboard.writeText(text),
          );
        }}
        onPaste={(event) => {
          handlePaste(event.nativeEvent);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onDragStart={(event) => {
          if (!isEditableTarget(event.target)) event.preventDefault();
        }}
        onLostPointerCapture={handlePointerCancel}
        onPointerCancel={handlePointerCancel}
        onPointerDownCapture={handleBlockedTouchCapture}
        onPointerDown={handlePointerDown}
        onPointerEnter={(event) => {
          updateCursor(localPoint(event.clientX, event.clientY), event.pointerType);
        }}
        onPointerLeave={() => setCursorVisible(false)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleMarkdownFragmentClick}
        onWheel={(event) => {
          if (isEditableTarget(event.target)) return;
          const textBox =
            event.target instanceof Element ? event.target.closest(".markdown-block") : null;
          if (
            !spaceHeldRef.current &&
            textBox !== null &&
            (textBox.scrollHeight > textBox.clientHeight ||
              textBox.scrollWidth > textBox.clientWidth)
          )
            return;
          event.preventDefault();
          if (spaceHeldRef.current) {
            const horizontalWheelDelta = event.shiftKey
              ? event.deltaX || event.deltaY
              : event.deltaX;
            const deltaX = horizontalWheelDelta *
              (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientWidth : 1);
            const deltaY = (event.shiftKey ? 0 : event.deltaY) *
              (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientHeight : 1);
            setCamera((value) => panCamera(value, { x: -deltaX, y: -deltaY }));
            return;
          }
          const point = localPoint(event.clientX, event.clientY);
          setCamera((value) =>
            zoomCameraAt(value, point, value.zoom * Math.exp(-event.deltaY * 0.0015)),
          );
          updateCursor(point);
        }}
      >
        <div className="canvas-interaction-plane" aria-hidden="true" />
        <div className="canvas-origin" style={{ transform }} aria-hidden="true" />
        {activePictureInPicture !== undefined && (
          <svg
            className="canvas-picture-in-picture-preview"
            style={{ transform, transformOrigin: "0 0" }}
            aria-hidden="true"
          >
            <rect
              {...normalizedBounds(activePictureInPicture.start, activePictureInPicture.end)}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        <CanvasElementLayer
          pageId={pageId}
          transform={transform}
          visibleTextBoxGroups={visibleTextBoxGroups}
          visibleElements={visibleElements}
          visibleSelectedElements={visibleSelectedElements}
          selectedElements={selectedElements}
          displayElements={displayElements}
          effectiveSelectedIds={effectiveSelectedIds}
          selectedTextGroupId={selectedTextGroupId}
          cursorVisible={cursorVisible}
          cursorWorld={cursorWorld}
          textGroupDropTargetId={textGroupDropTargetId}
          selectionZIndex={selectionZIndex}
          readOnly={readOnly}
          dimmedElementIds={dimmedElementIds}
          tool={tool === "picture-in-picture" ? previousDrawingToolRef.current : tool}
          hoveredId={hoveredId}
          effectiveEditingMarkdownId={effectiveEditingMarkdownId}
          markdownSearchBlocks={markdownSearchBlocks}
          activeMarkdownSearchElementId={activeMarkdownSearchElementId}
          activeMarkdownSearchMatch={activeMarkdownSearchMatch}
          markdownSearchQuery={markdownSearchQuery}
          effectiveMarkdownBoxAppearance={effectiveMarkdownBoxAppearance}
          effectiveMarkdownColorStyles={effectiveMarkdownColorStyles}
          theme={theme}
          markdownSources={markdownSources}
          surfaceRef={surfaceRef}
          editorOverlayRef={editorOverlayRef}
          elementsRef={elementsRef}
          cameraRef={cameraRef}
          gestureHistoryRef={gestureHistoryRef}
          resizeDragRef={resizeDragRef}
          elementDragRef={elementDragRef}
          localPoint={localPoint}
          setSelectedTextGroupId={setSelectedTextGroupId}
          setSelectedIds={setSelectedIds}
          setHoveredId={setHoveredId}
          setEditingMarkdownId={setEditingMarkdownId}
          sourcesRef={sourcesRef}
          onMarkdownSourceChange={onMarkdownSourceChange}
          commitMarkdown={commitMarkdown}
          removeMarkdown={removeMarkdown}
          beginMarkdownEditing={beginMarkdownEditing}
          createTextGroup={createTextGroup}
          addTextGroupBlock={addTextGroupBlock}
          detachTextGroupBlock={detachTextGroupBlock}
          changeMarkdownStyle={changeMarkdownStyle}
          onMarkdownHeightChange={handleMarkdownHeightChange}
          {...(loadImageAsset === undefined ? {} : { loadImageForCanvas })}
          activeInkPreviewRef={activeInkPreviewRef}
          activeInkPreviewSvgRef={activeInkPreviewSvgRef}
          activeInkPreviewPathRef={activeInkPreviewPathRef}
          activeShape={activeShape}
          activePath={activePath}
          activeSpace={activeSpace}
          visibleWorldBounds={visibleWorldBounds}
          cameraZoom={camera.zoom}
          remoteLaserPointers={remoteLaserPointers}
          localLaserPointers={localLaserPointers}
          laserPointerDecaySeconds={laserPointerDecaySeconds}
          laserZIndex={laserZIndex}
        >
          {children}
        </CanvasElementLayer>
        {activePath?.kind === "eraser" && (
          <svg
            className="canvas-path-preview canvas-eraser-trace kind-eraser"
            style={{ transform, transformOrigin: "0 0", zIndex: laserZIndex + 1 }}
            aria-hidden="true"
          >
            <path
              d={canvasPointsToSvgPath(activePath.points, false)}
              fill="none"
              stroke="var(--app-accent)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={effectiveEraserWidth}
            />
          </svg>
        )}
        {(tool === "pen" || tool === "highlighter" || tool === "eraser" || tool === "laser") && (
          <CanvasInkToolCursor
            position={cursorViewport}
            style={activeInkStyle}
            tool={tool}
            visible={cursorVisible}
            zoom={camera.zoom}
            zIndex={laserZIndex + 1}
            eraserWidth={effectiveEraserWidth}
          />
        )}
        {palmRejectionActive && (
          <button
            className={
              touchOverrideHeld ? "canvas-touch-override is-held" : "canvas-touch-override"
            }
            type="button"
            aria-label="Hold to enable canvas touch interactions"
            aria-pressed={touchOverrideHeld}
            title="Hold to enable canvas touch interactions for panning or zooming"
            onPointerCancel={handleTouchOverridePointerEnd}
            onPointerDown={handleTouchOverridePointerDown}
            onPointerMove={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerUp={handleTouchOverridePointerEnd}
            onLostPointerCapture={handleTouchOverridePointerEnd}
            onKeyDown={handleTouchOverrideKeyDown}
            onKeyUp={handleTouchOverrideKeyUp}
            onBlur={() => {
              if (touchOverridePointerIdRef.current === undefined) releaseTouchOverride();
            }}
            onMouseDown={preventTouchOverrideSelection}
            onTouchStart={handleTouchOverrideTouchStart}
            onTouchMove={preventTouchOverrideSelection}
            onTouchEnd={handleTouchOverrideTouchEnd}
            onContextMenu={preventTouchOverrideSelection}
            onDragStart={preventTouchOverrideSelection}
            onSelect={preventTouchOverrideSelection}
            draggable={false}
          />
        )}
        {radialMenuOverlay}
      </div>
      <div ref={editorOverlayRef} className={`canvas-screen-overlay ${fullscreen ? "is-fullscreen" : ""}`}>
        {!presentationOnly && (
          <div className="canvas-status">
            <span aria-label="Cursor world coordinates">
              ({Math.round(cursorWorld.x)}, {Math.round(cursorWorld.y)})
            </span>
            <span aria-hidden="true"> | </span>
            <output aria-label="Zoom level">{Math.round(camera.zoom * 100)}%</output>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function normalizedBounds(start: Point, end: Point): Bounds {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable='true'], [data-canvas-editor='active']",
    ) !== null
  );
}

function isCanvasHistoryControl(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.type !== "text" &&
    target.closest(".palette-editor, .markdown-style-editor") !== null
  );
}

function findMarkdownFragmentTarget(
  anchor: HTMLAnchorElement,
  surface: HTMLDivElement,
  href: string,
): HTMLElement | undefined {
  const encodedId = href.slice(1);
  if (encodedId.length === 0) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return undefined;
  }

  const markdownContent = anchor.closest<HTMLElement>(".markdown-content");
  const localTarget = [...(markdownContent?.querySelectorAll<HTMLElement>("[id]") ?? [])].find(
    (element) => element.id === id,
  );
  if (localTarget !== undefined) return localTarget;
  return [...surface.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === id);
}

function surfacePointScale(surface: HTMLDivElement | null, rect: DOMRect | undefined): Point {
  if (surface === null || rect === undefined || rect.width <= 0 || rect.height <= 0) {
    return { x: 1, y: 1 };
  }
  return {
    x: surface.clientWidth > 0 ? surface.clientWidth / rect.width : 1,
    y: surface.clientHeight > 0 ? surface.clientHeight / rect.height : 1,
  };
}

function gestureStart(pointers: readonly PointerSample[], camera: Camera) {
  const first = pointers[0] as Point;
  const second = pointers[1] as Point;
  return { camera, center: midpoint(first, second), distance: distance(first, second) };
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function combinedBounds(elements: readonly CanvasElement[]): Bounds | undefined {
  if (elements.length === 0) return undefined;
  const bounds = elements.map(elementBounds);
  const minX = Math.min(...bounds.map((value) => value.x));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxX = Math.max(...bounds.map((value) => value.x + value.width));
  const maxY = Math.max(...bounds.map((value) => value.y + value.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pointNearBounds(point: Point, bounds: CanvasBounds, padding: number): boolean {
  return boundsContainPoint(
    {
      x: bounds.x - padding,
      y: bounds.y - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    },
    point,
  );
}

function isAttachableTextBox(element: CanvasElement | undefined): boolean {
  return (
    element?.kind === "markdown" &&
    element.textGroupId === undefined &&
    element.groupId === undefined
  );
}

function textBoxGroupAtPoint(
  groups: readonly { readonly id: string; readonly bounds: CanvasBounds }[],
  point: Point,
): string | undefined {
  return groups.find((group) => boundsContainPoint(group.bounds, point))?.id;
}

function withoutGroupedTextBoxes(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    elements
      .filter((element) => ids.has(element.id))
      .filter((element) => !(element.kind === "markdown" && element.textGroupId !== undefined))
      .map((element) => element.id),
  );
}

function expandLassoSelection(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): ReadonlySet<string> {
  const selected = elements.find((element) => ids.has(element.id));
  if (ids.size === 1 && selected?.kind === "markdown" && selected.textGroupId !== undefined) {
    return new Set(ids);
  }
  const expanded = expandGroupedSelection(elements, ids);
  return new Set(
    [...expanded].filter((id) => {
      const element = elements.find((candidate) => candidate.id === id);
      return (
        element === undefined ||
        element.kind !== "markdown" ||
        element.textGroupId === undefined ||
        ids.has(id)
      );
    }),
  );
}

function filterMixedTextBoxSelection(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): ReadonlySet<string> {
  const selected = elements.filter((element) => ids.has(element.id));
  if (selected.length <= 1) return new Set(ids);
  return new Set(
    selected
      .filter((element) => !(element.kind === "markdown" && element.textGroupId !== undefined))
      .map((element) => element.id),
  );
}

function resizeBoundsForHandle(
  bounds: CanvasBounds,
  handle: ResizeHandle,
  delta: Point,
  minimumHeight: number,
): CanvasBounds {
  const minimumWidth = 24;
  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width;
  let height = bounds.height;

  if (handle.includes("w")) {
    const applied = Math.min(delta.x, Math.max(0, bounds.width - minimumWidth));
    x += applied;
    width -= applied;
  } else if (handle.includes("e")) {
    width = Math.max(minimumWidth, bounds.width + delta.x);
  }
  if (handle.includes("n")) {
    const applied = Math.min(delta.y, Math.max(0, bounds.height - minimumHeight));
    y += applied;
    height -= applied;
  } else if (handle.includes("s")) {
    height = Math.max(minimumHeight, bounds.height + delta.y);
  }

  return { x, y, width, height };
}

function createElement(
  kind: "markdown",
  id: string,
  position: Point,
  markdownStyleId?: string,
): CanvasElement {
  const shared = {
    id,
    position: [canonicalCoordinate(position.x), canonicalCoordinate(position.y)] as const,
    z: 0,
  };
  return {
    ...shared,
    kind,
    width: 280,
    height: 140,
    source: `markdown/${id}.md`,
    ...(markdownStyleId === undefined ? {} : { markdownStyleId }),
  };
}

function createImageElement(
  id: string,
  position: Point,
  image: ClipboardImage,
  asset: string,
): CanvasElement {
  return {
    id,
    kind: "image",
    position: [canonicalCoordinate(position.x), canonicalCoordinate(position.y)],
    z: 0,
    width: canonicalCoordinate(image.width),
    height: canonicalCoordinate(image.height),
    asset,
  };
}

function appendDistinctSamples(
  current: readonly InkPoint[],
  additions: readonly InkPoint[],
): readonly InkPoint[] {
  const result = [...current];
  for (const sample of additions) {
    const previous = result[result.length - 1];
    if (previous?.[0] === sample[0] && previous[1] === sample[1]) {
      continue;
    }
    result.push(sample);
  }
  return result;
}

function appendMovedSamples(
  current: readonly InkPoint[],
  additions: readonly InkPoint[],
): readonly InkPoint[] {
  const result = [...current];
  for (const sample of additions) {
    const previous = result[result.length - 1];
    if (previous?.[0] === sample[0] && previous[1] === sample[1]) continue;
    result.push(sample);
  }
  return result;
}

function appendDistinctPoints(
  current: readonly Point[],
  additions: readonly Point[],
): readonly Point[] {
  const result = [...current];
  for (const point of additions) {
    const previous = result[result.length - 1];
    if (previous?.x !== point.x || previous.y !== point.y) result.push(point);
  }
  return result;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image asset"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Image asset did not produce a data URL"));
    reader.readAsDataURL(blob);
  });
}

function appendLaserPoint(current: readonly Point[], point: Point): readonly Point[] {
  const next = [...current, point];
  if (next.length <= MAX_LASER_TRACE_POINTS) return next;
  const compacted = next.filter((_, index) => index % 2 === 0);
  if (compacted[compacted.length - 1] !== point) compacted.push(point);
  return compacted;
}

function toolForShortcut(key: string): Tool | undefined {
  switch (key) {
    case "s":
      return "select";
    case "t":
      return "text";
    case "p":
      return "pen";
    case "h":
      return "highlighter";
    case "e":
      return "eraser";
    case "l":
      return "laser";
    case "m":
      return "pan";
    default:
      return undefined;
  }
}

function keyboardPanDelta(key: string): Point | undefined {
  switch (key) {
    case "ArrowLeft":
      return { x: 1, y: 0 };
    case "ArrowRight":
      return { x: -1, y: 0 };
    case "ArrowUp":
      return { x: 0, y: 1 };
    case "ArrowDown":
      return { x: 0, y: -1 };
    default:
      return undefined;
  }
}
