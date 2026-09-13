import { useEffect, useMemo, useState } from "react";

import {
  elementBounds,
  serializeCanonicalJson,
  type CanvasElement,
  type NotebookHierarchy,
} from "@squillpad/core-model";
import { SpatialCanvas, type Bounds, type Camera } from "@squillpad/ui";

import { accessHeaders } from "./host-access";
import { RepositoryChangeBar } from "./RepositoryChangeSummary";
import type {
  RepositoryCommitSummary,
  RepositoryMergeConflict,
  RepositoryMergePageOverride,
  RepositoryMergePreview,
  RepositoryPreviewPage,
  RepositorySnapshotReview,
  RepositorySynchronizationResult,
} from "./repository-sync-types";

interface SnapshotResponse {
  readonly hierarchy: NotebookHierarchy;
}

interface SnapshotPair {
  readonly local: NotebookHierarchy;
  readonly remote: NotebookHierarchy;
}

interface ReviewPageProps {
  readonly label: string;
  readonly page: RepositoryPreviewPage | undefined;
  readonly camera: Camera | undefined;
  readonly contentBounds: Bounds | undefined;
  readonly dimmedElementIds: ReadonlySet<string> | undefined;
  readonly onCameraChange: (camera: Camera) => void;
  readonly pageId: string;
  readonly theme: "light" | "dark";
}

export interface RepositorySnapshotReviewProps {
  readonly busy: boolean;
  readonly onOperationStart?: () => () => void;
  readonly onResult: (result: RepositorySynchronizationResult) => void;
  readonly review: RepositorySnapshotReview;
  readonly theme: "light" | "dark";
}

const noop = () => undefined;

