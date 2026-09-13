import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  readSectionColor,
  type NotebookHierarchy,
  type NotebookSection,
  type PageManifest,
} from "@squillpad/core-model";

import { EditableTitle, MoonIcon, PanelsIcon, SunIcon } from "./AppChrome";
import { AppSettings, type AppSettingsProps } from "./AppSettings";
import type { Selection } from "./app-types";

const CONTEXT_MENU_ANIMATION_MS = 180;
const PAGE_MOVE_MENU_CLOSE_DELAY_MS = 120;
const DRAG_START_DISTANCE = 6;
const NAVIGATION_SECTION_DEFAULT_WIDTH = 200;
const NAVIGATION_SECTION_MIN_WIDTH = 160;
const NAVIGATION_SECTION_MAX_WIDTH = 352;
const NAVIGATION_PAGE_DEFAULT_WIDTH = 240;
const NAVIGATION_PAGE_MIN_WIDTH = 192;
const NAVIGATION_PAGE_MAX_WIDTH = 480;
const NAVIGATION_WORKSPACE_MIN_WIDTH = 320;
const NAVIGATION_RESIZE_KEY_STEP = 16;
const SECTION_COLOR_PICKER_FALLBACK = "#7656b3";

type PageMoveMenuPhase = "closed" | "opening" | "open" | "closing";

interface PageMoveMenuPosition {
  readonly side: "left" | "right";
  readonly top: number;
  readonly originX: number;
  readonly originY: number;
}

type ReorderKind = "section" | "page";
type NavigationPanelKind = "section" | "page";

type NavigationPanelWidths = Partial<Record<NavigationPanelKind, number>>;

interface NavigationResize {
  readonly kind: NavigationPanelKind;
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

interface ReorderDrag {
  readonly kind: ReorderKind;
  readonly id: string;
  readonly sourceIndex: number;
  readonly dropIndex: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly active: boolean;
  readonly sourceSectionId: string | undefined;
  readonly targetSectionId: string | undefined;
}

type HierarchyClipboard =
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "page"; readonly sectionId: string; readonly pageId: string };

type ContextMenuState =
  | {
      readonly key: string;
      readonly kind: "section";
      readonly sectionId: string;
      readonly index: number;
      readonly title: string;
      readonly anchorX: number;
      readonly anchorY: number;
      readonly left: number;
      readonly top: number;
      readonly originX: number;
      readonly originY: number;
      readonly phase: "opening" | "open" | "closing";
    }
  | {
      readonly key: string;
      readonly kind: "page";
      readonly sectionId: string;
      readonly pageId: string;
      readonly index: number;
      readonly title: string;
      readonly anchorX: number;
      readonly anchorY: number;
      readonly left: number;
      readonly top: number;
      readonly originX: number;
      readonly originY: number;
      readonly phase: "opening" | "open" | "closing";
    };

type ContextMenuInput =
  | Omit<
      Extract<ContextMenuState, { readonly kind: "section" }>,
      "left" | "top" | "originX" | "originY" | "phase"
    >
  | Omit<
      Extract<ContextMenuState, { readonly kind: "page" }>,
      "left" | "top" | "originX" | "originY" | "phase"
    >;

export interface AppNavigationProps {
  readonly hierarchy: NotebookHierarchy;
  readonly selectedSection: NotebookSection | undefined;
  readonly selectedPage: PageManifest | undefined;
  readonly navigationOpen: boolean;
  readonly mutationDisabled: boolean;
  readonly navigationDisabled: boolean;
  readonly theme: "light" | "dark";
  readonly settings: AppSettingsProps;
  readonly onCreateSection: (targetIndex?: number) => void;
  readonly onCreatePage: (targetIndex?: number) => void;
  readonly onRenameSection: (title: string) => void;
  readonly onSectionColorChange: (sectionId: string, color: string | undefined) => void;
  readonly onDeleteSection: (sectionId: string) => void;
  readonly onReorderSection: (fromIndex: number, toIndex: number) => void;
  readonly onNavigateToPage: (pageId: string) => void;
  readonly onReorderPage: (fromIndex: number, toIndex: number) => void;
  readonly onMovePage: (sourceSectionId: string, pageId: string, targetSectionId: string) => void;
  readonly onPasteSection: (sourceSectionId: string, targetIndex: number) => void;
  readonly onDuplicateSection: (sectionId: string, targetIndex: number) => void;
  readonly onPastePage: (
    sourceSectionId: string,
    sourcePageId: string,
    targetSectionId: string,
    targetIndex: number,
  ) => void;
  readonly onDuplicatePage: (sectionId: string, pageId: string, targetIndex: number) => void;
  readonly onDeletePage: (sectionId: string, pageId: string) => void;
  readonly onSelectionChange: (selection: Selection) => void;
  readonly onCloseNavigation: () => void;
  readonly onOpenNavigation: () => void;
  readonly navigationFloatingToggleRef: RefObject<HTMLButtonElement | null>;
  readonly nextTheme: "light" | "dark";
  readonly onToggleTheme: () => void;
  readonly children?: ReactNode;
}

