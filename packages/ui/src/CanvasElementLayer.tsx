import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import type {
  CanvasBounds,
  CanvasElement,
  InkCanvasRecord,
  InkStyle,
  MarkdownCanvasRecord,
  MarkdownBoxAppearance,
  MarkdownColorStyleLibrary,
  ShapeCanvasRecord,
} from "@squillpad/core-model";
import {
  boundsContainPoint,
  elementBounds,
  expandGroupedSelection,
  isResizableElement,
  textBoxGroupInsertionY,
  textBoxGroupMemberIds,
} from "@squillpad/core-model";

import type { Camera, Point } from "./canvas-camera";
import { viewportToWorld } from "./canvas-camera";
import { MarkdownBlock } from "./MarkdownBlock";
import { normalizeMarkdownBlockHeight } from "./markdown-layout";
import type { MarkdownSearchBlock, MarkdownSearchMatch } from "./markdown-search";
import { outlineToSvgPath, renderInkPath, strokeOutline } from "./ink-engine";
import { randomId } from "./random-id";
import type { LaserPointer } from "./canvas-types";

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface ResizeDragShape {
  readonly bounds: CanvasBounds;
  readonly elementId: string;
  readonly handle: ResizeHandle;
  readonly pointerId: number;
  readonly point: Point;
}

export const RESIZE_HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export interface CanvasElementLayerProps {
  readonly transform: string;
  readonly visibleTextBoxGroups: readonly { readonly id: string; readonly bounds: CanvasBounds }[];
  readonly visibleElements: readonly CanvasElement[];
  readonly visibleSelectedElements: readonly CanvasElement[];
  readonly selectedElements: readonly CanvasElement[];
  readonly displayElements: readonly CanvasElement[];
  readonly effectiveSelectedIds: ReadonlySet<string>;
  readonly selectedTextGroupId: string | undefined;
  readonly cursorVisible: boolean;
  readonly cursorWorld: Point;
  readonly textGroupDropTargetId: string | undefined;
  readonly selectionZIndex: number;
  readonly readOnly: boolean;
  readonly dimmedElementIds: ReadonlySet<string> | undefined;
  readonly tool: string;
  readonly hoveredId: string | undefined;
  readonly effectiveEditingMarkdownId: string | undefined;
  readonly markdownSearchBlocks: ReadonlyMap<string, MarkdownSearchBlock>;
  readonly activeMarkdownSearchElementId: string | undefined;
  readonly activeMarkdownSearchMatch: MarkdownSearchMatch | undefined;
  readonly markdownSearchQuery: string;
  readonly effectiveMarkdownBoxAppearance: MarkdownBoxAppearance;
  readonly effectiveMarkdownColorStyles: MarkdownColorStyleLibrary;
  readonly theme: "light" | "dark";
  readonly markdownSources: Readonly<Record<string, string>>;
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly elementsRef: MutableRefObject<readonly CanvasElement[]>;
  readonly cameraRef: MutableRefObject<Camera>;
  readonly gestureHistoryRef: MutableRefObject<string | undefined>;
  readonly resizeDragRef: MutableRefObject<ResizeDragShape | undefined>;
  readonly elementDragRef: MutableRefObject<
    | {
        readonly ids: ReadonlySet<string>;
        readonly pointerId: number;
        readonly point: Point;
        readonly attachableMarkdownId?: string;
        readonly textGroupMarkdownId?: string;
      }
    | undefined
  >;
  readonly localPoint: (clientX: number, clientY: number) => Point;
  readonly setSelectedTextGroupId: Dispatch<SetStateAction<string | undefined>>;
  readonly setSelectedIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setHoveredId: Dispatch<SetStateAction<string | undefined>>;
  readonly setEditingMarkdownId: Dispatch<SetStateAction<string | undefined>>;
  readonly sourcesRef: MutableRefObject<Readonly<Record<string, string>>>;
  readonly onMarkdownSourceChange?: (elementId: string, source: string) => void;
  readonly commitMarkdown: (elementId: string, source: string) => void;
  readonly removeMarkdown: (elementId: string) => void;
  readonly beginMarkdownEditing: (elementId: string) => void;
  readonly createTextGroup: (elementId: string) => void;
  readonly addTextGroupBlock: (elementId: string) => void;
  readonly detachTextGroupBlock: (elementId: string) => void;
  readonly changeMarkdownStyle: (elementId: string, styleId: string | undefined) => void;
  readonly onMarkdownHeightChange: (
    element: MarkdownCanvasRecord,
    bounds: CanvasBounds,
    height: number,
  ) => void;
  readonly loadImageForCanvas?: (asset: string) => Promise<Blob>;
  readonly activeInkPreviewRef: RefObject<HTMLDivElement | null>;
  readonly activeInkPreviewSvgRef: RefObject<SVGSVGElement | null>;
  readonly activeInkPreviewPathRef: RefObject<SVGPathElement | null>;
  readonly activeShape: ShapeCanvasRecord | undefined;
  readonly activePath:
    | { readonly kind: "eraser" | "lasso"; readonly points: readonly Point[] }
    | undefined;
  readonly activeSpace: { readonly cutY: number; readonly distance: number } | undefined;
  readonly visibleWorldBounds: CanvasBounds;
  readonly cameraZoom: number;
  readonly children?: ReactNode;
  readonly remoteLaserPointers: readonly LaserPointer[];
  readonly localLaserPointers: readonly LaserPointer[];
  readonly laserPointerDecaySeconds: number;
  readonly laserZIndex: number;
}

