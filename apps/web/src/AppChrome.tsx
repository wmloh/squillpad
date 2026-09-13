import type { RefObject } from "react";
import type { SynchronizationStatus } from "@squillpad/synchronization";

import {
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
} from "@squillpad/ui";

import { LanSharing } from "./LanSharing";
import { HostStopControl } from "./HostStopControl";
import {
  RepositorySynchronization,
  type RepositorySynchronizationHandle,
} from "./RepositorySynchronization";
import type { ProjectPresenceMember, SaveStatus, StorageDiagnosticsResponse } from "./app-types";

export interface AppChromeProps {
  readonly theme: "light" | "dark";
  readonly projectTitle: string;
  readonly projectTitleDisabled: boolean;
  readonly onProjectTitleCommit: (title: string) => void;
  readonly projectPresence: readonly ProjectPresenceMember[];
  readonly currentPresenceId: string | undefined;
  readonly selectedPageId: string | undefined;
  readonly busy: boolean;
  readonly selectedSaveLabel: string;
  readonly selectedSaveStatus: SaveStatus;
  readonly selectedSaveDirty: boolean;
  readonly selectedPageIsSaving: boolean;
  readonly selectedSyncStatus: SynchronizationStatus;
  readonly selectedSaveTooltip: string;
  readonly selectedSyncTooltip: string;
  readonly lanSharingEnabled: boolean | undefined;
  readonly hostSession: boolean;
  readonly clientReadOnly: boolean;
  readonly saveCurrentPage: (pageId: string) => void;
  readonly lanSharingRef: RefObject<HTMLDetailsElement | null>;
  readonly onLanSharingEnabledChange: (enabled: boolean | undefined) => void;
  readonly storageDiagnosticsRef: RefObject<HTMLDetailsElement | null>;
  readonly storageDiagnostics: StorageDiagnosticsResponse | undefined;
  readonly cleaningRuntimeCache: boolean;
  readonly onClearRuntimeCache: () => void;
  readonly repositorySynchronizationRef: RefObject<RepositorySynchronizationHandle | null>;
  readonly authenticatedUsername: string | undefined;
  readonly onLogout: () => void;
  readonly hostStopRef: RefObject<HTMLDetailsElement | null>;
  readonly stoppingHost: boolean;
  readonly onStopHosting: () => void;
  readonly onSyncNowBeforeStopping: () => void;
  readonly error: string | undefined;
  readonly onDismissError: () => void;
  readonly clientHostingStopped: boolean;
  readonly hostStoppedNotificationOpen: boolean;
  readonly onDismissHostStoppedNotification: () => void;
}