export function AppNavigation({
  hierarchy,
  selectedSection,
  selectedPage,
  navigationOpen,
  mutationDisabled,
  navigationDisabled,
  theme,
  settings,
  onCreateSection,
  onCreatePage,
  onRenameSection,
  onSectionColorChange,
  onDeleteSection,
  onReorderSection,
  onNavigateToPage,
  onReorderPage,
  onMovePage,
  onPasteSection,
  onDuplicateSection,
  onPastePage,
  onDuplicatePage,
  onDeletePage,
  onSelectionChange,
  onCloseNavigation,
  onOpenNavigation,
  navigationFloatingToggleRef,
  nextTheme,
  onToggleTheme,
  children,
}: AppNavigationProps) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const sectionRailRef = useRef<HTMLElement>(null);
  const pageSidebarRef = useRef<HTMLElement>(null);
  const sectionListRef = useRef<HTMLOListElement>(null);
  const pageListRef = useRef<HTMLOListElement>(null);
  const reorderRef = useRef<ReorderDrag | undefined>(undefined);
  const suppressedClickRef = useRef<
    { readonly key: string; readonly expiresAt: number } | undefined
  >(undefined);
  const resizeRef = useRef<NavigationResize | undefined>(undefined);
  const contextMenuElementRef = useRef<HTMLDivElement>(null);
  const contextMenuStateRef = useRef<ContextMenuState | undefined>(undefined);
  const contextMenuTriggerRef = useRef<HTMLElement | undefined>(undefined);
  const contextMenuCloseTimerRef = useRef<number | undefined>(undefined);
  const contextMenuOpenFrameRef = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState<ReorderDrag>();
  const [navigationPanelWidths, setNavigationPanelWidths] = useState<NavigationPanelWidths>({});
  const [resizingPanel, setResizingPanel] = useState<NavigationPanelKind>();
  const [clipboard, setClipboard] = useState<HierarchyClipboard>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  contextMenuStateRef.current = contextMenu;

  const clearContextMenuTimers = useCallback(() => {
    if (contextMenuCloseTimerRef.current !== undefined) {
      window.clearTimeout(contextMenuCloseTimerRef.current);
      contextMenuCloseTimerRef.current = undefined;
    }
    if (contextMenuOpenFrameRef.current !== undefined) {
      window.cancelAnimationFrame(contextMenuOpenFrameRef.current);
      contextMenuOpenFrameRef.current = undefined;
    }
  }, []);

  const closeContextMenu = useCallback(() => {
    const current = contextMenuStateRef.current;
    if (current === undefined || current.phase === "closing") return;
    clearContextMenuTimers();
    setContextMenu({ ...current, phase: "closing" });
    contextMenuCloseTimerRef.current = window.setTimeout(() => {
      contextMenuCloseTimerRef.current = undefined;
      setContextMenu(undefined);
      const trigger = contextMenuTriggerRef.current;
      if (trigger?.isConnected === true) trigger.focus({ preventScroll: true });
      contextMenuTriggerRef.current = undefined;
    }, CONTEXT_MENU_ANIMATION_MS);
  }, [clearContextMenuTimers]);

  const openContextMenu = useCallback(
    (next: ContextMenuInput, event: ReactMouseEvent<HTMLElement>) => {
      clearContextMenuTimers();
      const key = next.key;
      contextMenuTriggerRef.current =
        (event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>(
              "[data-context-menu-trigger], button, [href], [tabindex]",
            )
          : null) ??
        event.currentTarget.querySelector<HTMLElement>("[data-context-menu-trigger], button") ??
        undefined;
      setContextMenu({
        ...next,
        left: next.anchorX,
        top: next.anchorY,
        originX: 0,
        originY: 0,
        phase: "opening",
      });
      contextMenuOpenFrameRef.current = window.requestAnimationFrame(() => {
        contextMenuOpenFrameRef.current = undefined;
        setContextMenu((current) =>
          current?.key === key ? { ...current, phase: "open" } : current,
        );
      });
    },
    [clearContextMenuTimers],
  );

  const repositionContextMenu = useCallback(() => {
    const current = contextMenuStateRef.current;
    const menu = contextMenuElementRef.current;
    if (current === undefined || menu === null) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, current.anchorX),
      Math.max(margin, window.innerWidth - rect.width - margin),
    );
    const top = Math.min(
      Math.max(margin, current.anchorY),
      Math.max(margin, window.innerHeight - rect.height - margin),
    );
    const originX = current.anchorX - left;
    const originY = current.anchorY - top;
    if (
      current.left === left &&
      current.top === top &&
      current.originX === originX &&
      current.originY === originY
    ) {
      return;
    }
    setContextMenu((value) =>
      value?.key === current.key ? { ...value, left, top, originX, originY } : value,
    );
  }, []);

  useLayoutEffect(() => {
    if (contextMenu === undefined) return;
    repositionContextMenu();
  }, [contextMenu?.key, repositionContextMenu]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    const handleResize = () => repositionContextMenu();
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [contextMenu !== undefined, repositionContextMenu]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && contextMenuElementRef.current?.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && contextMenuElementRef.current?.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeContextMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu !== undefined, closeContextMenu]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      contextMenuElementRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu?.key, contextMenu?.phase]);

  useEffect(() => {
    if (navigationOpen) return;
    closeContextMenu();
  }, [closeContextMenu, navigationOpen]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    const targetStillExists =
      contextMenu.kind === "section"
        ? hierarchy.sections.some((section) => section.manifest.id === contextMenu.sectionId)
        : selectedSection?.manifest.id === contextMenu.sectionId &&
          selectedSection.pages.some((page) => page.id === contextMenu.pageId);
    if (!targetStillExists) closeContextMenu();
  }, [closeContextMenu, contextMenu, hierarchy.sections, selectedSection]);

  useEffect(
    () => () => {
      clearContextMenuTimers();
      reorderRef.current = undefined;
      resizeRef.current = undefined;
    },
    [clearContextMenuTimers],
  );

  const panelRefFor = useCallback(
    (kind: NavigationPanelKind) =>
      kind === "section" ? sectionRailRef.current : pageSidebarRef.current,
    [],
  );

  const panelWidthFor = useCallback(
    (kind: NavigationPanelKind) => {
      const measuredWidth = panelRefFor(kind)?.getBoundingClientRect().width;
      if (measuredWidth !== undefined && measuredWidth > 0) return measuredWidth;
      return (
        navigationPanelWidths[kind] ??
        (kind === "section" ? NAVIGATION_SECTION_DEFAULT_WIDTH : NAVIGATION_PAGE_DEFAULT_WIDTH)
      );
    },
    [navigationPanelWidths, panelRefFor],
  );

  const resizeBoundsFor = useCallback(
    (kind: NavigationPanelKind) => {
      const minimum = kind === "section" ? NAVIGATION_SECTION_MIN_WIDTH : NAVIGATION_PAGE_MIN_WIDTH;
      const maximum = kind === "section" ? NAVIGATION_SECTION_MAX_WIDTH : NAVIGATION_PAGE_MAX_WIDTH;
      const otherKind: NavigationPanelKind = kind === "section" ? "page" : "section";
      const layoutWidth = layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const availableMaximum =
        layoutWidth - panelWidthFor(otherKind) - NAVIGATION_WORKSPACE_MIN_WIDTH;
      return {
        min: minimum,
        max: Math.max(minimum, Math.min(maximum, availableMaximum)),
      };
    },
    [panelWidthFor],
  );

  const beginPanelResize = useCallback(
    (kind: NavigationPanelKind, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!navigationOpen || event.button !== 0 || event.isPrimary === false) return;
      const current: NavigationResize = {
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: panelWidthFor(kind),
      };
      resizeRef.current = current;
      setNavigationPanelWidths((widths) => ({ ...widths, [kind]: current.startWidth }));
      setResizingPanel(kind);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [navigationOpen, panelWidthFor],
  );

  const updatePanelResize = useCallback(
    (kind: NavigationPanelKind, event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = resizeRef.current;
      if (current === undefined || current.kind !== kind || current.pointerId !== event.pointerId) {
        return;
      }
      const bounds = resizeBoundsFor(kind);
      const nextWidth = clamp(
        current.startWidth + event.clientX - current.startX,
        bounds.min,
        bounds.max,
      );
      setNavigationPanelWidths((widths) =>
        widths[kind] === nextWidth ? widths : { ...widths, [kind]: nextWidth },
      );
      event.preventDefault();
    },
    [resizeBoundsFor],
  );

  const finishPanelResize = useCallback(
    (kind: NavigationPanelKind, event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = resizeRef.current;
      if (current === undefined || current.kind !== kind || current.pointerId !== event.pointerId) {
        return;
      }
      resizeRef.current = undefined;
      setResizingPanel(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const cancelPanelResize = useCallback((kind: NavigationPanelKind) => {
    if (resizeRef.current?.kind !== kind) return;
    resizeRef.current = undefined;
    setResizingPanel(undefined);
  }, []);

  const handlePanelResizeKeyDown = useCallback(
    (kind: NavigationPanelKind, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!navigationOpen) return;
      const bounds = resizeBoundsFor(kind);
      const currentWidth = panelWidthFor(kind);
      const step = event.shiftKey ? NAVIGATION_RESIZE_KEY_STEP * 3 : NAVIGATION_RESIZE_KEY_STEP;
      let nextWidth: number;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextWidth = currentWidth + step;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextWidth = currentWidth - step;
      } else if (event.key === "Home") {
        nextWidth = bounds.min;
      } else if (event.key === "End") {
        nextWidth = bounds.max;
      } else {
        return;
      }
      event.preventDefault();
      setNavigationPanelWidths((widths) => ({
        ...widths,
        [kind]: clamp(nextWidth, bounds.min, bounds.max),
      }));
    },
    [navigationOpen, panelWidthFor, resizeBoundsFor],
  );

  const finishReorder = useCallback(
    (
      kind: ReorderKind,
      event: ReactPointerEvent<HTMLLIElement>,
      onReorder: (fromIndex: number, toIndex: number) => void,
    ) => {
      const current = reorderRef.current;
      if (current === undefined || current.kind !== kind || current.pointerId !== event.pointerId) {
        return;
      }
      if (current.active) {
        event.preventDefault();
        suppressedClickRef.current = {
          key: reorderKey(kind, current.id),
          expiresAt: Date.now() + 400,
        };
        if (
          kind === "page" &&
          current.sourceSectionId !== undefined &&
          current.targetSectionId !== undefined &&
          current.sourceSectionId !== current.targetSectionId
        ) {
          onMovePage(current.sourceSectionId, current.id, current.targetSectionId);
        } else if (current.sourceIndex !== current.dropIndex) {
          onReorder(current.sourceIndex, current.dropIndex);
        }
      }
      reorderRef.current = undefined;
      setDragging(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [onMovePage],
  );

  const cancelReorder = useCallback((kind: ReorderKind) => {
    if (reorderRef.current?.kind !== kind) return;
    reorderRef.current = undefined;
    setDragging(undefined);
  }, []);

  const beginReorder = useCallback(
    (
      kind: ReorderKind,
      id: string,
      index: number,
      event: ReactPointerEvent<HTMLLIElement>,
      list: HTMLOListElement | null,
      sourceSectionId?: string,
    ) => {
      if (
        mutationDisabled ||
        event.button !== 0 ||
        list === null ||
        isContextMenuTriggerTarget(event.target)
      ) {
        return;
      }
      const current: ReorderDrag = {
        kind,
        id,
        sourceIndex: index,
        dropIndex: index,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        sourceSectionId: kind === "page" ? sourceSectionId : undefined,
        targetSectionId: undefined,
      };
      reorderRef.current = current;
    },
    [mutationDisabled],
  );

  const updateReorder = useCallback(
    (kind: ReorderKind, event: ReactPointerEvent<HTMLLIElement>, list: HTMLOListElement | null) => {
      const current = reorderRef.current;
      if (
        current === undefined ||
        current.kind !== kind ||
        current.pointerId !== event.pointerId ||
        list === null
      ) {
        return;
      }
      const moved =
        Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >=
        DRAG_START_DISTANCE;
      if (!current.active && !moved) return;
      if (!current.active) event.currentTarget.setPointerCapture(event.pointerId);
      const targetSectionId =
        kind === "page" ? sectionDropTargetForPointer(event.clientX, event.clientY) : undefined;
      const dropIndex =
        targetSectionId === undefined
          ? dropSlotForPointer(list, current.id, event.clientX, event.clientY)
          : current.dropIndex;
      const next = { ...current, active: true, dropIndex, targetSectionId };
      reorderRef.current = next;
      setDragging(next);
      event.preventDefault();
    },
    [],
  );

  const contextMenuCanPaste =
    contextMenu === undefined
      ? false
      : contextMenu.kind === "section"
        ? clipboard?.kind === "section" &&
          hierarchy.sections.some((section) => section.manifest.id === clipboard.sectionId)
        : clipboard?.kind === "page" &&
          hierarchy.sections.some(
            (section) =>
              section.manifest.id === clipboard.sectionId &&
              section.pages.some((page) => page.id === clipboard.pageId),
          );

  const contextMenuSectionColor =
    contextMenu?.kind === "section"
      ? readSectionColor(
          hierarchy.sections.find((section) => section.manifest.id === contextMenu.sectionId)
            ?.manifest.metadata ?? {},
        )
      : undefined;

  const runContextMenuAction = useCallback(
    (action: () => void) => {
      closeContextMenu();
      action();
    },
    [closeContextMenu],
  );

  const consumeSuppressedClick = useCallback((kind: ReorderKind, id: string) => {
    const suppressed = suppressedClickRef.current;
    if (suppressed === undefined) return false;
    suppressedClickRef.current = undefined;
    return suppressed.key === reorderKey(kind, id) && suppressed.expiresAt >= Date.now();
  }, []);

  let sectionDropSlot = 0;
  let pageDropSlot = 0;
  const navigationLayoutStyle = {
    ...(navigationPanelWidths.section === undefined
      ? {}
      : { "--navigation-section-width": `${navigationPanelWidths.section}px` }),
    ...(navigationPanelWidths.page === undefined
      ? {}
      : { "--navigation-page-width": `${navigationPanelWidths.page}px` }),
  } as CSSProperties;

  return (
    <>
      <div
        ref={layoutRef}
        id="notebook-layout"
        className={`notebook-layout ${navigationOpen ? "" : "navigation-collapsed"} ${resizingPanel === undefined ? "" : "is-navigation-resizing"} ${resizingPanel === "section" ? "is-section-resizing" : ""} ${resizingPanel === "page" ? "is-page-resizing" : ""}`}
        style={navigationLayoutStyle}
      >
        <nav
          ref={sectionRailRef}
          className="section-rail"
          aria-label="Sections"
          aria-hidden={!navigationOpen}
          inert={!navigationOpen}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="navigation-panel-top">
            <div className="rail-heading">
              <span>Sections</span>
            </div>
            <button
              className="new-navigation-button"
              type="button"
              title="Create section and focus its title"
              disabled={mutationDisabled}
              onClick={() => onCreateSection()}
            >
              New section
            </button>
          </div>
          <ol ref={sectionListRef} className="section-list">
            {hierarchy.sections.map((section, index) => {
              const isDragged = dragging?.kind === "section" && dragging.id === section.manifest.id;
              const sectionColor = readSectionColor(section.manifest.metadata);
              const showIndicator =
                dragging?.kind === "section" &&
                !isDragged &&
                dragging.dropIndex === sectionDropSlot;
              if (!isDragged) sectionDropSlot += 1;
              return (
                <Fragment key={section.manifest.id}>
                  {showIndicator && <ReorderDropIndicator />}
                  <li
                    className={[
                      section.manifest.id === selectedSection?.manifest.id ? "is-active" : "",
                      isDragged ? "is-dragging" : "",
                      dragging?.kind === "page" &&
                      dragging.targetSectionId === section.manifest.id &&
                      dragging.sourceSectionId !== section.manifest.id
                        ? "is-page-drop-target"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-reorder-id={section.manifest.id}
                    data-section-drop-target={section.manifest.id}
                    onPointerDown={(event) =>
                      beginReorder(
                        "section",
                        section.manifest.id,
                        index,
                        event,
                        sectionListRef.current,
                      )
                    }
                    onPointerMove={(event) =>
                      updateReorder("section", event, sectionListRef.current)
                    }
                    onPointerUp={(event) => finishReorder("section", event, onReorderSection)}
                    onPointerCancel={() => cancelReorder("section")}
                    onLostPointerCapture={() => cancelReorder("section")}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!navigationDisabled) selectSection(hierarchy, section, onSelectionChange);
                      openContextMenu(
                        {
                          key: `section:${section.manifest.id}`,
                          kind: "section",
                          sectionId: section.manifest.id,
                          index,
                          title: section.manifest.title,
                          anchorX: event.clientX,
                          anchorY: event.clientY,
                        },
                        event,
                      );
                    }}
                  >
                    <button
                      className="section-select"
                      disabled={navigationDisabled}
                      onClick={(event) => {
                        if (consumeSuppressedClick("section", section.manifest.id)) {
                          event.preventDefault();
                          return;
                        }
                        selectSection(hierarchy, section, onSelectionChange);
                      }}
                    >
                      <BookmarkIcon
                        className="section-bookmark"
                        {...(sectionColor === undefined ? {} : { style: { color: sectionColor } })}
                      />
                      <span>{section.manifest.title}</span>
                    </button>
                    <button
                      className="hierarchy-context-trigger"
                      type="button"
                      aria-label={`More actions for section ${section.manifest.title}`}
                      aria-haspopup="menu"
                      title={`More actions for section ${section.manifest.title}`}
                      data-context-menu-trigger="true"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!navigationDisabled)
                          selectSection(hierarchy, section, onSelectionChange);
                        const anchor = contextMenuAnchorForEvent(event);
                        openContextMenu(
                          {
                            key: `section:${section.manifest.id}`,
                            kind: "section",
                            sectionId: section.manifest.id,
                            index,
                            title: section.manifest.title,
                            anchorX: anchor.x,
                            anchorY: anchor.y,
                          },
                          event,
                        );
                      }}
                    >
                      <span aria-hidden="true">⋮</span>
                    </button>
                  </li>
                </Fragment>
              );
            })}
            {dragging?.kind === "section" && dragging.dropIndex === sectionDropSlot && (
              <ReorderDropIndicator />
            )}
          </ol>
          <div className="section-rail__footer">
            <AppSettings {...settings} />
            <button
              className="theme-toggle"
              type="button"
              aria-label={`Switch to ${nextTheme} mode`}
              aria-pressed={theme === "dark"}
              title={`Switch to ${nextTheme} mode`}
              onClick={onToggleTheme}
            >
              {theme === "light" ? <MoonIcon /> : <SunIcon />}
            </button>
            <button
              className="navigation-toggle"
              type="button"
              aria-controls="notebook-layout"
              aria-expanded={navigationOpen}
              aria-label="Hide section and page panels"
              title="Hide section and page panels"
              onClick={onCloseNavigation}
            >
              <PanelsIcon />
            </button>
          </div>
          <NavigationResizeHandle
            kind="section"
            width={navigationPanelWidths.section}
            onPointerDown={beginPanelResize}
            onPointerMove={updatePanelResize}
            onPointerUp={finishPanelResize}
            onPointerCancel={cancelPanelResize}
            onLostPointerCapture={cancelPanelResize}
            onKeyDown={handlePanelResizeKeyDown}
          />
        </nav>

        <aside
          ref={pageSidebarRef}
          className="page-sidebar"
          aria-label="Pages"
          aria-hidden={!navigationOpen}
          inert={!navigationOpen}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="navigation-panel-top">
            <div className="sidebar-heading">
              {selectedSection === undefined ? (
                <span>Pages</span>
              ) : (
                <EditableTitle
                  ariaLabel="Section title"
                  value={selectedSection.manifest.title}
                  disabled={mutationDisabled}
                  onCommit={onRenameSection}
                />
              )}
            </div>
            <button
              className="new-navigation-button"
              type="button"
              title="Create page and focus its title"
              disabled={mutationDisabled || selectedSection === undefined}
              onClick={() => onCreatePage()}
            >
              New page
            </button>
          </div>
          {selectedSection === undefined ? (
            <p className="empty-message">Create a section to begin.</p>
          ) : (
            <>
              <ol ref={pageListRef} className="page-list">
                {selectedSection.pages.map((page, index) => {
                  const isDragged = dragging?.kind === "page" && dragging.id === page.id;
                  const showIndicator =
                    dragging?.kind === "page" && !isDragged && dragging.dropIndex === pageDropSlot;
                  if (!isDragged) pageDropSlot += 1;
                  return (
                    <Fragment key={page.id}>
                      {showIndicator && <ReorderDropIndicator />}
                      <li
                        className={[
                          page.id === selectedPage?.id ? "is-active" : "",
                          isDragged ? "is-dragging" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        data-reorder-id={page.id}
                        onPointerDown={(event) =>
                          beginReorder(
                            "page",
                            page.id,
                            index,
                            event,
                            pageListRef.current,
                            selectedSection.manifest.id,
                          )
                        }
                        onPointerMove={(event) => updateReorder("page", event, pageListRef.current)}
                        onPointerUp={(event) => finishReorder("page", event, onReorderPage)}
                        onPointerCancel={() => cancelReorder("page")}
                        onLostPointerCapture={() => cancelReorder("page")}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          if (!navigationDisabled) onNavigateToPage(page.id);
                          openContextMenu(
                            {
                              key: `page:${selectedSection.manifest.id}:${page.id}`,
                              kind: "page",
                              sectionId: selectedSection.manifest.id,
                              pageId: page.id,
                              index,
                              title: page.title,
                              anchorX: event.clientX,
                              anchorY: event.clientY,
                            },
                            event,
                          );
                        }}
                      >
                        <button
                          className="page-select"
                          disabled={navigationDisabled}
                          onClick={(event) => {
                            if (consumeSuppressedClick("page", page.id)) {
                              event.preventDefault();
                              return;
                            }
                            onNavigateToPage(page.id);
                          }}
                        >
                          {page.title}
                        </button>
                        <button
                          className="hierarchy-context-trigger"
                          type="button"
                          aria-label={`More actions for page ${page.title}`}
                          aria-haspopup="menu"
                          title={`More actions for page ${page.title}`}
                          data-context-menu-trigger="true"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!navigationDisabled) onNavigateToPage(page.id);
                            const anchor = contextMenuAnchorForEvent(event);
                            openContextMenu(
                              {
                                key: `page:${selectedSection.manifest.id}:${page.id}`,
                                kind: "page",
                                sectionId: selectedSection.manifest.id,
                                pageId: page.id,
                                index,
                                title: page.title,
                                anchorX: anchor.x,
                                anchorY: anchor.y,
                              },
                              event,
                            );
                          }}
                        >
                          <span aria-hidden="true">⋮</span>
                        </button>
                      </li>
                    </Fragment>
                  );
                })}
                {dragging?.kind === "page" && dragging.dropIndex === pageDropSlot && (
                  <ReorderDropIndicator />
                )}
              </ol>
            </>
          )}
          <NavigationResizeHandle
            kind="page"
            width={navigationPanelWidths.page}
            onPointerDown={beginPanelResize}
            onPointerMove={updatePanelResize}
            onPointerUp={finishPanelResize}
            onPointerCancel={cancelPanelResize}
            onLostPointerCapture={cancelPanelResize}
            onKeyDown={handlePanelResizeKeyDown}
          />
        </aside>
        {children}
      </div>
      {!navigationOpen && (
        <button
          ref={navigationFloatingToggleRef}
          className="navigation-floating-toggle"
          type="button"
          aria-controls="notebook-layout"
          aria-label="Show section and page panels"
          title="Show section and page panels"
          onClick={onOpenNavigation}
        >
          <PanelsIcon />
        </button>
      )}
      {contextMenu !== undefined && (
        <NavigationContextMenu
          key={contextMenu.key}
          menuRef={contextMenuElementRef}
          target={contextMenu}
          style={contextMenuStyle(contextMenu)}
          mutationDisabled={mutationDisabled}
          canPaste={contextMenuCanPaste}
          sections={hierarchy.sections}
          sectionColor={contextMenuSectionColor}
          onSectionColorChange={(color) => {
            if (contextMenu.kind === "section") {
              onSectionColorChange(contextMenu.sectionId, color);
            }
          }}
          onAdd={() =>
            runContextMenuAction(() =>
              contextMenu.kind === "section"
                ? onCreateSection(contextMenu.index + 1)
                : onCreatePage(contextMenu.index + 1),
            )
          }
          onCopy={() =>
            runContextMenuAction(() =>
              setClipboard(
                contextMenu.kind === "section"
                  ? { kind: "section", sectionId: contextMenu.sectionId }
                  : {
                      kind: "page",
                      sectionId: contextMenu.sectionId,
                      pageId: contextMenu.pageId,
                    },
              ),
            )
          }
          onPaste={() =>
            runContextMenuAction(() => {
              if (clipboard === undefined || !contextMenuCanPaste) return;
              if (contextMenu.kind === "section" && clipboard.kind === "section") {
                onPasteSection(clipboard.sectionId, contextMenu.index + 1);
              } else if (contextMenu.kind === "page" && clipboard.kind === "page") {
                onPastePage(
                  clipboard.sectionId,
                  clipboard.pageId,
                  contextMenu.sectionId,
                  contextMenu.index + 1,
                );
              }
            })
          }
          onDuplicate={() =>
            runContextMenuAction(() =>
              contextMenu.kind === "section"
                ? onDuplicateSection(contextMenu.sectionId, contextMenu.index + 1)
                : onDuplicatePage(contextMenu.sectionId, contextMenu.pageId, contextMenu.index + 1),
            )
          }
          onDelete={() =>
            runContextMenuAction(() =>
              contextMenu.kind === "section"
                ? onDeleteSection(contextMenu.sectionId)
                : onDeletePage(contextMenu.sectionId, contextMenu.pageId),
            )
          }
          onMovePage={(targetSectionId) =>
            runContextMenuAction(() => {
              if (contextMenu.kind === "page") {
                onMovePage(contextMenu.sectionId, contextMenu.pageId, targetSectionId);
              }
            })
          }
        />
      )}
    </>
  );
}

