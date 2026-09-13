import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type Ref,
} from "react";
import { flushSync } from "react-dom";

import {
  AUTOSAVE_INTERVAL_SECONDS,
  DEFAULT_APPLICATION_TEXT_SCALE_PERCENT,
  DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER,
  DEFAULT_LASER_POINTER_SETTINGS,
  DEFAULT_MARKDOWN_BOX_APPEARANCE,
  EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
  DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  LASER_POINTER_DECAY_MAX_SECONDS,
  LASER_POINTER_DECAY_MIN_SECONDS,
  LASER_POINTER_DECAY_STEP_SECONDS,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  MARKDOWN_FONT_SIZE_STEP,
  readAutosaveIntervalSeconds,
  readApplicationTextScalePercent,
  readKeyboardPanSpeedMultiplier,
  readLaserPointerSettings,
  readMarkdownBoxAppearance,
  readMarkdownColorStyles,
  isProfileSettingsExport,
  serializeProfileSettingsExport,
  type AutosaveIntervalSeconds,
  type LaserPointerSettings,
  type MarkdownBoxAppearance,
  type MarkdownColorStyleLibrary,
  type NotebookHierarchy,
  type NotebookSection,
  type ProfileDrawingPalettes,
  type ProfileSettings,
} from "@squillpad/core-model";
import {
  PageSyncClient,
  createPageDocument,
  isPageDocumentEmpty,
  materializePageDocument,
  observePageDocument,
  replacePageContent,
  updateMarkdownSource,
  type SynchronizationStatus,
} from "@squillpad/synchronization";
import {
  CANVAS_TOOLBAR_HEIGHT_MAX,
  CANVAS_TOOLBAR_HEIGHT_MIN,
  CanvasSession,
  clampCanvasToolbarHeight,
  DEFAULT_CANVAS_TOOLBAR_HEIGHT,
  dismissAnimatedMenuFromInteraction,
  downloadExport,
  loadDrawingPreferences,
  loadProfileDrawingPreferences,
  normalizeProfileDrawingPalettes,
  saveDrawingPreferences,
  searchMarkdown,
  parseGeometryPreview,
  type LaserPointer,
  type GeometryPreview,
  type CanvasExportRegionMode,
  type DrawingPreferences,
  type PictureInPictureCapture,
  type SpatialCanvasHandle,
} from "@squillpad/ui";

import { accessToken, accessHeaders } from "./host-access";
import { ConnectionScreen } from "./ConnectionScreen";
import { ConfirmationDialog } from "./ConfirmationDialog";
import type { RepositorySynchronizationHandle } from "./RepositorySynchronization";
import {
  loadApplicationPreferences,
  loadProfileApplicationPreferences,
  saveApplicationPreferences,
} from "./application-preferences";
import { LatestValuePublisher } from "./latest-value-publisher";
import { AppChrome, PowerIcon } from "./AppChrome";
import { AppNavigation, moveItem, navigateToPage } from "./AppNavigation";
import { PageWorkspace } from "./PageWorkspace";
import type { PictureInPictureView } from "./PictureInPictureOverlay";
import type {
  AuthenticationStatusResponse,
  CanvasFullscreenPhase,
  HierarchyCommand,
  LivePage,
  PageData,
  PageRoute,
  ProjectPresenceMember,
  ProjectPresenceResponse,
  RuntimeCacheCleanupResponse,
  SaveSnapshot,
  SaveStatus,
  Selection,
  StorageDiagnosticsResponse,
  SynchronizationStatusResponse,
} from "./app-types";

const LIVE_PREVIEW_INTERVAL_MS = 1_000 / 30;
const PROJECT_PRESENCE_INTERVAL_MS = 5_000;
const PROFILE_SETTINGS_IMPORT_MAX_BYTES = 256 * 1024;
const PRESENCE_CLIENT_ID_HEADER = "x-squillpad-presence-id";
const PROJECT_PRESENCE_CLIENT_ID_KEY = "squillpad:project-presence-client-id";
const PROJECT_PRESENCE_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SAVE_STATUS_POSSIBILITIES = "Saving, Saved, Save error";
const SYNCHRONIZATION_STATUS_POSSIBILITIES =
  "Connecting, Synchronized, Offline — editing locally, Synchronization error, Host disconnected, Project reloaded, Host stopped";
let nextPictureInPictureId = 0;

type PendingDeletion =
  | {
      readonly kind: "section";
      readonly sectionId: string;
      readonly title: string;
      readonly pageCount: number;
    }
  | {
      readonly kind: "page";
      readonly sectionId: string;
      readonly pageId: string;
      readonly title: string;
    };

export type { ProjectPresenceMember } from "./app-types";

export function requiresProfileAuthentication(
  status: AuthenticationStatusResponse | undefined,
): boolean {
  return (
    status !== undefined &&
    (!status.authenticated || (status.hostAuthorized && status.username === undefined))
  );
}

export function isHostSession(
  status: AuthenticationStatusResponse | undefined,
  hostname = typeof window === "undefined" ? undefined : window.location.hostname,
): boolean {
  return isLoopbackHostname(hostname) && (status === undefined || status.hostAuthorized);
}

