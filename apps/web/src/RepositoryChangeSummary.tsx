import { useEffect, useState } from "react";

import { accessHeaders } from "./host-access";
import type { RepositoryLineChanges, RepositorySnapshotReview } from "./repository-sync-types";

type RepositoryComparison =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly outcome: "up-to-date" | "publish-local" | "apply-remote" | "conflict";
      readonly publishLocal: RepositoryLineChanges;
      readonly applyRemote: RepositoryLineChanges;
      readonly review?: RepositorySnapshotReview;
    };

export interface RepositoryChangeSummaryProps {
  readonly refreshToken?: number;
  readonly disabled?: boolean;
  readonly onReview?: (review: RepositorySnapshotReview) => void;
}

/** Shows the line-level effect of the next repository synchronization. */
export function RepositoryChangeSummary({
  refreshToken = 0,
  disabled = false,
  onReview,
}: RepositoryChangeSummaryProps) {
  const [comparison, setComparison] = useState<RepositoryComparison>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    if (disabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void fetch("/api/repository-sync/comparison", {
      method: "GET",
      headers: accessHeaders(),
    })
      .then(async (response) => {
        const body = (await response.json()) as RepositoryComparison | { readonly error?: string };
        if (!response.ok) {
          throw new Error("error" in body ? body.error : "Could not compare snapshots");
        }
        if (!cancelled) {
          const next = body as RepositoryComparison;
          setComparison(next);
          if (next.configured && next.review !== undefined) onReview?.(next.review);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [disabled, manualRefresh, onReview, refreshToken]);

  return (
    <section className="repository-change-summary" aria-label="Changes at next sync">
      <header>
        <strong>Changes at next sync</strong>
        <button
          type="button"
          disabled={disabled || loading}
          aria-label="Refresh change comparison"
          onClick={() => setManualRefresh((value) => value + 1)}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </header>
      {error !== undefined ? (
        <p className="repository-change-summary__status" role="alert">
          {error}
        </p>
      ) : comparison?.configured === false ? (
        <p className="repository-change-summary__status">
          Connect a repository to compare changes.
        </p>
      ) : comparison?.configured === true ? (
        comparison.outcome === "conflict" ? (
          <div className="repository-change-summary__conflict">
            <RepositoryChangeBar label="Publish local" changes={comparison.publishLocal} />
            <RepositoryChangeBar label="Apply remote" changes={comparison.applyRemote} />
          </div>
        ) : (
          <RepositoryChangeBar
            label={comparisonLabel(comparison.outcome)}
            changes={
              comparison.outcome === "apply-remote"
                ? comparison.applyRemote
                : comparison.publishLocal
            }
          />
        )
      ) : disabled && comparison === undefined ? (
        <p className="repository-change-summary__status">
          Comparison paused while a repository review or action is active.
        </p>
      ) : (
        <p className="repository-change-summary__status">Measuring saved notebook changes…</p>
      )}
    </section>
  );
}

export function RepositoryChangeBar({
  label,
  changes,
}: {
  readonly label: string;
  readonly changes: RepositoryLineChanges;
}) {
  const total = changes.insertions + changes.deletions;
  const insertionWidth = total === 0 ? 0 : (changes.insertions / total) * 100;
  const deletionWidth = total === 0 ? 0 : 100 - insertionWidth;
  const description = `${label}: ${formatCount(changes.insertions, "insertion")}, ${formatCount(changes.deletions, "deletion")}`;
  return (
    <div className="repository-change-bar">
      <div className="repository-change-bar__labels">
        <span>{label}</span>
        <span>
          <span className="repository-change-bar__insertions">
            +{changes.insertions} {pluralize(changes.insertions, "insertion")}
          </span>
          <span aria-hidden="true"> · </span>
          <span className="repository-change-bar__deletions">
            −{changes.deletions} {pluralize(changes.deletions, "deletion")}
          </span>
        </span>
      </div>
      <div className="repository-change-bar__track" role="img" aria-label={description}>
        <span
          className="repository-change-bar__segment repository-change-bar__segment--insertions"
          style={{ width: `${insertionWidth}%` }}
        />
        <span
          className="repository-change-bar__segment repository-change-bar__segment--deletions"
          style={{ width: `${deletionWidth}%` }}
        />
      </div>
    </div>
  );
}

function comparisonLabel(outcome: Exclude<RepositoryComparison, { configured: false }>["outcome"]) {
  if (outcome === "publish-local") return "Publish local";
  if (outcome === "apply-remote") return "Apply remote";
  return "Up to date";
}

function formatCount(count: number, noun: string): string {
  return `${count} ${pluralize(count, noun)}`;
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
