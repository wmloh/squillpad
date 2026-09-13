import { forwardRef, useImperativeHandle } from "react";

import { RepositorySynchronizationDialogs } from "./RepositorySynchronizationDialog";
import { useRepositorySynchronization } from "./useRepositorySynchronization";

export interface RepositorySynchronizationHandle {
  syncNow(): void;
}

/** Host-only GitHub synchronization button with layered snapshot review dialogs. */
export const RepositorySynchronization = forwardRef<
  RepositorySynchronizationHandle,
  { readonly onProjectReload?: () => void; readonly theme: "light" | "dark" }
>(function RepositorySynchronization({ onProjectReload, theme }, ref) {
  const state = useRepositorySynchronization(
    onProjectReload === undefined ? {} : { onProjectReload },
  );
  useImperativeHandle(ref, () => ({ syncNow: state.syncNow }), [state.syncNow]);

  if (state.status === undefined) return null;

  return (
    <>
      <button
        className="repository-sync-button"
        type="button"
        aria-haspopup="dialog"
        aria-label="Sync"
        title={
          state.review === undefined
            ? "Synchronize project snapshots through GitHub"
            : state.open
              ? "A snapshot review is open; finish or close it before synchronizing again"
              : "Reopen the snapshot review to finish or close it"
        }
        disabled={state.busy || state.reloadRequested || (state.review !== undefined && state.open)}
        onClick={() => state.setOpen(true)}
      >
        <SyncIcon />
        <span className="visually-hidden">Sync</span>
      </button>
      <RepositorySynchronizationDialogs state={state} theme={theme} />
    </>
  );
});

function SyncIcon() {
  return (
    <svg className="topbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M20 7v5h-5M4 17v-5h5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M18.2 12a6.5 6.5 0 0 0-11.1-4.6L5 9M5.8 12a6.5 6.5 0 0 0 11.1 4.6L19 15"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export type { RepositorySynchronizationState } from "./useRepositorySynchronization";
