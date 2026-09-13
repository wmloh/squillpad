import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";

import { pageRoomId } from "./index.js";

export type SynchronizationStatus =
  | "connecting"
  | "synchronized"
  | "offline"
  | "error"
  | "host-disconnected"
  | "project-reloaded"
  | "host-stopped";

export const HOST_STOPPED_CLOSE_CODE = 4401;
export const HOST_STOPPED_CLOSE_REASON = "Host stopped";
export const REPOSITORY_OPERATION_CLOSE_CODE = 4423;
export const REPOSITORY_OPERATION_CLOSE_REASON = "Repository snapshot operation in progress";
export const PROJECT_RELOADED_CLOSE_CODE = 4409;
export const PROJECT_RELOADED_CLOSE_REASON = "Project snapshot replaced";
const REPOSITORY_RECONNECT_INITIAL_DELAY_MS = 250;
const REPOSITORY_RECONNECT_MAX_DELAY_MS = 5_000;

export interface PagePresence {
  readonly clientId: number;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface PageSyncClientOptions {
  readonly document: Y.Doc;
  readonly pageId: string;
  readonly projectId: string;
  readonly serverUrl: string;
  readonly synchronizationGeneration: string;
  readonly accessToken?: string;
  readonly disableIndexedDb?: boolean;
  readonly WebSocketPolyfill?: typeof WebSocket;
}

/** Browser-owned network, offline persistence, status, and awareness for one page document. */
export class PageSyncClient {
  readonly document: Y.Doc;
  readonly provider: WebsocketProvider;
  readonly persistence: IndexeddbPersistence | undefined;
  readonly #listeners = new Set<(status: SynchronizationStatus) => void>();
  readonly #offlineHandler: (() => void) | undefined;
  readonly #onlineHandler: (() => void) | undefined;
  #repositoryReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #repositoryReconnectDelayMs = REPOSITORY_RECONNECT_INITIAL_DELAY_MS;
  #clientOffline = false;
  #hostDisconnected = false;
  #hostStopped = false;
  #projectReloaded = false;
  #status: SynchronizationStatus = "connecting";

  constructor(options: PageSyncClientOptions) {
    this.document = options.document;
    const roomId = pageRoomId(options.synchronizationGeneration, options.projectId, options.pageId);
    this.persistence = options.disableIndexedDb
      ? undefined
      : new IndexeddbPersistence(`squillpad:${roomId}`, options.document);
    this.provider = new WebsocketProvider(options.serverUrl, roomId, options.document, {
      disableBc: options.accessToken !== undefined,
      protocols:
        options.accessToken === undefined
          ? []
          : ["squillpad", `squillpad-token.${options.accessToken}`],
      ...(options.WebSocketPolyfill === undefined
        ? {}
        : { WebSocketPolyfill: options.WebSocketPolyfill }),
    });
    this.provider.on("status", ({ status }: { status: string }) => {
      if (this.#hostStopped || this.#projectReloaded) return;
      if (status === "connected") {
        this.#repositoryReconnectDelayMs = REPOSITORY_RECONNECT_INITIAL_DELAY_MS;
      }
      const next = status === "connecting" || status === "connected" ? "connecting" : "offline";
      if (next === "offline" && this.#hostDisconnected && !this.#clientOffline) {
        this.#setStatus("host-disconnected");
        return;
      }
      this.#setStatus(next);
    });
    this.provider.on("sync", (synced: boolean) => {
      if (synced && !this.#hostStopped && !this.#projectReloaded) {
        this.#hostDisconnected = false;
        this.#setStatus("synchronized");
      }
    });
    this.provider.on("connection-error", () => {
      if (!this.#hostStopped && !this.#projectReloaded) {
        this.#hostDisconnected = true;
        this.#setStatus("host-disconnected");
      }
    });
    this.provider.on("closed", (event: { readonly code: number; readonly reason: string }) => {
      if (this.#hostStopped || this.#projectReloaded) return;
      if (this.#clientOffline) {
        this.#setStatus("offline");
        return;
      }
      if (event.code === PROJECT_RELOADED_CLOSE_CODE) {
        this.#projectReloaded = true;
        this.provider.disconnect();
        this.#setStatus("project-reloaded");
        return;
      }
      if (event.code === HOST_STOPPED_CLOSE_CODE) {
        this.#hostStopped = true;
        this.provider.disconnect();
        this.#setStatus("host-stopped");
        return;
      }
      if (event.code === REPOSITORY_OPERATION_CLOSE_CODE) {
        this.#setStatus("connecting");
        this.#scheduleRepositoryReconnect();
        return;
      }
      this.#hostDisconnected = true;
      this.#setStatus("host-disconnected");
    });
    if (typeof window === "undefined") {
      this.#offlineHandler = undefined;
      this.#onlineHandler = undefined;
    } else {
      this.#offlineHandler = () => {
        if (this.#hostStopped || this.#projectReloaded) return;
        this.#clientOffline = true;
        this.#hostDisconnected = false;
        this.provider.disconnect();
        this.#setStatus("offline");
      };
      this.#onlineHandler = () => {
        if (this.#hostStopped || this.#projectReloaded) return;
        this.#clientOffline = false;
        this.#hostDisconnected = false;
        this.#setStatus("connecting");
        this.provider.connect();
      };
      window.addEventListener("offline", this.#offlineHandler);
      window.addEventListener("online", this.#onlineHandler);
      if (!navigator.onLine) {
        this.#clientOffline = true;
        this.#setStatus("offline");
      }
    }
  }

  get status(): SynchronizationStatus {
    return this.#status;
  }

  subscribe(listener: (status: SynchronizationStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#status);
    return () => this.#listeners.delete(listener);
  }

  subscribePresence(listener: (presence: readonly PagePresence[]) => void): () => void {
    const awareness = this.provider.awareness;
    const notify = () => {
      listener(
        [...awareness.getStates().entries()]
          .filter(([clientId]) => clientId !== awareness.clientID)
          .map(([clientId, state]) => ({ clientId, state })),
      );
    };
    awareness.on("change", notify);
    notify();
    return () => awareness.off("change", notify);
  }

  setPresence(value: Readonly<Record<string, unknown>> | null): void {
    this.provider.awareness.setLocalState(value);
  }

  setPresenceField(name: string, value: unknown): void {
    this.provider.awareness.setLocalStateField(name, value);
  }

  destroy(): void {
    if (this.#repositoryReconnectTimer !== undefined) {
      clearTimeout(this.#repositoryReconnectTimer);
      this.#repositoryReconnectTimer = undefined;
    }
    if (typeof window !== "undefined") {
      if (this.#offlineHandler !== undefined)
        window.removeEventListener("offline", this.#offlineHandler);
      if (this.#onlineHandler !== undefined)
        window.removeEventListener("online", this.#onlineHandler);
    }
    this.provider.destroy();
    void this.persistence?.destroy();
    this.#listeners.clear();
  }

  #setStatus(status: SynchronizationStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  #scheduleRepositoryReconnect(): void {
    if (this.#repositoryReconnectTimer !== undefined) return;
    const delay = this.#repositoryReconnectDelayMs;
    this.#repositoryReconnectDelayMs = Math.min(delay * 2, REPOSITORY_RECONNECT_MAX_DELAY_MS);
    this.#repositoryReconnectTimer = setTimeout(() => {
      this.#repositoryReconnectTimer = undefined;
      if (this.#hostStopped || this.#projectReloaded) return;
      this.provider.connect();
    }, delay);
  }
}
