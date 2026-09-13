import { useCallback, useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import {
  DEFAULT_CLIENT_LIMIT,
  isClientLimit,
  MAX_CLIENT_LIMIT,
  MIN_CLIENT_LIMIT,
} from "@squillpad/synchronization";
import {
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
} from "@squillpad/ui";

import { accessHeaders } from "./host-access";
import { ToggleSwitch } from "./ToggleSwitch";

interface Sharing {
  enabled: boolean;
  defaultEnabled?: boolean;
  clientLimit?: number;
  connectedClients?: number;
  clientSlotsUsed?: number;
  connections: { url: string; qr: string }[];
}

type SharingStatus = "pending" | "enabled" | "disabled" | "error";

export function LanSharing({
  detailsRef,
  host = false,
  onEnabledChange,
}: {
  readonly detailsRef?: Ref<HTMLDetailsElement>;
  readonly host?: boolean;
  readonly onEnabledChange?: (enabled: boolean | undefined) => void;
} = {}) {
  const [status, setStatus] = useState<SharingStatus>("pending");
  const [connections, setConnections] = useState<Sharing["connections"]>([]);
  const [visibleQrUrls, setVisibleQrUrls] = useState<ReadonlySet<string>>(new Set());
  const [defaultEnabled, setDefaultEnabled] = useState(true);
  const [configuredClientLimit, setConfiguredClientLimit] = useState(DEFAULT_CLIENT_LIMIT);
  const [clientLimitDraft, setClientLimitDraft] = useState(String(DEFAULT_CLIENT_LIMIT));
  const [clientSlotsUsed, setClientSlotsUsed] = useState(host ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const clientLimitDraftDirtyRef = useRef(false);

  const applySharing = useCallback(
    (next: Sharing) => {
      const nextClientLimit = isClientLimit(next.clientLimit)
        ? next.clientLimit
        : DEFAULT_CLIENT_LIMIT;
      const nextClientSlotsUsed = next.clientSlotsUsed ?? next.connectedClients ?? (host ? 1 : 0);
      setConnections(next.connections ?? []);
      setVisibleQrUrls((current) => {
        const availableUrls = new Set((next.connections ?? []).map(({ url }) => url));
        return new Set([...current].filter((url) => availableUrls.has(url)));
      });
      setDefaultEnabled(next.defaultEnabled ?? next.enabled);
      setConfiguredClientLimit(nextClientLimit);
      setClientSlotsUsed(nextClientSlotsUsed);
      if (!clientLimitDraftDirtyRef.current) setClientLimitDraft(String(nextClientLimit));
      setStatus(next.enabled ? "enabled" : "disabled");
      setActionError(undefined);
      onEnabledChange?.(next.enabled);
    },
    [host, onEnabledChange],
  );

  const refreshSharing = useCallback(async () => {
    const response = await fetch("/api/sharing", {
      headers: accessHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Sharing status request failed");
    applySharing((await response.json()) as Sharing);
  }, [applySharing]);

  useEffect(() => {
    if (!host) {
      onEnabledChange?.(undefined);
      return;
    }
    void refreshSharing().catch(() => {
      setStatus("error");
      onEnabledChange?.(undefined);
    });
  }, [host, onEnabledChange, refreshSharing]);

  useEffect(() => {
    if (!host) return;
    const timer = window.setInterval(() => {
      void refreshSharing().catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [host, refreshSharing]);

  const enabled = status === "enabled";
  const statusLabel =
    status === "enabled"
      ? "enabled"
      : status === "disabled"
        ? "disabled"
        : status === "error"
          ? "unavailable"
          : "checking";

  const updateSharing = async (nextEnabled: boolean = !enabled) => {
    if (!host || busy || status === "pending" || status === "error") return;
    setBusy(true);
    try {
      const response = await fetch("/api/sharing", {
        method: "POST",
        headers: { ...accessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!response.ok) throw new Error("Could not update LAN sharing");
      applySharing((await response.json()) as Sharing);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not update LAN sharing";
      void refreshSharing()
        .catch(() => undefined)
        .then(() => setActionError(message));
    } finally {
      setBusy(false);
    }
  };

  const updateDefault = async (nextDefaultEnabled: boolean = !defaultEnabled) => {
    if (!host || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/hierarchy/commands", {
        method: "POST",
        headers: { ...accessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          action: "update-lan-sharing-default",
          enabled: nextDefaultEnabled,
        }),
      });
      if (!response.ok) throw new Error("Could not update the LAN sharing default");
      setDefaultEnabled(nextDefaultEnabled);
      setActionError(undefined);
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Could not update the LAN sharing default",
      );
    } finally {
      setBusy(false);
    }
  };

  const updateClientLimit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!host || busy || status === "pending" || status === "error") return;
    const nextClientLimit = parseClientLimit(clientLimitDraft);
    if (nextClientLimit === undefined) {
      setActionError(
        `Client limit must be a whole number between ${MIN_CLIENT_LIMIT} and ${MAX_CLIENT_LIMIT}`,
      );
      return;
    }
    if (nextClientLimit === configuredClientLimit) {
      clientLimitDraftDirtyRef.current = false;
      setClientLimitDraft(String(nextClientLimit));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/sharing", {
        method: "POST",
        headers: { ...accessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ clientLimit: nextClientLimit }),
      });
      if (!response.ok) throw new Error("Could not update the client limit");
      clientLimitDraftDirtyRef.current = false;
      applySharing((await response.json()) as Sharing);
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Could not update the client limit",
      );
    } finally {
      setBusy(false);
    }
  };

  const parsedClientLimit = parseClientLimit(clientLimitDraft);

  if (!host) return null;

  return (
    <details
      ref={detailsRef}
      className={`lan-sharing lan-sharing--${status}`}
      aria-disabled={!host && !enabled}
      onToggle={(event) => {
        prepareAnimatedMenu(event.currentTarget);
        if (host && event.currentTarget.open) void refreshSharing().catch(() => undefined);
      }}
      onAnimationEnd={(event) =>
        finishAnimatedMenu(event.currentTarget, event.animationName, event.target)
      }
    >
      <summary
        className="save-status topbar-status-control lan-sharing__summary"
        aria-label={`Sharing: ${statusLabel}`}
        title={enabled ? "Show LAN sharing controls and links" : `LAN sharing is ${statusLabel}`}
        onClick={(event) => {
          if (!host && !enabled) event.preventDefault();
          else prepareAnimatedMenuFromSummary(event.currentTarget, event);
        }}
      >
        Sharing
      </summary>
      {(enabled || host) && status !== "pending" && status !== "error" && (
        <div className="lan-sharing__content" data-animated-menu>
          {actionError !== undefined && (
            <p className="lan-sharing__error" role="alert">
              {actionError}
            </p>
          )}
          <p>
            {enabled
              ? "Anyone with this link can read and edit this notebook. HTTP does not encrypt notes or credentials. Use only a trusted local network unless you intentionally configure secure HTTPS / reverse-proxy infrastructure."
              : "LAN sharing is disabled. The host remains editable locally; connected LAN clients are read-only until LAN sharing is enabled and they reload."}
          </p>
          {host && (
            <div className="lan-sharing__controls">
              <ToggleSwitch
                className="lan-sharing__toggle"
                checked={enabled}
                disabled={busy}
                label="LAN sharing"
                onChange={(checked) => void updateSharing(checked)}
              />
              <ToggleSwitch
                className="lan-sharing__toggle"
                checked={defaultEnabled}
                disabled={busy}
                label="Start with LAN sharing by default"
                onChange={(checked) => void updateDefault(checked)}
              />
            </div>
          )}
          {host && (
            <section className="lan-sharing__client-limit" aria-label="Client capacity">
              <p className="lan-sharing__capacity" role="status">
                {clientSlotsUsed} of {configuredClientLimit} client slots in use, including this
                host.
                {clientSlotsUsed >= configuredClientLimit &&
                  " New connections are currently blocked."}
              </p>
              <form
                className="lan-sharing__limit-form"
                onSubmit={(event) => void updateClientLimit(event)}
              >
                <label htmlFor="lan-sharing-client-limit">Maximum clients (including host)</label>
                <div className="lan-sharing__limit-control">
                  <input
                    id="lan-sharing-client-limit"
                    type="number"
                    inputMode="numeric"
                    min={MIN_CLIENT_LIMIT}
                    max={MAX_CLIENT_LIMIT}
                    step="1"
                    required
                    value={clientLimitDraft}
                    aria-invalid={clientLimitDraft.length > 0 && parsedClientLimit === undefined}
                    aria-describedby="lan-sharing-client-limit-help"
                    disabled={busy}
                    onChange={(event) => {
                      clientLimitDraftDirtyRef.current = true;
                      setClientLimitDraft(event.target.value);
                      setActionError(undefined);
                    }}
                  />
                  <button
                    type="submit"
                    disabled={busy || parsedClientLimit === configuredClientLimit}
                  >
                    Apply
                  </button>
                </div>
                <p className="lan-sharing__limit-help" id="lan-sharing-client-limit-help">
                  Use a whole number from {MIN_CLIENT_LIMIT} to {MAX_CLIENT_LIMIT}. The limit is
                  reset to {DEFAULT_CLIENT_LIMIT} whenever the host restarts.
                </p>
              </form>
            </section>
          )}
          {enabled &&
            connections.map(({ url, qr }, index) => {
              const qrId = `lan-sharing-qr-${index}`;
              const qrVisible = visibleQrUrls.has(url);
              return (
                <div className="lan-sharing__connection" key={url}>
                  <a className="lan-sharing__url" href={url} referrerPolicy="no-referrer">
                    {url}
                  </a>
                  <button
                    type="button"
                    className="lan-sharing__qr-toggle"
                    aria-controls={qrId}
                    aria-expanded={qrVisible}
                    onClick={() =>
                      setVisibleQrUrls((current) => {
                        const next = new Set(current);
                        if (next.has(url)) next.delete(url);
                        else next.add(url);
                        return next;
                      })
                    }
                  >
                    {qrVisible ? "Hide QR code" : "Show QR code"}
                  </button>
                  {qrVisible && (
                    <img
                      id={qrId}
                      className="lan-sharing__qr"
                      src={qr}
                      width="240"
                      height="240"
                      alt="Scan to connect to this shared notebook"
                    />
                  )}
                </div>
              );
            })}
        </div>
      )}
    </details>
  );
}

function parseClientLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return isClientLimit(parsed) ? parsed : undefined;
}
