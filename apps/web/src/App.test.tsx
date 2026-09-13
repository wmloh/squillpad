import { describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";

import {
  CANONICAL_SCHEMA_VERSION,
  MARKDOWN_COLOR_KEYS,
  type CanvasElement,
  type NotebookHierarchy,
} from "@squillpad/core-model";
import {
  CanvasFileMenu,
  DEFAULT_DRAWING_PREFERENCES,
  DEFAULT_PROFILE_DRAWING_PALETTES,
  DRAWING_PREFERENCES_KEY,
  MarkdownBlock,
  MarkdownPreview,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
  SpatialCanvas,
} from "@squillpad/ui";

import {
  App,
  createProjectPresenceClientId,
  HelpGuides,
  HostStoppedNotification,
  ProjectPresenceAvatars,
  isHostSession,
  moveItem,
  parseLaserPointers,
  parsePageRoute,
  requiresProfileAuthentication,
  resolveSelection,
  saveStatusTooltip,
  synchronizationStatusForSharing,
  synchronizationStatusTooltip,
} from "./App";
import { AppChrome, type AppChromeProps } from "./AppChrome";
import { ConnectionScreen } from "./ConnectionScreen";
import type { RepositorySynchronizationHandle } from "./RepositorySynchronization";
import mathFixture from "./test-fixtures/math.md?raw";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PROJECT_ID = "018f1f2e-7c8a-7b1c-8d2e-3f4a5b6c7d8e";
const SECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PAGE_ID = "223e4567-e89b-42d3-a456-426614174001";
const hierarchy: NotebookHierarchy = {
  notebook: {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    projectId: PROJECT_ID,
    title: "Test",
    sectionIds: [SECTION_ID],
    settings: { defaultZoom: 1, metadata: {} },
  },
  sections: [
    {
      manifest: {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        id: SECTION_ID,
        title: "Section",
        pageIds: [PAGE_ID],
        metadata: {},
      },
      pages: [
        { schemaVersion: CANONICAL_SCHEMA_VERSION, id: PAGE_ID, title: "Page", metadata: {} },
      ],
    },
  ],
};

function appChromeProps(hostSession: boolean): AppChromeProps {
  return {
    theme: "light",
    projectTitle: "Test",
    projectTitleDisabled: false,
    onProjectTitleCommit: () => undefined,
    projectPresence: [],
    currentPresenceId: undefined,
    selectedPageId: undefined,
    busy: false,
    selectedSaveLabel: "Saved",
    selectedSaveStatus: "saved",
    selectedSaveDirty: false,
    selectedPageIsSaving: false,
    selectedSyncStatus: "synchronized",
    selectedSaveTooltip: "All changes are saved.",
    selectedSyncTooltip: "This page is synchronized with the host.",
    lanSharingEnabled: false,
    hostSession,
    clientReadOnly: false,
    saveCurrentPage: () => undefined,
    lanSharingRef: createRef<HTMLDetailsElement>(),
    onLanSharingEnabledChange: () => undefined,
    storageDiagnosticsRef: createRef<HTMLDetailsElement>(),
    storageDiagnostics: {
      canonicalBytes: 120,
      canonicalFileCount: 3,
      runtimeCacheBytes: 40,
      runtimeCacheFileCount: 2,
    },
    cleaningRuntimeCache: false,
    onClearRuntimeCache: () => undefined,
    repositorySynchronizationRef: createRef<RepositorySynchronizationHandle>(),
    authenticatedUsername: undefined,
    onLogout: () => undefined,
    hostStopRef: createRef<HTMLDetailsElement>(),
    stoppingHost: false,
    onStopHosting: () => undefined,
    onSyncNowBeforeStopping: () => undefined,
    error: undefined,
    onDismissError: () => undefined,
    clientHostingStopped: false,
    hostStoppedNotificationOpen: false,
    onDismissHostStoppedNotification: () => undefined,
  };
}

describe("App", () => {
  it("is a renderable component", () => {
    expect(typeof App).toBe("function");
  });

  it("renders a dismissible host-stopped notification", () => {
    const html = renderToStaticMarkup(<HostStoppedNotification onDismiss={() => undefined} />);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Host stopped hosting");
    expect(html).toContain('aria-label="Dismiss host stopped notification"');
    expect(html).toContain('class="host-stopped-notification__close"');
  });

  it("reports local editing when LAN sharing is disabled and keeps tooltips untruncated", () => {
    expect(synchronizationStatusForSharing("synchronized", false)).toBe("offline");
    expect(synchronizationStatusForSharing("synchronized", undefined)).toBe("synchronized");

    const synchronizationTooltip = synchronizationStatusTooltip("offline");
    const saveTooltip = saveStatusTooltip("saving", false, true, false);
    expect(synchronizationTooltip).toContain("Offline — editing locally");
    expect(`${synchronizationTooltip}\n${saveTooltip}`).not.toMatch(/…|\.\.\./);
  });

  it("renders self and duplicate profile presence avatars with hover details", () => {
    const html = renderToStaticMarkup(
      <ProjectPresenceAvatars
        currentMemberId="second-client"
        members={[
          { id: "first-client", username: "alice", ipAddress: "192.168.1.20" },
          { id: "second-client", username: "alice", ipAddress: "192.168.1.21" },
        ]}
      />,
    );
    expect(html.match(/class="project-presence-avatar"/g)).toHaveLength(1);
    expect(html.match(/class="project-presence-avatar is-current-user"/g)).toHaveLength(1);
    expect(html).toContain(">A</span>");
    expect(html).toContain('title="alice — 192.168.1.20"');
    expect(html).toContain('title="alice — 192.168.1.21"');
  });

  it("keeps the project presence client ID across a tab refresh", () => {
    const key = "squillpad:project-presence-client-id";
    const previous = sessionStorage.getItem(key);
    try {
      sessionStorage.removeItem(key);
      const first = createProjectPresenceClientId();
      expect(sessionStorage.getItem(key)).toBe(first);
      expect(createProjectPresenceClientId()).toBe(first);
    } finally {
      if (previous === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, previous);
    }
  });

  it("waits for a disclosure to open before measuring its menu origin", () => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const menu = document.createElement("div");
    menu.dataset.animatedMenu = "";
    details.append(summary, menu);
    document.body.append(details);
    vi.spyOn(summary, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 100,
      width: 30,
      height: 30,
    } as DOMRect);
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: -250,
      width: 200,
      height: 300,
    } as DOMRect);

    try {
      prepareAnimatedMenuFromSummary(summary);
      expect(details.dataset.menuPhase).toBe("opening");
      expect(menu.style.getPropertyValue("--menu-origin-y")).toBe("");

      details.open = true;
      prepareAnimatedMenu(details);
      expect(details.dataset.menuPhase).toBe("opening");
      expect(menu.style.getPropertyValue("--menu-origin-y")).toBe("215px");
    } finally {
      details.remove();
    }
  });

  it("renders a browser connection form when no notebook is available", () => {
    const html = renderToStaticMarkup(<ConnectionScreen error="No project is open." />);
    expect(html).toContain("Authorized host URL");
    expect(html).toContain("No project is open.");
    expect(html).toContain("Connect");
  });

  it("retries a transient repository hierarchy response and opens the notebook", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    let hierarchyRequests = 0;
    const emptyNotebook: NotebookHierarchy = {
      notebook: {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        projectId: PROJECT_ID,
        title: "Recovered notebook",
        sectionIds: [],
        settings: { defaultZoom: 1, metadata: {} },
      },
      sections: [],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (String(input)) {
        case "/api/auth/status":
          return appResponse({ authenticated: true, hostAuthorized: true, username: "owner" });
        case "/api/hierarchy":
          hierarchyRequests += 1;
          return hierarchyRequests === 1
            ? appResponse(
                { error: "Repository snapshot operation in progress; retry shortly" },
                409,
              )
            : appResponse(emptyNotebook);
        case "/api/sync/status":
          return appResponse({ synchronizationGeneration: "018f1f2e-7c8a-7b1c-8d2e-3f4a5b6c7d8f" });
        case "/api/sharing":
          return appResponse({ enabled: false, connections: [] });
        case "/api/storage/diagnostics":
          return appResponse({
            canonicalBytes: 0,
            canonicalFileCount: 0,
            runtimeCacheBytes: 0,
            runtimeCacheFileCount: 0,
          });
        case "/api/presence":
          return appResponse({ participants: [] });
        case "/api/repository-sync/status":
          return appResponse({ error: "host only" }, 403);
        default:
          throw new Error(`Unexpected request: ${String(input)}`);
      }
    });

    try {
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(container.querySelector<HTMLInputElement>('[aria-label="Project title"]')?.value).toBe(
        "Recovered notebook",
      );
      expect(container.textContent).not.toContain("Connect to a SquillPad notebook");
      expect(hierarchyRequests).toBe(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("shows a retryable update error after bounded hierarchy retries are exhausted", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    let hierarchyRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (String(input)) {
        case "/api/auth/status":
          return appResponse({ authenticated: true, hostAuthorized: true, username: "owner" });
        case "/api/hierarchy":
          hierarchyRequests += 1;
          return appResponse(
            { error: "Repository snapshot operation in progress; retry shortly" },
            409,
          );
        case "/api/sync/status":
          return appResponse({ synchronizationGeneration: "018f1f2e-7c8a-7b1c-8d2e-3f4a5b6c7d8f" });
        case "/api/sharing":
          return appResponse({ enabled: false, connections: [] });
        case "/api/repository-sync/status":
          return appResponse({ error: "host only" }, 403);
        default:
          throw new Error(`Unexpected request: ${String(input)}`);
      }
    });

    try {
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(hierarchyRequests).toBe(5);
      expect(container.textContent).toContain("Updating notebook");
      expect(container.textContent).toContain("Retry opening notebook");
      expect(container.textContent).not.toContain("Connect to a SquillPad notebook");
      expect(container.textContent).toContain("still being updated from its repository");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("shows the username requirements on the authentication form", () => {
    const html = renderToStaticMarkup(<ConnectionScreen authentication />);
    expect(html).toContain("3–32 characters");
    expect(html).toContain("Usernames are saved in lowercase");
    expect(html).not.toContain('minLength="12"');
  });

  it("keeps a profiled host browser authorized for host-only controls", () => {
    expect(
      requiresProfileAuthentication({
        authenticated: true,
        hostAuthorized: true,
        username: "owner",
      }),
    ).toBe(false);
    expect(requiresProfileAuthentication({ authenticated: true, hostAuthorized: true })).toBe(true);
    expect(
      requiresProfileAuthentication({
        authenticated: true,
        hostAuthorized: false,
        username: "reader",
      }),
    ).toBe(false);
  });

  it("keeps the host-stop control exclusive to the host session", () => {
    expect(isHostSession(undefined, "127.0.0.1")).toBe(true);
    expect(isHostSession({ authenticated: true, hostAuthorized: true }, "localhost")).toBe(true);
    expect(isHostSession({ authenticated: true, hostAuthorized: true }, "192.168.1.20")).toBe(
      false,
    );
    expect(
      isHostSession(
        { authenticated: true, hostAuthorized: false, username: "reader" },
        "localhost",
      ),
    ).toBe(false);
  });

  it("keeps storage diagnostics and runtime cache cleanup host-only", () => {
    const hostHtml = renderToStaticMarkup(<AppChrome {...appChromeProps(true)} />);
    const clientHtml = renderToStaticMarkup(<AppChrome {...appChromeProps(false)} />);

    expect(hostHtml).toContain('class="storage-diagnostics"');
    expect(hostHtml).toContain("Clear runtime cache");
    expect(clientHtml).not.toContain("storage-diagnostics");
    expect(clientHtml).not.toContain("Clear runtime cache");
  });

  it("renders the complete Phase 4 drawing toolbar", () => {
    const html = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} />);
    expect(html).toContain(">Pen<");
    expect(html).toContain(">Highlight<");
    expect(html).toContain(">Erase<");
    expect(html).toContain(">Insert space</span>");
    expect(html).toContain(">Laser<");
    expect(html).toContain('title="Insert or remove vertical space"');
    expect(html).toContain('title="Insert or remove vertical space"><svg class="tool-icon"');
    expect(html).not.toContain('aria-keyshortcuts="I"');
    expect(html).not.toContain(">Lasso<");
    expect(html).toContain(">Arrow<");
    expect(html).not.toContain("Pen draws, touch navigates");
    expect(html).not.toContain("Export block Markdown");
    expect(html).toContain('class="tool-group canvas-tool-menu canvas-shape-menu"');
    expect(html).toContain('title="Line tool"><svg class="tool-icon"');
    expect(html).toContain('title="Arrow tool"><svg class="tool-icon"');
    expect(html).toContain('title="Rectangle tool"><svg class="tool-icon"');
    expect(html).toContain('title="Ellipse tool"><svg class="tool-icon"');
    expect(html).toContain(">Rectangle</span>");
    expect(html).toContain('aria-label="Select"');
    expect(html).toContain('aria-label="Hand"');
    expect(html).toContain('aria-label="Miscellaneous tools"');
    expect(html).toContain("Picture in picture");
    expect(html).toContain(
      'title="Picture in picture: draw a region to keep a live, read-only reference view"',
    );
    expect(html).toContain("Search Markdown text");
    expect(html).toContain('aria-label="Enter fullscreen"');
    expect(html).toContain('aria-label="Copy selected objects"');
    expect(html).toContain('aria-label="Paste objects"');
    expect(html).not.toContain(">Cut<");
    expect(html).not.toContain("Shortcuts");
    expect(html).toContain('title="Pen (P)"');
    expect(html).toContain('class="spatial-canvas-frame"');
    expect(html).not.toContain("canvas-export-message");
    expect(html).not.toContain("Exported PNG");

    const fullscreen = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} fullscreen />);
    expect(fullscreen).not.toContain(">Actions<");
    expect(fullscreen).toContain('aria-label="Copy selected objects"');
    expect(fullscreen).toContain('aria-label="Paste objects"');
    expect(fullscreen).toContain('aria-label="Send selected objects to back"');
    expect(fullscreen).toContain('aria-label="Send selected objects backward"');
    expect(fullscreen).toContain('aria-label="Bring selected objects forward"');
    expect(fullscreen).toContain('aria-label="Bring selected objects to front"');
    expect(fullscreen).toContain('aria-label="Group selection"');
    expect(fullscreen).not.toContain('aria-label="Duplicate selection"');

    const ruled = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} pageBackground="ruled" />);
    expect(ruled).toContain("page-background-ruled");

    const presentation = renderToStaticMarkup(
      <SpatialCanvas pageId={PAGE_ID} presentationOnly readOnly />,
    );
    expect(presentation).not.toContain('aria-label="Canvas controls"');
    expect(presentation).toContain('aria-label="Picture-in-picture canvas view"');
    expect(presentation).toContain('tabindex="-1"');
    expect(presentation).not.toContain('class="canvas-status"');
  });

  it("shows the Markdown style manager when the Text tool is active", () => {
    window.localStorage.setItem(
      DRAWING_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "text" }),
    );
    const html = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} />);
    window.localStorage.removeItem(DRAWING_PREFERENCES_KEY);

    expect(html).toContain("Edit styles");
    expect(html).toContain('aria-label="Markdown color styles"');
    expect(html).toContain("Original");
    expect(html).toContain('class="toggle-switch settings-toggle markdown-style-editor__default-toggle"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Default for new text boxes");
    expect(html).toContain("Heading 3");
    expect(html).toContain("Code background");
    expect(html).toContain("Footnotes");
    expect(html).toContain("Highlight background");
    expect(html).toContain("light/dark");
    expect(html).toContain('aria-label="Body text Light mode color"');
    expect(html).toContain('aria-label="Body text Dark mode color"');
    expect(html).not.toContain("Strikethrough");
    expect(html).not.toContain("Ordered lists");
    expect(html).not.toContain("Unordered lists");
    expect(html).not.toContain("Tables");
    expect(html).not.toContain("Highlight text");
  });

  it("keeps the laser control available on a read-only canvas when explicitly allowed", () => {
    const html = renderToStaticMarkup(
      <SpatialCanvas pageId={PAGE_ID} readOnly allowLaserPointer />,
    );
    expect(html).toContain("is-read-only-laser");
    expect(html).toContain(">Laser<");
    expect(html).toContain('aria-label="Read-only page canvas"');
    expect(html).toContain('aria-label="Hand"');
  });

  it("renders a selectable reflective frame for a text-box group", () => {
    const textGroupId = "723e4567-e89b-42d3-a456-426614174006";
    const element: CanvasElement = {
      id: "323e4567-e89b-42d3-a456-426614174002",
      kind: "markdown",
      position: [10, 20],
      z: 0,
      width: 280,
      height: 140,
      source: "markdown/323e4567-e89b-42d3-a456-426614174002.md",
      textGroupId,
    };
    const html = renderToStaticMarkup(
      <SpatialCanvas
        pageId={PAGE_ID}
        elements={[element]}
        markdownSources={{ [element.id]: "A" }}
      />,
    );

    expect(html).toContain('class="canvas-text-box-group"');
    expect(html).toContain('aria-label="Select and move text box group"');
    expect(html).toContain("left:-2px");
    expect(html).toContain("width:304px");
  });

  it("renders the momentary touch control only for fullscreen palm rejection mode", () => {
    const standard = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} />);
    expect(standard).not.toContain("canvas-touch-override");

    const windowedPalmRejection = renderToStaticMarkup(
      <SpatialCanvas pageId={PAGE_ID} palmRejection />,
    );
    expect(windowedPalmRejection).not.toContain("is-palm-rejection");
    expect(windowedPalmRejection).not.toContain("canvas-touch-override");

    const fullscreenPalmRejection = renderToStaticMarkup(
      <SpatialCanvas pageId={PAGE_ID} fullscreen palmRejection />,
    );
    expect(fullscreenPalmRejection).toContain("is-palm-rejection");
    expect(fullscreenPalmRejection).toContain('class="canvas-touch-override"');
    expect(fullscreenPalmRejection).toContain(
      'aria-label="Hold to enable canvas touch interactions"',
    );
    expect(fullscreenPalmRejection).toContain("panning or zooming");
  });

  it("renders the file menu controls for the page header", () => {
    const html = renderToStaticMarkup(
      <CanvasFileMenu
        exportRegionMode="content"
        selectionAvailable={false}
        onImportMarkdown={() => undefined}
        onExportMarkdown={() => undefined}
        onExportRegionModeChange={() => undefined}
        onExportSvg={() => undefined}
        onExportPng={() => undefined}
      />,
    );
    expect(html).toContain(">Page<");
    expect(html).toContain(">Import Markdown<");
    expect(html).toContain(">Export page Markdown<");
    expect(html).toContain(">Export SVG<");
    expect(html).toContain(">Export PNG<");
  });

  it("can disable imports while retaining local page exports", () => {
    const html = renderToStaticMarkup(
      <CanvasFileMenu
        importDisabled
        exportRegionMode="content"
        selectionAvailable={false}
        onImportMarkdown={() => undefined}
        onExportMarkdown={() => undefined}
        onExportRegionModeChange={() => undefined}
        onExportSvg={() => undefined}
        onExportPng={() => undefined}
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain(">Export page Markdown<");
  });

  it("uses the configured laser decay duration for fading traces", () => {
    const html = renderToStaticMarkup(
      <SpatialCanvas
        pageId={PAGE_ID}
        laserPointerDecaySeconds={2.7}
        remoteLaserPointers={[
          { active: false, color: "#ef3e58", id: "laser", points: [{ x: 10, y: 20 }] },
        ]}
      />,
    );
    expect(html).toContain('class="canvas-laser-trail is-fading"');
    expect(html).toContain("animation-duration:2.7s");
  });

  it("keeps laser traces above the canvas stacking order", () => {
    const html = renderToStaticMarkup(
      <SpatialCanvas
        pageId={PAGE_ID}
        elements={[
          {
            id: "markdown-element",
            kind: "markdown",
            position: [0, 0],
            z: 42,
            width: 120,
            height: 80,
            source: "markdown/markdown-element.md",
          },
        ]}
        remoteLaserPointers={[
          { active: true, color: "#ef3e58", id: "laser", points: [{ x: 10, y: 20 }] },
        ]}
      />,
    );

    expect(html).toContain('style="animation-duration:1.4s;z-index:44"');
  });

  it("parses all laser traces in a presence payload", () => {
    const first = { active: false, color: "#ef3e58", id: "first", points: [{ x: 10, y: 20 }] };
    const second = { active: true, color: "#ef3e58", id: "second", points: [{ x: 30, y: 40 }] };

    expect(parseLaserPointers([first, second])).toEqual([first, second]);
    expect(parseLaserPointers(first)).toEqual([first]);
  });

  it("renders Guide as a link to the full guide in a new tab", () => {
    const html = renderToStaticMarkup(<HelpGuides />);
    expect(html).toContain('href="./docs.html"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">Guide</a>");
  });

  it("renders one-pixel ink thickness steps and the shared shape palette", () => {
    const previous = localStorage.getItem(DRAWING_PREFERENCES_KEY);
    try {
      localStorage.setItem(
        DRAWING_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "pen" }),
      );
      const pen = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} />);
      expect(pen).toContain('aria-keyshortcuts="1"');
      expect(pen).toContain('class="radial-toolbar-toggle"');
      expect(pen).toContain('class="radial-toolbar-toggle__track"');
      expect(pen).toContain('aria-label="Ink thickness"');
      expect(pen).toContain('min="2"');
      expect(pen).toContain('max="30"');
      expect(pen).toContain('step="1"');

      localStorage.setItem(
        DRAWING_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "highlighter" }),
      );
      const highlighter = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} />);
      expect(highlighter).toContain('aria-label="Ink height"');
      expect(highlighter).toContain('min="10"');
      expect(highlighter).toContain('max="40"');
      expect(highlighter).toContain('step="2"');

      localStorage.setItem(
        DRAWING_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "rectangle" }),
      );
      const shape = renderToStaticMarkup(<SpatialCanvas pageId={PAGE_ID} />);
      expect(shape).toContain('aria-label="Use shape color #9ca3af"');
      expect(shape).toContain('aria-label="Use shape color #c4b5fd"');
    } finally {
      if (previous === null) localStorage.removeItem(DRAWING_PREFERENCES_KEY);
      else localStorage.setItem(DRAWING_PREFERENCES_KEY, previous);
    }
  });

  it("renders the profile custom palette mode without the direct thickness controls", () => {
    const customPalettes = {
      ...DEFAULT_PROFILE_DRAWING_PALETTES,
      pen: { ...DEFAULT_PROFILE_DRAWING_PALETTES.pen, custom: true },
      highlighter: { ...DEFAULT_PROFILE_DRAWING_PALETTES.highlighter, custom: true },
      shape: { ...DEFAULT_PROFILE_DRAWING_PALETTES.shape, custom: true },
    };
    const previous = localStorage.getItem(DRAWING_PREFERENCES_KEY);
    try {
      localStorage.setItem(
        DRAWING_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "pen" }),
      );
      const pen = renderToStaticMarkup(
        <SpatialCanvas
          pageId={PAGE_ID}
          profileDrawingPalettes={customPalettes}
          elements={[]}
        />,
      );
      expect(pen).toContain(">Custom<");
      expect(pen).toContain('aria-label="Use custom pen colors"');
      expect(pen).not.toContain('aria-label="Ink thickness"');

      localStorage.setItem(
        DRAWING_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "rectangle" }),
      );
      const shape = renderToStaticMarkup(
        <SpatialCanvas
          pageId={PAGE_ID}
          profileDrawingPalettes={customPalettes}
          elements={[]}
        />,
      );
      expect(shape).not.toContain('aria-label="Shape stroke width"');
    } finally {
      if (previous === null) localStorage.removeItem(DRAWING_PREFERENCES_KEY);
      else localStorage.setItem(DRAWING_PREFERENCES_KEY, previous);
    }
  });

  it("parses stable page routes and ignores unrelated hashes", () => {
    expect(
      parsePageRoute(`#/projects/${PROJECT_ID}/sections/${SECTION_ID}/pages/${PAGE_ID}`),
    ).toEqual({ projectId: PROJECT_ID, sectionId: SECTION_ID, pageId: PAGE_ID });
    expect(parsePageRoute("#/settings")).toEqual({});
  });

  it("resolves invalid transient selection to canonical first entries", () => {
    history.replaceState(null, "", "#/settings");
    sessionStorage.clear();
    expect(resolveSelection(hierarchy, { sectionId: "missing", pageId: "missing" })).toEqual({
      sectionId: SECTION_ID,
      pageId: PAGE_ID,
    });
  });

  it("moves ordered IDs without mutating the source", () => {
    const source = ["one", "two", "three"];
    expect(moveItem(source, 2, 0)).toEqual(["three", "one", "two"]);
    expect(source).toEqual(["one", "two", "three"]);
  });

  it("renders ordinary and GitHub-Flavored Markdown structures", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source={
          "# Heading\n\n*emphasis*\n\n> quote\n\n- item\n\n[link](https://example.com)\n\n```ts\nconst value = 1;\n```\n\n| A | B |\n| - | - |\n| one | two |"
        }
      />,
    );

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain('href="https://example.com/"');
    expect(html).toMatch(/<code class="[^"]*hljs[^"]*language-ts[^"]*">/);
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain("<table>");
  });

  it("auto-highlights an unlabeled Python code block", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview source={"```\ndef greet(name):\n    return f\"Hello, {name}\"\n```"} />,
    );

    expect(html).toContain('<span class="hljs-keyword">def</span>');
  });

  it("renders GFM footnotes, explicit heading IDs, and inline highlights", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source={"# Heading {#custom-id}\n\n==Important== text[^note]\n\n[^note]: Footnote text"}
      />,
    );

    expect(html).toContain('<h1 id="custom-id">Heading</h1>');
    expect(html).toContain('<mark class="markdown-highlight">Important</mark>');
    expect(html).toContain('class="footnotes"');
    expect(html).toContain("Footnote text");
  });

  it("highlights Markdown search matches in rendered content", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source="Alpha alpha"
        searchQuery="alpha"
        searchMatchOffset={0}
        activeSearchMatch={1}
      />,
    );

    expect(html).toContain('data-markdown-search-match="0"');
    expect(html).toContain('data-markdown-search-match="1"');
    expect(html).toContain("markdown-search-match is-active");
  });

  it("renders each Markdown hard break inserted for blank space", () => {
    const source = "Start" + ("\\" + "\n").repeat(5) + "\nEnd";
    const html = renderToStaticMarkup(<MarkdownPreview source={source} />);

    expect(html.match(/<br\s*\/?\s*>/g)).toHaveLength(5);
    expect(html).not.toContain("\\");
  });

  it("renders inline and display math from unchanged Markdown source", () => {
    const html = renderToStaticMarkup(<MarkdownPreview source={mathFixture} />);
    const sameLineDisplayHtml = renderToStaticMarkup(
      <MarkdownPreview source={"Inline $x^2$ and display:\n\n$$y = mx + b$$"} />,
    );

    expect(html).toContain('<span class="katex">');
    expect(html).toContain('<span class="katex-display">');
    expect(sameLineDisplayHtml).toContain('<span class="katex-display">');
    expect(html).toContain(
      '<annotation encoding="application/x-tex">\\alpha^2 + \\beta_i = \\gamma</annotation>',
    );
    expect(html).toContain("\\begin{bmatrix}");
    expect(html).toContain("\\begin{aligned}");
    expect(mathFixture).toContain("$\\alpha^2 + \\beta_i = \\gamma$");
    expect(mathFixture).toContain("$$\n\\int_{-\\infty}^{\\infty}");
  });

  it("keeps the rendered block visible behind the floating Markdown editor", () => {
    const html = renderToStaticMarkup(
      <MarkdownBlock
        boxOpacity={1}
        editing
        fontSize={22}
        source={"# Active\n\n**Rendered**"}
        onChange={() => undefined}
        onCommit={() => undefined}
        onFinishEditing={() => undefined}
        onHeightChange={() => undefined}
      />,
    );
    expect(html).toContain("markdown-source-editor");
    expect(html).toContain("markdown-editor-popover");
    expect(html).toContain("Markdown source");
    expect(html).toContain('aria-label="Undo Markdown changes"');
    expect(html).toContain('aria-label="Redo Markdown changes"');
    expect(html).toContain('class="markdown-editor-icon"');
    expect(html).toContain('class="markdown-editor-icon markdown-editor-close-icon"');
    expect(html).toContain('aria-label="Close Markdown editor"');
    expect(html).toContain("Create text box group");
    expect(html).not.toContain("Add text box below");
    expect(html).toContain("--markdown-font-size:22px");
    expect(html).not.toContain("markdown-inline-editor");
    expect(html).toContain("<strong>Rendered</strong>");
    expect(html).not.toContain("</>");
  });

  it("applies a named color style without changing Markdown source", () => {
    const colors = Object.fromEntries(
      MARKDOWN_COLOR_KEYS.map((key) => [
        key,
        {
          light: key === "bold" ? "#ff0000" : "#123456",
          dark: key === "bold" ? "#00ff00" : "#654321",
        },
      ]),
    ) as Record<(typeof MARKDOWN_COLOR_KEYS)[number], { light: string; dark: string }>;
    const style = { id: SECTION_ID, name: "Lecture", colors };
    const source = "**Unchanged**";
    const html = renderToStaticMarkup(
      <MarkdownBlock
        boxOpacity={1}
        editing
        source={source}
        colorStyle={style}
        colorStyles={[style]}
        markdownStyleId={style.id}
        onMarkdownStyleChange={() => undefined}
        onChange={() => undefined}
        onCommit={() => undefined}
        onFinishEditing={() => undefined}
        onHeightChange={() => undefined}
      />,
    );

    expect(source).toBe("**Unchanged**");
    expect(html).toContain("<strong>Unchanged</strong>");
    expect(html).toContain("--markdown-color-bold:#ff0000");
    expect(html).toContain('<option value="">Original</option>');
    expect(html).toContain(`value="${SECTION_ID}" selected="">Lecture`);

    const darkHtml = renderToStaticMarkup(
      <MarkdownBlock
        boxOpacity={1}
        editing
        source={source}
        theme="dark"
        colorStyle={style}
        colorStyles={[style]}
        markdownStyleId={style.id}
        onMarkdownStyleChange={() => undefined}
        onChange={() => undefined}
        onCommit={() => undefined}
        onFinishEditing={() => undefined}
        onHeightChange={() => undefined}
      />,
    );
    expect(darkHtml).toContain("--markdown-color-bold:#00ff00");
  });

  it("shows add and detach controls for a grouped Markdown editor", () => {
    const html = renderToStaticMarkup(
      <MarkdownBlock
        boxOpacity={1}
        editing
        source="Grouped"
        textGroupId={SECTION_ID}
        onChange={() => undefined}
        onCommit={() => undefined}
        onFinishEditing={() => undefined}
        onHeightChange={() => undefined}
      />,
    );

    expect(html).toContain("Add text box below");
    expect(html).toContain("Detach");
    expect(html).not.toContain("Create text box group");
  });

  it("measures intrinsic Markdown content instead of the self-sized block", async () => {
    const testGlobals = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
    };
    const actEnvironment = testGlobals.IS_REACT_ACT_ENVIRONMENT;
    testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const resizeObserver = globalThis.ResizeObserver;
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const observed: Element[] = [];
    const heights: number[] = [];
    globalThis.ResizeObserver = class {
      observe(target: Element) {
        observed.push(target);
      }

      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("markdown-content") ? 80 : 100_000;
      },
    });

    try {
      document.body.append(container);
      await act(async () => {
        root.render(
          <MarkdownBlock
            boxOpacity={1}
            editing={false}
            source={"- [ ] a\n  \n- [ ] b"}
            onChange={() => undefined}
            onCommit={() => undefined}
            onFinishEditing={() => undefined}
            onHeightChange={(height) => heights.push(height)}
          />,
        );
      });
      const content = container.querySelector<HTMLElement>(".markdown-content");
      expect(content).not.toBeNull();
      expect(heights).toEqual([80]);
      expect(observed).toEqual([content]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.ResizeObserver = resizeObserver;
      if (scrollHeightDescriptor === undefined) {
        delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      } else {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      }
      testGlobals.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  it("keeps Markdown history buttons in sync with the CodeMirror history", async () => {
    const testGlobals = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
    };
    const actEnvironment = testGlobals.IS_REACT_ACT_ENVIRONMENT;
    testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const resizeObserver = globalThis.ResizeObserver;
    const rangeClientRects = Range.prototype.getClientRects;
    const elementClientRects = Element.prototype.getClientRects;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Element.prototype.getClientRects = () => [] as unknown as DOMRectList;

    try {
      document.body.append(container);
      await act(async () => {
        root.render(
          <MarkdownBlock
            boxOpacity={1}
            editing
            source="Initial"
            onChange={() => undefined}
            onCommit={() => undefined}
            onFinishEditing={() => undefined}
            onHeightChange={() => undefined}
          />,
        );
      });
      const editor = container.querySelector<HTMLElement>(".cm-content");
      const undoButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Undo Markdown changes"]',
      );
      const redoButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Redo Markdown changes"]',
      );
      expect(editor).not.toBeNull();
      expect(undoButton).not.toBeNull();
      expect(redoButton).not.toBeNull();
      expect(undoButton?.disabled).toBe(true);
      expect(redoButton?.disabled).toBe(true);

      const view = EditorView.findFromDOM(editor!);
      expect(view).toBeDefined();
      await act(async () => {
        view!.dispatch({ changes: { from: view!.state.doc.length, insert: " changed" } });
      });
      expect(undoButton?.disabled).toBe(false);
      expect(redoButton?.disabled).toBe(true);

      await act(async () => undoButton?.click());
      expect(view?.state.doc.toString()).toBe("Initial");
      expect(undoButton?.disabled).toBe(true);
      expect(redoButton?.disabled).toBe(false);

      await act(async () => redoButton?.click());
      expect(view?.state.doc.toString()).toBe("Initial changed");
      expect(undoButton?.disabled).toBe(false);
      expect(redoButton?.disabled).toBe(true);

      await act(async () => {
        view!.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            key: "z",
          }),
        );
      });
      expect(view?.state.doc.toString()).toBe("Initial");
      expect(undoButton?.disabled).toBe(true);
      expect(redoButton?.disabled).toBe(false);

      await act(async () => {
        view!.dispatch({ selection: { anchor: view!.state.doc.length } });
        for (let index = 0; index < 5; index += 1) {
          view!.contentDOM.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: "Enter",
              shiftKey: true,
            }),
          );
        }
      });
      expect(view?.state.doc.toString()).toBe("Initial" + ("\\" + "\n").repeat(5));

      const applyMarkdownShortcut = async (
        key: string,
        options: Pick<KeyboardEventInit, "ctrlKey" | "shiftKey">,
      ) => {
        await act(async () => {
          view!.dispatch({
            changes: { from: 0, to: view!.state.doc.length, insert: "Initial" },
            selection: { anchor: 0, head: "Initial".length },
          });
          view!.contentDOM.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key,
              ...options,
            }),
          );
        });
        return view!.state.doc.toString();
      };

      expect(await applyMarkdownShortcut("b", { ctrlKey: true })).toBe("**Initial**");
      expect(await applyMarkdownShortcut("i", { ctrlKey: true })).toBe("*Initial*");
      expect(await applyMarkdownShortcut("x", { ctrlKey: true, shiftKey: true })).toBe(
        "~~Initial~~",
      );
      expect(await applyMarkdownShortcut("`", { ctrlKey: true })).toBe("`Initial`");
      expect(await applyMarkdownShortcut("k", { ctrlKey: true })).toBe("[Initial](url)");
    } finally {
      await act(async () => root.unmount());
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      container.remove();
      globalThis.ResizeObserver = resizeObserver;
      Range.prototype.getClientRects = rangeClientRects;
      Element.prototype.getClientRects = elementClientRects;
      testGlobals.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  it("keeps invalid formulas visible instead of throwing", () => {
    const source = "Before $\\notACommand{x}$ after";
    const html = renderToStaticMarkup(<MarkdownPreview source={source} />);

    expect(html).toContain(
      '<annotation encoding="application/x-tex">\\notACommand{x}</annotation>',
    );
    expect(html).toContain('style="color:#a3203e"');
    expect(html).toContain("\\notACommand{x}");
    expect(html).toContain("Before");
    expect(html).toContain("after");
  });

  it("does not trust KaTeX HTML commands or unsafe links", () => {
    const source = String.raw`$\htmlClass{injected}{x} \href{javascript:alert(1)}{click}$`;
    const html = renderToStaticMarkup(<MarkdownPreview source={source} />);

    expect(html).not.toContain('class="injected"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("\\htmlClass");
    expect(html).toContain("\\href");
  });

  it("disables raw HTML and gives external Markdown links no renderer privileges", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source={
          '<script>alert("x")</script>\n\n[remote](https://example.com/note)\n\n[unsafe](javascript:alert(1))'
        }
      />,
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://example.com/note"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('href="javascript:');
  });
});

function appResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
