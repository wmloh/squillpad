import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  elementBounds,
  serializeCanonicalJson,
  type CanvasElement,
  type NotebookHierarchy,
} from "@squillpad/core-model";
import { type Bounds, type Camera } from "@squillpad/ui";

import { accessHeaders } from "./host-access";
import type {
  RepositoryCheck,
  RepositoryCommitSummary,
  RepositoryConfirmation,
  RepositoryLineChanges,
  RepositoryPreviewPage,
  RepositorySnapshotReview as RepositorySnapshotReviewState,
  RepositorySynchronizationResult,
} from "./repository-sync-types";

export interface RepositoryStatus {
  readonly available: true;
  readonly configured: boolean;
  readonly remoteUrl?: string;
  readonly branch?: string;
}

export type CommitSummary = RepositoryCommitSummary;
export type Confirmation = RepositoryConfirmation;
export type PreviewPage = RepositoryPreviewPage;
export type SynchronizationResult = RepositorySynchronizationResult;

export interface HistoricalSnapshot {
  readonly commit: string;
  readonly hierarchy: NotebookHierarchy;
  readonly changes: RepositoryLineChanges;
}

export const CURRENT_SNAPSHOT_ID = "current";

export interface SnapshotOption {
  readonly id: string;
  readonly commit?: CommitSummary;
}

export interface LoadedSnapshot {
  readonly option: SnapshotOption;
  readonly hierarchy: NotebookHierarchy;
  readonly changes?: RepositoryLineChanges;
}

export interface ComparisonSection {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly { readonly id: string; readonly title: string }[];
}

export type PendingConfirmation =
  | {
      readonly kind: "request";
      readonly path: string;
      readonly body: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "restore"; readonly commit: string; readonly head: string };

interface RepositorySynchronizationOptions {
  readonly onProjectReload?: () => void;
}