const LASER_POINTER_TIP_RADIUS = 5;

export function CanvasElementLayer({
  transform,
  visibleTextBoxGroups,
  visibleElements,
  visibleSelectedElements,
  selectedElements,
  displayElements,
  effectiveSelectedIds,
  selectedTextGroupId,
  cursorVisible,
  cursorWorld,
  textGroupDropTargetId,
  selectionZIndex,
  readOnly,
  dimmedElementIds,
  tool,
  hoveredId,
  effectiveEditingMarkdownId,
  markdownSearchBlocks,
  activeMarkdownSearchElementId,
  activeMarkdownSearchMatch,
  markdownSearchQuery,
  effectiveMarkdownBoxAppearance,
  effectiveMarkdownColorStyles,
  theme,
  markdownSources,
  surfaceRef,
  elementsRef,
  cameraRef,
  gestureHistoryRef,
  resizeDragRef,
  elementDragRef,
  localPoint,
  setSelectedTextGroupId,
  setSelectedIds,
  setHoveredId,
  setEditingMarkdownId,
  sourcesRef,
  onMarkdownSourceChange,
  commitMarkdown,
  removeMarkdown,
  beginMarkdownEditing,
  createTextGroup,
  addTextGroupBlock,
  detachTextGroupBlock,
  changeMarkdownStyle,
  onMarkdownHeightChange,
  loadImageForCanvas,
  activeInkPreviewRef,
  activeInkPreviewSvgRef,
  activeInkPreviewPathRef,
  activeShape,
  activePath,
  activeSpace,
  visibleWorldBounds,
  cameraZoom,
  children,
  remoteLaserPointers,
  localLaserPointers,
  laserPointerDecaySeconds,
  laserZIndex,
}: CanvasElementLayerProps) {
  return (
    <div className="canvas-world" style={{ transform }}>
      {visibleTextBoxGroups.map((group) => (
        <div
          key={`text-group-${group.id}`}
          className={`canvas-text-box-group${selectedTextGroupId === group.id ? " is-selected" : ""}${cursorVisible && pointNearBounds(cursorWorld, group.bounds, 24) ? " is-pointer-near" : ""}${textGroupDropTargetId === group.id ? " is-drop-target" : ""}`}
          style={{
            left: group.bounds.x,
            top: group.bounds.y,
            width: group.bounds.width,
            height: group.bounds.height,
            zIndex: selectionZIndex,
          }}
        >
          {!readOnly && tool === "select" && (
            <button
              type="button"
              className="canvas-text-box-group-handle"
              aria-label="Select and move text box group"
              title="Select and move text box group; drop a text box here to attach it"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const ids = expandGroupedSelection(
                  elementsRef.current,
                  textBoxGroupMemberIds(elementsRef.current, group.id),
                );
                setSelectedTextGroupId(group.id);
                setSelectedIds(ids);
                gestureHistoryRef.current = randomId();
                const point = viewportToWorld(
                  localPoint(event.clientX, event.clientY),
                  cameraRef.current,
                );
                elementDragRef.current = {
                  ids,
                  pointerId: event.pointerId,
                  point,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                surfaceRef.current?.focus({ preventScroll: true });
              }}
            />
          )}
          {textGroupDropTargetId === group.id && (
            <>
              <span
                className="canvas-text-box-group-drop-line"
                style={{
                  top:
                    (textBoxGroupInsertionY(displayElements, group.id, cursorWorld.y) ??
                      group.bounds.y) - group.bounds.y,
                }}
                aria-hidden="true"
              />
              <span className="canvas-text-box-group-drop-indicator" aria-hidden="true">
                Release to attach
              </span>
            </>
          )}
        </div>
      ))}
      {visibleElements.map((element) => {
        const bounds = elementBounds(element);
        const selected = effectiveSelectedIds.has(element.id);
        const showElementSelection = selected && selectedTextGroupId === undefined;
        const searchBlock = markdownSearchBlocks.get(element.id);
        const isDimmed = dimmedElementIds?.has(element.id) === true;
        return (
          <div
            key={element.id}
            data-canvas-element-id={element.id}
            className={`canvas-element kind-${element.kind} ${showElementSelection ? "is-selected" : ""} ${hoveredId === element.id ? "is-hovered" : ""} ${effectiveEditingMarkdownId === element.id ? "is-editing" : ""} ${isDimmed ? "is-dimmed" : ""}`}
            style={{
              left: bounds.x,
              top: bounds.y,
              width: Math.max(1, bounds.width),
              height: Math.max(1, bounds.height),
              zIndex: element.z,
              opacity: isDimmed ? 0.25 : undefined,
            }}
            aria-label={`${element.kind} element`}
            onPointerEnter={() => setHoveredId(element.id)}
            onPointerLeave={() =>
              setHoveredId((current) => (current === element.id ? undefined : current))
            }
            onClick={(event) => {
              if (
                readOnly ||
                tool !== "text" ||
                element.kind !== "markdown" ||
                isEditableTarget(event.target)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              beginMarkdownEditing(element.id);
            }}
            onDoubleClick={(event) => {
              if (readOnly || element.kind !== "markdown" || (tool !== "select" && tool !== "text"))
                return;
              event.stopPropagation();
              beginMarkdownEditing(element.id);
            }}
          >
            {element.kind === "markdown" ? (
              <>
                {effectiveEditingMarkdownId !== element.id && (
                  <button
                    type="button"
                    className="canvas-markdown-drag-handle"
                    aria-label="Move Markdown block"
                    title={
                      isAttachableTextBox(element)
                        ? "Move Markdown block; drop on a text box group to attach"
                        : "Move Markdown block"
                    }
                  >
                    ⋮⋮
                  </button>
                )}
                <MarkdownBlock
                  searchMatchOffset={searchBlock?.matchOffset ?? 0}
                  searchQuery={markdownSearchQuery}
                  {...(activeMarkdownSearchElementId === element.id &&
                  activeMarkdownSearchMatch !== undefined
                    ? { activeSearchMatch: activeMarkdownSearchMatch.index }
                    : {})}
                  boxOpacity={effectiveMarkdownBoxAppearance.opacity}
                  fontSize={effectiveMarkdownBoxAppearance.fontSize}
                  theme={theme}
                  colorStyles={effectiveMarkdownColorStyles.styles}
                  {...(element.markdownStyleId === undefined
                    ? {}
                    : { markdownStyleId: element.markdownStyleId })}
                  {...(() => {
                    const colorStyle = effectiveMarkdownColorStyles.styles.find(
                      (style) => style.id === element.markdownStyleId,
                    );
                    return colorStyle === undefined ? {} : { colorStyle };
                  })()}
                  editing={effectiveEditingMarkdownId === element.id}
                  editorPortalTarget={surfaceRef.current}
                  source={markdownSources[element.id] ?? ""}
                  onChange={(source) => onMarkdownSourceChange?.(element.id, source)}
                  onCommit={(source) => commitMarkdown(element.id, source)}
                  onCreateTextGroup={() => createTextGroup(element.id)}
                  onAddTextGroupBlock={() => addTextGroupBlock(element.id)}
                  onDetachTextGroupBlock={() => detachTextGroupBlock(element.id)}
                  onMarkdownStyleChange={(styleId) => changeMarkdownStyle(element.id, styleId)}
                  onFinishEditing={() => {
                    if ((sourcesRef.current[element.id] ?? "").trim().length === 0) {
                      removeMarkdown(element.id);
                    }
                    setEditingMarkdownId(undefined);
                    surfaceRef.current?.focus({ preventScroll: true });
                  }}
                  onHeightChange={(height) => {
                    const normalizedHeight = normalizeMarkdownBlockHeight(height);
                    if (normalizedHeight === undefined) return;
                    onMarkdownHeightChange(element, bounds, normalizedHeight);
                  }}
                  {...(element.textGroupId === undefined
                    ? {}
                    : { textGroupId: element.textGroupId })}
                />
              </>
            ) : (
              <CanvasElementView
                element={element}
                bounds={bounds}
                {...(loadImageForCanvas === undefined
                  ? {}
                  : { loadImageAsset: loadImageForCanvas })}
                renderTolerance={0.15 / Math.max(0.1, cameraZoom)}
              />
            )}
            {!readOnly &&
              showElementSelection &&
              selectedElements.length === 1 &&
              isResizableElement(element) &&
              RESIZE_HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  className={`canvas-resize-handle is-${handle}`}
                  aria-label={`Resize ${element.kind} element${handle === "se" ? "" : ` from ${resizeHandleLabel(handle)}`}`}
                  title={`Resize from ${resizeHandleLabel(handle)}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const point = localPoint(event.clientX, event.clientY);
                    gestureHistoryRef.current = randomId();
                    resizeDragRef.current = {
                      bounds,
                      elementId: element.id,
                      handle,
                      pointerId: event.pointerId,
                      point: viewportToWorld(point, cameraRef.current),
                    };
                    surfaceRef.current?.setPointerCapture(event.pointerId);
                  }}
                />
              ))}
          </div>
        );
      })}
      {(selectedTextGroupId === undefined ? visibleSelectedElements : []).map((element) => {
        const bounds = elementBounds(element);
        return (
          <div
            key={`selection-${element.id}`}
            className={`canvas-selection-overlay kind-${element.kind}`}
            aria-hidden="true"
            style={{
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              zIndex: selectionZIndex,
            }}
          >
            {element.kind === "ink" && (
              <InkSelectionOutline
                element={element}
                bounds={bounds}
                renderTolerance={0.15 / Math.max(0.1, cameraZoom)}
              />
            )}
          </div>
        );
      })}
      <div
        ref={activeInkPreviewRef}
        className="canvas-element canvas-ink-preview"
        aria-hidden="true"
        hidden
      >
        <svg
          ref={activeInkPreviewSvgRef}
          className="canvas-vector"
          preserveAspectRatio="none"
          shapeRendering="geometricPrecision"
        >
          <path ref={activeInkPreviewPathRef} />
        </svg>
      </div>
      {activeShape !== undefined && (
        <CanvasElementPreview element={activeShape} className="canvas-shape-preview" />
      )}
      {activePath?.kind === "lasso" && (
        <svg className="canvas-path-preview kind-lasso" aria-hidden="true">
          <path
            d={pointsToSvgPath(activePath.points, true)}
            fill="rgb(112 82 165 / 10%)"
            stroke="#7052a5"
            strokeDasharray="6 4"
            strokeWidth={2}
          />
        </svg>
      )}
      {activeSpace !== undefined && (
        <div
          className="canvas-insert-space-preview"
          aria-hidden="true"
          style={{
            left: visibleWorldBounds.x,
            top: Math.min(activeSpace.cutY, activeSpace.cutY + activeSpace.distance),
            width: visibleWorldBounds.width,
            height: Math.max(2 / cameraZoom, Math.abs(activeSpace.distance)),
          }}
        />
      )}
      {children}
      {[...remoteLaserPointers, ...localLaserPointers]
        .filter((pointer) => pointer.points.length > 0)
        .map((pointer) => {
          const tip = pointer.points[pointer.points.length - 1] as Point;
          return (
            <svg
              key={pointer.id}
              className={`canvas-laser-trail ${pointer.active ? "is-active" : "is-fading"}`}
              style={{
                animationDuration: `${laserPointerDecaySeconds}s`,
                zIndex: laserZIndex,
              }}
              aria-hidden="true"
            >
              <path d={pointsToSvgPath(pointer.points, false)} stroke={pointer.color} />
              <circle
                cx={tip.x}
                cy={tip.y}
                r={LASER_POINTER_TIP_RADIUS / cameraZoom}
                fill={pointer.color}
              />
            </svg>
          );
        })}
    </div>
  );
}

type InkCursorTool = "pen" | "highlighter" | "eraser" | "laser";

export function InkToolCursor({
  position,
  style,
  tool,
  visible,
  zoom,
  zIndex,
  eraserWidth,
}: {
  readonly position: Point;
  readonly style: InkStyle;
  readonly tool: InkCursorTool;
  readonly visible: boolean;
  readonly zoom: number;
  readonly zIndex: number;
  readonly eraserWidth: number;
}) {
  const inkWidth = style.width;
  const toolWidth = tool === "eraser" ? eraserWidth : inkWidth;
  const size = tool === "laser" ? LASER_POINTER_TIP_RADIUS * 2 : Math.max(1, toolWidth * zoom);
  const halfSize = size / 2;
  const cursorStyle: CSSProperties = {
    left: position.x - halfSize,
    top: position.y - halfSize,
    width: size,
    height: size,
    opacity: visible ? 1 : 0,
    zIndex,
  };

  if (tool === "laser") {
    return (
      <svg
        className="canvas-ink-cursor canvas-ink-cursor-laser"
        style={cursorStyle}
        viewBox={`-${LASER_POINTER_TIP_RADIUS} -${LASER_POINTER_TIP_RADIUS} ${LASER_POINTER_TIP_RADIUS * 2} ${LASER_POINTER_TIP_RADIUS * 2}`}
        aria-hidden="true"
        focusable="false"
      >
        <circle r={LASER_POINTER_TIP_RADIUS} fill="#ef3e58" fillOpacity="0.55" />
      </svg>
    );
  }

  if (tool === "eraser") {
    const radius = Math.max(0.5, eraserWidth / 2);
    return (
      <svg
        className="canvas-ink-cursor canvas-ink-cursor-eraser"
        style={cursorStyle}
        viewBox={`-${radius} -${radius} ${radius * 2} ${radius * 2}`}
        aria-hidden="true"
        focusable="false"
      >
        <circle r={radius} fill="var(--app-accent)" fillOpacity="0.2" />
      </svg>
    );
  }

  if (tool === "highlighter") {
    const width = Math.max(1, 1 * zoom);
    const height = Math.max(1, inkWidth * zoom);
    const highlighterCursorStyle: CSSProperties = {
      left: position.x - width / 2,
      top: position.y - height / 2,
      width,
      height,
      opacity: visible ? 1 : 0,
      zIndex,
    };
    const cursorOpacity = Math.min(0.6, Math.max(0.22, style.opacity));
    return (
      <svg
        className="canvas-ink-cursor canvas-ink-cursor-highlighter"
        style={highlighterCursorStyle}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
      >
        <rect width={width} height={height} fill={style.color} fillOpacity={cursorOpacity} />
      </svg>
    );
  }

  const outline = strokeOutline([[0, 0]], style.width, style.smoothing ?? 0.65, 0, false);
  const cursorOpacity = Math.min(0.6, Math.max(0.22, style.opacity));
  return (
    <svg
      className={`canvas-ink-cursor canvas-ink-cursor-${tool}`}
      style={cursorStyle}
      viewBox={`-${Math.max(0.5, inkWidth / 2)} -${Math.max(0.5, inkWidth / 2)} ${Math.max(1, inkWidth)} ${Math.max(1, inkWidth)}`}
      preserveAspectRatio="none"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
    >
      <path d={outlineToSvgPath(outline)} fill={style.color} fillOpacity={cursorOpacity} />
    </svg>
  );
}

export function CanvasElementView({
  element,
  bounds,
  loadImageAsset,
  renderTolerance = 0,
}: {
  readonly element: CanvasElement;
  readonly bounds: CanvasBounds;
  readonly loadImageAsset?: (asset: string) => Promise<Blob>;
  readonly renderTolerance?: number;
}) {
  if (element.kind === "markdown") return null;
  if (element.kind === "image") {
    return (
      <LazyCanvasImage
        asset={element.asset}
        {...(loadImageAsset === undefined ? {} : { loadImageAsset })}
      />
    );
  }
  if (element.kind === "ink") {
    return <InkStrokeVector element={element} bounds={bounds} renderTolerance={renderTolerance} />;
  }

  const { geometry, style } = element;
  if (geometry.kind === "line" || geometry.kind === "arrow") {
    const markerId = `arrow-${element.id}`;
    return (
      <svg
        className="canvas-vector"
        viewBox={`0 0 ${bounds.width} ${bounds.height}`}
        preserveAspectRatio="none"
      >
        {geometry.kind === "arrow" && (
          <defs>
            <marker
              id={markerId}
              markerWidth="5"
              markerHeight="5"
              refX="4"
              refY="2.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M 0 0 L 5 2.5 L 0 5 Z" fill={style.strokeColor} />
            </marker>
          </defs>
        )}
        <line
          x1={element.position[0] + geometry.start[0] - bounds.x}
          y1={element.position[1] + geometry.start[1] - bounds.y}
          x2={element.position[0] + geometry.end[0] - bounds.x}
          y2={element.position[1] + geometry.end[1] - bounds.y}
          stroke={style.strokeColor}
          strokeWidth={style.strokeWidth}
          opacity={style.opacity}
          markerEnd={geometry.kind === "arrow" ? `url(#${markerId})` : undefined}
        />
      </svg>
    );
  }
  return (
    <svg
      className="canvas-vector"
      viewBox={`0 0 ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="none"
    >
      {geometry.kind === "rectangle" ? (
        <rect
          x={style.strokeWidth / 2}
          y={style.strokeWidth / 2}
          width={Math.max(0, bounds.width - style.strokeWidth)}
          height={Math.max(0, bounds.height - style.strokeWidth)}
          fill={style.fillColor ?? "none"}
          stroke={style.strokeColor}
          strokeWidth={style.strokeWidth}
          opacity={style.opacity}
        />
      ) : (
        <ellipse
          cx={bounds.width / 2}
          cy={bounds.height / 2}
          rx={Math.max(0, (bounds.width - style.strokeWidth) / 2)}
          ry={Math.max(0, (bounds.height - style.strokeWidth) / 2)}
          fill={style.fillColor ?? "none"}
          stroke={style.strokeColor}
          strokeWidth={style.strokeWidth}
          opacity={style.opacity}
        />
      )}
    </svg>
  );
}

function LazyCanvasImage({
  asset,
  loadImageAsset,
}: {
  readonly asset: string;
  readonly loadImageAsset?: (asset: string) => Promise<Blob>;
}) {
  const [source, setSource] = useState<string>();
  const loaderRef = useRef(loadImageAsset);
  loaderRef.current = loadImageAsset;
  useEffect(() => {
    const loader = loaderRef.current;
    if (loader === undefined) return;
    let disposed = false;
    let url: string | undefined;
    void loader(asset).then((blob) => {
      if (disposed) return;
      url = URL.createObjectURL(blob);
      setSource(url);
    });
    return () => {
      disposed = true;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [asset]);
  return <img className="canvas-image" src={source} alt="" draggable={false} />;
}

function CanvasElementPreview({
  element,
  className,
}: {
  readonly element: ShapeCanvasRecord;
  readonly className: string;
}) {
  const bounds = elementBounds(element);
  return (
    <div
      className={`canvas-element ${className}`}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
        zIndex: element.z,
      }}
      aria-hidden="true"
    >
      <CanvasElementView element={element} bounds={bounds} />
    </div>
  );
}

function InkSelectionOutline({
  element,
  bounds,
  renderTolerance,
}: {
  readonly element: InkCanvasRecord;
  readonly bounds: CanvasBounds;
  readonly renderTolerance: number;
}) {
  const points = element.points.map(
    (point) =>
      [
        element.position[0] + point[0] - bounds.x,
        element.position[1] + point[1] - bounds.y,
      ] as const,
  );
  const outline = strokeOutline(
    points,
    element.style.width,
    element.style.smoothing ?? 0.65,
    renderTolerance,
    element.style.highlighter,
  );
  const path = outlineToSvgPath(outline);
  return (
    <svg
      className="canvas-selection-outline"
      viewBox={`0 0 ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="4"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        fill="none"
        stroke="#7052a5"
        strokeDasharray="6 4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function InkStrokeVector({
  element,
  bounds,
  renderTolerance = 0,
}: {
  readonly element: InkCanvasRecord;
  readonly bounds: CanvasBounds;
  readonly renderTolerance?: number;
}) {
  const path = renderInkPath(element, bounds, renderTolerance);
  return (
    <svg
      className="canvas-vector"
      viewBox={`0 0 ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="none"
      shapeRendering="geometricPrecision"
    >
      <path d={path} fill={element.style.color} opacity={element.style.opacity} />
    </svg>
  );
}

export function pointsToSvgPath(points: readonly Point[], closed: boolean): string {
  if (points.length === 0) return "";
  const commands = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`);
  return `${commands.join(" ")}${closed && points.length > 2 ? " Z" : ""}`;
}

export function resizeHandleLabel(handle: ResizeHandle): string {
  return (
    {
      n: "top edge",
      ne: "top-right corner",
      e: "right edge",
      se: "bottom-right corner",
      s: "bottom edge",
      sw: "bottom-left corner",
      w: "left edge",
      nw: "top-left corner",
    } as const
  )[handle];
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable='true'], [data-canvas-editor='active']",
    ) !== null
  );
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