export function AppChrome({
  theme,
  projectTitle,
  projectTitleDisabled,
  onProjectTitleCommit,
  projectPresence,
  currentPresenceId,
  selectedPageId,
  busy,
  selectedSaveLabel,
  selectedSaveStatus,
  selectedSaveDirty,
  selectedPageIsSaving,
  selectedSyncStatus,
  selectedSaveTooltip,
  selectedSyncTooltip,
  lanSharingEnabled,
  hostSession,
  clientReadOnly,
  saveCurrentPage,
  lanSharingRef,
  onLanSharingEnabledChange,
  storageDiagnosticsRef,
  storageDiagnostics,
  cleaningRuntimeCache,
  onClearRuntimeCache,
  repositorySynchronizationRef,
  authenticatedUsername,
  onLogout,
  hostStopRef,
  stoppingHost,
  onStopHosting,
  onSyncNowBeforeStopping,
  error,
  onDismissError,
  clientHostingStopped,
  hostStoppedNotificationOpen,
  onDismissHostStoppedNotification,
}: AppChromeProps) {
  return (
    <>
      <header className="topbar">
        <img
          className="brand-mark"
          src={theme === "dark" ? "./squillpad-dark.png" : "./squillpad-light.png"}
          alt=""
          aria-hidden="true"
        />
        <h1>
          <EditableTitle
            ariaLabel="Project title"
            value={projectTitle}
            disabled={projectTitleDisabled}
            onCommit={onProjectTitleCommit}
          />
        </h1>
        <ProjectPresenceAvatars members={projectPresence} currentMemberId={currentPresenceId} />
        <div className="topbar-actions">
          <div
            className="topbar-status-group"
            role="group"
            aria-label="Notebook status"
            aria-live="polite"
          >
            {selectedPageId !== undefined && !busy && (
              <>
                <div className="status-control">
                  <button
                    type="button"
                    className={`save-status topbar-status-control ${lanSharingEnabled === true ? "sync-synchronized save-status--shared" : `save-${selectedSaveStatus}${selectedSaveDirty ? " is-dirty" : ""}`}`}
                    aria-label={`Save status: ${selectedSaveLabel}`}
                    aria-describedby="save-status-tooltip"
                    disabled={
                      lanSharingEnabled === true ||
                      !hostSession ||
                      !selectedSaveDirty ||
                      selectedPageIsSaving ||
                      clientReadOnly
                    }
                    onClick={() => void saveCurrentPage(selectedPageId)}
                  >
                    {selectedSaveLabel}
                  </button>
                  <div id="save-status-tooltip" className="status-tooltip" role="tooltip">
                    {selectedSaveTooltip}
                  </div>
                </div>
                <div className="status-control">
                  <span
                    className={`save-status topbar-status-control sync-${selectedSyncStatus}${lanSharingEnabled === false ? " sync-sharing-disabled" : ""}`}
                    role="status"
                    tabIndex={0}
                    aria-label={`Synchronization status: ${syncStatusLabel(selectedSyncStatus)}`}
                    aria-describedby="synchronization-status-tooltip"
                  >
                    {syncStatusLabel(selectedSyncStatus)}
                  </span>
                  <div
                    id="synchronization-status-tooltip"
                    className="status-tooltip"
                    role="tooltip"
                  >
                    {selectedSyncTooltip}
                  </div>
                </div>
              </>
            )}
            {hostSession && (
              <LanSharing
                detailsRef={lanSharingRef}
                host
                onEnabledChange={onLanSharingEnabledChange}
              />
            )}
            {hostSession && storageDiagnostics !== undefined && (
              <details
                ref={storageDiagnosticsRef}
                className="storage-diagnostics"
                onToggle={(event) => prepareAnimatedMenu(event.currentTarget)}
                onAnimationEnd={(event) =>
                  finishAnimatedMenu(event.currentTarget, event.animationName, event.target)
                }
              >
                <summary
                  className="topbar-status-control storage-diagnostics__summary"
                  onClick={(event) => prepareAnimatedMenuFromSummary(event.currentTarget, event)}
                >
                  Storage
                </summary>
                <div data-animated-menu aria-label="Project storage diagnostics">
                  <span>Project files {formatByteCount(storageDiagnostics.canonicalBytes)}</span>
                  <span>Runtime {formatByteCount(storageDiagnostics.runtimeCacheBytes)}</span>
                  <button
                    type="button"
                    disabled={cleaningRuntimeCache || clientReadOnly}
                    onClick={onClearRuntimeCache}
                  >
                    {cleaningRuntimeCache ? "Cleaning…" : "Clear runtime cache"}
                  </button>
                </div>
              </details>
            )}
          </div>
          {!clientReadOnly && (
            <RepositorySynchronization ref={repositorySynchronizationRef} theme={theme} />
          )}
          {authenticatedUsername !== undefined && (
            <button
              className="theme-toggle topbar-icon-button topbar-sign-out"
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={onLogout}
            >
              <SignOutIcon />
            </button>
          )}
          {hostSession && (
            <HostStopControl
              detailsRef={hostStopRef}
              onStopHosting={onStopHosting}
              onSyncNow={onSyncNowBeforeStopping}
              stopping={stoppingHost}
              theme={theme}
            />
          )}
        </div>
      </header>
      {error !== undefined && (
        <aside className="notification-area" aria-label="Notifications" aria-live="polite">
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss notification" onClick={onDismissError}>
              Dismiss
            </button>
          </div>
        </aside>
      )}
      {clientHostingStopped && hostStoppedNotificationOpen && (
        <HostStoppedNotification onDismiss={onDismissHostStoppedNotification} />
      )}
    </>
  );
}