const NavigationContextMenu = (props: {
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly target: ContextMenuState;
  readonly style: CSSProperties;
  readonly mutationDisabled: boolean;
  readonly canPaste: boolean;
  readonly sections: readonly NotebookSection[];
  readonly sectionColor: string | undefined;
  readonly onSectionColorChange: (color: string | undefined) => void;
  readonly onAdd: () => void;
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onMovePage: (targetSectionId: string) => void;
}) => {
  const {
    target,
    style,
    mutationDisabled,
    canPaste,
    sections,
    sectionColor,
    onSectionColorChange,
    onAdd,
    onCopy,
    onPaste,
    onDuplicate,
    onDelete,
    onMovePage,
  } = props;
  const moveMenuContainerRef = useRef<HTMLDivElement>(null);
  const moveMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const moveMenuElementRef = useRef<HTMLDivElement>(null);
  const moveMenuCloseTimerRef = useRef<number | undefined>(undefined);
  const moveMenuOpenFrameRef = useRef<number | undefined>(undefined);
  const moveMenuFocusFrameRef = useRef<number | undefined>(undefined);
  const [moveMenuPhase, setMoveMenuPhase] = useState<PageMoveMenuPhase>("closed");
  const moveMenuPhaseRef = useRef<PageMoveMenuPhase>("closed");
  const [moveMenuPosition, setMoveMenuPosition] = useState<PageMoveMenuPosition>({
    side: "right",
    top: 0,
    originX: 0,
    originY: 0,
  });
  moveMenuPhaseRef.current = moveMenuPhase;

  const moveTargets =
    target.kind === "page"
      ? sections.filter((section) => section.manifest.id !== target.sectionId)
      : [];
  const canMovePage = target.kind === "page" && !mutationDisabled && moveTargets.length > 0;

  const clearMoveMenuTimers = useCallback(() => {
    if (moveMenuCloseTimerRef.current !== undefined) {
      window.clearTimeout(moveMenuCloseTimerRef.current);
      moveMenuCloseTimerRef.current = undefined;
    }
    if (moveMenuOpenFrameRef.current !== undefined) {
      window.cancelAnimationFrame(moveMenuOpenFrameRef.current);
      moveMenuOpenFrameRef.current = undefined;
    }
    if (moveMenuFocusFrameRef.current !== undefined) {
      window.cancelAnimationFrame(moveMenuFocusFrameRef.current);
      moveMenuFocusFrameRef.current = undefined;
    }
  }, []);

  const closeMoveMenu = useCallback(
    (restoreFocus = false) => {
      const current = moveMenuPhaseRef.current;
      if (current === "closed" || current === "closing") return;
      clearMoveMenuTimers();
      setMoveMenuPhase("closing");
      moveMenuCloseTimerRef.current = window.setTimeout(() => {
        moveMenuCloseTimerRef.current = undefined;
        setMoveMenuPhase("closed");
        if (restoreFocus) moveMenuTriggerRef.current?.focus({ preventScroll: true });
      }, CONTEXT_MENU_ANIMATION_MS);
    },
    [clearMoveMenuTimers],
  );

  const openMoveMenu = useCallback(
    (focusFirst = false) => {
      if (!canMovePage) return;
      clearMoveMenuTimers();
      setMoveMenuPhase((current) => (current === "open" ? current : "opening"));
      moveMenuOpenFrameRef.current = window.requestAnimationFrame(() => {
        moveMenuOpenFrameRef.current = undefined;
        setMoveMenuPhase((current) => (current === "opening" ? "open" : current));
      });
      if (focusFirst) {
        moveMenuFocusFrameRef.current = window.requestAnimationFrame(() => {
          moveMenuFocusFrameRef.current = window.requestAnimationFrame(() => {
            moveMenuFocusFrameRef.current = undefined;
            moveMenuElementRef.current
              ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              ?.focus({ preventScroll: true });
          });
        });
      }
    },
    [canMovePage, clearMoveMenuTimers],
  );

  const cancelMoveMenuClose = useCallback(() => {
    if (moveMenuCloseTimerRef.current !== undefined) {
      window.clearTimeout(moveMenuCloseTimerRef.current);
      moveMenuCloseTimerRef.current = undefined;
    }
  }, []);

  const scheduleMoveMenuClose = useCallback(() => {
    if (moveMenuPhaseRef.current === "closed" || moveMenuPhaseRef.current === "closing") return;
    cancelMoveMenuClose();
    moveMenuCloseTimerRef.current = window.setTimeout(() => {
      moveMenuCloseTimerRef.current = undefined;
      closeMoveMenu();
    }, PAGE_MOVE_MENU_CLOSE_DELAY_MS);
  }, [cancelMoveMenuClose, closeMoveMenu]);

  const measureMoveMenu = useCallback(() => {
    if (moveMenuPhaseRef.current === "closed") return;
    const container = moveMenuContainerRef.current;
    const trigger = moveMenuTriggerRef.current;
    const menu = moveMenuElementRef.current;
    if (container === null || trigger === null || menu === null) return;
    const containerBounds = container.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const margin = 8;
    const gap = 6;
    const right = containerBounds.right + gap;
    const left = containerBounds.left - gap - menuBounds.width;
    const side =
      right + menuBounds.width <= viewportWidth - margin || left < margin ? "right" : "left";
    const menuLeft = side === "right" ? right : left;
    const maximumTop = viewportHeight - margin - menuBounds.height;
    const visibleTop = clamp(containerBounds.top, margin, Math.max(margin, maximumTop));
    const next: PageMoveMenuPosition = {
      side,
      top: visibleTop - containerBounds.top,
      originX: triggerBounds.left + triggerBounds.width / 2 - menuLeft,
      originY: triggerBounds.top + triggerBounds.height / 2 - visibleTop,
    };
    setMoveMenuPosition((current) =>
      current.side === next.side &&
      Math.abs(current.top - next.top) < 0.5 &&
      Math.abs(current.originX - next.originX) < 0.5 &&
      Math.abs(current.originY - next.originY) < 0.5
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    measureMoveMenu();
  }, [
    measureMoveMenu,
    moveMenuPhase,
    moveMenuPosition.originX,
    moveMenuPosition.originY,
    moveMenuPosition.side,
    moveMenuPosition.top,
    sections,
    style.left,
    style.top,
    target.key,
    target.phase,
  ]);

  useEffect(() => {
    if (moveMenuPhase === "closed") return;
    const handleResize = () => measureMoveMenu();
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [measureMoveMenu, moveMenuPhase]);

  useEffect(() => {
    if (target.phase === "closing" || !canMovePage) closeMoveMenu();
  }, [canMovePage, closeMoveMenu, target.phase]);

  useEffect(
    () => () => {
      clearMoveMenuTimers();
    },
    [clearMoveMenuTimers],
  );

  const moveMenuStyle = {
    "--page-move-menu-top": `${moveMenuPosition.top}px`,
    "--page-move-menu-origin-x": `${moveMenuPosition.originX}px`,
    "--page-move-menu-origin-y": `${moveMenuPosition.originY}px`,
  } as CSSProperties;
  const itemLabel = target.kind === "section" ? "section" : "page";
  return (
    <div
      ref={props.menuRef}
      className="hierarchy-context-menu"
      data-context-menu-phase={target.phase}
      role="menu"
      aria-label={`${target.title} ${itemLabel} actions`}
      style={style}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="hierarchy-context-menu__heading" aria-hidden="true">
        <span>{itemLabel}</span>
        <strong>{target.title}</strong>
      </div>
      {target.kind === "section" && (
        <div className="hierarchy-context-menu__color-control">
          <div className="hierarchy-context-menu__color-heading">
            <label htmlFor={`section-color-${target.sectionId}`}>Section color</label>
            <span>{sectionColor ?? "Theme"}</span>
          </div>
          <input
            id={`section-color-${target.sectionId}`}
            type="color"
            aria-label="Section color"
            title="Choose section color"
            value={sectionColor ?? SECTION_COLOR_PICKER_FALLBACK}
            disabled={mutationDisabled}
            onChange={(event) => onSectionColorChange(event.currentTarget.value)}
          />
          <button
            type="button"
            role="menuitem"
            disabled={mutationDisabled || sectionColor === undefined}
            onClick={() => onSectionColorChange(undefined)}
          >
            <span aria-hidden="true">↺</span> Use theme color
          </button>
        </div>
      )}
      {target.kind === "page" && (
        <div
          ref={moveMenuContainerRef}
          className="hierarchy-context-menu__move-page"
          onPointerEnter={cancelMoveMenuClose}
          onPointerLeave={scheduleMoveMenuClose}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              moveMenuContainerRef.current?.contains(event.relatedTarget)
            ) {
              return;
            }
            scheduleMoveMenuClose();
          }}
        >
          <button
            ref={moveMenuTriggerRef}
            type="button"
            role="menuitem"
            aria-label="Move page to section"
            aria-haspopup="menu"
            aria-expanded={moveMenuPhase === "opening" || moveMenuPhase === "open"}
            aria-controls={`page-move-menu-${target.pageId}`}
            disabled={!canMovePage}
            onPointerEnter={() => openMoveMenu()}
            onFocus={() => openMoveMenu()}
            onClick={(event) => {
              event.stopPropagation();
              openMoveMenu();
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              openMoveMenu(true);
            }}
          >
            <span aria-hidden="true">⇥</span>
            Move page to section
            <span className="hierarchy-context-menu__submenu-arrow" aria-hidden="true">
              ›
            </span>
          </button>
          {moveMenuPhase !== "closed" && (
            <div
              ref={moveMenuElementRef}
              id={`page-move-menu-${target.pageId}`}
              className="hierarchy-context-menu__move-page-submenu"
              data-page-move-menu-phase={moveMenuPhase}
              data-page-move-menu-side={moveMenuPosition.side}
              role="menu"
              aria-label="Move page to section"
              style={moveMenuStyle}
              onPointerEnter={cancelMoveMenuClose}
              onPointerLeave={scheduleMoveMenuClose}
            >
              {moveTargets.map((section) => (
                <button
                  key={section.manifest.id}
                  type="button"
                  role="menuitem"
                  disabled={mutationDisabled}
                  onClick={() => onMovePage(section.manifest.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeMoveMenu(true);
                    }
                  }}
                >
                  <span aria-hidden="true">→</span>
                  {section.manifest.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button type="button" role="menuitem" disabled={mutationDisabled} onClick={onAdd}>
        <span aria-hidden="true">＋</span> Add {itemLabel} below
      </button>
      <button type="button" role="menuitem" onClick={onCopy}>
        <span aria-hidden="true">⧉</span> Copy {itemLabel}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={mutationDisabled || !canPaste}
        onClick={onPaste}
      >
        <span aria-hidden="true">↳</span> Paste {itemLabel} below
      </button>
      <button type="button" role="menuitem" disabled={mutationDisabled} onClick={onDuplicate}>
        <span aria-hidden="true">⧉</span> Duplicate {itemLabel}
      </button>
      <div className="hierarchy-context-menu__separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="hierarchy-context-menu__delete"
        disabled={mutationDisabled}
        onClick={onDelete}
      >
        <span aria-hidden="true">×</span> Delete {itemLabel}
      </button>
    </div>
  );
};

function BookmarkIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7.25 3.75h9.5a1.5 1.5 0 0 1 1.5 1.5v15l-6.25-4.25-6.25 4.25v-15a1.5 1.5 0 0 1 1.5-1.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function NavigationResizeHandle({
  kind,
  width,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
}: {
  readonly kind: NavigationPanelKind;
  readonly width: number | undefined;
  readonly onPointerDown: (
    kind: NavigationPanelKind,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onPointerMove: (
    kind: NavigationPanelKind,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onPointerUp: (
    kind: NavigationPanelKind,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onPointerCancel: (kind: NavigationPanelKind) => void;
  readonly onLostPointerCapture: (kind: NavigationPanelKind) => void;
  readonly onKeyDown: (
    kind: NavigationPanelKind,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}) {
  const isSection = kind === "section";
  return (
    <button
      className={`navigation-resize-handle ${isSection ? "is-section-resize" : "is-page-resize"}`}
      type="button"
      role="separator"
      aria-label={isSection ? "Resize sections panel" : "Resize pages panel"}
      aria-orientation="vertical"
      aria-valuemin={isSection ? NAVIGATION_SECTION_MIN_WIDTH : NAVIGATION_PAGE_MIN_WIDTH}
      aria-valuemax={isSection ? NAVIGATION_SECTION_MAX_WIDTH : NAVIGATION_PAGE_MAX_WIDTH}
      aria-valuenow={Math.round(
        width ?? (isSection ? NAVIGATION_SECTION_DEFAULT_WIDTH : NAVIGATION_PAGE_DEFAULT_WIDTH),
      )}
      title={isSection ? "Resize sections panel" : "Resize pages panel"}
      onPointerDown={(event) => onPointerDown(kind, event)}
      onPointerMove={(event) => onPointerMove(kind, event)}
      onPointerUp={(event) => onPointerUp(kind, event)}
      onPointerCancel={() => onPointerCancel(kind)}
      onLostPointerCapture={() => onLostPointerCapture(kind)}
      onKeyDown={(event) => onKeyDown(kind, event)}
    />
  );
}

function contextMenuStyle(menu: ContextMenuState): CSSProperties {
  return {
    left: `${menu.left}px`,
    top: `${menu.top}px`,
    "--context-menu-origin-x": `${menu.originX}px`,
    "--context-menu-origin-y": `${menu.originY}px`,
  } as CSSProperties;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function ReorderDropIndicator() {
  return (
    <li className="reorder-drop-indicator" aria-hidden="true">
      <span />
    </li>
  );
}

function isContextMenuTriggerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-context-menu-trigger]") !== null;
}

function reorderKey(kind: ReorderKind, id: string): string {
  return `${kind}:${id}`;
}

function contextMenuAnchorForEvent(event: ReactMouseEvent<HTMLElement>): {
  readonly x: number;
  readonly y: number;
} {
  if (event.detail !== 0) return { x: event.clientX, y: event.clientY };
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: bounds.right, y: bounds.bottom };
}

function dropSlotForPointer(
  list: HTMLOListElement,
  draggedId: string,
  clientX: number,
  clientY: number,
): number {
  const items = Array.from(list.children).filter(
    (child): child is HTMLLIElement =>
      child instanceof HTMLLIElement && child.dataset.reorderId !== undefined,
  );
  const remaining = items.filter((item) => item.dataset.reorderId !== draggedId);
  const computed = window.getComputedStyle(list);
  const horizontal = computed.display === "flex" && computed.flexDirection.startsWith("row");
  const pointer = horizontal ? clientX : clientY;
  for (const [index, item] of remaining.entries()) {
    const rect = item.getBoundingClientRect();
    const midpoint = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    if (pointer < midpoint) return index;
  }
  return remaining.length;
}

function sectionDropTargetForPointer(clientX: number, clientY: number): string | undefined {
  const element = document.elementFromPoint(clientX, clientY);
  const section = element?.closest<HTMLElement>("[data-section-drop-target]");
  return section?.dataset.sectionDropTarget;
}

export function selectSection(
  hierarchy: NotebookHierarchy,
  section: NotebookSection,
  update: (selection: Selection) => void,
): void {
  const pageId = section.pages[0]?.id;
  update({ sectionId: section.manifest.id, ...(pageId === undefined ? {} : { pageId }) });
  if (pageId !== undefined)
    navigateToPage(hierarchy.notebook.projectId, section.manifest.id, pageId);
  else history.replaceState(null, "", "#/");
}

export function navigateToPage(projectId: string, sectionId: string, pageId: string): void {
  location.hash = pageRoute(projectId, { sectionId, pageId });
}

function pageRoute(projectId: string, selection: Selection): string {
  return selection.sectionId !== undefined && selection.pageId !== undefined
    ? `#/projects/${projectId}/sections/${selection.sectionId}/pages/${selection.pageId}`
    : "#/";
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length)
    return [...items];
  const result = [...items];
  const [item] = result.splice(from, 1);
  if (item !== undefined) result.splice(to, 0, item);
  return result;
}