export function isClientReadOnly({
  hostDisconnected,
  hostStopped,
}: {
  readonly hostDisconnected: boolean;
  readonly hostStopped: boolean;
}): boolean {
  return hostStopped || hostDisconnected;
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  return (
    hostname === undefined ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

const API_PATH = "/api/hierarchy";
const MAX_LASER_TRACE_POINTS = 4096;
const CANVAS_FULLSCREEN_TRANSITION_MS = 420;
const REPOSITORY_OPERATION_IN_PROGRESS_MESSAGE =
  "Repository snapshot operation in progress; retry shortly";
const REPOSITORY_OPERATION_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

type RepositoryRetryNotice = (attempt: number, maximumAttempts: number) => void;

class RepositoryOperationInProgressError extends Error {
  constructor() {
    super(REPOSITORY_OPERATION_IN_PROGRESS_MESSAGE);
    this.name = "RepositoryOperationInProgressError";
  }
}

class RepositoryOperationRetryExhaustedError extends Error {
  constructor() {
    super(
      "The notebook is still being updated from its repository. Retry opening the notebook shortly.",
    );
    this.name = "RepositoryOperationRetryExhaustedError";
  }
}

function isRepositoryOperationRetryExhausted(
  error: unknown,
): error is RepositoryOperationRetryExhaustedError {
  return error instanceof RepositoryOperationRetryExhaustedError;
}

export { HostStoppedNotification, ProjectPresenceAvatars } from "./AppChrome";
export { HelpGuides } from "./AppSettings";
export { moveItem } from "./AppNavigation";

export function App() {
  const canvasSessionRef = useRef(new CanvasSession());
  const canvasRef = useRef<SpatialCanvasHandle>(null);
  const notebookAppRef = useRef<HTMLElement>(null);
  const markdownSearchInputRef = useRef<HTMLInputElement>(null);
  const navigationFloatingToggleRef = useRef<HTMLButtonElement>(null);
  const fileMenuRef = useRef<HTMLDetailsElement>(null);
  const sectionSettingsRef = useRef<HTMLDetailsElement>(null);
  const lanSharingRef = useRef<HTMLDetailsElement>(null);
  const storageDiagnosticsRef = useRef<HTMLDetailsElement>(null);
  const hostStopRef = useRef<HTMLDetailsElement>(null);
  const repositorySynchronizationRef = useRef<RepositorySynchronizationHandle>(null);
  const [hierarchy, setHierarchy] = useState<NotebookHierarchy>();
  const [selection, setSelection] = useState<Selection>({});
  const [applicationPreferences, setApplicationPreferences] = useState(() =>
    loadApplicationPreferences(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [canvasFullscreen, setCanvasFullscreen] = useState(false);
  const [canvasFullscreenPhase, setCanvasFullscreenPhase] =
    useState<CanvasFullscreenPhase>("closed");
  const [drawingPreferences, setDrawingPreferences] = useState<DrawingPreferences>(() =>
    loadDrawingPreferences(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [palmRejection, setPalmRejection] = useState(false);
  const [profileDrawingPalettes, setProfileDrawingPalettes] = useState<ProfileDrawingPalettes>(() =>
    normalizeProfileDrawingPalettes(undefined),
  );
  const [markdownBoxAppearance, setMarkdownBoxAppearance] = useState<MarkdownBoxAppearance>(
    DEFAULT_MARKDOWN_BOX_APPEARANCE,
  );
  const [markdownColorStyles, setMarkdownColorStyles] = useState<MarkdownColorStyleLibrary>(
    EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
  );
  const [autosaveIntervalSeconds, setAutosaveIntervalSeconds] = useState<AutosaveIntervalSeconds>(
    DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  );
  const [markdownSearchQuery, setMarkdownSearchQuery] = useState("");
  const [markdownSearchActiveIndex, setMarkdownSearchActiveIndex] = useState(0);
  const [markdownEditing, setMarkdownEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [repositoryOperationRetrying, setRepositoryOperationRetrying] = useState(false);
  const [repositoryOperationError, setRepositoryOperationError] = useState(false);
  const [projectLoadAttempt, setProjectLoadAttempt] = useState(0);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [profileSettingsReady, setProfileSettingsReady] = useState(false);
  const [hostSession, setHostSession] = useState(false);
  const [authenticatedUsername, setAuthenticatedUsername] = useState<string>();
  const [projectPresence, setProjectPresence] = useState<readonly ProjectPresenceMember[]>([]);
  const [canvasToolbarHeight, setCanvasToolbarHeight] = useState(DEFAULT_CANVAS_TOOLBAR_HEIGHT);
  const [canvasToolbarHeightDraft, setCanvasToolbarHeightDraft] = useState(
    String(DEFAULT_CANVAS_TOOLBAR_HEIGHT),
  );
  const [exportRegionMode, setExportRegionMode] = useState<CanvasExportRegionMode>("content");
  const [canvasSelectionCount, setCanvasSelectionCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion>();
  const [stoppingHost, setStoppingHost] = useState(false);
  const [hostingStopped, setHostingStopped] = useState(false);
  const [clientHostingStopped, setClientHostingStopped] = useState(false);
  const [clientHostDisconnected, setClientHostDisconnected] = useState(false);
  const [hostStoppedNotificationOpen, setHostStoppedNotificationOpen] = useState(false);
  const [pages, setPages] = useState<Readonly<Record<string, PageData>>>({});
  const [pictureInPictures, setPictureInPictures] = useState<readonly PictureInPictureView[]>([]);
  const [syncStatuses, setSyncStatuses] = useState<Readonly<Record<string, SynchronizationStatus>>>(
    {},
  );
  const [lanSharingEnabled, setLanSharingEnabled] = useState<boolean>();
  const [saveStatuses, setSaveStatuses] = useState<Readonly<Record<string, SaveSnapshot>>>({});
  const [savingPageId, setSavingPageId] = useState<string>();
  const [storageDiagnostics, setStorageDiagnostics] = useState<StorageDiagnosticsResponse>();
  const [cleaningRuntimeCache, setCleaningRuntimeCache] = useState(false);
  const [readyPageIds, setReadyPageIds] = useState<ReadonlySet<string>>(new Set());
  const [synchronizationGeneration, setSynchronizationGeneration] = useState<string>();
  const [laserPointersByPage, setLaserPointersByPage] = useState<
    Readonly<Record<string, readonly LaserPointer[]>>
  >({});
  const [geometryPreviewsByPage, setGeometryPreviewsByPage] = useState<
    Readonly<Record<string, readonly GeometryPreview[]>>
  >({});
  const [laserPointerSettings, setLaserPointerSettings] = useState<LaserPointerSettings>(
    DEFAULT_LASER_POINTER_SETTINGS,
  );
  const [keyboardPanSpeedMultiplier, setKeyboardPanSpeedMultiplier] = useState(
    DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER,
  );
  const profileSettingsImportRef = useRef<HTMLInputElement>(null);
  const profileSettingsSaveQueueRef = useRef(Promise.resolve());
  const profileCacheHasAuthenticatedUserRef = useRef(false);
  const hierarchyRef = useRef<NotebookHierarchy | undefined>(undefined);
  const hostSessionRef = useRef(false);
  const clientHostingStoppedRef = useRef(false);
  const clientReadOnlyRef = useRef(false);
  const projectPresenceClientIdRef = useRef<string | undefined>(undefined);
  const selectionRef = useRef(selection);
  const markdownEditingRef = useRef(false);
  const pagesRef = useRef<Readonly<Record<string, PageData>>>({});
  const pageFetchesRef = useRef(new Map<string, Promise<PageData>>());
  const livePagesRef = useRef(new Map<string, LivePage>());
  const laserPageRef = useRef<string | undefined>(undefined);
  const pendingMarkdownRef = useRef(new Map<string, Record<string, string>>());
  const pendingSynchronizedMarkdownRef = useRef(new Map<string, Record<string, string>>());
  const markdownPublisherRef = useRef<
    LatestValuePublisher<string, { pageId: string; elementId: string; source: string }> | undefined
  >(undefined);
  const geometryPublisherRef = useRef<LatestValuePublisher<string, GeometryPreview> | undefined>(
    undefined,
  );
  const canvasFullscreenRef = useRef(false);
  const canvasFullscreenPhaseRef = useRef<CanvasFullscreenPhase>("closed");
  const canvasFullscreenTimerRef = useRef<number | undefined>(undefined);
  if (projectPresenceClientIdRef.current === undefined) {
    projectPresenceClientIdRef.current = createProjectPresenceClientId();
  }
  if (markdownPublisherRef.current === undefined) {
    markdownPublisherRef.current = new LatestValuePublisher(
      LIVE_PREVIEW_INTERVAL_MS,
      (_key, value) => {
        if (clientReadOnlyRef.current) return;
        const livePage = livePagesRef.current.get(value.pageId);
        if (livePage !== undefined) {
          const pending = pendingSynchronizedMarkdownRef.current.get(value.pageId);
          if (pending?.[value.elementId] === value.source) {
            const remaining = { ...pending };
            delete remaining[value.elementId];
            if (Object.keys(remaining).length === 0) {
              pendingSynchronizedMarkdownRef.current.delete(value.pageId);
            } else {
              pendingSynchronizedMarkdownRef.current.set(value.pageId, remaining);
            }
          }
          updateMarkdownSource(livePage.document, value.elementId, value.source);
        }
      },
    );
  }
  if (geometryPublisherRef.current === undefined) {
    geometryPublisherRef.current = new LatestValuePublisher(
      LIVE_PREVIEW_INTERVAL_MS,
      (pageId, preview) => {
        if (clientReadOnlyRef.current) return;
        livePagesRef.current.get(pageId)?.client.setPresenceField("geometry", preview);
      },
    );
  }
  const hasHierarchy = hierarchy !== undefined;
  hostSessionRef.current = hostSession;
  clientHostingStoppedRef.current = clientHostingStopped;
  canvasFullscreenRef.current = canvasFullscreen;
  canvasFullscreenPhaseRef.current = canvasFullscreenPhase;
  const clientReadOnly = isClientReadOnly({
    hostDisconnected: clientHostDisconnected,
    hostStopped: clientHostingStopped,
  });
  clientReadOnlyRef.current = clientReadOnly;
  selectionRef.current = selection;
  const handleMarkdownEditingChange = useCallback((editing: boolean) => {
    markdownEditingRef.current = editing;
    setMarkdownEditing(editing);
  }, []);
  const handleRemoteHostStopped = useCallback(() => {
    if (hostSessionRef.current) return;
    clientReadOnlyRef.current = true;
    clientHostingStoppedRef.current = true;
    markdownEditingRef.current = false;
    setMarkdownEditing(false);
    setClientHostingStopped(true);
    setReadyPageIds((current) => new Set([...current, ...Object.keys(pagesRef.current)]));
    setHostStoppedNotificationOpen(true);
  }, []);
  const handleRemoteHostDisconnected = useCallback(() => {
    if (hostSessionRef.current) return;
    clientReadOnlyRef.current = true;
    markdownEditingRef.current = false;
    setMarkdownEditing(false);
    setClientHostDisconnected(true);
    setReadyPageIds((current) => new Set([...current, ...Object.keys(pagesRef.current)]));
  }, []);
  const handleRemoteHostReconnected = useCallback(() => {
    if (hostSessionRef.current) return;
    setClientHostDisconnected(false);
    clientReadOnlyRef.current = clientHostingStoppedRef.current;
  }, []);
  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
    window.requestAnimationFrame(() => navigationFloatingToggleRef.current?.focus());
  }, []);
  const completeCanvasFullscreen = useCallback(() => {
    if (canvasFullscreenTimerRef.current !== undefined) {
      window.clearTimeout(canvasFullscreenTimerRef.current);
      canvasFullscreenTimerRef.current = undefined;
    }
    canvasFullscreenRef.current = false;
    canvasFullscreenPhaseRef.current = "closed";
    setCanvasFullscreen(false);
    setCanvasFullscreenPhase("closed");
  }, []);
  const beginCanvasFullscreenOpen = useCallback(() => {
    if (canvasFullscreenTimerRef.current !== undefined) {
      window.clearTimeout(canvasFullscreenTimerRef.current);
    }
    canvasFullscreenPhaseRef.current = "opening";
    setCanvasFullscreenPhase("opening");
    canvasFullscreenTimerRef.current = window.setTimeout(() => {
      canvasFullscreenTimerRef.current = undefined;
      if (!canvasFullscreenRef.current) return;
      canvasFullscreenPhaseRef.current = "open";
      setCanvasFullscreenPhase("open");
    }, CANVAS_FULLSCREEN_TRANSITION_MS);
  }, []);
  const beginCanvasFullscreenClose = useCallback(() => {
    if (!canvasFullscreenRef.current || canvasFullscreenPhaseRef.current === "closing") return;
    if (canvasFullscreenTimerRef.current !== undefined) {
      window.clearTimeout(canvasFullscreenTimerRef.current);
    }
    canvasFullscreenPhaseRef.current = "closing";
    setCanvasFullscreenPhase("closing");
    canvasFullscreenTimerRef.current = window.setTimeout(() => {
      canvasFullscreenTimerRef.current = undefined;
      const app = notebookAppRef.current;
      if (
        typeof document !== "undefined" &&
        document.fullscreenElement === app &&
        typeof document.exitFullscreen === "function"
      ) {
        void document.exitFullscreen().then(completeCanvasFullscreen, completeCanvasFullscreen);
        return;
      }
      completeCanvasFullscreen();
    }, CANVAS_FULLSCREEN_TRANSITION_MS);
  }, [completeCanvasFullscreen]);
  const toggleCanvasFullscreen = useCallback(
    (next: boolean) => {
      if (!next) {
        beginCanvasFullscreenClose();
        return;
      }
      canvasFullscreenRef.current = true;
      setCanvasFullscreen(true);
      beginCanvasFullscreenOpen();
      const app = notebookAppRef.current;
      if (
        app === null ||
        typeof document === "undefined" ||
        typeof app.requestFullscreen !== "function" ||
        document.fullscreenElement === app
      ) {
        return;
      }
      try {
        void app.requestFullscreen().catch(() => undefined);
      } catch {
        // Keep the in-app fullscreen fallback when the native request is rejected synchronously.
      }
    },
    [beginCanvasFullscreenClose, beginCanvasFullscreenOpen],
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncNativeFullscreen = () => {
      if (document.fullscreenElement === notebookAppRef.current) {
        if (!canvasFullscreenRef.current) {
          canvasFullscreenRef.current = true;
          setCanvasFullscreen(true);
          beginCanvasFullscreenOpen();
        }
        return;
      }
      if (canvasFullscreenPhaseRef.current === "closing") {
        if (canvasFullscreenTimerRef.current === undefined) completeCanvasFullscreen();
        return;
      }
      beginCanvasFullscreenClose();
    };
    document.addEventListener("fullscreenchange", syncNativeFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncNativeFullscreen);
  }, [beginCanvasFullscreenClose, beginCanvasFullscreenOpen, completeCanvasFullscreen]);
  useEffect(
    () => () => {
      if (canvasFullscreenTimerRef.current !== undefined) {
        window.clearTimeout(canvasFullscreenTimerRef.current);
      }
      if (
        typeof document !== "undefined" &&
        document.fullscreenElement === notebookAppRef.current &&
        typeof document.exitFullscreen === "function"
      ) {
        void document.exitFullscreen().catch(() => undefined);
      }
    },
    [],
  );
  const dismissSelectionMenus = useCallback((target?: EventTarget | null) => {
    const menus = [
      fileMenuRef.current,
      sectionSettingsRef.current,
      lanSharingRef.current,
      storageDiagnosticsRef.current,
      hostStopRef.current,
    ];
    for (const menu of menus) {
      dismissAnimatedMenuFromInteraction(menu, target);
    }
  }, []);
  const handleMenuPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => dismissSelectionMenus(event.target),
    [dismissSelectionMenus],
  );
  const handleCanvasSelectionChange = useCallback(
    (selectedCount: number) => {
      setCanvasSelectionCount(selectedCount);
      dismissSelectionMenus();
    },
    [dismissSelectionMenus],
  );

  const applyProfileSettings = useCallback((settings: ProfileSettings) => {
    setApplicationPreferences({
      ...settings.application,
      textScalePercent: readApplicationTextScalePercent(settings.application.textScalePercent),
    });
    setDrawingPreferences(settings.drawing);
    setKeyboardPanSpeedMultiplier(
      readKeyboardPanSpeedMultiplier(settings.keyboardPanSpeedMultiplier),
    );
    setPalmRejection(settings.palmRejection);
    setProfileDrawingPalettes(normalizeProfileDrawingPalettes(settings.drawingPalettes));
    setCanvasToolbarHeight(clampCanvasToolbarHeight(settings.toolbarHeight));
  }, []);

  const currentProfileSettings = useCallback(
    (): ProfileSettings => ({
      application: applicationPreferences,
      drawing: drawingPreferences,
      keyboardPanSpeedMultiplier,
      toolbarHeight: canvasToolbarHeight,
      palmRejection,
      drawingPalettes: profileDrawingPalettes,
    }),
    [
      applicationPreferences,
      canvasToolbarHeight,
      drawingPreferences,
      keyboardPanSpeedMultiplier,
      palmRejection,
      profileDrawingPalettes,
    ],
  );

  useEffect(() => {
    if (authenticatedUsername === undefined && profileCacheHasAuthenticatedUserRef.current) return;
    saveApplicationPreferences(
      applicationPreferences,
      typeof window === "undefined" ? undefined : window.localStorage,
      authenticatedUsername,
    );
    document.documentElement.dataset.theme = applicationPreferences.theme;
    document.documentElement.style.setProperty(
      "--app-text-scale",
      String(
        readApplicationTextScalePercent(
          applicationPreferences.textScalePercent ?? DEFAULT_APPLICATION_TEXT_SCALE_PERCENT,
        ) / 100,
      ),
    );
    const favicon = document.querySelector<HTMLLinkElement>("#squillpad-favicon");
    if (favicon !== null) {
      favicon.href = "./squillpad-tab-icon.png";
    }
  }, [applicationPreferences, authenticatedUsername]);

  useEffect(() => {
    setCanvasToolbarHeightDraft(String(canvasToolbarHeight));
  }, [canvasToolbarHeight]);

  useEffect(() => {
    setCanvasSelectionCount(0);
    dismissSelectionMenus();
  }, [dismissSelectionMenus, selection.pageId, selection.sectionId]);

  useEffect(() => {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    if (authenticatedUsername === undefined && profileCacheHasAuthenticatedUserRef.current) return;
    saveDrawingPreferences(drawingPreferences, storage, authenticatedUsername);
  }, [authenticatedUsername, drawingPreferences]);

  useEffect(() => {
    if (!profileSettingsReady || authenticatedUsername === undefined || clientReadOnlyRef.current) {
      return;
    }
    let cancelled = false;
    const settings = currentProfileSettings();
    profileSettingsSaveQueueRef.current = profileSettingsSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await withRepositoryOperationRetry(() =>
          requestJson<{ readonly settings: ProfileSettings }>("/api/profile/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ settings }),
          }),
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [
    authenticatedUsername,
    currentProfileSettings,
    drawingPreferences,
    palmRejection,
    profileDrawingPalettes,
    profileSettingsReady,
    applicationPreferences,
    canvasToolbarHeight,
    keyboardPanSpeedMultiplier,
  ]);

  useEffect(() => {
    setMarkdownSearchQuery("");
    setMarkdownSearchActiveIndex(0);
  }, [selection.pageId]);

  const applyHierarchy = useCallback((next: NotebookHierarchy) => {
    setHierarchy(next);
    setMarkdownBoxAppearance(
      readMarkdownBoxAppearance(next.notebook.settings.metadata) ?? DEFAULT_MARKDOWN_BOX_APPEARANCE,
    );
    setMarkdownColorStyles(
      readMarkdownColorStyles(next.notebook.settings.metadata) ??
        EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
    );
    setLaserPointerSettings(
      readLaserPointerSettings(next.notebook.settings.metadata) ?? DEFAULT_LASER_POINTER_SETTINGS,
    );
    setAutosaveIntervalSeconds(
      readAutosaveIntervalSeconds(next.notebook.settings.metadata) ??
        DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
    );
    setSelection((current) => resolveSelection(next, current));
    setError(undefined);
  }, []);
  hierarchyRef.current = hierarchy;
  const loadCachedPage = useCallback((sectionId: string, pageId: string): Promise<PageData> => {
    const cached = pagesRef.current[pageId];
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = pageFetchesRef.current.get(pageId);
    if (pending !== undefined) return pending;
    const request = fetchPage(sectionId, pageId);
    pageFetchesRef.current.set(pageId, request);
    const clear = () => {
      if (pageFetchesRef.current.get(pageId) === request) pageFetchesRef.current.delete(pageId);
    };
    void request.then(clear, clear);
    return request;
  }, []);

  const retryProjectLoad = useCallback(() => {
    setRepositoryOperationRetrying(false);
    setRepositoryOperationError(false);
    setError(undefined);
    setLoading(true);
    setProjectLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProfileSettingsReady(false);
    void fetch("/api/auth/status", { headers: accessHeaders(), cache: "no-store" })
      .then(async (response) => {
        if (response.status === 503) return undefined;
        if (!response.ok) throw new Error("Could not check host authentication");
        return (await response.json()) as AuthenticationStatusResponse;
      })
      .then((status) => {
        const needsCollaboratorLogin = requiresProfileAuthentication(status);
        if (cancelled || needsCollaboratorLogin) {
          if (!cancelled) {
            setAuthenticationRequired(true);
            setProfileSettingsReady(false);
            setLoading(false);
          }
          return undefined;
        }
        setAuthenticationRequired(false);
        setHostSession(isHostSession(status));
        setAuthenticatedUsername(status?.username);
        if (status?.username !== undefined) profileCacheHasAuthenticatedUserRef.current = true;
        const storage = typeof window === "undefined" ? undefined : window.localStorage;
        const cachedApplicationPreferences =
          status?.username === undefined
            ? undefined
            : loadProfileApplicationPreferences(storage, status.username);
        const cachedDrawingPreferences =
          status?.username === undefined
            ? undefined
            : loadProfileDrawingPreferences(storage, status.username);
        if (status?.profileSettings !== undefined) {
          applyProfileSettings(status.profileSettings);
        } else {
          if (status?.username !== undefined) {
            setApplicationPreferences(cachedApplicationPreferences!);
            setDrawingPreferences(cachedDrawingPreferences!);
          }
          setPalmRejection(status?.palmRejection ?? false);
          setProfileDrawingPalettes(normalizeProfileDrawingPalettes(status?.drawingPalettes));
          setCanvasToolbarHeight(
            clampCanvasToolbarHeight(status?.toolbarHeight ?? DEFAULT_CANVAS_TOOLBAR_HEIGHT),
          );
        }
        setProfileSettingsReady(status?.profileSettingsAvailable === true);
        return Promise.all([
          fetchHierarchy((attempt, maximumAttempts) => {
            if (cancelled) return;
            setRepositoryOperationRetrying(true);
            setRepositoryOperationError(false);
            setError(
              `Updating notebook from repository… Retrying shortly (${attempt}/${maximumAttempts})`,
            );
          }),
          fetchSynchronizationStatus(),
        ]);
      })
      .then((next) => {
        if (cancelled || next === undefined) return;
        applyHierarchy(next[0]);
        setSynchronizationGeneration(next[1].synchronizationGeneration);
        setRepositoryOperationRetrying(false);
        setRepositoryOperationError(false);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setRepositoryOperationRetrying(false);
        setRepositoryOperationError(isRepositoryOperationRetryExhausted(reason));
        setError(errorMessage(reason));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyHierarchy, applyProfileSettings, projectLoadAttempt]);

  useEffect(() => {
    if (!hasHierarchy) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await fetchHierarchy();
        const current = hierarchyRef.current;
        if (
          cancelled ||
          current === undefined ||
          JSON.stringify(current) === JSON.stringify(next)
        ) {
          return;
        }
        applyHierarchy(next);
      } catch {
        // A hierarchy refresh failure must not interrupt local notebook editing.
      }
    };
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyHierarchy, hasHierarchy]);

  useEffect(() => {
    const projectId = hierarchy?.notebook.projectId;
    const username = authenticatedUsername;
    const clientId = projectPresenceClientIdRef.current;
    if (projectId === undefined || username === undefined || clientId === undefined) {
      setProjectPresence([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await requestJson<ProjectPresenceResponse>("/api/presence", {
          method: "GET",
          headers: { [PRESENCE_CLIENT_ID_HEADER]: clientId },
        });
        if (!cancelled) setProjectPresence(next.participants);
      } catch {
        // Presence is auxiliary; keep the last roster when a heartbeat is unavailable.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), PROJECT_PRESENCE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authenticatedUsername, hierarchy?.notebook.projectId]);

  useEffect(() => {
    const navigate = () => {
      const current = hierarchyRef.current;
      if (current === undefined) return;
      if (markdownEditingRef.current) {
        const route = pageRoute(current.notebook.projectId, selectionRef.current);
        if (route !== location.hash) history.replaceState(null, "", route);
        return;
      }
      const route = parsePageRoute(location.hash);
      if (route.projectId === current.notebook.projectId && !containsRoute(current, route)) return;
      setSelection(resolveSelection(current, route));
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);

  useEffect(() => {
    if (hierarchy === undefined) return;
    const resolved = resolveSelection(hierarchy, selection);
    try {
      sessionStorage.setItem(selectionKey(hierarchy.notebook.projectId), JSON.stringify(resolved));
    } catch {
      // Restricted tab storage must not interrupt notebook navigation.
    }
    const route = pageRoute(hierarchy.notebook.projectId, resolved);
    if (route !== location.hash) history.replaceState(null, "", route);
  }, [hierarchy, selection]);

  useEffect(() => {
    if (hierarchy === undefined) return;
    let cancelled = false;
    for (const section of hierarchy.sections) {
      for (const page of section.pages) {
        if (pagesRef.current[page.id] !== undefined) continue;
        void loadCachedPage(section.manifest.id, page.id)
          .then((next) => {
            if (cancelled || pagesRef.current[page.id] !== undefined) return;
            pagesRef.current = { ...pagesRef.current, [page.id]: next };
            setPages(pagesRef.current);
            if (clientReadOnlyRef.current) {
              setReadyPageIds((current) => new Set(current).add(page.id));
            }
          })
          .catch(() => undefined);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [hierarchy, loadCachedPage]);

  useEffect(() => {
    if (hierarchy === undefined) return;
    setPictureInPictures((current) => {
      let changed = false;
      const next = current.flatMap((view) => {
        const section = hierarchy.sections.find((candidate) =>
          candidate.pages.some((page) => page.id === view.pageId),
        );
        const page = section?.pages.find((candidate) => candidate.id === view.pageId);
        if (section === undefined || page === undefined) {
          changed = true;
          return [];
        }
        if (view.sectionId === section.manifest.id && view.sourceTitle === page.title)
          return [view];
        changed = true;
        return [{ ...view, sectionId: section.manifest.id, sourceTitle: page.title }];
      });
      return changed ? next : current;
    });
  }, [hierarchy]);

  useEffect(() => {
    if (hierarchy === undefined || synchronizationGeneration === undefined) return;
    const projectId = hierarchy.notebook.projectId;
    const sectionId = selection.sectionId;
    const pageId = selection.pageId;
    if (sectionId === undefined || pageId === undefined || livePagesRef.current.has(pageId)) return;
    if (clientReadOnlyRef.current) return;
    let cancelled = false;
    void loadCachedPage(sectionId, pageId)
      .then((page) => {
        if (cancelled) return;
        if (pagesRef.current[pageId] === undefined) {
          pagesRef.current = { ...pagesRef.current, [pageId]: page };
          setPages(pagesRef.current);
        }
        if (clientReadOnlyRef.current) return;
        const document = createPageDocument();
        const publishDocument = () => {
          try {
            const content = materializePageDocument(document);
            const current = pagesRef.current[pageId];
            if (current === undefined) return;
            pagesRef.current = {
              ...pagesRef.current,
              [pageId]: {
                ...current,
                ...content,
                markdown: {
                  ...content.markdown,
                  ...pendingMarkdownRef.current.get(pageId),
                  ...pendingSynchronizedMarkdownRef.current.get(pageId),
                },
              },
            };
            setPages(pagesRef.current);
          } catch {
            // A remote update is projected only after it forms a complete valid page.
          }
        };
        const disposePageObserver = observePageDocument(document, publishDocument);
        const client = new PageSyncClient({
          document,
          pageId,
          projectId,
          serverUrl: synchronizationUrl(),
          synchronizationGeneration,
          ...(accessToken === undefined ? {} : { accessToken }),
        });
        const disposePresenceObserver = client.subscribePresence((presence) => {
          const pointers = presence.flatMap((entry) =>
            parseLaserPointers(entry.state.laser).map((pointer) => ({
              ...pointer,
              id: `${entry.clientId}:${pointer.id}`,
            })),
          );
          const geometryPreviews = presence
            .map((entry) => parseGeometryPreview(entry.state.geometry))
            .filter((preview): preview is GeometryPreview => preview !== undefined);
          setLaserPointersByPage((current) => ({ ...current, [pageId]: pointers }));
          setGeometryPreviewsByPage((current) => ({
            ...current,
            [pageId]: geometryPreviews,
          }));
        });
        const disposeObserver = () => {
          disposePageObserver();
          disposePresenceObserver();
        };
        client.subscribe((status) => {
          setSyncStatuses((current) => ({ ...current, [pageId]: status }));
          if (status === "project-reloaded") window.location.reload();
          if (status === "host-stopped") handleRemoteHostStopped();
          if (status === "host-disconnected") handleRemoteHostDisconnected();
          if (status === "synchronized") {
            handleRemoteHostReconnected();
            publishDocument();
            setReadyPageIds((current) => new Set(current).add(pageId));
          }
        });
        void client.persistence?.whenSynced.then(() => {
          if (!isPageDocumentEmpty(document) || page.canvas.length === 0) {
            publishDocument();
            setReadyPageIds((current) => new Set(current).add(pageId));
          }
        });
        livePagesRef.current.set(pageId, { client, document, disposeObserver });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [
    handleRemoteHostDisconnected,
    handleRemoteHostReconnected,
    handleRemoteHostStopped,
    hierarchy,
    loadCachedPage,
    selection.pageId,
    selection.sectionId,
    synchronizationGeneration,
  ]);

  useEffect(() => {
    const pageId = selection.pageId;
    if (pageId === undefined) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await requestJson<SynchronizationStatusResponse>("/api/sync/status", {
          method: "GET",
        });
        if (!cancelled) setSaveStatuses(status.canonical ?? {});
      } catch {
        // Network synchronization status remains available when this auxiliary request fails.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selection.pageId]);

  useEffect(() => {
    if (hierarchy === undefined || !hostSession) {
      setStorageDiagnostics(undefined);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const diagnostics = await requestJson<StorageDiagnosticsResponse>(
          "/api/storage/diagnostics",
          { method: "GET" },
        );
        if (!cancelled) setStorageDiagnostics(diagnostics);
      } catch {
        // Storage diagnostics are helpful telemetry and do not block notebook editing.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hierarchy, hostSession]);

  useEffect(
    () => () => {
      for (const livePage of livePagesRef.current.values()) {
        livePage.disposeObserver();
        livePage.client.destroy();
        livePage.document.destroy();
      }
      markdownPublisherRef.current?.destroy();
      geometryPublisherRef.current?.destroy();
      livePagesRef.current.clear();
    },
    [],
  );

  const updatePage = useCallback((pageId: string, update: (page: PageData) => PageData) => {
    if (clientReadOnlyRef.current) return;
    const current = pagesRef.current[pageId];
    if (current === undefined) return;
    const next = update(current);
    const livePage = livePagesRef.current.get(pageId);
    if (livePage === undefined) {
      pagesRef.current = { ...pagesRef.current, [pageId]: next };
      setPages(pagesRef.current);
    } else {
      const markdownIds = new Set(
        next.canvas.filter((element) => element.kind === "markdown").map((element) => element.id),
      );
      const pending = pendingMarkdownRef.current.get(pageId);
      if (pending !== undefined) {
        const remaining = Object.fromEntries(
          Object.entries(pending).filter(([id]) => !markdownIds.has(id)),
        );
        if (Object.keys(remaining).length === 0) pendingMarkdownRef.current.delete(pageId);
        else pendingMarkdownRef.current.set(pageId, remaining);
      }
      replacePageContent(livePage.document, next);
    }
  }, []);

  const updateMarkdown = useCallback(
    (pageId: string, elementId: string, source: string, commit = false) => {
      if (clientReadOnlyRef.current) return;
      const livePage = livePagesRef.current.get(pageId);
      const current = pagesRef.current[pageId];
      if (current === undefined) return;
      if (livePage !== undefined) {
        if (!current.canvas.some((element) => element.id === elementId)) {
          pendingMarkdownRef.current.set(pageId, {
            ...pendingMarkdownRef.current.get(pageId),
            [elementId]: source,
          });
        }
        pendingSynchronizedMarkdownRef.current.set(pageId, {
          ...pendingSynchronizedMarkdownRef.current.get(pageId),
          [elementId]: source,
        });
        const key = `${pageId}\u0000${elementId}`;
        const value = { pageId, elementId, source };
        if (commit) markdownPublisherRef.current?.flush(key, value);
        else markdownPublisherRef.current?.publish(key, value);
      }
      pagesRef.current = {
        ...pagesRef.current,
        [pageId]: { ...current, markdown: { ...current.markdown, [elementId]: source } },
      };
      setPages(pagesRef.current);
    },
    [],
  );

  const updateLaserPointers = useCallback((pageId: string, pointers: readonly LaserPointer[]) => {
    if (clientHostingStoppedRef.current) return;
    const previousPageId = laserPageRef.current;
    if (previousPageId !== undefined && previousPageId !== pageId) {
      livePagesRef.current.get(previousPageId)?.client.setPresenceField("laser", undefined);
    }
    const client = livePagesRef.current.get(pageId)?.client;
    if (pointers.length === 0) {
      client?.setPresenceField("laser", undefined);
      laserPageRef.current = undefined;
      return;
    }
    client?.setPresenceField("laser", pointers);
    laserPageRef.current = pageId;
  }, []);

  const updateGeometryPreview = useCallback(
    (pageId: string, preview: GeometryPreview | undefined) => {
      if (clientReadOnlyRef.current) return;
      if (preview === undefined) {
        geometryPublisherRef.current?.cancel(pageId);
        livePagesRef.current.get(pageId)?.client.setPresenceField("geometry", undefined);
        return;
      }
      geometryPublisherRef.current?.publish(pageId, preview);
    },
    [],
  );

  const command = useCallback(
    async (value: HierarchyCommand, after?: (next: NotebookHierarchy) => void) => {
      if (clientReadOnlyRef.current) return;
      setBusy(true);
      try {
        const next = await sendCommand(value);
        if (after === undefined) {
          applyHierarchy(next);
        } else {
          setHierarchy(next);
          setMarkdownBoxAppearance(
            readMarkdownBoxAppearance(next.notebook.settings.metadata) ??
              DEFAULT_MARKDOWN_BOX_APPEARANCE,
          );
          setMarkdownColorStyles(
            readMarkdownColorStyles(next.notebook.settings.metadata) ??
              EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
          );
          setLaserPointerSettings(
            readLaserPointerSettings(next.notebook.settings.metadata) ??
              DEFAULT_LASER_POINTER_SETTINGS,
          );
          setAutosaveIntervalSeconds(
            readAutosaveIntervalSeconds(next.notebook.settings.metadata) ??
              DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
          );
          setError(undefined);
          after(next);
        }
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [applyHierarchy],
  );

  const updateMarkdownBoxAppearance = useCallback(
    (appearance: MarkdownBoxAppearance) => {
      if (clientReadOnlyRef.current) return;
      setMarkdownBoxAppearance(appearance);
      void command({
        action: "update-markdown-box-appearance",
        opacity: appearance.opacity,
        fontSize: appearance.fontSize,
      });
    },
    [command],
  );

  const updateMarkdownColorStyles = useCallback(
    (library: MarkdownColorStyleLibrary) => {
      if (clientReadOnlyRef.current) return;
      setMarkdownColorStyles(library);
      void command({ action: "update-markdown-color-styles", library });
    },
    [command],
  );

  const updateLaserPointerSettings = useCallback(
    (settings: LaserPointerSettings) => {
      if (clientReadOnlyRef.current) return;
      setLaserPointerSettings(settings);
      void command({
        action: "update-laser-pointer-settings",
        decaySeconds: settings.decaySeconds,
      });
    },
    [command],
  );

  const updateKeyboardPanSpeedMultiplier = useCallback((multiplier: number) => {
    if (clientReadOnlyRef.current) return;
    setKeyboardPanSpeedMultiplier(readKeyboardPanSpeedMultiplier(multiplier));
  }, []);

  const updateAutosaveFrequency = useCallback(
    (seconds: AutosaveIntervalSeconds) => {
      if (!hostSessionRef.current || clientReadOnlyRef.current) return;
      setAutosaveIntervalSeconds(seconds);
      void command({ action: "update-autosave-frequency", intervalSeconds: seconds });
    },
    [command],
  );

  const saveCurrentPage = useCallback(
    async (pageId: string) => {
      if (!hostSessionRef.current || clientReadOnlyRef.current || savingPageId !== undefined) {
        return;
      }
      const key = hierarchyRef.current?.notebook.projectId;
      if (key === undefined) return;
      const statusKey = pageStatusKey(key, pageId);
      setSavingPageId(pageId);
      try {
        await requestJson<{ readonly saved: boolean }>("/api/sync/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pageId }),
        });
        setSaveStatuses((current) => {
          const previous = current[statusKey];
          return {
            ...current,
            [statusKey]: {
              status: "saved",
              revision: previous?.revision ?? 0,
              dirty: false,
            },
          };
        });
      } catch (reason) {
        setSaveStatuses((current) => {
          const previous = current[statusKey];
          return {
            ...current,
            [statusKey]: {
              status: "error",
              revision: previous?.revision ?? 0,
              dirty: true,
              error: errorMessage(reason),
            },
          };
        });
        setError(errorMessage(reason));
      } finally {
        setSavingPageId(undefined);
      }
    },
    [savingPageId],
  );

  const saveCanvasToolbarHeight = useCallback((height: number) => {
    if (clientReadOnlyRef.current) return;
    setCanvasToolbarHeight(height);
  }, []);

  const updateApplicationTextScalePercent = useCallback((percent: number) => {
    if (clientReadOnlyRef.current) return;
    setApplicationPreferences((current) => ({
      ...current,
      textScalePercent: readApplicationTextScalePercent(percent),
    }));
  }, []);

  const savePalmRejection = useCallback((enabled: boolean) => {
    if (clientReadOnlyRef.current) return;
    setPalmRejection(enabled);
  }, []);

  const saveProfileDrawingPalettes = useCallback((drawingPalettes: ProfileDrawingPalettes) => {
    if (clientReadOnlyRef.current) return;
    setProfileDrawingPalettes(drawingPalettes);
  }, []);

  const clearRuntimeCache = async () => {
    if (!hostSessionRef.current || clientReadOnlyRef.current) return;
    setCleaningRuntimeCache(true);
    try {
      await requestJson<RuntimeCacheCleanupResponse>("/api/storage/runtime-cache/cleanup", {
        method: "POST",
      });
      setStorageDiagnostics(
        await requestJson<StorageDiagnosticsResponse>("/api/storage/diagnostics", {
          method: "GET",
        }),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCleaningRuntimeCache(false);
    }
  };

  const stopHosting = async () => {
    setStoppingHost(true);
    setError(undefined);
    try {
      await requestJson<{ readonly stopping: boolean }>("/api/host/stop", { method: "POST" });
      setHostingStopped(true);
    } catch (reason) {
      setStoppingHost(false);
      setError(errorMessage(reason));
    }
  };

  const syncNowBeforeStopping = () => {
    const synchronization = repositorySynchronizationRef.current;
    if (synchronization === null) {
      setError("Synchronization controls are still loading. Try again in a moment.");
      return;
    }
    synchronization.syncNow();
  };

  const commitCanvasToolbarHeight = () => {
    if (clientReadOnlyRef.current) return;
    const rawValue = canvasToolbarHeightDraft.trim();
    const parsedValue = rawValue.length === 0 ? canvasToolbarHeight : Number(rawValue);
    const next = Number.isFinite(parsedValue)
      ? clampCanvasToolbarHeight(parsedValue)
      : canvasToolbarHeight;
    setCanvasToolbarHeightDraft(String(next));
    if (next === canvasToolbarHeight) return;
    saveCanvasToolbarHeight(next);
  };

  if (loading) {
    return (
      <main className="loading-screen">
        <h1>SquillPad</h1>
        <p>
          {repositoryOperationRetrying
            ? "Updating notebook from repository… Retrying shortly"
            : "Opening notebook…"}
        </p>
      </main>
    );
  }

  if (hostingStopped) {
    return (
      <main className="hosting-stopped-screen">
        <section className="hosting-stopped-card" aria-labelledby="hosting-stopped-title">
          <PowerIcon />
          <h1 id="hosting-stopped-title">Hosting stopped</h1>
          <p>The notebook was synced and the host is now offline.</p>
        </section>
      </main>
    );
  }

  if (authenticationRequired)
    return <ConnectionScreen authentication theme={applicationPreferences.theme} />;

  if (hierarchy === undefined)
    return (
      <ConnectionScreen
        theme={applicationPreferences.theme}
        {...(error === undefined ? {} : { error })}
        {...(repositoryOperationError
          ? { onRetry: retryProjectLoad, transientOperation: true }
          : {})}
      />
    );

  const selectedSection = hierarchy.sections.find(
    (section) => section.manifest.id === selection.sectionId,
  );
  const selectedPage = selectedSection?.pages.find((page) => page.id === selection.pageId);
  const selectedPageData = selectedPage === undefined ? undefined : pages[selectedPage.id];
  const markdownSearch = searchMarkdown(
    selectedPageData?.canvas ?? [],
    selectedPageData?.markdown ?? {},
    markdownSearchQuery,
  );
  const moveMarkdownSearch = (direction: number) => {
    const count = markdownSearch.matches.length;
    if (count === 0) return;
    setMarkdownSearchActiveIndex((current) => (current + direction + count) % count);
  };
  const createPictureInPicture = (capture: PictureInPictureCapture) => {
    if (selectedSection === undefined || selectedPage === undefined) return;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const maximumWidth = Math.max(1, viewportWidth * 0.42);
    const maximumHeight = Math.max(1, viewportHeight * 0.42);
    const minimumScale = Math.max(
      120 / capture.viewportSize.width,
      80 / capture.viewportSize.height,
    );
    const maximumScale = Math.min(
      maximumWidth / capture.viewportSize.width,
      maximumHeight / capture.viewportSize.height,
    );
    const scale = Math.min(maximumScale, Math.max(1, minimumScale));
    const width = capture.viewportSize.width * scale;
    const height = capture.viewportSize.height * scale;
    const cascade = (pictureInPictures.length % 6) * 18;
    const gutter = 20;
    const view: PictureInPictureView = {
      id: `picture-in-picture-${Date.now()}-${nextPictureInPictureId++}`,
      sectionId: selectedSection.manifest.id,
      pageId: selectedPage.id,
      sourceTitle: selectedPage.title,
      bounds: capture.bounds,
      left: Math.max(gutter, viewportWidth - width - gutter - cascade),
      top: Math.max(gutter, viewportHeight - height - gutter - cascade),
      width,
      height,
    };
    setPictureInPictures((current) => [...current, view]);
  };
  const activatePictureInPicture = (id: string) => {
    setPictureInPictures((current) => {
      const active = current.find((view) => view.id === id);
      return active === undefined || current[current.length - 1] === active
        ? current
        : [...current.filter((view) => view.id !== id), active];
    });
  };
  const changePictureInPicture = (id: string, patch: Partial<PictureInPictureView>) => {
    setPictureInPictures((current) =>
      current.map((view) => (view.id === id ? { ...view, ...patch, id: view.id } : view)),
    );
  };

  const createSection = (targetIndex?: number) => {
    if (clientReadOnlyRef.current || busy || markdownEditingRef.current) return;
    flushSync(() => setBusy(true));
    const existingIds = new Set(hierarchy.sections.map((section) => section.manifest.id));
    void command(
      {
        action: "create-section",
        ...(targetIndex === undefined ? {} : { targetIndex }),
      },
      (next) => {
        const created = next.sections.find((section) => !existingIds.has(section.manifest.id));
        if (created === undefined) return;
        const firstPageId = created.pages[0]?.id;
        const nextSelection = {
          sectionId: created.manifest.id,
          ...(firstPageId === undefined ? {} : { pageId: firstPageId }),
        };
        setSelection(nextSelection);
        history.replaceState(null, "", pageRoute(next.notebook.projectId, nextSelection));
        if (firstPageId === undefined) focusEditableTitle("Section title");
      },
    );
  };

  const createPage = (targetIndex?: number) => {
    if (
      selectedSection === undefined ||
      clientReadOnlyRef.current ||
      busy ||
      markdownEditingRef.current
    )
      return;
    flushSync(() => setBusy(true));
    const sectionId = selectedSection.manifest.id;
    const existingIds = new Set(selectedSection.pages.map((page) => page.id));
    void command(
      {
        action: "create-page",
        sectionId,
        ...(targetIndex === undefined ? {} : { targetIndex }),
      },
      (next) => {
        const section = next.sections.find((candidate) => candidate.manifest.id === sectionId);
        const created = section?.pages.find((page) => !existingIds.has(page.id));
        if (section === undefined || created === undefined) return;
        const nextSelection = { sectionId, pageId: created.id };
        setSelection(nextSelection);
        history.replaceState(null, "", pageRoute(next.notebook.projectId, nextSelection));
        focusEditableTitle("Page title");
      },
    );
  };

  const duplicateSection = (sectionId: string, targetIndex: number) => {
    if (clientReadOnlyRef.current || busy || markdownEditingRef.current) return;
    flushSync(() => setBusy(true));
    const existingIds = new Set(hierarchy.sections.map((section) => section.manifest.id));
    void command(
      { action: "duplicate-section", sourceSectionId: sectionId, targetIndex },
      (next) => {
        const duplicated = next.sections.find((section) => !existingIds.has(section.manifest.id));
        if (duplicated === undefined) return;
        const firstPageId = duplicated.pages[0]?.id;
        const nextSelection = {
          sectionId: duplicated.manifest.id,
          ...(firstPageId === undefined ? {} : { pageId: firstPageId }),
        };
        setSelection(nextSelection);
        history.replaceState(null, "", pageRoute(next.notebook.projectId, nextSelection));
        if (firstPageId === undefined) focusEditableTitle("Section title");
      },
    );
  };

  const duplicatePage = (
    sourceSectionId: string,
    sourcePageId: string,
    targetSectionId: string,
    targetIndex: number,
  ) => {
    if (clientReadOnlyRef.current || busy || markdownEditingRef.current) return;
    const target = hierarchy.sections.find((section) => section.manifest.id === targetSectionId);
    if (target === undefined) return;
    flushSync(() => setBusy(true));
    const existingIds = new Set(target.pages.map((page) => page.id));
    void command(
      {
        action: "duplicate-page",
        sourceSectionId,
        sourcePageId,
        targetSectionId,
        targetIndex,
      },
      (next) => {
        const nextTarget = next.sections.find((section) => section.manifest.id === targetSectionId);
        const duplicated = nextTarget?.pages.find((page) => !existingIds.has(page.id));
        if (nextTarget === undefined || duplicated === undefined) return;
        const nextSelection = { sectionId: targetSectionId, pageId: duplicated.id };
        setSelection(nextSelection);
        history.replaceState(null, "", pageRoute(next.notebook.projectId, nextSelection));
        focusEditableTitle("Page title");
      },
    );
  };

  const updateSectionColor = (sectionId: string, color: string | undefined) => {
    if (clientReadOnlyRef.current || busy || markdownEditingRef.current) return;
    void command({
      action: "update-section-color",
      sectionId,
      ...(color === undefined ? {} : { color }),
    });
  };

  const requestDeleteSection = (sectionId: string) => {
    if (clientReadOnlyRef.current || busy || markdownEditingRef.current) return;
    const section = hierarchy.sections.find((candidate) => candidate.manifest.id === sectionId);
    if (section === undefined) return;
    setPendingDeletion({
      kind: "section",
      sectionId,
      title: section.manifest.title,
      pageCount: section.pages.length,
    });
  };

  const requestDeletePage = (sectionId: string, pageId: string) => {
    if (clientReadOnlyRef.current || busy || markdownEditingRef.current) return;
    const section = hierarchy.sections.find((candidate) => candidate.manifest.id === sectionId);
    const page = section?.pages.find((candidate) => candidate.id === pageId);
    if (page === undefined) return;
    setPendingDeletion({ kind: "page", sectionId, pageId, title: page.title });
  };

  const confirmPendingDeletion = () => {
    const pending = pendingDeletion;
    if (pending === undefined || clientReadOnlyRef.current || busy) return;
    const value: HierarchyCommand =
      pending.kind === "section"
        ? { action: "delete-section", sectionId: pending.sectionId, confirmed: true }
        : {
            action: "delete-page",
            sectionId: pending.sectionId,
            pageId: pending.pageId,
            confirmed: true,
          };
    void command(value, (next) => {
      applyHierarchy(next);
      setPendingDeletion(undefined);
    });
  };

  const toggleTheme = () => {
    setApplicationPreferences((current) => ({
      ...current,
      theme: current.theme === "light" ? "dark" : "light",
    }));
  };
  const exportProfileSettings = () => {
    if (authenticatedUsername === undefined) return;
    try {
      downloadExport(
        `${authenticatedUsername}-squillpad-profile.json`,
        serializeProfileSettingsExport(currentProfileSettings()),
        "application/json;charset=utf-8",
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const importProfileSettings = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined || authenticatedUsername === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      if (file.size > PROFILE_SETTINGS_IMPORT_MAX_BYTES) {
        throw new Error("Profile-settings imports must be 256 KiB or smaller");
      }
      const parsed: unknown = JSON.parse(await file.text());
      if (!isProfileSettingsExport(parsed)) {
        throw new Error("Choose a valid SquillPad profile-settings export file");
      }
      const result = await withRepositoryOperationRetry(() =>
        requestJson<{ readonly settings: ProfileSettings }>("/api/profile/settings/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ export: parsed }),
        }),
      );
      applyProfileSettings(result.settings);
      setProfileSettingsReady(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const nextTheme = applicationPreferences.theme === "light" ? "dark" : "light";
  const logout = async () => {
    const clientId = projectPresenceClientIdRef.current;
    if (clientId !== undefined) {
      await requestJson<ProjectPresenceResponse>("/api/presence", {
        method: "POST",
        headers: { [PRESENCE_CLIENT_ID_HEADER]: clientId },
      }).catch(() => undefined);
    }
    await fetch("/api/auth/logout", { method: "POST", headers: accessHeaders() }).catch(
      () => undefined,
    );
    location.reload();
  };
  const navigationDisabled = busy || markdownEditing;
  const mutationDisabled = navigationDisabled || clientReadOnly;
  const selectedSaveSnapshot =
    selectedPage === undefined
      ? undefined
      : saveStatuses[pageStatusKey(hierarchy.notebook.projectId, selectedPage.id)];
  const selectedSaveStatus: SaveStatus =
    savingPageId === selectedPage?.id ? "saving" : (selectedSaveSnapshot?.status ?? "saving");
  const selectedSaveDirty =
    selectedSaveSnapshot?.dirty ??
    (selectedSaveStatus !== "saved" || savingPageId === selectedPage?.id);
  const selectedPageIsSaving = savingPageId === selectedPage?.id;
  const manualSaveActive =
    lanSharingEnabled === false && selectedSaveDirty && !selectedPageIsSaving;
  const selectedSaveLabel = manualSaveActive
    ? "Save now"
    : saveStatusLabel(selectedSaveStatus, selectedSaveDirty);
  const selectedSyncStatus = synchronizationStatusForSharing(
    syncStatuses[selectedPage?.id ?? ""] ?? "connecting",
    lanSharingEnabled,
  );
  const selectedSaveTooltip = saveStatusTooltip(
    selectedSaveStatus,
    selectedSaveDirty,
    lanSharingEnabled,
    manualSaveActive,
  );
  const selectedSyncTooltip = synchronizationStatusTooltip(selectedSyncStatus);

  return (
    <main
      ref={notebookAppRef}
      className={`notebook-app ${canvasFullscreen ? "is-canvas-fullscreen" : ""}`}
      data-theme={applicationPreferences.theme}
      data-fullscreen-phase={canvasFullscreenPhase}
      onPointerDownCapture={handleMenuPointerDown}
      onFocusCapture={(event) => dismissSelectionMenus(event.target)}
    >
      <AppChrome
        theme={applicationPreferences.theme}
        projectTitle={hierarchy.notebook.title}
        projectTitleDisabled={mutationDisabled}
        onProjectTitleCommit={(title) => void command({ action: "rename-project", title })}
        projectPresence={projectPresence}
        currentPresenceId={projectPresenceClientIdRef.current}
        selectedPageId={selectedPage?.id}
        busy={busy}
        selectedSaveLabel={selectedSaveLabel}
        selectedSaveStatus={selectedSaveStatus}
        selectedSaveDirty={selectedSaveDirty}
        selectedPageIsSaving={selectedPageIsSaving}
        selectedSyncStatus={selectedSyncStatus}
        selectedSaveTooltip={selectedSaveTooltip}
        selectedSyncTooltip={selectedSyncTooltip}
        lanSharingEnabled={lanSharingEnabled}
        hostSession={hostSession}
        clientReadOnly={clientReadOnly}
        saveCurrentPage={saveCurrentPage}
        lanSharingRef={lanSharingRef}
        onLanSharingEnabledChange={setLanSharingEnabled}
        storageDiagnosticsRef={storageDiagnosticsRef}
        storageDiagnostics={storageDiagnostics}
        cleaningRuntimeCache={cleaningRuntimeCache}
        onClearRuntimeCache={() => void clearRuntimeCache()}
        repositorySynchronizationRef={repositorySynchronizationRef}
        authenticatedUsername={authenticatedUsername}
        onLogout={() => void logout()}
        hostStopRef={hostStopRef}
        stoppingHost={stoppingHost}
        onStopHosting={() => void stopHosting()}
        onSyncNowBeforeStopping={syncNowBeforeStopping}
        error={error}
        onDismissError={() => setError(undefined)}
        clientHostingStopped={clientHostingStopped}
        hostStoppedNotificationOpen={hostStoppedNotificationOpen}
        onDismissHostStoppedNotification={() => setHostStoppedNotificationOpen(false)}
      />
      <AppNavigation
        hierarchy={hierarchy}
        selectedSection={selectedSection}
        selectedPage={selectedPage}
        navigationOpen={navigationOpen}
        mutationDisabled={mutationDisabled}
        navigationDisabled={navigationDisabled}
        theme={applicationPreferences.theme}
        settings={{
          detailsRef: sectionSettingsRef,
          markdownBoxAppearance,
          textScalePercent: applicationPreferences.textScalePercent,
          laserPointerSettings,
          keyboardPanSpeedMultiplier,
          autosaveIntervalSeconds,
          drawingPreferences,
          palmRejection,
          canvasToolbarHeightDraft,
          authenticatedUsername,
          applicationPageBackground: applicationPreferences.pageBackground,
          hostSession,
          clientReadOnly,
          busy,
          profileSettingsImportRef,
          onMarkdownBoxAppearanceChange: updateMarkdownBoxAppearance,
          onTextScalePercentChange: updateApplicationTextScalePercent,
          onLaserPointerSettingsChange: updateLaserPointerSettings,
          onKeyboardPanSpeedMultiplierChange: updateKeyboardPanSpeedMultiplier,
          onAutosaveIntervalChange: updateAutosaveFrequency,
          onPenDrawsTouchNavigatesChange: (enabled) => {
            if (clientReadOnlyRef.current) return;
            setDrawingPreferences((current) => ({
              ...current,
              penDrawsTouchNavigates: enabled,
            }));
          },
          onPalmRejectionChange: savePalmRejection,
          onCanvasToolbarHeightDraftChange: setCanvasToolbarHeightDraft,
          onCanvasToolbarHeightCommit: commitCanvasToolbarHeight,
          onPageBackgroundChange: (pageBackground) =>
            setApplicationPreferences((current) => ({ ...current, pageBackground })),
          onExportProfileSettings: exportProfileSettings,
          onImportProfileSettings: (event) => void importProfileSettings(event),
        }}
        onCreateSection={createSection}
        onCreatePage={createPage}
        onRenameSection={(title) =>
          void command({
            action: "rename-section",
            sectionId: selectedSection?.manifest.id ?? "",
            title,
          })
        }
        onSectionColorChange={updateSectionColor}
        onDeleteSection={requestDeleteSection}
        onReorderSection={(fromIndex, toIndex) => {
          if (mutationDisabled || fromIndex === toIndex) return;
          void command({
            action: "reorder-sections",
            sectionIds: moveItem(hierarchy.notebook.sectionIds, fromIndex, toIndex),
          });
        }}
        onNavigateToPage={(pageId) => {
          if (selectedSection !== undefined) {
            navigateToPage(hierarchy.notebook.projectId, selectedSection.manifest.id, pageId);
          }
        }}
        onReorderPage={(fromIndex, toIndex) => {
          if (selectedSection === undefined || mutationDisabled || fromIndex === toIndex) return;
          void command({
            action: "reorder-pages",
            sectionId: selectedSection.manifest.id,
            pageIds: moveItem(selectedSection.manifest.pageIds, fromIndex, toIndex),
          });
        }}
        onMovePage={(sourceSectionId, pageId, targetSectionId) => {
          if (mutationDisabled || sourceSectionId === targetSectionId) return;
          const sourceSection = hierarchy.sections.find(
            (section) => section.manifest.id === sourceSectionId,
          );
          if (sourceSection?.pages.some((page) => page.id === pageId) !== true) return;
          void command(
            {
              action: "move-page",
              sourceSectionId,
              targetSectionId,
              pageId,
            },
            (next) => {
              const targetSection = next.sections.find(
                (section) => section.manifest.id === targetSectionId,
              );
              if (targetSection?.pages.some((page) => page.id === pageId) !== true) return;
              const nextSelection = { sectionId: targetSectionId, pageId };
              setSelection(nextSelection);
              history.replaceState(null, "", pageRoute(next.notebook.projectId, nextSelection));
            },
          );
        }}
        onPasteSection={(sourceSectionId, targetIndex) =>
          duplicateSection(sourceSectionId, targetIndex)
        }
        onDuplicateSection={(sectionId, targetIndex) => duplicateSection(sectionId, targetIndex)}
        onPastePage={(sourceSectionId, sourcePageId, targetSectionId, targetIndex) =>
          duplicatePage(sourceSectionId, sourcePageId, targetSectionId, targetIndex)
        }
        onDuplicatePage={(sectionId, pageId, targetIndex) =>
          duplicatePage(sectionId, pageId, sectionId, targetIndex)
        }
        onDeletePage={requestDeletePage}
        onSelectionChange={setSelection}
        onCloseNavigation={closeNavigation}
        onOpenNavigation={() => setNavigationOpen(true)}
        navigationFloatingToggleRef={navigationFloatingToggleRef}
        nextTheme={nextTheme}
        onToggleTheme={toggleTheme}
      >
        <PageWorkspace
          selectedSection={selectedSection}
          selectedPage={selectedPage}
          selectedPageData={selectedPageData}
          pages={pages}
          pictureInPictures={pictureInPictures}
          session={canvasSessionRef.current}
          pageReady={selectedPage !== undefined && readyPageIds.has(selectedPage.id)}
          mutationDisabled={mutationDisabled}
          busy={busy}
          clientReadOnly={clientReadOnly}
          pageBackground={applicationPreferences.pageBackground}
          theme={applicationPreferences.theme}
          canvasFullscreen={canvasFullscreen}
          canvasToolbarHeight={canvasToolbarHeight}
          exportRegionMode={exportRegionMode}
          canvasSelectionCount={canvasSelectionCount}
          laserPointerDecaySeconds={laserPointerSettings.decaySeconds}
          keyboardPanSpeedMultiplier={keyboardPanSpeedMultiplier}
          drawingPreferences={drawingPreferences}
          palmRejection={palmRejection}
          profileDrawingPalettes={profileDrawingPalettes}
          markdownSearchQuery={markdownSearchQuery}
          markdownSearchActiveIndex={markdownSearchActiveIndex}
          markdownSearchInputRef={markdownSearchInputRef}
          markdownBoxAppearance={markdownBoxAppearance}
          markdownColorStyles={markdownColorStyles}
          geometryPreviews={geometryPreviewsByPage[selectedPage?.id ?? ""] ?? []}
          laserPointers={laserPointersByPage[selectedPage?.id ?? ""] ?? []}
          canvasRef={canvasRef}
          fileMenuRef={fileMenuRef}
          onPageTitleCommit={(title) => {
            if (selectedSection === undefined || selectedPage === undefined) return;
            void command({
              action: "rename-page",
              sectionId: selectedSection.manifest.id,
              pageId: selectedPage.id,
              title,
            });
          }}
          onMarkdownSearchQueryChange={(query) => {
            setMarkdownSearchQuery(query);
            setMarkdownSearchActiveIndex(0);
          }}
          onMarkdownSearchActiveIndexChange={setMarkdownSearchActiveIndex}
          onMoveMarkdownSearch={moveMarkdownSearch}
          onExportRegionModeChange={setExportRegionMode}
          onFullscreenChange={toggleCanvasFullscreen}
          onSelectionChange={handleCanvasSelectionChange}
          onPictureInPictureCapture={createPictureInPicture}
          onPictureInPictureActivate={activatePictureInPicture}
          onPictureInPictureChange={changePictureInPicture}
          onPictureInPictureClose={(id) =>
            setPictureInPictures((current) => current.filter((view) => view.id !== id))
          }
          onDrawingPreferencesChange={setDrawingPreferences}
          onProfileDrawingPalettesChange={saveProfileDrawingPalettes}
          onMarkdownColorStylesChange={updateMarkdownColorStyles}
          onMarkdownEditingChange={handleMarkdownEditingChange}
          onGeometryPreviewChange={(preview) => {
            if (selectedPage !== undefined) updateGeometryPreview(selectedPage.id, preview);
          }}
          onLaserPointerChange={(pointers) => {
            if (selectedPage !== undefined) updateLaserPointers(selectedPage.id, pointers);
          }}
          onElementsChange={(elements) => {
            if (selectedPage === undefined) return;
            updatePage(selectedPage.id, (page) => {
              const markdownIds = new Set(
                elements
                  .filter((element) => element.kind === "markdown")
                  .map((element) => element.id),
              );
              const markdown = Object.fromEntries(
                [...markdownIds].map((id) => [id, page.markdown[id] ?? ""]),
              );
              return { ...page, canvas: elements, markdown };
            });
          }}
          onMarkdownSourceChange={(elementId, source) => {
            if (selectedPage !== undefined) updateMarkdown(selectedPage.id, elementId, source);
          }}
          onMarkdownCommit={(elementId, source) => {
            if (selectedPage !== undefined)
              updateMarkdown(selectedPage.id, elementId, source, true);
          }}
          loadImageAsset={(asset) =>
            selectedSection === undefined || selectedPage === undefined
              ? Promise.reject(new Error("Page is unavailable"))
              : fetchImageAsset(selectedSection.manifest.id, selectedPage.id, asset)
          }
          saveImageAsset={(blob) =>
            selectedSection === undefined || selectedPage === undefined
              ? Promise.reject(new Error("Page is unavailable"))
              : uploadImageAsset(selectedSection.manifest.id, selectedPage.id, blob)
          }
          loadPictureInPictureImageAsset={(sectionId, pageId, asset) =>
            fetchImageAsset(sectionId, pageId, asset)
          }
        />
      </AppNavigation>
      <ConfirmationDialog
        open={pendingDeletion !== undefined}
        title={pendingDeletion?.kind === "section" ? "Delete section?" : "Delete page?"}
        description={
          pendingDeletion?.kind === "section" ? (
            <>
              Delete <strong>“{pendingDeletion.title}”</strong> and all {pendingDeletion.pageCount}{" "}
              {pendingDeletion.pageCount === 1 ? "page" : "pages"}? This cannot be undone.
            </>
          ) : pendingDeletion === undefined ? (
            ""
          ) : (
            <>
              Delete <strong>“{pendingDeletion.title}”</strong>? This cannot be undone.
            </>
          )
        }
        confirmLabel={pendingDeletion?.kind === "section" ? "Delete section" : "Delete page"}
        busy={busy}
        onConfirm={confirmPendingDeletion}
        onCancel={() => setPendingDeletion(undefined)}
      />
    </main>
  );
}

function focusEditableTitle(ariaLabel: string): void {
  window.setTimeout(() => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
    input?.focus();
    input?.select();
  }, 0);
}

async function fetchHierarchy(onRetry?: RepositoryRetryNotice): Promise<NotebookHierarchy> {
  return withRepositoryOperationRetry(
    () => requestJson<NotebookHierarchy>(API_PATH, { method: "GET" }),
    onRetry,
  );
}

async function fetchSynchronizationStatus(): Promise<SynchronizationStatusResponse> {
  return requestJson<SynchronizationStatusResponse>("/api/sync/status", { method: "GET" });
}

export function createProjectPresenceClientId(): string {
  try {
    const stored = window.sessionStorage.getItem(PROJECT_PRESENCE_CLIENT_ID_KEY);
    if (stored !== null && PROJECT_PRESENCE_CLIENT_ID_PATTERN.test(stored)) return stored;
  } catch {
    // Restricted tab storage must not prevent presence from being announced.
  }

  const clientId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    window.sessionStorage.setItem(PROJECT_PRESENCE_CLIENT_ID_KEY, clientId);
  } catch {
    // Restricted tab storage only forfeits refresh continuity.
  }
  return clientId;
}

async function fetchPage(sectionId: string, pageId: string): Promise<PageData> {
  return withRepositoryOperationRetry(() =>
    requestJson<PageData>(`/api/pages/${sectionId}/${pageId}`, { method: "GET" }),
  );
}

const imageAssetCache = new Map<string, Promise<Blob>>();

function fetchImageAsset(sectionId: string, pageId: string, asset: string): Promise<Blob> {
  const filename = asset.replace(/^assets\//, "");
  const path = `/api/pages/${sectionId}/${pageId}/assets/${filename}`;
  const cached = imageAssetCache.get(path);
  if (cached !== undefined) return cached;
  const pending = fetch(path, { headers: accessHeaders() }).then(async (response) => {
    if (!response.ok) throw new Error(`Could not load image asset (${response.status})`);
    return response.blob();
  });
  imageAssetCache.set(path, pending);
  void pending.catch(() => imageAssetCache.delete(path));
  return pending;
}

async function uploadImageAsset(sectionId: string, pageId: string, blob: Blob): Promise<string> {
  const response = await fetch(`/api/pages/${sectionId}/${pageId}/assets`, {
    method: "PUT",
    headers: { ...accessHeaders(), "content-type": blob.type },
    body: blob,
  });
  const result = (await response.json()) as { readonly asset?: unknown; readonly error?: unknown };
  if (!response.ok || typeof result.asset !== "string") {
    throw new Error(
      typeof result.error === "string" ? result.error : "Could not store image asset",
    );
  }
  imageAssetCache.set(`/api/pages/${sectionId}/${pageId}/${result.asset}`, Promise.resolve(blob));
  return result.asset;
}

async function sendCommand(command: HierarchyCommand): Promise<NotebookHierarchy> {
  return withRepositoryOperationRetry(() =>
    requestJson<NotebookHierarchy>(`${API_PATH}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    }),
  );
}

function synchronizationUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/sync`;
}

export function synchronizationStatusForSharing(
  status: SynchronizationStatus,
  lanSharingEnabled: boolean | undefined,
): SynchronizationStatus {
  return lanSharingEnabled === false ? "offline" : status;
}

function synchronizationStatusDescription(status: SynchronizationStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting to the host to synchronize this page.";
    case "synchronized":
      return "This page is synchronized with the host.";
    case "offline":
      return "The page is offline and changes are being kept locally.";
    case "error":
      return "Synchronization encountered an error.";
    case "host-disconnected":
      return "The host disconnected, so this page is read-only until synchronization resumes.";
    case "project-reloaded":
      return "The project snapshot changed; reloading into the new synchronization generation.";
    case "host-stopped":
      return "The host stopped, so this page is read-only.";
  }
}

export function synchronizationStatusTooltip(status: SynchronizationStatus): string {
  return `${synchronizationStatusDescription(status)}\nPossible statuses: ${SYNCHRONIZATION_STATUS_POSSIBILITIES}`;
}

function saveStatusLabel(status: SaveStatus, dirty = false): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return dirty ? "Save" : "Saved";
    case "error":
      return "Save error";
  }
}

export function saveStatusTooltip(
  status: SaveStatus,
  dirty: boolean,
  lanSharingEnabled: boolean | undefined,
  manualSaveActive: boolean,
): string {
  let description: string;
  if (manualSaveActive) {
    description =
      status === "error"
        ? "The last save failed; click to retry manually."
        : "Pending changes can be saved manually.";
  } else if (lanSharingEnabled === true) {
    description = "Changes are saved automatically while LAN sharing is enabled.";
  } else {
    switch (status) {
      case "saving":
        description = "Changes are currently being saved.";
        break;
      case "saved":
        description = dirty ? "Changes are waiting to be saved." : "All changes are saved.";
        break;
      case "error":
        description = "The last save failed.";
        break;
    }
  }
  return manualSaveActive
    ? description
    : `${description}\nPossible statuses: ${SAVE_STATUS_POSSIBILITIES}`;
}

function autosaveIntervalLabel(seconds: AutosaveIntervalSeconds): string {
  if (seconds === 0) return "Never";
  if (seconds < 60) return `${seconds} seconds`;
  return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
}

function pageStatusKey(projectId: string, pageId: string): string {
  return `${projectId}:${pageId}`;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(accessHeaders())) headers.set(key, value);
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  const value: unknown = await response.json().catch(() => undefined);
  if (response.status === 401)
    throw new Error("Access denied. Open the authorized connection link shown by the host.");
  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && "error" in value
        ? String(value.error)
        : `Request failed (${response.status})`;
    if (response.status === 409 && message.includes("Repository snapshot operation in progress")) {
      throw new RepositoryOperationInProgressError();
    }
    throw new Error(message);
  }
  return value as T;
}

async function withRepositoryOperationRetry<T>(
  request: () => Promise<T>,
  onRetry?: RepositoryRetryNotice,
): Promise<T> {
  const maximumAttempts = REPOSITORY_OPERATION_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof RepositoryOperationInProgressError)) throw error;
      if (attempt === maximumAttempts) throw new RepositoryOperationRetryExhaustedError();
      onRetry?.(attempt, maximumAttempts);
      const delay = REPOSITORY_OPERATION_RETRY_DELAYS_MS[attempt - 1];
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
  throw new RepositoryOperationRetryExhaustedError();
}

function containsRoute(hierarchy: NotebookHierarchy, route: PageRoute): boolean {
  const section = hierarchy.sections.find((item) => item.manifest.id === route.sectionId);
  return section !== undefined && section.pages.some((page) => page.id === route.pageId);
}

export function resolveSelection(hierarchy: NotebookHierarchy, candidate: Selection): Selection {
  const parsedRoute = parsePageRoute(location.hash);
  const route = parsedRoute.projectId === hierarchy.notebook.projectId ? parsedRoute : {};
  const stored = readStoredSelection(hierarchy.notebook.projectId);
  for (const selection of [route, candidate, stored]) {
    const section = hierarchy.sections.find((item) => item.manifest.id === selection.sectionId);
    if (section === undefined) continue;
    if (section.pages.some((page) => page.id === selection.pageId)) {
      return { sectionId: section.manifest.id, pageId: selection.pageId as string };
    }
    const firstPageId = section.pages[0]?.id;
    return {
      sectionId: section.manifest.id,
      ...(firstPageId === undefined ? {} : { pageId: firstPageId }),
    };
  }
  const section = hierarchy.sections[0];
  if (section === undefined) return {};
  const pageId = section.pages[0]?.id;
  return { sectionId: section.manifest.id, ...(pageId === undefined ? {} : { pageId }) };
}

export function parsePageRoute(hash: string): PageRoute {
  const match = /^#\/projects\/([0-9a-f-]+)\/sections\/([0-9a-f-]+)\/pages\/([0-9a-f-]+)$/.exec(
    hash,
  );
  const projectId = match?.[1];
  const sectionId = match?.[2];
  const pageId = match?.[3];
  return projectId === undefined || sectionId === undefined || pageId === undefined
    ? {}
    : { projectId, sectionId, pageId };
}

function pageRoute(projectId: string, selection: Selection): string {
  return selection.sectionId !== undefined && selection.pageId !== undefined
    ? `#/projects/${projectId}/sections/${selection.sectionId}/pages/${selection.pageId}`
    : "#/";
}

function readStoredSelection(projectId: string): Selection {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(selectionKey(projectId)) ?? "null");
    if (typeof value !== "object" || value === null) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.sectionId === "string" ? { sectionId: record.sectionId } : {}),
      ...(typeof record.pageId === "string" ? { pageId: record.pageId } : {}),
    };
  } catch {
    return {};
  }
}

function selectionKey(projectId: string): string {
  return `squillpad:selection:${projectId}`;
}

const MAX_LASER_POINTERS = 32;

export function parseLaserPointers(value: unknown): readonly LaserPointer[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_LASER_POINTERS) return [];
  return values
    .map((candidate) => parseLaserPointer(candidate))
    .filter((pointer): pointer is LaserPointer => pointer !== undefined);
}

function parseLaserPointer(value: unknown): LaserPointer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.active !== "boolean" ||
    typeof record.color !== "string" ||
    !/^#[0-9a-f]{6}$/iu.test(record.color) ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > 100 ||
    !Array.isArray(record.points) ||
    record.points.length > MAX_LASER_TRACE_POINTS
  ) {
    return undefined;
  }
  const points = record.points.filter((point): point is { x: number; y: number } => {
    if (typeof point !== "object" || point === null) return false;
    const candidate = point as Record<string, unknown>;
    const x = candidate.x;
    const y = candidate.y;
    return (
      typeof x === "number" &&
      Number.isFinite(x) &&
      Math.abs(x) <= 10_000_000 &&
      typeof y === "number" &&
      Number.isFinite(y) &&
      Math.abs(y) <= 10_000_000
    );
  });
  if (points.length === 0 || points.length !== record.points.length) return undefined;
  return { active: record.active, color: record.color, id: record.id, points };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