export function HostStoppedNotification({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <aside
      className="host-stopped-notification"
      role="alertdialog"
      aria-labelledby="host-stopped-notification-title"
      aria-describedby="host-stopped-notification-description"
    >
      <button
        type="button"
        className="host-stopped-notification__close"
        aria-label="Dismiss host stopped notification"
        onClick={onDismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
      <PowerIcon />
      <div>
        <h2 id="host-stopped-notification-title">Host stopped hosting</h2>
        <p id="host-stopped-notification-description">
          This notebook is now read-only. You can still browse pages, pan, zoom, and use the laser
          pointer.
        </p>
      </div>
    </aside>
  );
}

/** Renders one initial avatar per named client currently active in the project. */
export function ProjectPresenceAvatars({
  members,
  currentMemberId,
}: {
  readonly members: readonly ProjectPresenceMember[];
  readonly currentMemberId: string | undefined;
}) {
  if (members.length === 0) return null;
  return (
    <div
      className="project-presence"
      aria-label={`Profiles in this project: ${members.map((member) => member.username).join(", ")}`}
    >
      {members.map((member) => (
        <span
          key={member.id}
          className={`project-presence-avatar${member.id === currentMemberId ? " is-current-user" : ""}`}
          role="img"
          aria-label={`${member.username}, IP address ${member.ipAddress}`}
          title={`${member.username} — ${member.ipAddress}`}
        >
          {member.username.charAt(0).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

export function EditableTitle({
  ariaLabel,
  disabled,
  onCommit,
  value,
}: {
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
  readonly value: string;
}) {
  return (
    <input
      key={value}
      className="editable-title"
      aria-label={ariaLabel}
      defaultValue={value}
      disabled={disabled}
      title="Press Enter to save or Escape to cancel"
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next.length > 0 && next !== value) onCommit(next);
        else event.currentTarget.value = value;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function PowerIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3v8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path
        d="M7.05 5.9a8 8 0 1 0 9.9 0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M14.267 1.52a0.76 0.76 0 0 1 0.724 0.527l0.836 2.597q0.527 0.257 1.008 0.582l2.669 -0.575a0.76 0.76 0 0 1 0.818 0.365l2.107 3.647a0.76 0.76 0 0 1 -0.096 0.891l-1.832 2.022a8.708 8.708 0 0 1 0 1.165l1.832 2.024a0.76 0.76 0 0 1 0.096 0.891l-2.107 3.648a0.76 0.76 0 0 1 -0.818 0.363l-2.669 -0.575a8.708 8.708 0 0 1 -1.006 0.582l-0.838 2.597a0.76 0.76 0 0 1 -0.724 0.528h-4.213a0.76 0.76 0 0 1 -0.724 -0.527l-0.834 -2.597a8.392 8.392 0 0 1 -1.011 -0.585l-2.668 0.576a0.76 0.76 0 0 1 -0.818 -0.365L1.892 15.656a0.76 0.76 0 0 1 0.096 -0.891l1.832 -2.024a8.708 8.708 0 0 1 0 -1.161L1.988 9.555a0.76 0.76 0 0 1 -0.096 -0.891l2.107 -3.648a0.76 0.76 0 0 1 0.818 -0.363l2.668 0.576a8.392 8.392 0 0 1 1.011 -0.585l0.836 -2.596a0.76 0.76 0 0 1 0.72 -0.528h4.213zM12.16 7.6a4.56 4.56 0 1 1 0 9.12 4.56 4.56 0 0 1 0 -9.12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      {/* <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" /> */}
    </svg>
  );
}

export function SunIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.5v2M12 19.5v2M4.58 4.58l1.42 1.42M18 18l1.42 1.42M2.5 12h2M19.5 12h2M4.58 19.42 6 18M18 6l1.42-1.42"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function PanelsIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M8 4v16M12 8h5M12 12h5M12 16h3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function syncStatusLabel(status: SynchronizationStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "synchronized":
      return "Synchronized";
    case "offline":
      return "Offline — editing locally";
    case "error":
      return "Synchronization error";
    case "host-disconnected":
      return "Host disconnected";
    case "project-reloaded":
      return "Project reloaded";
    case "host-stopped":
      return "Host stopped";
  }
}

function SignOutIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M14 5h5v14h-5M10 12h9M14.5 8.5 18 12l-3.5 3.5M5 12h8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