/** Reviews a pending remote update or conflict in one inline, side-by-side workflow. */
export function RepositorySnapshotReview({
  busy,
  onOperationStart,
  onResult,
  review,
  theme,
}: RepositorySnapshotReviewProps) {
  const [snapshotPair, setSnapshotPair] = useState<SnapshotPair>();
  const [selectedSectionId, setSelectedSectionId] = useState<string>();
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [selectedLocalOnlyKey, setSelectedLocalOnlyKey] = useState<string>();
  const [localPage, setLocalPage] = useState<RepositoryPreviewPage>();
  const [remotePage, setRemotePage] = useState<RepositoryPreviewPage>();
  const [mergePreview, setMergePreview] = useState<RepositoryMergePreview>();
  const [candidatePages, setCandidatePages] = useState<
    Readonly<Record<string, RepositoryPreviewPage>>
  >({});
  const [dirtyCandidateKeys, setDirtyCandidateKeys] = useState<ReadonlySet<string>>(new Set());
  const [resolvedConflictPaths, setResolvedConflictPaths] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [linkNavigation, setLinkNavigation] = useState(true);
  const [dimCommonElements, setDimCommonElements] = useState(false);
  const [localCamera, setLocalCamera] = useState<Camera>();
  const [remoteCamera, setRemoteCamera] = useState<Camera>();
  const [linkedCamera, setLinkedCamera] = useState<Camera>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setSnapshotPair(undefined);
    setSelectedSectionId(undefined);
    setSelectedPageId(undefined);
    setSelectedLocalOnlyKey(undefined);
    setLocalPage(undefined);
    setRemotePage(undefined);
    setMergePreview(undefined);
    setCandidatePages({});
    setDirtyCandidateKeys(new Set());
    setResolvedConflictPaths(new Set());
    setLocalCamera(undefined);
    setRemoteCamera(undefined);
    setLinkedCamera(undefined);
    setError(undefined);
    const release = onOperationStart?.() ?? noop;
    void Promise.all([
      postJson<SnapshotResponse>("/api/repository-sync/history/snapshot", {
        commit: review.local.commit,
      }),
      postJson<SnapshotResponse>("/api/repository-sync/history/snapshot", {
        commit: review.remote.commit,
      }),
    ])
      .then(([local, remote]) => {
        if (cancelled) return;
        setSnapshotPair({ local: local.hierarchy, remote: remote.hierarchy });
        const initial = firstReviewPage(review, local.hierarchy, remote.hierarchy);
        setSelectedSectionId(initial?.sectionId);
        setSelectedPageId(initial?.pageId);
        setSelectedLocalOnlyKey(
          initial !== undefined && !hasPage(remote.hierarchy, initial.sectionId, initial.pageId)
            ? pageKey(initial.sectionId, initial.pageId)
            : undefined,
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(release);
    return () => {
      cancelled = true;
    };
  }, [onOperationStart, review, review.local.commit, review.remote.commit]);

  const sectionOptions = useMemo(
    () =>
      snapshotPair?.remote.sections.map((section) => ({
        id: section.manifest.id,
        title: section.manifest.title,
        pages: section.pages.map((page) => ({ id: page.id, title: page.title })),
      })) ?? [],
    [snapshotPair],
  );
  const localOnlyPages = useMemo(
    () =>
      snapshotPair === undefined
        ? []
        : localOnlyPageOptions(snapshotPair.local, snapshotPair.remote),
    [snapshotPair],
  );
  const selectedSection = sectionOptions.find((section) => section.id === selectedSectionId);
  const pageOptions = useMemo(() => selectedSection?.pages ?? [], [selectedSection]);

  useEffect(() => {
    if (selectedLocalOnlyKey !== undefined) {
      if (!localOnlyPages.some((page) => page.key === selectedLocalOnlyKey)) {
        setSelectedLocalOnlyKey(undefined);
      }
      return;
    }
    if (selectedSectionId === undefined) return;
    if (!sectionOptions.some((section) => section.id === selectedSectionId)) {
      setSelectedSectionId(sectionOptions[0]?.id);
      return;
    }
    if (!pageOptions.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(pageOptions[0]?.id);
    }
  }, [
    localOnlyPages,
    pageOptions,
    sectionOptions,
    selectedLocalOnlyKey,
    selectedPageId,
    selectedSectionId,
  ]);

  useEffect(() => {
    if (
      snapshotPair === undefined ||
      selectedSectionId === undefined ||
      selectedPageId === undefined
    ) {
      setLocalPage(undefined);
      setRemotePage(undefined);
      return;
    }
    let cancelled = false;
    setLocalPage(undefined);
    setRemotePage(undefined);
    setLocalCamera(undefined);
    setRemoteCamera(undefined);
    setLinkedCamera(undefined);
    const localExists = hasPage(snapshotPair.local, selectedSectionId, selectedPageId);
    const remoteExists = hasPage(snapshotPair.remote, selectedSectionId, selectedPageId);
    const release = onOperationStart?.() ?? noop;
    void Promise.all([
      localExists
        ? postJson<RepositoryPreviewPage>("/api/repository-sync/history/page", {
            commit: review.local.commit,
            sectionId: selectedSectionId,
            pageId: selectedPageId,
          })
        : Promise.resolve(undefined),
      remoteExists
        ? postJson<RepositoryPreviewPage>("/api/repository-sync/history/page", {
            commit: review.remote.commit,
            sectionId: selectedSectionId,
            pageId: selectedPageId,
          })
        : Promise.resolve(undefined),
    ])
      .then(([local, remote]) => {
        if (cancelled) return;
        setLocalPage(local);
        setRemotePage(remote);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(release);
    return () => {
      cancelled = true;
    };
  }, [
    onOperationStart,
    review.local.commit,
    review.remote.commit,
    selectedPageId,
    selectedSectionId,
    snapshotPair,
  ]);

  const candidateKey =
    selectedSectionId === undefined || selectedPageId === undefined
      ? undefined
      : pageKey(selectedSectionId, selectedPageId);
  const candidatePage = candidateKey === undefined ? undefined : candidatePages[candidateKey];
  const candidateHasPage =
    mergePreview?.hierarchy !== undefined &&
    selectedSectionId !== undefined &&
    selectedPageId !== undefined &&
    hasPage(mergePreview.hierarchy, selectedSectionId, selectedPageId);

  useEffect(() => {
    if (
      mergePreview === undefined ||
      candidateKey === undefined ||
      selectedSectionId === undefined ||
      selectedPageId === undefined ||
      !candidateHasPage ||
      candidatePage !== undefined
    ) {
      return;
    }
    let cancelled = false;
    const release = onOperationStart?.() ?? noop;
    void postJson<RepositoryPreviewPage>("/api/repository-sync/merge/page", {
      candidateId: mergePreview.candidateId,
      sectionId: selectedSectionId,
      pageId: selectedPageId,
    })
      .then((page) => {
        if (cancelled) return;
        setCandidatePages((current) => ({ ...current, [candidateKey]: page }));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(release);
    return () => {
      cancelled = true;
    };
  }, [
    candidateHasPage,
    candidateKey,
    candidatePage,
    mergePreview,
    onOperationStart,
    selectedPageId,
    selectedSectionId,
  ]);

  const contentBounds = useMemo(
    () => combinedPreviewBounds([...(localPage?.canvas ?? []), ...(remotePage?.canvas ?? [])]),
    [localPage, remotePage],
  );
  const unchangedElementIds = useMemo(
    () =>
      localPage !== undefined && remotePage !== undefined
        ? findUnchangedElementIds(localPage, remotePage)
        : undefined,
    [localPage, remotePage],
  );
  const dimmedElementIds = dimCommonElements ? unchangedElementIds : undefined;
  const camerasLinked = linkNavigation && localPage !== undefined && remotePage !== undefined;
  const comparisonCamera = linkedCamera ?? localCamera ?? remoteCamera;
  const disabled = busy;

  const updateLocalCamera = (camera: Camera) => {
    setLocalCamera(camera);
    if (camerasLinked) {
      setRemoteCamera(camera);
      setLinkedCamera(camera);
    }
  };
  const updateRemoteCamera = (camera: Camera) => {
    setRemoteCamera(camera);
    if (camerasLinked) {
      setLocalCamera(camera);
      setLinkedCamera(camera);
    }
  };

  const request = async (path: string, body: Readonly<Record<string, unknown>>) => {
    setError(undefined);
    const release = onOperationStart?.() ?? noop;
    try {
      onResult(await postJson<RepositorySynchronizationResult>(path, body));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      release();
    }
  };

  const startMerge = async () => {
    setError(undefined);
    const release = onOperationStart?.() ?? noop;
    try {
      const preview = await postJson<RepositoryMergePreview>("/api/repository-sync/merge/preview", {
        localCommit: review.local.commit,
        remoteCommit: review.remote.commit,
      });
      setMergePreview(preview);
      setCandidatePages({});
      setDirtyCandidateKeys(new Set());
      setResolvedConflictPaths(new Set());
      const firstConflictPage = preview.conflicts
        .map(conflictPageIdentity)
        .find(
          (identity) =>
            identity !== undefined &&
            preview.hierarchy !== undefined &&
            hasPage(preview.hierarchy, identity.sectionId, identity.pageId),
        );
      if (firstConflictPage !== undefined) {
        setSelectedLocalOnlyKey(undefined);
        setSelectedSectionId(firstConflictPage.sectionId);
        setSelectedPageId(firstConflictPage.pageId);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      release();
    }
  };

  const applyCandidate = async () => {
    if (mergePreview === undefined) return;
    const pages: RepositoryMergePageOverride[] = Object.entries(candidatePages)
      .filter(([key]) => dirtyCandidateKeys.has(key))
      .map(([key, page]) => {
        const [sectionId, pageId] = key.split(":");
        return { sectionId: sectionId as string, pageId: pageId as string, page };
      });
    await request("/api/repository-sync/merge/apply", {
      candidateId: mergePreview.candidateId,
      localCommit: review.local.commit,
      remoteCommit: review.remote.commit,
      pages,
      resolvedConflictPaths: [...resolvedConflictPaths],
    });
  };

  const updateCandidatePage = (update: (page: RepositoryPreviewPage) => RepositoryPreviewPage) => {
    if (candidateKey === undefined) return;
    setDirtyCandidateKeys((current) => new Set(current).add(candidateKey));
    setCandidatePages((current) => {
      const page = current[candidateKey];
      return page === undefined ? current : { ...current, [candidateKey]: update(page) };
    });
  };

  const resolveConflict = (conflict: RepositoryMergeConflict, side: "local" | "remote") => {
    const identity = conflictPageIdentity(conflict);
    const sourcePage = side === "local" ? localPage : remotePage;
    if (
      identity === undefined ||
      identity.sectionId !== selectedSectionId ||
      identity.pageId !== selectedPageId ||
      sourcePage === undefined
    ) {
      return;
    }
    updateCandidatePage((page) => applyConflictChoice(page, sourcePage, identity));
    setResolvedConflictPaths((current) => {
      const next = new Set(current);
      next.add(conflict.path);
      return next;
    });
  };

  const unresolvedConflictCount =
    mergePreview?.conflicts.filter((conflict) => !resolvedConflictPaths.has(conflict.path))
      .length ?? 0;

  return (
    <section className="repository-sync-review" aria-label="Snapshot review">
      <header>
        <h3>
          {review.kind === "conflict" ? "Review conflicting snapshots" : "Review GitHub update"}
        </h3>
        <p>
          {review.kind === "conflict"
            ? "Both snapshots changed. Review them side by side, then combine or choose one complete snapshot."
            : "Review the newer GitHub snapshot before applying it to this host."}
        </p>
        <p className="repository-sync-review-explanation">
          <strong>Sync now</strong> performs a fresh synchronization: it flushes and may commit
          pending local canonical changes before comparing heads, which can turn this review into a
          conflict. The choices below apply one specific snapshot decision.
        </p>
      </header>
      <div className="repository-sync-review-commits">
        <ReviewCommit label="Local host" commit={review.local} />
        <ReviewCommit label="GitHub" commit={review.remote} />
      </div>
      {review.publishLocal !== undefined && review.applyRemote !== undefined && (
        <div className="repository-sync-review-diff" aria-label="Snapshot changes">
          <RepositoryChangeBar label="Publish local" changes={review.publishLocal} />
          <RepositoryChangeBar label="Apply remote" changes={review.applyRemote} />
        </div>
      )}
      {error !== undefined && (
        <p className="repository-sync-review-error" role="alert">
          {error}
        </p>
      )}
      {snapshotPair === undefined ? (
        <p>Loading both project snapshots…</p>
      ) : (
        <>
          <div className="repository-sync-review-controls">
            <select
              aria-label="Review section"
              value={selectedSectionId ?? ""}
              disabled={disabled}
              onChange={(event) => {
                setSelectedLocalOnlyKey(undefined);
                const section = sectionOptions.find(
                  (candidate) => candidate.id === event.target.value,
                );
                setSelectedSectionId(section?.id);
                setSelectedPageId(section?.pages[0]?.id);
              }}
            >
              {sectionOptions.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.title}
                </option>
              ))}
            </select>
            <select
              aria-label="Review page"
              value={selectedPageId ?? ""}
              disabled={disabled}
              onChange={(event) => {
                setSelectedLocalOnlyKey(undefined);
                setSelectedPageId(event.target.value);
              }}
            >
              {pageOptions.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title}
                </option>
              ))}
            </select>
            {localOnlyPages.length > 0 && (
              <label>
                Local-only content
                <select
                  aria-label="Local-only page"
                  value={selectedLocalOnlyKey ?? ""}
                  disabled={disabled}
                  onChange={(event) => {
                    const selected = localOnlyPages.find((page) => page.key === event.target.value);
                    setSelectedLocalOnlyKey(selected?.key);
                    setSelectedSectionId(selected?.sectionId);
                    setSelectedPageId(selected?.pageId);
                  }}
                >
                  <option value="">GitHub pages</option>
                  {localOnlyPages.map((page) => (
                    <option key={page.key} value={page.key}>
                      {page.sectionTitle} · {page.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div
            className="repository-sync-preview-toggles"
            role="group"
            aria-label="Snapshot review display"
          >
            <label className="repository-sync-toggle">
              <input
                type="checkbox"
                checked={linkNavigation}
                disabled={disabled || localPage === undefined || remotePage === undefined}
                onChange={(event) => {
                  setLinkNavigation(event.target.checked);
                  if (event.target.checked) setLinkedCamera(localCamera ?? remoteCamera);
                }}
              />
              Link pan and zoom
            </label>
            <label className="repository-sync-toggle">
              <input
                type="checkbox"
                checked={dimCommonElements}
                disabled={disabled || localPage === undefined || remotePage === undefined}
                onChange={(event) => setDimCommonElements(event.target.checked)}
              />
              Dim unchanged elements
            </label>
          </div>
          <div
            className="repository-sync-preview-canvases"
            role="group"
            aria-label="Local and GitHub canvases"
          >
            <ReviewPage
              label="Local host snapshot"
              page={localPage}
              camera={camerasLinked ? comparisonCamera : localCamera}
              contentBounds={contentBounds}
              dimmedElementIds={dimmedElementIds}
              onCameraChange={updateLocalCamera}
              pageId={selectedPageId ?? "review-local"}
              theme={theme}
            />
            <ReviewPage
              label="GitHub snapshot"
              page={remotePage}
              camera={camerasLinked ? comparisonCamera : remoteCamera}
              contentBounds={contentBounds}
              dimmedElementIds={dimmedElementIds}
              onCameraChange={updateRemoteCamera}
              pageId={selectedPageId ?? "review-remote"}
              theme={theme}
            />
          </div>
          <div className="repository-sync-review-actions">
            {review.kind === "remote-update" ? (
              <button
                type="button"
                className="danger"
                disabled={disabled}
                aria-describedby="repository-sync-destructive-choice-description"
                onClick={() =>
                  void request("/api/repository-sync/apply-remote", {
                    localCommit: review.local.commit,
                    remoteCommit: review.remote.commit,
                  })
                }
              >
                {busy ? "Working…" : "Use GitHub snapshot for local contents"}
              </button>
            ) : (
              <>
                <button type="button" disabled={disabled} onClick={() => void startMerge()}>
                  {busy ? "Working…" : "Combine both changes"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={disabled}
                  aria-describedby="repository-sync-destructive-choice-description"
                  onClick={() =>
                    void request("/api/repository-sync/resolve", {
                      choice: "remote",
                      localCommit: review.local.commit,
                      remoteCommit: review.remote.commit,
                    })
                  }
                >
                  Use GitHub snapshot for local contents
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={disabled}
                  aria-describedby="repository-sync-destructive-choice-description"
                  onClick={() =>
                    void request("/api/repository-sync/resolve", {
                      choice: "local",
                      localCommit: review.local.commit,
                      remoteCommit: review.remote.commit,
                    })
                  }
                >
                  Use local snapshot for GitHub contents
                </button>
              </>
            )}
          </div>
          <p
            id="repository-sync-destructive-choice-description"
            className="repository-sync-review-warning"
            role="note"
          >
            Whole-snapshot choices replace project contents. GitHub wins and combined results use a
            resolution commit that preserves both input histories. A local win replaces the GitHub
            branch only when its reviewed remote head is still current.
          </p>
          {mergePreview !== undefined && (
            <section
              className="repository-sync-merge-candidate"
              aria-label="Combined snapshot candidate"
            >
              <h4>Combined snapshot candidate</h4>
              <p>
                This temporary candidate is editable. Changes remain local to this review until you
                apply the combined snapshot.
              </p>
              {mergePreview.conflicts.length > 0 && (
                <MergeConflictList
                  conflicts={mergePreview.conflicts}
                  disabled={
                    disabled ||
                    candidatePage === undefined ||
                    localPage === undefined ||
                    remotePage === undefined
                  }
                  onChoose={resolveConflict}
                  resolvedPaths={resolvedConflictPaths}
                  selectedPage={{ sectionId: selectedSectionId, pageId: selectedPageId }}
                />
              )}
              {!mergePreview.mergeable ? (
                <p className="repository-sync-review-error">
                  Some conflicts are outside the visual editor. Choose the complete local or GitHub
                  snapshot above.
                </p>
              ) : candidateHasPage && candidatePage === undefined ? (
                <p>Loading the combined page candidate…</p>
              ) : (
                <>
                  {candidatePage === undefined ? (
                    <div className="repository-sync-missing-page">
                      This page is not part of the combined snapshot candidate. Select another page
                      to inspect the candidate.
                    </div>
                  ) : (
                    <div className="repository-sync-canvas-preview repository-sync-candidate-canvas">
                      <SpatialCanvas
                        elements={candidatePage.canvas}
                        markdownSources={candidatePage.markdown}
                        onElementsChange={(elements) =>
                          updateCandidatePage((page) => ({
                            ...page,
                            canvas: elements,
                            markdown: Object.fromEntries(
                              elements
                                .filter((element) => element.kind === "markdown")
                                .map((element) => [element.id, page.markdown[element.id] ?? ""]),
                            ),
                          }))
                        }
                        onMarkdownSourceChange={(elementId, source) =>
                          updateCandidatePage((page) => ({
                            ...page,
                            markdown: { ...page.markdown, [elementId]: source },
                          }))
                        }
                        pageId={candidatePage.manifest.id}
                        readOnly={disabled}
                        theme={theme}
                      />
                    </div>
                  )}
                  {unresolvedConflictCount > 0 && (
                    <p className="repository-sync-review-warning" role="status">
                      Resolve {unresolvedConflictCount} remaining conflict
                      {unresolvedConflictCount === 1 ? "" : "s"} before publishing.
                    </p>
                  )}
                  <div className="repository-sync-review-actions">
                    <button
                      type="button"
                      className="repository-sync-run-button"
                      disabled={disabled || unresolvedConflictCount > 0}
                      onClick={() => void applyCandidate()}
                    >
                      {busy ? "Working…" : "Apply combined snapshot"}
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setMergePreview(undefined);
                        setCandidatePages({});
                        setDirtyCandidateKeys(new Set());
                        setResolvedConflictPaths(new Set());
                      }}
                    >
                      Cancel combined candidate
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}

function ReviewPage({
  label,
  page,
  camera,
  contentBounds,
  dimmedElementIds,
  onCameraChange,
  pageId,
  theme,
}: ReviewPageProps) {
  return (
    <div className="repository-sync-preview-canvas">
      <h4>{label}</h4>
      {page === undefined ? (
        <div className="repository-sync-missing-page">
          This page is not present in this snapshot.
        </div>
      ) : (
        <div className="repository-sync-canvas-preview">
          <SpatialCanvas
            key={`${pageId}:${label}`}
            {...(camera === undefined ? {} : { camera })}
            {...(contentBounds === undefined ? {} : { contentBounds })}
            {...(dimmedElementIds === undefined ? {} : { dimmedElementIds })}
            elements={page.canvas}
            markdownSources={page.markdown}
            onCameraChange={onCameraChange}
            pageId={page.manifest.id}
            readOnly
            theme={theme}
          />
        </div>
      )}
    </div>
  );
}

function ReviewCommit({
  label,
  commit,
}: {
  readonly label: string;
  readonly commit: RepositoryCommitSummary;
}) {
  return (
    <article>
      <h4>{label}</h4>
      <strong>{commit.message}</strong>
      <span>{formatTimestamp(commit.timestamp)}</span>
      <span>{commit.author}</span>
      <code>{commit.commit.slice(0, 7)}</code>
      <p>
        {commit.affectedPages.length === 0
          ? `${commit.changedPaths.length} affected project file(s)`
          : `Affected pages: ${commit.affectedPages.map((page) => page.title).join(", ")}`}
      </p>
    </article>
  );
}

function MergeConflictList({
  conflicts,
  disabled,
  onChoose,
  resolvedPaths,
  selectedPage,
}: {
  readonly conflicts: readonly RepositoryMergeConflict[];
  readonly disabled: boolean;
  readonly onChoose: (conflict: RepositoryMergeConflict, side: "local" | "remote") => void;
  readonly resolvedPaths: ReadonlySet<string>;
  readonly selectedPage: {
    readonly sectionId: string | undefined;
    readonly pageId: string | undefined;
  };
}) {
  return (
    <div className="repository-sync-merge-conflicts">
      <strong>Conflicts requiring visual review</strong>
      <ul>
        {conflicts.map((conflict) => {
          const identity = conflictPageIdentity(conflict);
          const isSelectedPage =
            identity !== undefined &&
            identity.sectionId === selectedPage.sectionId &&
            identity.pageId === selectedPage.pageId;
          const resolved = resolvedPaths.has(conflict.path);
          return (
            <li key={`${conflict.kind}:${conflict.path}`} className={resolved ? "is-resolved" : ""}>
              <div>
                <code>{conflict.path}</code> — {resolved ? "Resolved" : conflict.message}
              </div>
              {isSelectedPage && conflict.editable && (
                <div
                  className="repository-sync-conflict-choices"
                  role="group"
                  aria-label={`Resolve ${conflict.path}`}
                >
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChoose(conflict, "local")}
                  >
                    Use local
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChoose(conflict, "remote")}
                  >
                    Use GitHub
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ConflictPageIdentity {
  readonly sectionId: string;
  readonly pageId: string;
  readonly elementId?: string;
  readonly elementFieldPath?: readonly string[];
  readonly markdownId?: string;
}

function conflictPageIdentity(conflict: RepositoryMergeConflict): ConflictPageIdentity | undefined {
  const match =
    /^sections\/([^/]+)\/pages\/([^/]+)\/(?:canvas\.jsonl(?:#([^.]+)((?:\.[^.]+)*))?|markdown\/([^/]+)\.md)/.exec(
      conflict.path,
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    sectionId: match[1],
    pageId: match[2],
    ...(match[3] === undefined ? {} : { elementId: match[3] }),
    ...(match[4] === undefined || match[4] === ""
      ? {}
      : { elementFieldPath: match[4].slice(1).split(".") }),
    ...(match[5] === undefined ? {} : { markdownId: match[5] }),
  };
}

function applyConflictChoice(
  candidate: RepositoryPreviewPage,
  source: RepositoryPreviewPage,
  identity: ConflictPageIdentity,
): RepositoryPreviewPage {
  if (identity.elementId !== undefined) {
    const selected = source.canvas.find((element) => element.id === identity.elementId);
    const existingIndex = candidate.canvas.findIndex(
      (element) => element.id === identity.elementId,
    );
    if (selected !== undefined && existingIndex >= 0 && identity.elementFieldPath !== undefined) {
      const canvas = [...candidate.canvas];
      canvas[existingIndex] = copyJsonPath(
        canvas[existingIndex],
        selected,
        identity.elementFieldPath,
      ) as CanvasElement;
      return { ...candidate, canvas };
    }
    const canvas = candidate.canvas.filter((element) => element.id !== identity.elementId);
    const markdown = { ...candidate.markdown };
    if (selected === undefined) delete markdown[identity.elementId];
    if (selected !== undefined)
      canvas.splice(existingIndex < 0 ? canvas.length : existingIndex, 0, selected);
    return {
      ...candidate,
      canvas,
      markdown,
    };
  }
  if (identity.markdownId !== undefined) {
    const sourceValue = source.markdown[identity.markdownId];
    if (sourceValue === undefined) return candidate;
    return {
      ...candidate,
      markdown: { ...candidate.markdown, [identity.markdownId]: sourceValue },
    };
  }
  return candidate;
}

function copyJsonPath(candidate: unknown, source: unknown, path: readonly string[]): unknown {
  const result = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
  let resultParent = result;
  let sourceParent = source as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    resultParent = resultParent[key] as Record<string, unknown>;
    sourceParent = sourceParent[key] as Record<string, unknown>;
  }
  const finalKey = path.at(-1);
  if (finalKey === undefined) return result;
  if (sourceParent[finalKey] === undefined) delete resultParent[finalKey];
  else resultParent[finalKey] = JSON.parse(JSON.stringify(sourceParent[finalKey])) as unknown;
  return result;
}

interface LocalOnlyPageOption {
  readonly key: string;
  readonly sectionId: string;
  readonly pageId: string;
  readonly sectionTitle: string;
  readonly title: string;
}

function localOnlyPageOptions(
  local: NotebookHierarchy,
  remote: NotebookHierarchy,
): readonly LocalOnlyPageOption[] {
  return local.sections.flatMap((section) =>
    section.pages
      .filter((page) => !hasPage(remote, section.manifest.id, page.id))
      .map((page) => ({
        key: pageKey(section.manifest.id, page.id),
        sectionId: section.manifest.id,
        pageId: page.id,
        sectionTitle: section.manifest.title,
        title: page.title,
      })),
  );
}

function firstReviewPage(
  review: RepositorySnapshotReview,
  local: NotebookHierarchy,
  remote: NotebookHierarchy,
): { readonly sectionId: string; readonly pageId: string } | undefined {
  const affected = [...review.remote.affectedPages, ...review.local.affectedPages];
  for (const page of affected) {
    if (hasPage(remote, page.sectionId, page.pageId)) {
      return { sectionId: page.sectionId, pageId: page.pageId };
    }
  }
  const remoteSection = remote.sections[0];
  const remotePage = remoteSection?.pages[0];
  if (remoteSection !== undefined && remotePage !== undefined) {
    return { sectionId: remoteSection.manifest.id, pageId: remotePage.id };
  }
  for (const page of affected) {
    if (hasPage(local, page.sectionId, page.pageId)) {
      return { sectionId: page.sectionId, pageId: page.pageId };
    }
  }
  const localSection = local.sections[0];
  const localPage = localSection?.pages[0];
  return localSection === undefined || localPage === undefined
    ? undefined
    : { sectionId: localSection.manifest.id, pageId: localPage.id };
}

function hasPage(hierarchy: NotebookHierarchy, sectionId: string, pageId: string): boolean {
  return hierarchy.sections.some(
    (section) => section.manifest.id === sectionId && section.manifest.pageIds.includes(pageId),
  );
}

function pageKey(sectionId: string, pageId: string): string {
  return `${sectionId}:${pageId}`;
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

function findUnchangedElementIds(
  localPage: RepositoryPreviewPage,
  remotePage: RepositoryPreviewPage,
): ReadonlySet<string> {
  const remoteSignatures = new Set(
    remotePage.canvas.map((element) => previewElementSignature(element, remotePage.markdown)),
  );
  return new Set(
    localPage.canvas
      .filter((element) =>
        remoteSignatures.has(previewElementSignature(element, localPage.markdown)),
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

async function postJson<T>(path: string, body: Readonly<Record<string, unknown>>): Promise<T> {
  const headers = new Headers(accessHeaders());
  headers.set("content-type", "application/json");
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const value = (await response.json().catch(() => ({}))) as { readonly error?: unknown } & T;
  if (!response.ok) {
    throw new Error(
      typeof value.error === "string" ? value.error : `Request failed (${response.status})`,
    );
  }
  return value;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