export interface RepositorySynchronizationState {
  readonly status: RepositoryStatus | undefined;
  readonly open: boolean;
  readonly historyOpen: boolean;
  readonly url: string;
  readonly note: string;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly message: string | undefined;
  readonly review: RepositorySnapshotReviewState | undefined;
  readonly confirmation: Confirmation | undefined;
  readonly confirmationInput: string;
  readonly history: readonly CommitSummary[] | undefined;
  readonly olderSnapshotId: string | undefined;
  readonly newerSnapshotId: string | undefined;
  readonly olderSnapshot: LoadedSnapshot | undefined;
  readonly newerSnapshot: LoadedSnapshot | undefined;
  readonly selectedSectionId: string | undefined;
  readonly selectedPageId: string | undefined;
  readonly olderPage: PreviewPage | undefined;
  readonly newerPage: PreviewPage | undefined;
  readonly previewMode: "older" | "newer";
  readonly compareSnapshots: boolean;
  readonly synchronizeNavigation: boolean;
  readonly dimCommonElements: boolean;
  readonly olderCamera: Camera | undefined;
  readonly newerCamera: Camera | undefined;
  readonly linkedCamera: Camera | undefined;
  readonly orderSwapFlash: boolean;
  readonly orderSwapNotice: string | undefined;
  readonly reloadRequested: boolean;
  readonly comparisonRefreshToken: number;
  readonly snapshotOptions: readonly SnapshotOption[];
  readonly olderSelection: SnapshotOption | undefined;
  readonly newerSelection: SnapshotOption | undefined;
  readonly comparisonSections: readonly ComparisonSection[];
  readonly selectedSection: ComparisonSection | undefined;
  readonly comparisonChanges: RepositoryLineChanges | undefined;
  readonly previewPage: PreviewPage | undefined;
  readonly previewCamerasLinked: boolean;
  readonly comparisonContentBounds: Bounds | undefined;
  readonly dimmedPreviewElementIds: ReadonlySet<string> | undefined;
  readonly comparisonCamera: Camera | undefined;
  readonly setOpen: (open: boolean) => void;
  readonly setHistoryOpen: (open: boolean) => void;
  readonly setUrl: (url: string) => void;
  readonly setNote: (note: string) => void;
  readonly setConfirmationInput: (input: string) => void;
  readonly setSelectedSectionId: (id: string | undefined) => void;
  readonly setSelectedPageId: (id: string | undefined) => void;
  readonly setLinkedCamera: (camera: Camera | undefined) => void;
  readonly setPreviewMode: (mode: "older" | "newer") => void;
  readonly setCompareSnapshots: (compare: boolean) => void;
  readonly setSynchronizeNavigation: (synchronize: boolean) => void;
  readonly setDimCommonElements: (dim: boolean) => void;
  readonly beginOperation: () => () => void;
  readonly run: (path: string, body: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly openHistory: () => void;
  readonly selectSnapshot: (side: "older" | "newer", id: string) => void;
  readonly requestRestore: (commit: CommitSummary, typed?: string) => Promise<void>;
  readonly confirmPending: () => void;
  readonly closeSynchronization: () => void;
  readonly handleResult: (result: SynchronizationResult) => void;
  readonly handleComparisonReview: (review: RepositorySnapshotReviewState) => void;
  readonly handleOlderCameraChange: (camera: Camera) => void;
  readonly handleNewerCameraChange: (camera: Camera) => void;
  readonly snapshotOptionLabel: (option: SnapshotOption) => string;
  readonly syncNow: () => void;
}

export function useRepositorySynchronization(
  options: RepositorySynchronizationOptions = {},
): RepositorySynchronizationState {
  const { onProjectReload } = options;
  const [status, setStatus] = useState<RepositoryStatus>();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [operationCount, setOperationCount] = useState(0);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [review, setReview] = useState<RepositorySnapshotReviewState>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [confirmationInput, setConfirmationInput] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const [history, setHistory] = useState<readonly CommitSummary[]>();
  const [olderSnapshotId, setOlderSnapshotId] = useState<string>();
  const [newerSnapshotId, setNewerSnapshotId] = useState<string>();
  const [olderSnapshot, setOlderSnapshot] = useState<LoadedSnapshot>();
  const [newerSnapshot, setNewerSnapshot] = useState<LoadedSnapshot>();
  const [selectedSectionId, setSelectedSectionId] = useState<string>();
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [olderPage, setOlderPage] = useState<PreviewPage>();
  const [newerPage, setNewerPage] = useState<PreviewPage>();
  const [previewMode, setPreviewMode] = useState<"older" | "newer">("older");
  const [compareSnapshots, setCompareSnapshots] = useState(true);
  const [synchronizeNavigation, setSynchronizeNavigation] = useState(true);
  const [dimCommonElements, setDimCommonElements] = useState(false);
  const [olderCamera, setOlderCamera] = useState<Camera>();
  const [newerCamera, setNewerCamera] = useState<Camera>();
  const [linkedCamera, setLinkedCamera] = useState<Camera>();
  const [orderSwapFlash, setOrderSwapFlash] = useState(false);
  const [orderSwapNotice, setOrderSwapNotice] = useState<string>();
  const [comparisonRefreshToken, setComparisonRefreshToken] = useState(0);
  const [reloadRequested, setReloadRequested] = useState(false);
  const orderSwapTimer = useRef<number | undefined>(undefined);
  const busy = operationCount > 0;

  const beginOperation = useCallback(() => {
    let released = false;
    setOperationCount((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setOperationCount((count) => Math.max(0, count - 1));
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchJson<RepositoryStatus>("/api/repository-sync/status", { method: "GET" })
      .then(async (next) => {
        if (cancelled) return;
        setStatus(next);
        setUrl(next.remoteUrl ?? "");
        if (!next.configured) return;
        const release = beginOperation();
        try {
          const check = await fetchJson<RepositoryCheck>("/api/repository-sync/check", {
            method: "GET",
          });
          if (cancelled) return;
          setMessage(check.message);
          if (check.review !== undefined) setReview(check.review);
          if (check.remoteUpdateAvailable) setOpen(true);
        } finally {
          release();
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [beginOperation]);

  const snapshotOptions = useMemo<readonly SnapshotOption[]>(
    () => [
      { id: CURRENT_SNAPSHOT_ID },
      ...(history ?? []).map((commit) => ({ id: commit.commit, commit })),
    ],
    [history],
  );
  const olderSelection = useMemo(
    () => snapshotOptions.find((option) => option.id === olderSnapshotId),
    [olderSnapshotId, snapshotOptions],
  );
  const newerSelection = useMemo(
    () => snapshotOptions.find((option) => option.id === newerSnapshotId),
    [newerSnapshotId, snapshotOptions],
  );

  const selectSnapshot = useCallback(
    (side: "older" | "newer", id: string) => {
      const requestedOlderId = side === "older" ? id : (olderSnapshotId ?? id);
      const requestedNewerId = side === "newer" ? id : (newerSnapshotId ?? id);
      const normalized = normalizeSnapshotPair(requestedOlderId, requestedNewerId, history ?? []);
      setOlderSnapshotId(normalized.olderId);
      setNewerSnapshotId(normalized.newerId);
      if (normalized.swapped) {
        setOrderSwapNotice("Reordered the selections so the comparison runs older → newer.");
        setOrderSwapFlash(false);
        if (orderSwapTimer.current !== undefined) window.clearTimeout(orderSwapTimer.current);
        orderSwapTimer.current = window.setTimeout(() => {
          setOrderSwapFlash(true);
          orderSwapTimer.current = window.setTimeout(() => setOrderSwapFlash(false), 850);
        }, 0);
      } else {
        setOrderSwapNotice(undefined);
      }
    },
    [history, newerSnapshotId, olderSnapshotId],
  );

  useEffect(
    () => () => {
      if (orderSwapTimer.current !== undefined) window.clearTimeout(orderSwapTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (olderSelection === undefined || newerSelection === undefined) {
      setOlderSnapshot(undefined);
      setNewerSnapshot(undefined);
      return;
    }
    let cancelled = false;
    setOlderSnapshot(undefined);
    setNewerSnapshot(undefined);
    setOlderPage(undefined);
    setNewerPage(undefined);
    setOlderCamera(undefined);
    setNewerCamera(undefined);
    setLinkedCamera(undefined);
    const release = beginOperation();
    const compareTo =
      olderSelection.commit !== undefined && newerSelection.commit !== undefined
        ? olderSelection.commit.commit
        : undefined;
    void Promise.all([loadSnapshot(olderSelection), loadSnapshot(newerSelection, compareTo)])
      .then(([older, newer]) => {
        if (cancelled) return;
        setOlderSnapshot(older);
        setNewerSnapshot(newer);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(release);
    return () => {
      cancelled = true;
    };
  }, [beginOperation, newerSelection, olderSelection]);

  const comparisonSections = useMemo(
    () => unionComparisonSections(olderSnapshot?.hierarchy, newerSnapshot?.hierarchy),
    [newerSnapshot?.hierarchy, olderSnapshot?.hierarchy],
  );
  const selectedSection = comparisonSections.find((section) => section.id === selectedSectionId);
  const comparisonChanges =
    newerSnapshot?.changes ??
    (newerSelection?.id === CURRENT_SNAPSHOT_ID ? olderSnapshot?.changes : undefined);
  const previewPage = previewMode === "older" ? olderPage : newerPage;
  const previewCamerasLinked =
    compareSnapshots && synchronizeNavigation && olderPage !== undefined && newerPage !== undefined;
  const comparisonContentBounds = useMemo(
    () =>
      compareSnapshots && olderPage !== undefined && newerPage !== undefined
        ? combinedPreviewBounds([...olderPage.canvas, ...newerPage.canvas])
        : undefined,
    [compareSnapshots, newerPage, olderPage],
  );
  const unchangedPreviewElementIds = useMemo(
    () =>
      compareSnapshots && olderPage !== undefined && newerPage !== undefined
        ? findUnchangedPreviewElementIds(newerPage, olderPage)
        : undefined,
    [compareSnapshots, newerPage, olderPage],
  );
  const dimmedPreviewElementIds = dimCommonElements ? unchangedPreviewElementIds : undefined;
  const comparisonCamera = linkedCamera ?? olderCamera ?? newerCamera;

  useEffect(() => {
    if (comparisonSections.length === 0) {
      setSelectedSectionId(undefined);
      setSelectedPageId(undefined);
      return;
    }
    const section = comparisonSections.find((candidate) => candidate.id === selectedSectionId);
    const resolvedSection = section ?? comparisonSections[0];
    const page = resolvedSection?.pages.find((candidate) => candidate.id === selectedPageId);
    setSelectedSectionId(resolvedSection?.id);
    setSelectedPageId(page?.id ?? resolvedSection?.pages[0]?.id);
  }, [comparisonSections, selectedPageId, selectedSectionId]);

  useEffect(() => {
    if (
      olderSnapshot === undefined ||
      newerSnapshot === undefined ||
      selectedSectionId === undefined ||
      selectedPageId === undefined
    ) {
      setOlderPage(undefined);
      setNewerPage(undefined);
      return;
    }
    let cancelled = false;
    setOlderPage(undefined);
    setNewerPage(undefined);
    setOlderCamera(undefined);
    setNewerCamera(undefined);
    setLinkedCamera(undefined);
    const release = beginOperation();
    void Promise.all([
      loadPreviewPage(olderSnapshot, selectedSectionId, selectedPageId),
      loadPreviewPage(newerSnapshot, selectedSectionId, selectedPageId),
    ])
      .then(([older, newer]) => {
        if (cancelled) return;
        setOlderPage(older);
        setNewerPage(newer);
        if (older === undefined) setPreviewMode("newer");
        if (newer === undefined) setPreviewMode("older");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(release);
    return () => {
      cancelled = true;
    };
  }, [beginOperation, newerSnapshot, olderSnapshot, selectedPageId, selectedSectionId]);

  const handleOlderCameraChange = useCallback(
    (next: Camera) => {
      setOlderCamera(next);
      if (previewCamerasLinked) {
        setNewerCamera(next);
        setLinkedCamera(next);
      }
    },
    [previewCamerasLinked],
  );
  const handleNewerCameraChange = useCallback(
    (next: Camera) => {
      setNewerCamera(next);
      if (previewCamerasLinked) {
        setOlderCamera(next);
        setLinkedCamera(next);
      }
    },
    [previewCamerasLinked],
  );

  const handleResult = useCallback((result: SynchronizationResult) => {
    setMessage(result.message);
    if (result.outcome !== "confirmation-required") {
      setConfirmation(undefined);
      setPendingConfirmation(undefined);
      setConfirmationInput("");
    }
    if (result.conflict !== undefined) {
      setReview({ kind: "conflict", ...result.conflict });
    } else if (result.review !== undefined) {
      setReview(result.review);
    } else if (result.outcome !== "confirmation-required") {
      setReview(undefined);
    }
    if (result.projectReloaded) setReloadRequested(true);
    else setComparisonRefreshToken((value) => value + 1);
  }, []);

  const handleComparisonReview = useCallback((next: RepositorySnapshotReviewState) => {
    setReview(next);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!reloadRequested || busy) return;
    if (onProjectReload === undefined) window.location.reload();
    else onProjectReload();
  }, [busy, onProjectReload, reloadRequested]);

  const run = useCallback(
    async (path: string, body: Readonly<Record<string, unknown>>) => {
      const release = beginOperation();
      setError(undefined);
      try {
        const result = await fetchJson<SynchronizationResult>(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (result.outcome === "confirmation-required" && result.confirmation !== undefined) {
          setConfirmation(result.confirmation);
          setPendingConfirmation({ kind: "request", path, body });
          setConfirmationInput("");
          setMessage(result.message);
        } else handleResult(result);
        if (path.endsWith("/configure")) {
          const nextStatus = await fetchJson<RepositoryStatus>("/api/repository-sync/status", {
            method: "GET",
          });
          setStatus(nextStatus);
          setUrl(nextStatus.remoteUrl ?? url);
        }
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        release();
      }
    },
    [beginOperation, handleResult, url],
  );

  const loadHistory = useCallback(async () => {
    const release = beginOperation();
    setError(undefined);
    setHistory(undefined);
    setOlderSnapshotId(undefined);
    setNewerSnapshotId(undefined);
    setOlderSnapshot(undefined);
    setNewerSnapshot(undefined);
    setOlderPage(undefined);
    setNewerPage(undefined);
    setOlderCamera(undefined);
    setNewerCamera(undefined);
    setLinkedCamera(undefined);
    setOrderSwapFlash(false);
    setOrderSwapNotice(undefined);
    try {
      const response = await fetchJson<{ readonly commits: readonly CommitSummary[] }>(
        "/api/repository-sync/history",
        { method: "GET" },
      );
      setHistory(response.commits);
      setOlderSnapshotId(response.commits[0]?.commit ?? CURRENT_SNAPSHOT_ID);
      setNewerSnapshotId(CURRENT_SNAPSHOT_ID);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      release();
    }
  }, [beginOperation]);

  const openHistory = useCallback(() => {
    if (busy || review !== undefined || reloadRequested) return;
    setHistoryOpen(true);
    setCompareSnapshots(true);
    setSynchronizeNavigation(true);
    setDimCommonElements(false);
    void loadHistory();
  }, [busy, loadHistory, reloadRequested, review]);

  const requestRestore = useCallback(
    async (commit: CommitSummary, typed?: string) => {
      const head = history?.[0]?.commit;
      if (head === undefined) return;
      const release = beginOperation();
      setError(undefined);
      try {
        const result = await fetchJson<SynchronizationResult>(
          "/api/repository-sync/history/restore",
          {
            method: "POST",
            body: JSON.stringify({
              commit: commit.commit,
              head,
              ...(typed === undefined ? {} : { confirmation: typed }),
            }),
          },
        );
        if (result.outcome === "confirmation-required" && result.confirmation !== undefined) {
          setConfirmation(result.confirmation);
          setPendingConfirmation({ kind: "restore", commit: commit.commit, head });
          setConfirmationInput("");
          setMessage(result.message);
          setHistoryOpen(false);
        } else handleResult(result);
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        release();
      }
    },
    [beginOperation, handleResult, history],
  );

  const confirmPending = useCallback(() => {
    if (pendingConfirmation?.kind === "request") {
      void run(pendingConfirmation.path, {
        ...pendingConfirmation.body,
        confirmation: confirmationInput,
      });
    } else if (pendingConfirmation?.kind === "restore") {
      const commit = history?.find((entry) => entry.commit === pendingConfirmation.commit);
      if (commit !== undefined) void requestRestore(commit, confirmationInput);
    }
  }, [confirmationInput, history, pendingConfirmation, requestRestore, run]);

  const closeSynchronization = useCallback(() => {
    if (busy || reloadRequested) return;
    setOpen(false);
    setHistoryOpen(false);
  }, [busy, reloadRequested]);

  const syncNow = useCallback(() => {
    if (busy || review !== undefined || reloadRequested) return;
    setOpen(true);
    if (status?.configured === true) void run("/api/repository-sync/run", { note });
  }, [busy, note, reloadRequested, review, run, status]);

  const snapshotOptionLabel = useCallback((option: SnapshotOption): string => {
    return option.commit === undefined
      ? "Current snapshot (live)"
      : `${option.commit.message} · ${formatTimestamp(option.commit.timestamp)}`;
  }, []);

  return {
    status,
    open,
    historyOpen,
    url,
    note,
    busy,
    error,
    message,
    review,
    confirmation,
    confirmationInput,
    history,
    olderSnapshotId,
    newerSnapshotId,
    olderSnapshot,
    newerSnapshot,
    selectedSectionId,
    selectedPageId,
    olderPage,
    newerPage,
    previewMode,
    compareSnapshots,
    synchronizeNavigation,
    dimCommonElements,
    olderCamera,
    newerCamera,
    linkedCamera,
    orderSwapFlash,
    orderSwapNotice,
    reloadRequested,
    comparisonRefreshToken,
    snapshotOptions,
    olderSelection,
    newerSelection,
    comparisonSections,
    selectedSection,
    comparisonChanges,
    previewPage,
    previewCamerasLinked,
    comparisonContentBounds,
    dimmedPreviewElementIds,
    comparisonCamera,
    setOpen,
    setHistoryOpen,
    setUrl,
    setNote,
    setConfirmationInput,
    setSelectedSectionId,
    setSelectedPageId,
    setLinkedCamera,
    setPreviewMode,
    setCompareSnapshots,
    setSynchronizeNavigation,
    setDimCommonElements,
    beginOperation,
    run,
    openHistory,
    selectSnapshot,
    requestRestore,
    confirmPending,
    closeSynchronization,
    handleResult,
    handleComparisonReview,
    handleOlderCameraChange,
    handleNewerCameraChange,
    snapshotOptionLabel,
    syncNow,
  };
}

async function loadSnapshot(option: SnapshotOption, compareTo?: string): Promise<LoadedSnapshot> {
  if (option.commit === undefined) {
    return {
      option,
      hierarchy: await fetchJson<NotebookHierarchy>("/api/hierarchy", { method: "GET" }),
    };
  }
  const snapshot = await fetchJson<HistoricalSnapshot>("/api/repository-sync/history/snapshot", {
    method: "POST",
    body: JSON.stringify({
      commit: option.commit.commit,
      ...(compareTo === undefined ? {} : { compareTo }),
    }),
  });
  return { option, hierarchy: snapshot.hierarchy, changes: snapshot.changes };
}

async function loadPreviewPage(
  snapshot: LoadedSnapshot,
  sectionId: string,
  pageId: string,
): Promise<PreviewPage | undefined> {
  if (!hasPage(snapshot.hierarchy, sectionId, pageId)) return undefined;
  if (snapshot.option.commit === undefined) {
    return fetchJson<PreviewPage>(`/api/pages/${sectionId}/${pageId}`, { method: "GET" });
  }
  return fetchJson<PreviewPage>("/api/repository-sync/history/page", {
    method: "POST",
    body: JSON.stringify({ commit: snapshot.option.commit.commit, sectionId, pageId }),
  });
}

function normalizeSnapshotPair(
  olderId: string,
  newerId: string,
  history: readonly CommitSummary[],
): { readonly olderId: string; readonly newerId: string; readonly swapped: boolean } {
  if (snapshotOrder(olderId, history) >= snapshotOrder(newerId, history)) {
    return { olderId, newerId, swapped: false };
  }
  return { olderId: newerId, newerId: olderId, swapped: true };
}

function snapshotOrder(id: string, history: readonly CommitSummary[]): number {
  if (id === CURRENT_SNAPSHOT_ID) return -1;
  const index = history.findIndex((commit) => commit.commit === id);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function unionComparisonSections(
  older: NotebookHierarchy | undefined,
  newer: NotebookHierarchy | undefined,
): readonly ComparisonSection[] {
  const sections = new Map<
    string,
    { readonly id: string; title: string; pages: Map<string, string> }
  >();
  for (const hierarchy of [older, newer]) {
    if (hierarchy === undefined) continue;
    for (const section of hierarchy.sections) {
      const existing = sections.get(section.manifest.id);
      if (existing === undefined) {
        sections.set(section.manifest.id, {
          id: section.manifest.id,
          title: section.manifest.title,
          pages: new Map(section.pages.map((page) => [page.id, page.title])),
        });
      } else {
        existing.title = section.manifest.title;
        for (const page of section.pages) existing.pages.set(page.id, page.title);
      }
    }
  }
  return [...sections.values()].map((section) => ({
    id: section.id,
    title: section.title,
    pages: [...section.pages].map(([id, title]) => ({ id, title })),
  }));
}

function hasPage(hierarchy: NotebookHierarchy, sectionId: string, pageId: string): boolean {
  return hierarchy.sections.some(
    (section) => section.manifest.id === sectionId && section.manifest.pageIds.includes(pageId),
  );
}

function combinedPreviewBounds(elements: readonly CanvasElement[]): Bounds | undefined {
  if (elements.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const bounds = elementBounds(element);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function findUnchangedPreviewElementIds(
  newerPage: PreviewPage,
  olderPage: PreviewPage,
): ReadonlySet<string> {
  const olderSignatures = new Set(
    olderPage.canvas.map((element) => previewElementSignature(element, olderPage.markdown)),
  );
  return new Set(
    newerPage.canvas
      .filter((element) =>
        olderSignatures.has(previewElementSignature(element, newerPage.markdown)),
      )
      .map((element) => element.id),
  );
}

function previewElementSignature(
  element: CanvasElement,
  markdownSources: Readonly<Record<string, string>>,
): string {
  return serializeCanonicalJson({
    element,
    markdownSource: element.kind === "markdown" ? (markdownSources[element.id] ?? "") : null,
  });
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(accessHeaders());
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as { readonly error?: unknown } & T;
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    );
  }
  return body;
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
