import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { MarkdownBoxAppearance, MarkdownColorStyleLibrary } from "@squillpad/core-model";
import { SpatialCanvas, type Bounds, type Camera } from "@squillpad/ui";

import type { PageData } from "./app-types";

const LONG_PRESS_MS = 500;
const HOLD_CANCEL_DISTANCE_PX = 8;
const MIN_WIDTH_PX = 120;

export interface PictureInPictureView {
  readonly id: string;
  readonly sectionId: string;
  readonly pageId: string;
  readonly sourceTitle: string;
  readonly bounds: Bounds;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface PictureInPictureOverlayProps {
  readonly views: readonly PictureInPictureView[];
  readonly pages: Readonly<Record<string, PageData>>;
  readonly pageBackground: "blank" | "ruled" | "grid";
  readonly theme: "light" | "dark";
  readonly markdownBoxAppearance: MarkdownBoxAppearance;
  readonly markdownColorStyles: MarkdownColorStyleLibrary;
  readonly onActivate: (id: string) => void;
  readonly onChange: (id: string, patch: Partial<PictureInPictureView>) => void;
  readonly onClose: (id: string) => void;
  readonly loadImageAsset: (sectionId: string, pageId: string, asset: string) => Promise<Blob>;
}

interface WindowInteraction {
  readonly kind: "drag" | "resize";
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function PictureInPictureOverlay({
  views,
  pages,
  pageBackground,
  theme,
  markdownBoxAppearance,
  markdownColorStyles,
  onActivate,
  onChange,
  onClose,
  loadImageAsset,
}: PictureInPictureOverlayProps) {
  useEffect(() => {
    const keepViewsInViewport = () => {
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      for (const view of views) {
        const aspectRatio = view.width / view.height;
        const width = Math.min(view.width, viewportWidth, viewportHeight * aspectRatio);
        const height = width / aspectRatio;
        const left = clamp(view.left, 0, Math.max(0, viewportWidth - width));
        const top = clamp(view.top, 0, Math.max(0, viewportHeight - height));
        if (
          width !== view.width ||
          height !== view.height ||
          left !== view.left ||
          top !== view.top
        ) {
          onChange(view.id, { width, height, left, top });
        }
      }
    };
    window.addEventListener("resize", keepViewsInViewport);
    window.visualViewport?.addEventListener("resize", keepViewsInViewport);
    return () => {
      window.removeEventListener("resize", keepViewsInViewport);
      window.visualViewport?.removeEventListener("resize", keepViewsInViewport);
    };
  }, [onChange, views]);

  return (
    <div className="picture-in-picture-layer" aria-label="Picture-in-picture reference views">
      {views.map((view) => {
        const page = pages[view.pageId];
        if (page === undefined) return null;
        return (
          <PictureInPictureWindow
            key={view.id}
            view={view}
            page={page}
            pageBackground={pageBackground}
            theme={theme}
            markdownBoxAppearance={markdownBoxAppearance}
            markdownColorStyles={markdownColorStyles}
            onActivate={onActivate}
            onChange={onChange}
            onClose={onClose}
            loadImageAsset={loadImageAsset}
          />
        );
      })}
    </div>
  );
}

function PictureInPictureWindow({
  view,
  page,
  pageBackground,
  theme,
  markdownBoxAppearance,
  markdownColorStyles,
  onActivate,
  onChange,
  onClose,
  loadImageAsset,
}: Omit<PictureInPictureOverlayProps, "views" | "pages"> & {
  readonly view: PictureInPictureView;
  readonly page: PageData;
}) {
  const windowRef = useRef<HTMLElement>(null);
  const interactionRef = useRef<WindowInteraction | undefined>(undefined);
  const holdTimerRef = useRef<number | undefined>(undefined);
  const holdStartRef = useRef<{ x: number; y: number; pointerId: number } | undefined>(undefined);
  const [closeRevealed, setCloseRevealed] = useState(false);
  const camera = useMemo(
    () => cameraForBounds(view.bounds, view.width, view.height),
    [view.bounds, view.height, view.width],
  );

  const clearHold = () => {
    if (holdTimerRef.current !== undefined) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = undefined;
    holdStartRef.current = undefined;
  };

  useEffect(() => clearHold, []);
  useEffect(() => {
    if (!closeRevealed) return;
    const dismiss = (event: globalThis.Event) => {
      if (event.target instanceof Node && windowRef.current?.contains(event.target)) return;
      setCloseRevealed(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
    };
  }, [closeRevealed]);

  const startInteraction = (event: PointerEvent<HTMLElement>, kind: WindowInteraction["kind"]) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate(view.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current = {
      kind,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      left: view.left,
      top: view.top,
      width: view.width,
      height: view.height,
    };
    if (kind === "drag") {
      clearHold();
      holdStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      holdTimerRef.current = window.setTimeout(() => {
        setCloseRevealed(true);
        holdTimerRef.current = undefined;
      }, LONG_PRESS_MS);
    }
  };

  const moveInteraction = (event: PointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (interaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - interaction.clientX;
    const deltaY = event.clientY - interaction.clientY;
    const holdStart = holdStartRef.current;
    if (
      holdStart?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y) > HOLD_CANCEL_DISTANCE_PX
    ) {
      clearHold();
    }
    if (interaction.kind === "drag") {
      onChange(view.id, {
        left: clamp(interaction.left + deltaX, 0, Math.max(0, window.innerWidth - view.width)),
        top: clamp(interaction.top + deltaY, 0, Math.max(0, window.innerHeight - view.height)),
      });
      return;
    }
    const aspectRatio = interaction.width / interaction.height;
    const widthFromY = interaction.width + deltaY * aspectRatio;
    const requestedWidth =
      Math.abs(deltaX) >= Math.abs(deltaY * aspectRatio) ? interaction.width + deltaX : widthFromY;
    const maximumWidth = Math.min(
      window.innerWidth - interaction.left,
      (window.innerHeight - interaction.top) * aspectRatio,
    );
    const width = clamp(requestedWidth, Math.min(MIN_WIDTH_PX, maximumWidth), maximumWidth);
    onChange(view.id, { width, height: width / aspectRatio });
  };

  const endInteraction = (event: PointerEvent<HTMLElement>) => {
    if (interactionRef.current?.pointerId !== event.pointerId) return;
    clearHold();
    interactionRef.current = undefined;
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    const delta = event.shiftKey ? 25 : 10;
    const movement = keyboardDirection(event.key, delta);
    if (movement === undefined) return;
    event.preventDefault();
    onActivate(view.id);
    onChange(view.id, {
      left: clamp(view.left + movement.x, 0, Math.max(0, window.innerWidth - view.width)),
      top: clamp(view.top + movement.y, 0, Math.max(0, window.innerHeight - view.height)),
    });
  };

  return (
    <section
      ref={windowRef}
      className={`picture-in-picture-window ${closeRevealed ? "is-close-revealed" : ""}`}
      style={{ left: view.left, top: view.top, width: view.width, height: view.height }}
      tabIndex={0}
      aria-label={`Live picture-in-picture reference from ${view.sourceTitle}`}
      onFocus={() => setCloseRevealed(true)}
      onKeyDown={moveWithKeyboard}
      onPointerDown={(event) => startInteraction(event, "drag")}
      onPointerMove={moveInteraction}
      onPointerUp={endInteraction}
      onPointerCancel={endInteraction}
      onLostPointerCapture={endInteraction}
    >
      <div className="picture-in-picture-window__viewport" aria-hidden="true" inert>
        <SpatialCanvas
          camera={camera}
          contentBounds={view.bounds}
          elements={page.canvas}
          markdownSources={page.markdown}
          markdownBoxAppearance={markdownBoxAppearance}
          markdownColorStyles={markdownColorStyles}
          pageBackground={pageBackground}
          pageId={`picture-in-picture:${view.id}:${view.pageId}`}
          presentationOnly
          readOnly
          theme={theme}
          loadImageAsset={(asset) => loadImageAsset(view.sectionId, view.pageId, asset)}
        />
      </div>
      <button
        className="picture-in-picture-window__close"
        type="button"
        aria-label={`Close picture-in-picture reference from ${view.sourceTitle}`}
        title="Close picture in picture"
        tabIndex={closeRevealed ? 0 : -1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onClose(view.id)}
      >
        ×
      </button>
      <button
        className="picture-in-picture-window__resize"
        type="button"
        aria-label={`Resize picture-in-picture reference from ${view.sourceTitle}`}
        title="Drag to resize proportionally"
        onPointerDown={(event) => startInteraction(event, "resize")}
        onPointerMove={moveInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        onLostPointerCapture={endInteraction}
        onKeyDown={(event) => {
          const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
          if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
          event.preventDefault();
          const aspectRatio = view.width / view.height;
          const maximumWidth = Math.min(
            window.innerWidth - view.left,
            (window.innerHeight - view.top) * aspectRatio,
          );
          const width = clamp(
            view.width + direction * (event.shiftKey ? 25 : 10),
            Math.min(MIN_WIDTH_PX, maximumWidth),
            maximumWidth,
          );
          onChange(view.id, { width, height: width / aspectRatio });
        }}
      />
    </section>
  );
}

function cameraForBounds(bounds: Bounds, width: number, height: number): Camera {
  const zoom = Math.min(width / bounds.width, height / bounds.height);
  return {
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(minimum, value), Math.max(minimum, maximum));
}

function keyboardDirection(key: string, distance: number): { x: number; y: number } | undefined {
  switch (key) {
    case "ArrowLeft":
      return { x: -distance, y: 0 };
    case "ArrowRight":
      return { x: distance, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -distance };
    case "ArrowDown":
      return { x: 0, y: distance };
    default:
      return undefined;
  }
}
