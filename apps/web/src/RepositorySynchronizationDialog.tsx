import { SpatialCanvas } from "@squillpad/ui";

import { RepositoryChangeBar, RepositoryChangeSummary } from "./RepositoryChangeSummary";
import { RepositorySnapshotReview } from "./RepositorySnapshotReview";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  formatTimestamp,
  type LoadedSnapshot,
  type RepositorySynchronizationState,
} from "./useRepositorySynchronization";

interface RepositorySynchronizationDialogProps {
  readonly state: RepositorySynchronizationState;
  readonly theme: "light" | "dark";
}

export function RepositorySynchronizationDialogs({
  state,
  theme,
}: RepositorySynchronizationDialogProps) {
  const {
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
    orderSwapFlash,
    orderSwapNotice,
    reloadRequested,
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
  } = state;

  if (status === undefined) return null;

  const needsSshMigration = !status.configured && status.remoteUrl !== undefined;
  const repositoryLinkDisabled =
    busy || review !== undefined || confirmation !== undefined || reloadRequested;

  return (
    <>
      {open && (
        <div className="repository-sync-overlay" role="presentation">
          <dialog
            className={`repository-sync-dialog${review === undefined ? "" : " repository-sync-review-dialog"}`}
            open
            aria-modal="true"
            aria-labelledby="repository-sync-title"
          >
            <header>
              <div>
                <div className="repository-sync-title-row">
                  <h2 id="repository-sync-title">Cross-host snapshot synchronization</h2>
                  <span className="repository-sync-help-control">
                    <button
                      type="button"
                      className="repository-sync-help"
                      aria-label="Show synchronization setup instructions"
                      aria-describedby="repository-sync-instructions"
                    >
                      <InfoIcon />
                    </button>
                    <div
                      id="repository-sync-instructions"
                      className="repository-sync-tooltip"
                      role="tooltip"
                    >
                      <ol>
                        <li>Use an empty repository or a valid SquillPad project at its root.</li>
                        <li>
                          Use an SSH URL such as <code>git@github.com:owner/repository.git</code>;
                          HTTPS URLs are not supported.
                        </li>
                        <li>Configure SSH keys or an SSH agent outside SquillPad.</li>
                        <li>
                          Sync checks both histories before pushing and opens a review whenever both
                          changed.
                        </li>
                      </ol>
                    </div>
                  </span>
                </div>
                <p>
                  This host-only feature stores canonical project snapshots in a dedicated GitHub
                  repository. The link must use SSH, and Git credentials must already be configured
                  on this host; SquillPad never exposes synchronization controls to connected
                  clients.
                </p>
              </div>
              <button
                type="button"
                className="repository-sync-close"
                aria-label="Close synchronization dialog"
                disabled={busy || reloadRequested}
                onClick={closeSynchronization}
              >
                <RepositorySyncCloseIcon />
              </button>
            </header>

            {!status.configured ? (
              <section
                aria-label={
                  needsSshMigration ? "Migrate GitHub repository" : "Connect GitHub repository"
                }
              >
                <label>
                  GitHub SSH repository URL
                  <input
                    type="text"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    value={url}
                    placeholder="git@github.com:owner/project.git"
                    disabled={repositoryLinkDisabled}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                <p className="repository-sync-action-explanation">
                  {needsSshMigration
                    ? "This project has a legacy or unsupported remote. Replace it with the SSH URL above before synchronizing."
                    : "Use the exact SSH format git@github.com:owner/repository.git. Configure the SSH key or agent on this host before connecting."}
                </p>
                <label>
                  {needsSshMigration ? "Optional snapshot note" : "Optional first snapshot note"}
                  <input
                    value={note}
                    maxLength={200}
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={repositoryLinkDisabled || url.trim().length === 0}
                  onClick={() => void run("/api/repository-sync/configure", { url, note })}
                >
                  {busy
                    ? needsSshMigration
                      ? "Migrating…"
                      : "Checking repository…"
                    : needsSshMigration
                      ? "Save SSH link and inspect"
                      : "Connect and inspect"}
                </button>
              </section>
            ) : (
              <>
                <section className="repository-sync-repository" aria-label="Edit GitHub repository">
                  <label>
                    GitHub SSH repository URL
                    <input
                      type="text"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      value={url}
                      placeholder="git@github.com:owner/project.git"
                      disabled={repositoryLinkDisabled}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </label>
                  <p className="repository-sync-action-explanation">
                    Change the link here to switch this host to another dedicated repository. The
                    local snapshot history is preserved, and the new repository is inspected before
                    it is used.
                  </p>
                  <button
                    type="button"
                    disabled={
                      repositoryLinkDisabled ||
                      url.trim().length === 0 ||
                      url.trim() === status.remoteUrl
                    }
                    onClick={() => void run("/api/repository-sync/configure", { url, note })}
                  >
                    {busy ? "Checking repository…" : "Save link and inspect"}
                  </button>
                </section>
                <section className="repository-sync-actions" aria-label="Synchronize snapshots">
                  <p>
                    <strong>{status.remoteUrl}</strong>
                    {status.branch === undefined ? "" : ` · ${status.branch}`}
                  </p>
                  <label>
                    Optional snapshot note
                    <input
                      value={note}
                      maxLength={200}
                      disabled={busy}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                  <p className="repository-sync-action-explanation">
                    <strong>Refresh</strong> fetches the current GitHub branch and recomputes this
                    comparison without publishing or applying a snapshot. <strong>Sync now</strong>{" "}
                    flushes pending canonical changes and may commit them before comparing local and
                    GitHub heads. Use the review choices for a specific snapshot decision; a fresh
                    sync can turn an open remote-update review into a conflict.
                  </p>
                  <div>
                    <button
                      type="button"
                      className={`repository-sync-run-button repository-sync-run-button--${theme}`}
                      disabled={busy || review !== undefined || reloadRequested}
                      onClick={() => void run("/api/repository-sync/run", { note })}
                    >
                      {busy ? "Checking…" : "Sync now"}
                    </button>
                    <button
                      type="button"
                      disabled={busy || review !== undefined || reloadRequested}
                      onClick={openHistory}
                    >
                      Previous snapshots
                    </button>
                  </div>
                  <RepositoryChangeSummary
                    disabled={busy || historyOpen || review !== undefined || reloadRequested}
                    onReview={handleComparisonReview}
                    refreshToken={state.comparisonRefreshToken}
                  />
                </section>
              </>
            )}

            {message !== undefined && <p className="repository-sync-message">{message}</p>}
            {error !== undefined && (
              <div className="repository-sync-error" role="alert">
                <strong>Synchronization stopped.</strong>
                <p>{error}</p>
                <p>No remote history was intentionally overwritten. Correct the issue and retry.</p>
              </div>
            )}

            {review !== undefined && (
              <RepositorySnapshotReview
                busy={busy}
                onOperationStart={beginOperation}
                onResult={handleResult}
                review={review}
                theme={theme}
              />
            )}

            {confirmation !== undefined && (
              <section
                className="repository-sync-confirmation"
                aria-label="Confirm destructive action"
              >
                <h3>Final confirmation</h3>
                {confirmation.deletedPaths.length > 0 ? (
                  <>
                    <p>The chosen snapshot removes these current paths:</p>
                    <ul>
                      {confirmation.deletedPaths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>This action changes the project’s global snapshot.</p>
                )}
                <label>
                  Type <code>{confirmation.phrase}</code> to continue
                  <input
                    autoComplete="off"
                    value={confirmationInput}
                    onChange={(event) => setConfirmationInput(event.target.value)}
                  />
                </label>
                <button
                  className="danger"
                  disabled={busy || confirmationInput !== confirmation.phrase}
                  onClick={confirmPending}
                >
                  Confirm snapshot change
                </button>
              </section>
            )}
          </dialog>
        </div>
      )}
      {historyOpen && (
        <div className="repository-sync-history-overlay" role="presentation">
          <dialog
            className="repository-sync-dialog repository-sync-history-dialog"
            open
            aria-modal="true"
            aria-labelledby="repository-sync-history-title"
          >
            <header>
              <div>
                <h2 id="repository-sync-history-title">Compare snapshots</h2>
                <p>Pick any two snapshots to inspect the project as it changed over time.</p>
              </div>
              <button
                type="button"
                className="repository-sync-close"
                aria-label="Close previous snapshots"
                disabled={busy || reloadRequested}
                onClick={() => {
                  if (!busy && !reloadRequested) setHistoryOpen(false);
                }}
              >
                <RepositorySyncCloseIcon />
              </button>
            </header>

            {history === undefined ? (
              error === undefined ? (
                <p>Loading previous snapshots…</p>
              ) : (
                <div className="repository-sync-error" role="alert">
                  <strong>History could not be loaded.</strong>
                  <p>{error}</p>
                </div>
              )
            ) : (
              <>
                {error !== undefined && (
                  <div className="repository-sync-error" role="alert">
                    <strong>History action stopped.</strong>
                    <p>{error}</p>
                  </div>
                )}
                {history.length === 0 ? (
                  <p>No previous snapshots are available.</p>
                ) : (
                  <section className="repository-sync-history" aria-label="Snapshot comparison">
                    <div className="repository-sync-history-layout">
                      <aside
                        className="repository-sync-history-sidebar"
                        aria-label="Choose snapshots"
                      >
                        <div className="repository-sync-snapshot-pickers">
                          <h3>Choose snapshots</h3>
                          <p>
                            The left side is always older. Pick either side; reverse selections are
                            reordered automatically.
                          </p>
                          <label>
                            Older snapshot
                            <select
                              aria-label="Older snapshot"
                              value={olderSnapshotId ?? ""}
                              disabled={busy || reloadRequested}
                              onChange={(event) => selectSnapshot("older", event.target.value)}
                            >
                              {snapshotOptions.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {snapshotOptionLabel(option)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Newer snapshot
                            <select
                              aria-label="Newer snapshot"
                              value={newerSnapshotId ?? ""}
                              disabled={busy || reloadRequested}
                              onChange={(event) => selectSnapshot("newer", event.target.value)}
                            >
                              {snapshotOptions.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {snapshotOptionLabel(option)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {orderSwapNotice !== undefined && (
                            <p className="repository-sync-order-notice" role="status">
                              {orderSwapNotice}
                            </p>
                          )}
                        </div>
                        <div className="repository-sync-history-list-heading">
                          <h3>Saved snapshots</h3>
                          <span>{history.length}</span>
                        </div>
                        <ol className="repository-sync-commit-list" aria-label="Saved snapshots">
                          {history.map((commit) => (
                            <li key={commit.commit}>
                              <div className="repository-sync-commit-entry">
                                <strong>{commit.message}</strong>
                                <span>{formatTimestamp(commit.timestamp)}</span>
                                <span>
                                  {commit.affectedPages.length === 0
                                    ? `${commit.changedPaths.length} project file(s)`
                                    : commit.affectedPages.map((page) => page.title).join(", ")}
                                </span>
                                <div className="repository-sync-commit-entry-actions">
                                  <button
                                    type="button"
                                    className={olderSnapshotId === commit.commit ? "is-active" : ""}
                                    disabled={busy || reloadRequested}
                                    aria-label={`Use ${commit.message} as older snapshot`}
                                    onClick={() => selectSnapshot("older", commit.commit)}
                                  >
                                    Older
                                  </button>
                                  <button
                                    type="button"
                                    className={newerSnapshotId === commit.commit ? "is-active" : ""}
                                    disabled={busy || reloadRequested}
                                    aria-label={`Use ${commit.message} as newer snapshot`}
                                    onClick={() => selectSnapshot("newer", commit.commit)}
                                  >
                                    Newer
                                  </button>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </aside>

                      {olderSnapshot !== undefined && newerSnapshot !== undefined ? (
                        <div className="repository-sync-preview">
                          <div className="repository-sync-snapshot-meta-grid">
                            <SnapshotMeta label="Older snapshot" snapshot={olderSnapshot} />
                            <SnapshotMeta label="Newer snapshot" snapshot={newerSnapshot} />
                          </div>
                          {comparisonChanges !== undefined ? (
                            <RepositoryChangeBar
                              label="Older → newer"
                              changes={comparisonChanges}
                            />
                          ) : (
                            <p className="repository-sync-preview-direction">
                              Choose two different snapshots to measure their changes.
                            </p>
                          )}
                          <div className="repository-sync-preview-controls">
                            <label>
                              Section
                              <select
                                aria-label="Comparison section"
                                value={selectedSectionId ?? ""}
                                disabled={busy || reloadRequested}
                                onChange={(event) => {
                                  const section = comparisonSections.find(
                                    (candidate) => candidate.id === event.target.value,
                                  );
                                  setSelectedSectionId(section?.id);
                                  setSelectedPageId(section?.pages[0]?.id);
                                }}
                              >
                                {comparisonSections.map((section) => (
                                  <option key={section.id} value={section.id}>
                                    {section.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Page
                              <select
                                aria-label="Comparison page"
                                value={selectedPageId ?? ""}
                                disabled={busy || reloadRequested}
                                onChange={(event) => setSelectedPageId(event.target.value)}
                              >
                                {selectedSection?.pages.map((page) => (
                                  <option key={page.id} value={page.id}>
                                    {page.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {!compareSnapshots && (
                              <div role="group" aria-label="Preview snapshot">
                                <button
                                  type="button"
                                  className={previewMode === "older" ? "is-active" : ""}
                                  disabled={busy || reloadRequested || olderPage === undefined}
                                  onClick={() => setPreviewMode("older")}
                                >
                                  Older
                                </button>
                                <button
                                  type="button"
                                  className={previewMode === "newer" ? "is-active" : ""}
                                  disabled={busy || reloadRequested || newerPage === undefined}
                                  onClick={() => setPreviewMode("newer")}
                                >
                                  Newer
                                </button>
                              </div>
                            )}
                          </div>
                          <div
                            className="repository-sync-preview-toggles"
                            role="group"
                            aria-label="Snapshot comparison"
                          >
                            <ToggleSwitch
                              className="repository-sync-toggle"
                              checked={compareSnapshots}
                              disabled={
                                busy ||
                                reloadRequested ||
                                (olderPage === undefined && newerPage === undefined)
                              }
                              label="Compare snapshots"
                              onChange={(checked) => {
                                setCompareSnapshots(checked);
                                if (checked && synchronizeNavigation) {
                                  setLinkedCamera(state.olderCamera ?? state.newerCamera);
                                }
                              }}
                            />
                            <ToggleSwitch
                              className="repository-sync-toggle"
                              checked={synchronizeNavigation}
                              disabled={
                                busy ||
                                reloadRequested ||
                                !compareSnapshots ||
                                olderPage === undefined ||
                                newerPage === undefined
                              }
                              label="Link pan and zoom"
                              onChange={(checked) => {
                                setSynchronizeNavigation(checked);
                                if (checked && compareSnapshots) {
                                  setLinkedCamera(state.olderCamera ?? state.newerCamera);
                                }
                              }}
                            />
                            <ToggleSwitch
                              className="repository-sync-toggle"
                              checked={dimCommonElements}
                              disabled={
                                busy ||
                                reloadRequested ||
                                !compareSnapshots ||
                                olderPage === undefined ||
                                newerPage === undefined
                              }
                              label="Dim unchanged elements"
                              title="Reduce unchanged elements to 25% opacity"
                              onChange={(checked) => setDimCommonElements(checked)}
                            />
                          </div>
                          {compareSnapshots &&
                          olderPage === undefined &&
                          newerPage === undefined ? (
                            <p>Loading the selected page previews…</p>
                          ) : compareSnapshots ? (
                            <>
                              <p className="visually-hidden">
                                Side-by-side read-only comparison from the older snapshot to the
                                newer snapshot.
                              </p>
                              <div
                                className={`repository-sync-preview-canvases${orderSwapFlash ? " repository-sync-preview-canvases--swap" : ""}`}
                                role="group"
                                aria-label="Older and newer canvases"
                              >
                                <div className="repository-sync-preview-canvas">
                                  <h4>Older snapshot</h4>
                                  {olderPage === undefined ? (
                                    <div className="repository-sync-missing-page">
                                      <p>This page is not present in the older snapshot.</p>
                                    </div>
                                  ) : (
                                    <div className="repository-sync-canvas-preview">
                                      <SpatialCanvas
                                        key={`${olderSnapshot.option.id}:${selectedPageId}:older`}
                                        {...(previewCamerasLinked && comparisonCamera !== undefined
                                          ? { camera: comparisonCamera }
                                          : {})}
                                        {...(comparisonContentBounds === undefined
                                          ? {}
                                          : { contentBounds: comparisonContentBounds })}
                                        {...(dimmedPreviewElementIds === undefined
                                          ? {}
                                          : { dimmedElementIds: dimmedPreviewElementIds })}
                                        elements={olderPage.canvas}
                                        markdownSources={olderPage.markdown}
                                        onCameraChange={handleOlderCameraChange}
                                        pageId={olderPage.manifest.id}
                                        readOnly
                                        theme={theme}
                                      />
                                    </div>
                                  )}
                                </div>
                                <div className="repository-sync-preview-canvas">
                                  <h4>Newer snapshot</h4>
                                  {newerPage === undefined ? (
                                    <div className="repository-sync-missing-page">
                                      <p>This page is not present in the newer snapshot.</p>
                                    </div>
                                  ) : (
                                    <div className="repository-sync-canvas-preview">
                                      <SpatialCanvas
                                        key={`${newerSnapshot.option.id}:${selectedPageId}:newer`}
                                        {...(previewCamerasLinked && comparisonCamera !== undefined
                                          ? { camera: comparisonCamera }
                                          : {})}
                                        {...(comparisonContentBounds === undefined
                                          ? {}
                                          : { contentBounds: comparisonContentBounds })}
                                        {...(dimmedPreviewElementIds === undefined
                                          ? {}
                                          : { dimmedElementIds: dimmedPreviewElementIds })}
                                        elements={newerPage.canvas}
                                        markdownSources={newerPage.markdown}
                                        onCameraChange={handleNewerCameraChange}
                                        pageId={newerPage.manifest.id}
                                        readOnly
                                        theme={theme}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </>
                          ) : previewPage === undefined ? (
                            <p>Loading the selected page preview…</p>
                          ) : (
                            <>
                              <p className="visually-hidden">
                                Read-only {previewMode} snapshot preview containing{" "}
                                {previewPage.canvas.length} canvas objects.
                              </p>
                              <div className="repository-sync-canvas-preview">
                                <SpatialCanvas
                                  key={`${olderSnapshot.option.id}:${newerSnapshot.option.id}:${selectedPageId}:${previewMode}`}
                                  elements={previewPage.canvas}
                                  markdownSources={previewPage.markdown}
                                  onCameraChange={
                                    previewMode === "newer"
                                      ? handleNewerCameraChange
                                      : handleOlderCameraChange
                                  }
                                  pageId={previewPage.manifest.id}
                                  readOnly
                                  theme={theme}
                                />
                              </div>
                            </>
                          )}
                          <details>
                            <summary>Snapshot details</summary>
                            <div className="repository-sync-snapshot-details">
                              {([olderSelection, newerSelection] as const).map((option, index) =>
                                option?.commit === undefined ? null : (
                                  <div key={option.id}>
                                    <strong>{index === 0 ? "Older" : "Newer"}</strong>
                                    <span>{option.commit.author}</span>
                                    <code>{option.commit.commit.slice(0, 7)}</code>
                                    <span>{option.commit.changedPaths.length} changed file(s)</span>
                                  </div>
                                ),
                              )}
                            </div>
                          </details>
                          <div className="repository-sync-preview-actions">
                            {olderSelection?.commit !== undefined && (
                              <button
                                type="button"
                                className="danger"
                                disabled={busy || reloadRequested}
                                onClick={() => void requestRestore(olderSelection.commit!)}
                              >
                                Restore older snapshot…
                              </button>
                            )}
                            {newerSelection?.commit !== undefined && (
                              <button
                                type="button"
                                className="danger"
                                disabled={busy || reloadRequested}
                                onClick={() => void requestRestore(newerSelection.commit!)}
                              >
                                Restore newer snapshot…
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p>Loading the selected snapshots…</p>
                      )}
                    </div>
                  </section>
                )}
              </>
            )}
          </dialog>
        </div>
      )}
    </>
  );
}

function InfoIcon() {
  return (
    <svg
      className="repository-sync-info-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 11v5M12 8h.01"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function RepositorySyncCloseIcon() {
  return (
    <svg
      className="repository-sync-close-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m7 7 10 10M17 7 7 17"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SnapshotMeta({
  label,
  snapshot,
}: {
  readonly label: string;
  readonly snapshot: LoadedSnapshot;
}) {
  const commit = snapshot.option.commit;
  return (
    <div className="repository-sync-snapshot-meta">
      <strong>{label}</strong>
      <span>{commit?.message ?? "Live host contents"}</span>
      {commit === undefined ? (
        <span>Current snapshot</span>
      ) : (
        <>
          <span>{formatTimestamp(commit.timestamp)}</span>
          <span>{commit.author}</span>
          <code>{commit.commit.slice(0, 7)}</code>
        </>
      )}
    </div>
  );
}
