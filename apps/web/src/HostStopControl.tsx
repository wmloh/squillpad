import { useState, type Ref } from "react";

import {
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
} from "@squillpad/ui";

import { RepositoryChangeSummary } from "./RepositoryChangeSummary";

export interface HostStopControlProps {
  readonly detailsRef?: Ref<HTMLDetailsElement>;
  readonly onStopHosting: () => void;
  readonly onSyncNow: () => void;
  readonly stopping: boolean;
  readonly theme: "light" | "dark";
}

/** Offers a sync reminder and a safe host shutdown confirmation. */
export function HostStopControl({
  detailsRef,
  onStopHosting,
  onSyncNow,
  stopping,
  theme,
}: HostStopControlProps) {
  const [open, setOpen] = useState(false);

  return (
    <details
      ref={detailsRef}
      className="host-stop-control"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        prepareAnimatedMenu(event.currentTarget);
      }}
      onAnimationEnd={(event) =>
        finishAnimatedMenu(event.currentTarget, event.animationName, event.target)
      }
    >
      <summary
        className="topbar-icon-button host-stop-control__summary"
        aria-label="Stop hosting"
        title="Stop hosting"
        onClick={(event) => prepareAnimatedMenuFromSummary(event.currentTarget, event)}
      >
        <PowerIcon />
      </summary>
      <div className="host-stop-menu" data-animated-menu aria-label="Stop hosting options">
        <section className="host-stop-menu__section">
          <strong>Sync</strong>
          <p>Sync your latest changes before stopping the host.</p>
          {open && <RepositoryChangeSummary />}
          <button
            type="button"
            className={`repository-sync-run-button repository-sync-run-button--${theme}`}
            disabled={stopping}
            onClick={onSyncNow}
          >
            Sync now
          </button>
        </section>
        <section className="host-stop-menu__section host-stop-menu__confirmation">
          <strong>Stop hosting?</strong>
          <p>Everyone connected to this notebook will be disconnected.</p>
          <button
            type="button"
            className="host-stop-menu__confirm"
            disabled={stopping}
            onClick={onStopHosting}
          >
            <PowerIcon />
            {stopping ? "Stopping…" : "Stop hosting"}
          </button>
        </section>
      </div>
    </details>
  );
}

function PowerIcon() {
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
