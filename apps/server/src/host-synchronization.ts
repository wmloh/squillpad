import { constants as fsConstants, watch, type FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Server, IncomingMessage } from "node:http";

import {
  DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  isAutosaveIntervalSeconds,
  serializeCanvasJsonLines,
  type AutosaveIntervalSeconds,
} from "@squillpad/core-model";
import {
  createPageDocument,
  materializePageDocument,
  parsePageRoomId,
  reconcilePageContentById,
  HOST_STOPPED_CLOSE_CODE,
  HOST_STOPPED_CLOSE_REASON,
  REPOSITORY_OPERATION_CLOSE_CODE,
  REPOSITORY_OPERATION_CLOSE_REASON,
  PROJECT_RELOADED_CLOSE_CODE,
  PROJECT_RELOADED_CLOSE_REASON,
  CLIENT_LIMIT_CLOSE_CODE,
  CLIENT_LIMIT_CLOSE_REASON,
  DEFAULT_CLIENT_LIMIT,
  isClientLimit,
  type PageRoomIdentity,
  type SynchronizedPageContent,
} from "@squillpad/synchronization";
import {
  cleanupRuntimeCache,
  type RuntimeCacheCleanupResult,
  type ProjectHierarchyService,
  type StoredPageContent,
} from "@squillpad/storage";
import { consoleLogger, type StructuredLogger } from "./logging.js";
import { isLoopbackAddress } from "./security.js";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const COMPACT_AFTER_UPDATES = 100;
const RUNTIME_FLUSH_DELAY_MS = 1_000;
const RUNTIME_FLUSH_SIZE_BYTES = 1024 * 1024;
const MATERIALIZE_DELAY_MS = 250;
const CANONICAL_RESCAN_DELAY_MS = 80;
const PROJECT_PRESENCE_STALE_AFTER_MS = 15_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_GENERATION_PATTERN = new RegExp(`^${UUID}$`);
const CANONICAL_PATH = new RegExp(
  `^(?:notebook\\.json|sections/${UUID}/section\\.json|sections/${UUID}/pages/${UUID}/(?:page\\.json|canvas\\.jsonl)|sections/${UUID}/pages/${UUID}/markdown/${UUID}\\.md)$`,
);

export type CanonicalMaterializationStatus = "saving" | "saved" | "error";

export interface CanonicalPageStatus {
  readonly status: CanonicalMaterializationStatus;
  readonly revision: number;
  readonly dirty: boolean;
  readonly error?: string;
}

export interface HostSynchronizationStatus {
  readonly activeRooms: number;
  readonly connectedClients: number;
  readonly clientSlotsUsed: number;
  readonly clientLimit: number;
  readonly synchronizationGeneration: string;
  readonly canonical?: Readonly<Record<string, CanonicalPageStatus>>;
  readonly canonicalError?: string;
  readonly hierarchyRevision?: number;
}

export interface ProjectPresenceMember {
  readonly id: string;
  readonly username: string;
  readonly ipAddress: string;
}

interface ProjectPresenceEntry extends ProjectPresenceMember {
  readonly lastSeenAt: number;
}

interface CanonicalFileState {
  readonly exists: boolean;
  readonly contents?: string;
  readonly readError?: string;
}

type CanonicalFileMap = Map<string, CanonicalFileState>;

interface ExpectedFileWrite {
  readonly expected: CanonicalFileState;
  readonly previous: CanonicalFileState;
}

interface HostPageRoom {
  readonly document: Y.Doc;
  readonly awareness: Awareness;
  readonly clients: Set<WebSocket>;
  readonly localClients: Set<WebSocket>;
  readonly controlledAwarenessIds: Map<WebSocket, Set<number>>;
  readonly identity: PageRoomIdentity;
  sectionId: string;
  readonly snapshotPath: string;
  readonly updatesPath: string;
  materializationTimer: ReturnType<typeof setTimeout> | undefined;
  runtimeFlushTimer: ReturnType<typeof setTimeout> | undefined;
  bufferedRuntimeUpdates: Uint8Array[];
  bufferedRuntimeBytes: number;
  pendingWrites: Promise<void>;
  updatesSinceCompaction: number;
  dirtyRevision: number;
  materializedRevision: number;
  materializedContent: SynchronizedPageContent;
  materializationStatus: CanonicalMaterializationStatus;
  materializationError: string | undefined;
  readonly projectRoot: string;
  canonicalBlocked: boolean;
}

export interface HostSynchronizationOptions {
  readonly hierarchy: ProjectHierarchyService;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly sharingEnabled?: boolean;
  readonly clientLimit?: number;
  readonly autosaveIntervalSeconds?: AutosaveIntervalSeconds;
  readonly materializePage?: (
    sectionId: string,
    pageId: string,
    content: StoredPageContent,
  ) => Promise<void>;
  readonly materializeDelayMs?: number;
  readonly runtimeFlushDelayMs?: number;
  readonly runtimeFlushSizeBytes?: number;
  readonly canonicalRescanDelayMs?: number;
  readonly logger?: StructuredLogger;
}

/** Owns page rooms, runtime Yjs persistence, canonical materialization, and file reconciliation. */
export class HostSynchronizationService {
  readonly #options: HostSynchronizationOptions;
  readonly #logger: StructuredLogger;
  readonly #rooms = new Map<string, Promise<HostPageRoom>>();
  readonly #pageStatuses = new Map<string, CanonicalPageStatus>();
  readonly #webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("squillpad") ? "squillpad" : false),
  });
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #expectedWrites = new Map<string, ExpectedFileWrite>();
  readonly #canonicalFiles: CanonicalFileMap = new Map();
  readonly #canonicalErrors = new Map<string, string>();
  readonly #projectPresence = new Map<string, ProjectPresenceEntry>();
  readonly #watchReady: Promise<void>;
  #projectId: string;
  #watchTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingFileEvents = new Set<string>();
  #canonicalRescanInProgress = false;
  #canonicalRescanPending = false;
  #hierarchyRevision = 0;
  #closed = false;
  #notifyClientsOnClose = false;
  #connectedClients = 0;
  #localClientCount = 0;
  #clientLimit: number;
  #sharingEnabled: boolean;
  #autosaveIntervalSeconds: AutosaveIntervalSeconds;
  #sharingTransition: Promise<void> = Promise.resolve();
  #repositoryOperationActive = false;
  #runtimeCleanup: Promise<RuntimeCacheCleanupResult> | undefined;
  #synchronizationGeneration: string = randomUUID();

  constructor(options: HostSynchronizationOptions) {
    this.#options = options;
    this.#projectId = options.projectId;
    this.#logger = options.logger ?? consoleLogger;
    this.#sharingEnabled = options.sharingEnabled ?? true;
    this.#clientLimit = options.clientLimit ?? DEFAULT_CLIENT_LIMIT;
    if (!isClientLimit(this.#clientLimit)) {
      throw new Error("Client limit must be a whole number between 1 and 20");
    }
    this.#autosaveIntervalSeconds =
      options.autosaveIntervalSeconds ?? DEFAULT_AUTOSAVE_INTERVAL_SECONDS;
    if (!isAutosaveIntervalSeconds(this.#autosaveIntervalSeconds)) {
      throw new Error("Autosave interval must be one of the supported project intervals");
    }
    this.#watchReady = this.#initialize();
  }

  attach(
    server: Server,
    guard: (request: IncomingMessage, websocket: boolean) => number | undefined,
  ): void {
    server.on("upgrade", (request, socket, head) => {
      // A client can reset the socket before ws has attached its own listener.
      socket.on("error", () => undefined);
      const rejected = guard(request, true);
      if (rejected !== undefined) {
        socket.end(
          `HTTP/1.1 ${rejected} Request denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      if (this.#repositoryOperationActive) {
        this.#webSockets.handleUpgrade(request, socket, head, (client) => {
          client.close(REPOSITORY_OPERATION_CLOSE_CODE, REPOSITORY_OPERATION_CLOSE_REASON);
        });
        return;
      }
      const roomId = roomFromUrl(request.url);
      if (roomId === undefined) {
        socket.destroy();
        return;
      }
      const identity = parsePageRoomId(roomId);
      if (identity === undefined || identity.generation !== this.#synchronizationGeneration) {
        this.#webSockets.handleUpgrade(request, socket, head, (client) => {
          client.close(PROJECT_RELOADED_CLOSE_CODE, PROJECT_RELOADED_CLOSE_REASON);
        });
        return;
      }
      if (identity.projectId !== this.#projectId) {
        this.#webSockets.handleUpgrade(request, socket, head, (client) => {
          client.close(4404, "Synchronization room unavailable");
        });
        return;
      }
      const localClient = isLoopbackAddress(request.socket.remoteAddress);
      if (this.#connectionLimitReached(localClient)) {
        rejectClientLimitUpgrade(socket);
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (client) => {
        void this.#accept(client, roomId, localClient).catch(() => {
          this.#logger.warn("sync.room_unavailable", {
            pageId: parsePageRoomId(roomId)?.pageId,
            roomId,
          });
          client.close(4404, "Synchronization room unavailable");
        });
      });
    });
  }

  status(): HostSynchronizationStatus {
    const canonical = Object.fromEntries(this.#pageStatuses.entries());
    const canonicalError = firstError(this.#canonicalErrors);
    return {
      activeRooms: this.#rooms.size,
      connectedClients: this.#connectedClients,
      clientSlotsUsed: this.#connectedClients + (this.#localClientCount === 0 ? 1 : 0),
      clientLimit: this.#clientLimit,
      synchronizationGeneration: this.#synchronizationGeneration,
      ...(this.#pageStatuses.size === 0 ? {} : { canonical }),
      ...(canonicalError === undefined ? {} : { canonicalError }),
      ...(this.#hierarchyRevision === 0 ? {} : { hierarchyRevision: this.#hierarchyRevision }),
    };
  }

  /** Updates the process-local maximum without changing canonical project data. */
  setClientLimit(limit: number): void {
    if (!isClientLimit(limit)) {
      throw new Error("Client limit must be a whole number between 1 and 20");
    }
    this.#clientLimit = limit;
  }

  /** Resolves after the initial canonical snapshot and filesystem watchers are ready. */
  async ready(): Promise<void> {
    await this.#watchReady;
  }

  async flush(): Promise<void> {
    await this.#watchReady.catch(() => undefined);
    const rooms = await Promise.all(this.#rooms.values());
    await Promise.all(rooms.map((room) => this.#flushRoom(room)));
  }

  /** Enables or disables remote LAN clients while keeping the local host room alive. */
  async setSharingEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Sharing state must be a boolean");
    const transition = this.#sharingTransition.then(async () => {
      if (enabled === this.#sharingEnabled) return;
      if (!enabled) {
        this.#sharingEnabled = false;
        for (const roomPromise of this.#rooms.values()) {
          const room = await roomPromise;
          for (const client of room.clients) {
            if (!room.localClients.has(client)) this.#closeSharingClient(client);
          }
        }
        await this.flush();
        return;
      }
      await this.flush();
      this.#sharingEnabled = true;
    });
    this.#sharingTransition = transition.catch(() => undefined);
    await transition;
  }

  /** Updates the project autosave interval used while LAN sharing is disabled. */
  setAutosaveIntervalSeconds(seconds: AutosaveIntervalSeconds): void {
    if (!isAutosaveIntervalSeconds(seconds)) {
      throw new Error("Autosave interval must be one of the supported project intervals");
    }
    this.#autosaveIntervalSeconds = seconds;
    if (this.#sharingEnabled) return;
    for (const roomPromise of this.#rooms.values()) {
      void roomPromise.then((room) => {
        if (room.materializationTimer !== undefined) {
          clearTimeout(room.materializationTimer);
          room.materializationTimer = undefined;
        }
        if (seconds === 0) {
          if (room.materializationStatus === "saving") room.materializationStatus = "saved";
          this.#publishRoomStatus(room);
        } else if (!this.#sharingEnabled && this.#roomIsDirty(room)) {
          this.#scheduleMaterialization(room);
        }
      });
    }
  }

  /** Saves one loaded page immediately, including its runtime baseline. */
  async flushPage(pageId: string): Promise<void> {
    const room = await this.#roomForPage(pageId);
    if (room === undefined) return;
    await this.#flushRoom(room);
  }

  /** Quiesces live page rooms until one repository mutation completes. */
  async beginRepositoryOperation(): Promise<() => void> {
    if (this.#repositoryOperationActive) {
      throw new Error("Another repository snapshot operation is already running");
    }
    this.#repositoryOperationActive = true;
    try {
      await this.#runtimeCleanup;
      for (const room of await Promise.all(this.#rooms.values())) {
        for (const client of room.clients) {
          client.close(REPOSITORY_OPERATION_CLOSE_CODE, REPOSITORY_OPERATION_CLOSE_REASON);
        }
      }
      await this.flush();
    } catch (error) {
      this.#repositoryOperationActive = false;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#repositoryOperationActive = false;
    };
  }

  /** Discards loaded runtime rooms after Git replaces the canonical project tree. */
  async reloadCanonicalProject(projectId: string): Promise<void> {
    if (this.#closed) throw new Error("Synchronization service is closed");
    await this.#rotateSynchronizationGeneration();
    if (this.#watchTimer !== undefined) clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    this.#pendingFileEvents.clear();
    this.#canonicalRescanPending = false;
    this.#canonicalRescanInProgress = false;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();

    const rooms = await Promise.all(this.#rooms.values());
    for (const room of rooms) {
      if (room.materializationTimer !== undefined) clearTimeout(room.materializationTimer);
      if (room.runtimeFlushTimer !== undefined) clearTimeout(room.runtimeFlushTimer);
      for (const client of room.clients) client.terminate();
      room.clients.clear();
      room.localClients.clear();
      room.controlledAwarenessIds.clear();
      room.awareness.destroy();
      room.document.destroy();
    }
    this.#rooms.clear();
    this.#connectedClients = 0;
    this.#localClientCount = 0;
    this.#projectPresence.clear();
    this.#pageStatuses.clear();
    this.#canonicalErrors.clear();
    this.#canonicalFiles.clear();
    this.#expectedWrites.clear();
    this.#projectId = projectId;
    this.#hierarchyRevision += 1;
    await cleanupRuntimeCache(this.#options.projectRoot);
    await this.#initializeCanonicalWatcher();
  }

  async #initialize(): Promise<void> {
    const path = synchronizationGenerationPath(this.#options.projectRoot);
    await assertRuntimePath(this.#options.projectRoot, path);
    const stored = await readOptional(path);
    const generation = stored === undefined ? undefined : UTF8_DECODER.decode(stored).trim();
    if (generation !== undefined && UUID_GENERATION_PATTERN.test(generation)) {
      this.#synchronizationGeneration = generation;
    } else {
      await this.#writeSynchronizationGeneration(this.#synchronizationGeneration);
    }
    await this.#initializeCanonicalWatcher();
  }

  async #rotateSynchronizationGeneration(): Promise<void> {
    const generation = randomUUID();
    await this.#writeSynchronizationGeneration(generation);
    this.#synchronizationGeneration = generation;
  }

  async #writeSynchronizationGeneration(generation: string): Promise<void> {
    const path = synchronizationGenerationPath(this.#options.projectRoot);
    await assertRuntimePath(this.#options.projectRoot, path);
    await mkdir(join(this.#options.projectRoot, ".squillpad-runtime"), { recursive: true });
    await assertRuntimePath(this.#options.projectRoot, path);
    await atomicWrite(path, new TextEncoder().encode(`${generation}\n`));
  }

  /** Keeps live room baselines intact while removing unused runtime history. */
  cleanupRuntimeCache(): Promise<RuntimeCacheCleanupResult> {
    if (this.#runtimeCleanup !== undefined) return this.#runtimeCleanup;
    const preservedFiles = new Set<string>();
    for (const roomId of this.#rooms.keys()) {
      const key = createHash("sha256").update(roomId).digest("hex");
      preservedFiles.add(`${key}.snapshot`);
      preservedFiles.add(`${key}.updates`);
    }
    const cleanup = cleanupRuntimeCache(this.#options.projectRoot, preservedFiles);
    this.#runtimeCleanup = cleanup;
    void cleanup.then(
      () => {
        this.#runtimeCleanup = undefined;
      },
      () => {
        this.#runtimeCleanup = undefined;
      },
    );
    return cleanup;
  }

  async close(options: { readonly notifyClients?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#notifyClientsOnClose = options.notifyClients === true;
    this.#closed = true;
    if (this.#watchTimer !== undefined) clearTimeout(this.#watchTimer);
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    for (const room of await Promise.all(this.#rooms.values())) {
      for (const client of room.clients) this.#closeClient(client);
    }
    try {
      await this.flush();
    } finally {
      for (const room of await Promise.all(this.#rooms.values())) {
        room.awareness.destroy();
        room.document.destroy();
      }
      this.#projectPresence.clear();
      this.#webSockets.close();
    }
  }

  /** Records a named project client and returns the current active roster. */
  updateProjectPresence(
    id: string,
    username: string,
    ipAddress: string,
  ): readonly ProjectPresenceMember[] {
    this.#expireProjectPresence();
    this.#projectPresence.set(id, {
      id,
      username,
      ipAddress,
      lastSeenAt: Date.now(),
    });
    return this.listProjectPresence();
  }

  /** Removes one project client and returns the current active roster. */
  removeProjectPresence(id: string): readonly ProjectPresenceMember[] {
    this.#projectPresence.delete(id);
    return this.listProjectPresence();
  }

  /** Returns named clients whose five-second heartbeats have not gone stale. */
  listProjectPresence(): readonly ProjectPresenceMember[] {
    this.#expireProjectPresence();
    return [...this.#projectPresence.values()].map(({ id, username, ipAddress }) => ({
      id,
      username,
      ipAddress,
    }));
  }

  async #accept(client: WebSocket, roomId: string, localClient: boolean): Promise<void> {
    if (this.#closed) {
      this.#closeClient(client);
      return;
    }
    if (this.#connectionLimitReached(localClient)) {
      this.#closeAtClientLimit(client);
      return;
    }
    if (!localClient && !this.#sharingEnabled) {
      this.#closeSharingClient(client);
      return;
    }
    const state: { disconnected: boolean; room?: HostPageRoom } = { disconnected: false };
    const bufferedMessages: RawData[] = [];
    let bufferedBytes = 0;
    let windowStart = Date.now();
    let messages = 0;
    client.on("message", (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (Date.now() - windowStart > 1000) {
        windowStart = Date.now();
        messages = 0;
      }
      if (++messages > 200) {
        client.close(4408, "Too many messages");
        return;
      }
      if (state.room === undefined) {
        bufferedBytes += rawBytes(data).length;
        if (bufferedBytes > 8 * 1024 * 1024) {
          client.close(4408, "Too much pending data");
          return;
        }
        bufferedMessages.push(data);
      } else this.#receive(state.room, client, data);
    });
    const disconnect = () => {
      state.disconnected = true;
      if (state.room !== undefined) this.#disconnect(state.room, client);
    };
    client.on("close", disconnect);
    client.on("error", disconnect);
    const room = await this.#getRoom(roomId);
    state.room = room;
    if (this.#closed) {
      this.#closeClient(client);
      return;
    }
    if (!localClient && !this.#sharingEnabled) {
      this.#closeSharingClient(client);
      return;
    }
    if (state.disconnected || client.readyState !== WebSocket.OPEN) return;
    if (this.#connectionLimitReached(localClient)) {
      this.#closeAtClientLimit(client);
      return;
    }
    room.clients.add(client);
    if (localClient) {
      room.localClients.add(client);
      this.#localClientCount += 1;
    }
    this.#connectedClients += 1;
    room.controlledAwarenessIds.set(client, new Set());
    client.binaryType = "arraybuffer";
    for (const data of bufferedMessages) this.#receive(room, client, data);
    sendSyncStepOne(client, room.document);
    const awarenessIds = [...room.awareness.getStates().keys()];
    if (awarenessIds.length > 0) sendAwareness(client, room.awareness, awarenessIds);
  }

  #closeClient(client: WebSocket): void {
    if (this.#notifyClientsOnClose && client.readyState === WebSocket.OPEN) {
      client.close(HOST_STOPPED_CLOSE_CODE, HOST_STOPPED_CLOSE_REASON);
    } else {
      client.terminate();
    }
  }

  #closeSharingClient(client: WebSocket): void {
    if (client.readyState === WebSocket.OPEN) {
      client.close(HOST_STOPPED_CLOSE_CODE, HOST_STOPPED_CLOSE_REASON);
    } else {
      client.terminate();
    }
  }

  #closeAtClientLimit(client: WebSocket): void {
    if (client.readyState === WebSocket.OPEN) {
      client.close(CLIENT_LIMIT_CLOSE_CODE, CLIENT_LIMIT_CLOSE_REASON);
    } else {
      client.terminate();
    }
  }

  #connectionLimitReached(localClient: boolean): boolean {
    return this.#connectedClients >= (localClient ? this.#clientLimit : this.#clientLimit - 1);
  }

  #getRoom(roomId: string): Promise<HostPageRoom> {
    let room = this.#rooms.get(roomId);
    if (room === undefined) {
      room = this.#loadRoom(roomId);
      this.#rooms.set(roomId, room);
      void room.catch(() => this.#rooms.delete(roomId));
    }
    return room;
  }

  async #loadRoom(roomId: string): Promise<HostPageRoom> {
    await this.#runtimeCleanup;
    await this.#watchReady.catch(() => undefined);
    const identity = parsePageRoomId(roomId);
    if (identity === undefined || identity.projectId !== this.#projectId) {
      throw new Error("Unknown synchronization room");
    }
    const hierarchy = await this.#options.hierarchy.load();
    const section = hierarchy.sections.find((candidate) =>
      candidate.manifest.pageIds.includes(identity.pageId),
    );
    if (section === undefined) throw new Error("Synchronized page was not found");
    const canonical = await this.#options.hierarchy.loadPage(section.manifest.id, identity.pageId);
    const runtimeDirectory = join(this.#options.projectRoot, ".squillpad-runtime", "sync");
    await assertRuntimePath(this.#options.projectRoot, runtimeDirectory);
    await mkdir(runtimeDirectory, { recursive: true });
    const fileKey = createHash("sha256").update(roomId).digest("hex");
    const snapshotPath = join(runtimeDirectory, `${fileKey}.snapshot`);
    const updatesPath = join(runtimeDirectory, `${fileKey}.updates`);
    await assertRuntimePath(this.#options.projectRoot, snapshotPath);
    await assertRuntimePath(this.#options.projectRoot, updatesPath);
    const document = await loadRuntimeDocument(snapshotPath, updatesPath, canonical).catch(
      async () => {
        this.#logger.warn("sync.runtime_state_rebuilt", {
          pageId: identity.pageId,
          projectId: identity.projectId,
        });
        await quarantineCorruptState(snapshotPath);
        await quarantineCorruptState(updatesPath);
        return createPageDocument(canonical);
      },
    );
    const content: SynchronizedPageContent = {
      canvas: canonical.canvas,
      markdown: canonical.markdown,
    };
    const room: HostPageRoom = {
      document,
      awareness: new Awareness(document),
      clients: new Set(),
      localClients: new Set(),
      controlledAwarenessIds: new Map(),
      identity,
      sectionId: section.manifest.id,
      snapshotPath,
      updatesPath,
      pendingWrites: Promise.resolve(),
      materializationTimer: undefined,
      runtimeFlushTimer: undefined,
      bufferedRuntimeUpdates: [],
      bufferedRuntimeBytes: 0,
      updatesSinceCompaction: 0,
      dirtyRevision: 0,
      materializedRevision: 0,
      materializedContent: content,
      materializationStatus: "saved",
      materializationError: undefined,
      projectRoot: this.#options.projectRoot,
      canonicalBlocked: false,
    };
    // Persist hydration before incremental updates can refer to its Yjs structures.
    if (this.#sharingEnabled) await compactRoom(room);
    this.#publishRoomStatus(room);
    document.on("update", (update: Uint8Array, origin: unknown) => {
      this.#onDocumentUpdate(room, update, origin);
    });
    room.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const ids = [...added, ...updated, ...removed];
        if (ids.length === 0) return;
        const message = awarenessMessage(room.awareness, ids);
        const clients = this.#sharingEnabled ? room.clients : room.localClients;
        for (const client of clients) if (client !== origin) send(client, message);
      },
    );

    const runtimeContent = materializePageDocument(document);
    if (!samePageContent(runtimeContent, content)) {
      room.dirtyRevision = 1;
      this.#scheduleMaterialization(room, this.#sharingEnabled ? 0 : undefined);
    }
    return room;
  }

  #receive(room: HostPageRoom, client: WebSocket, data: RawData): void {
    if (this.#closed) return;
    if (!this.#sharingEnabled && !room.localClients.has(client)) {
      this.#closeSharingClient(client);
      return;
    }
    try {
      const bytes = rawBytes(data);
      const decoder = decoding.createDecoder(bytes);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.document, client);
        if (encoding.length(encoder) > 1) send(client, encoding.toUint8Array(encoder));
      } else if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        for (const id of awarenessClientIds(update))
          room.controlledAwarenessIds.get(client)?.add(id);
        applyAwarenessUpdate(room.awareness, update, client);
      } else if (messageType === MESSAGE_QUERY_AWARENESS) {
        sendAwareness(client, room.awareness, [...room.awareness.getStates().keys()]);
      } else {
        throw new Error("Unknown message type");
      }
    } catch {
      this.#logger.warn("sync.invalid_message", {
        pageId: room.identity.pageId,
        projectId: this.#projectId,
      });
      client.close(4400, "Invalid synchronization message");
    }
  }

  #onDocumentUpdate(room: HostPageRoom, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    const clients = this.#sharingEnabled ? room.clients : room.localClients;
    for (const client of clients) if (client !== origin) send(client, message);

    if (this.#sharingEnabled) {
      room.bufferedRuntimeUpdates.push(update);
      room.bufferedRuntimeBytes += update.byteLength;
      if (isExternalOrigin(origin)) {
        this.#queueRuntimeFlush(room);
      } else if (
        room.bufferedRuntimeBytes >=
        (this.#options.runtimeFlushSizeBytes ?? RUNTIME_FLUSH_SIZE_BYTES)
      ) {
        this.#queueRuntimeFlush(room);
      } else if (room.runtimeFlushTimer === undefined) {
        room.runtimeFlushTimer = setTimeout(() => {
          room.runtimeFlushTimer = undefined;
          this.#queueRuntimeFlush(room);
        }, this.#options.runtimeFlushDelayMs ?? RUNTIME_FLUSH_DELAY_MS);
      }
    }

    room.dirtyRevision += 1;
    this.#publishRoomStatus(room);
    if (
      !isExternalOrigin(origin) &&
      !this.#canonicalRescanInProgress &&
      !this.#canonicalRescanPending
    ) {
      this.#scheduleMaterialization(room);
    }
  }

  #queueRuntimeFlush(room: HostPageRoom): void {
    const update = takeBufferedRuntimeUpdate(room);
    if (update === undefined) return;
    room.pendingWrites = room.pendingWrites
      .then(() => this.#persistRuntimeUpdate(room, update))
      .catch((error: unknown) => this.#reportRuntimePersistenceError(room, error));
  }

  async #persistRuntimeUpdate(room: HostPageRoom, update: Uint8Array): Promise<void> {
    await appendRuntimeUpdate(room, frameUpdate(update));
    room.updatesSinceCompaction += 1;
    if (room.updatesSinceCompaction < COMPACT_AFTER_UPDATES) return;
    await compactRoom(room);
    room.updatesSinceCompaction = 0;
  }

  #reportRuntimePersistenceError(room: HostPageRoom, error: unknown): void {
    room.materializationError = `Runtime synchronization persistence failed: ${errorMessage(error)}`;
    this.#logger.error("sync.runtime_persistence_failed", {
      error: errorMessage(error),
      pageId: room.identity.pageId,
      projectId: this.#projectId,
    });
    this.#publishRoomStatus(room);
  }

  #scheduleMaterialization(room: HostPageRoom, delay?: number): void {
    if (room.canonicalBlocked || this.#canonicalErrors.size > 0 || this.#closed) return;
    const effectiveDelay = delay ?? this.#defaultMaterializationDelay();
    if (effectiveDelay === undefined) return;
    if (room.materializationTimer !== undefined) {
      if (!this.#sharingEnabled && delay === undefined) return;
      clearTimeout(room.materializationTimer);
    }
    room.materializationStatus = "saving";
    room.materializationError = undefined;
    this.#publishRoomStatus(room);
    room.materializationTimer = setTimeout(() => {
      room.materializationTimer = undefined;
      room.pendingWrites = room.pendingWrites
        .then(() => this.#materialize(room, !this.#sharingEnabled))
        .catch((error: unknown) => {
          room.materializationStatus = "error";
          room.materializationError = errorMessage(error);
          this.#logger.error("sync.canonical_materialization_failed", {
            error: errorMessage(error),
            pageId: room.identity.pageId,
            projectId: this.#projectId,
          });
          this.#publishRoomStatus(room);
        });
    }, effectiveDelay);
  }

  #defaultMaterializationDelay(): number | undefined {
    return this.#sharingEnabled
      ? (this.#options.materializeDelayMs ?? MATERIALIZE_DELAY_MS)
      : this.#autosaveIntervalSeconds * 1000 || undefined;
  }

  #roomIsDirty(room: HostPageRoom): boolean {
    return (
      room.dirtyRevision !== room.materializedRevision || room.materializationStatus !== "saved"
    );
  }

  #disconnect(room: HostPageRoom, client: WebSocket): void {
    if (!room.clients.delete(client)) return;
    if (room.localClients.delete(client)) {
      this.#localClientCount = Math.max(0, this.#localClientCount - 1);
    }
    this.#connectedClients = Math.max(0, this.#connectedClients - 1);
    const ids = [...(room.controlledAwarenessIds.get(client) ?? [])];
    room.controlledAwarenessIds.delete(client);
    if (ids.length > 0) removeAwarenessStates(room.awareness, ids, client);
  }

  #expireProjectPresence(now = Date.now()): void {
    for (const [id, entry] of this.#projectPresence) {
      if (now - entry.lastSeenAt > PROJECT_PRESENCE_STALE_AFTER_MS) {
        this.#projectPresence.delete(id);
      }
    }
  }

  async #materialize(room: HostPageRoom, compactRuntime = false): Promise<void> {
    if (room.canonicalBlocked || this.#canonicalErrors.size > 0) return;
    const revision = room.dirtyRevision;
    const content = materializePageDocument(room.document);
    const runtimeUpdate = takeBufferedRuntimeUpdate(room);
    if (runtimeUpdate !== undefined) await this.#persistRuntimeUpdate(room, runtimeUpdate);
    if (samePageContent(content, room.materializedContent)) {
      room.materializedRevision = revision;
      room.materializationStatus = "saved";
      room.materializationError = undefined;
      if (compactRuntime) await compactRoom(room);
      this.#publishRoomStatus(room);
      return;
    }

    room.materializationStatus = "saving";
    room.materializationError = undefined;
    this.#publishRoomStatus(room);
    const expected = canonicalPageFiles(
      room.sectionId,
      room.identity.pageId,
      content,
      room.materializedContent,
    );
    this.#expectWrites(expected);
    try {
      const materialize =
        this.#options.materializePage ??
        (async (sectionId: string, pageId: string, value: StoredPageContent) => {
          await this.#options.hierarchy.savePageContent(
            sectionId,
            pageId,
            value.canvas,
            value.markdown,
          );
        });
      await materialize(room.sectionId, room.identity.pageId, content);
      this.#completeExpectedWrites(expected, true);
      room.materializedContent = content;
      room.materializedRevision = revision;
      room.materializationStatus = "saved";
      room.materializationError = undefined;
      if (compactRuntime) await compactRoom(room);
      this.#publishRoomStatus(room);
      if (room.dirtyRevision !== revision) {
        this.#scheduleMaterialization(room, this.#sharingEnabled ? 0 : undefined);
      }
    } catch (error) {
      this.#completeExpectedWrites(expected, false);
      room.materializationStatus = "error";
      room.materializationError = `Canonical save failed: ${errorMessage(error)}`;
      this.#logger.error("sync.canonical_materialization_failed", {
        error: errorMessage(error),
        pageId: room.identity.pageId,
        projectId: this.#projectId,
      });
      this.#publishRoomStatus(room);
    }
  }

  async #flushRoom(room: HostPageRoom): Promise<void> {
    if (room.materializationTimer !== undefined) {
      clearTimeout(room.materializationTimer);
      room.materializationTimer = undefined;
    }
    if (room.runtimeFlushTimer !== undefined) {
      clearTimeout(room.runtimeFlushTimer);
      room.runtimeFlushTimer = undefined;
    }
    const flush = room.pendingWrites.then(async () => {
      await this.#materialize(room);
      try {
        await compactRoom(room);
      } catch (error) {
        room.materializationStatus = "error";
        room.materializationError = `Runtime synchronization compaction failed: ${errorMessage(error)}`;
        this.#publishRoomStatus(room);
        throw error;
      }
      if (
        room.materializationError !== undefined ||
        room.canonicalBlocked ||
        this.#canonicalErrors.size > 0
      ) {
        throw new Error(
          room.materializationError ??
            firstError(this.#canonicalErrors) ??
            "Canonical save is blocked",
        );
      }
    });
    room.pendingWrites = flush.catch(() => undefined);
    await flush;
  }

  async #initializeCanonicalWatcher(): Promise<void> {
    try {
      const current = await scanCanonicalFiles(this.#options.projectRoot);
      for (const [path, state] of current) this.#canonicalFiles.set(path, state);
      await this.#refreshWatchers();
    } catch (error) {
      this.#canonicalErrors.set("project", errorMessage(error));
      this.#logger.error("sync.canonical_scan_failed", {
        error: errorMessage(error),
        projectId: this.#projectId,
      });
    }
  }

  async #refreshWatchers(): Promise<void> {
    const directories = new Set<string>();
    await collectWatchDirectories(this.#options.projectRoot, directories);
    for (const [directory, watcher] of this.#watchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      this.#watchers.delete(directory);
    }
    for (const directory of directories) {
      if (this.#watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
          this.#handleFileEvent(directory, filename);
        });
        this.#watchers.set(directory, watcher);
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT"))
          this.#canonicalErrors.set(directory, errorMessage(error));
      }
    }
  }

  #handleFileEvent(directory: string, filename: string | Buffer | null): void {
    if (this.#closed) return;
    const candidate = filename === null ? directory : resolve(directory, filename.toString());
    if (
      !isWithin(this.#options.projectRoot, candidate) ||
      isIgnoredPath(candidate, this.#options.projectRoot)
    ) {
      return;
    }
    this.#pendingFileEvents.add(candidate);
    this.#canonicalRescanPending = true;
    for (const roomPromise of this.#rooms.values()) {
      void roomPromise.then((room) => {
        if (room.materializationTimer !== undefined) {
          clearTimeout(room.materializationTimer);
          room.materializationTimer = undefined;
        }
      });
    }
    if (this.#watchTimer !== undefined) clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(() => {
      this.#watchTimer = undefined;
      void this.#runCanonicalRescan();
    }, this.#options.canonicalRescanDelayMs ?? CANONICAL_RESCAN_DELAY_MS);
  }

  async #runCanonicalRescan(): Promise<void> {
    if (this.#closed || this.#canonicalRescanInProgress) return;
    this.#canonicalRescanInProgress = true;
    const eventPaths = [...this.#pendingFileEvents];
    this.#pendingFileEvents.clear();
    try {
      await Promise.all(
        [...this.#rooms.values()].map(async (roomPromise) => {
          const room = await roomPromise;
          await room.pendingWrites;
        }),
      );
      const current = await scanCanonicalFiles(this.#options.projectRoot);
      await this.#refreshWatchers();
      const changed = changedCanonicalPaths(this.#canonicalFiles, current).filter((path) => {
        const expected = this.#expectedWrites.get(path);
        if (expected === undefined) return true;
        const state = current.get(path) ?? missingFileState();
        return !sameFileState(state, expected.expected) && !sameFileState(state, expected.previous);
      });
      const massChange =
        eventPaths.length > 1 ||
        changed.length > 1 ||
        eventPaths.some((path) => {
          const relativePath = relative(this.#options.projectRoot, path).split(sep).join("/");
          return (
            relativePath === "notebook.json" ||
            relativePath.endsWith("/section.json") ||
            relativePath.endsWith("/page.json")
          );
        });
      await this.#reconcileCanonicalChanges(changed, current, massChange);
      this.#canonicalFiles.clear();
      for (const [path, state] of current) this.#canonicalFiles.set(path, state);
    } catch (error) {
      this.#canonicalErrors.set("project", errorMessage(error));
      this.#logger.error("sync.external_rescan_failed", {
        error: errorMessage(error),
        projectId: this.#projectId,
      });
    } finally {
      this.#canonicalRescanInProgress = false;
      this.#canonicalRescanPending = false;
      if (this.#pendingFileEvents.size > 0) {
        this.#canonicalRescanPending = true;
        this.#watchTimer = setTimeout(() => {
          this.#watchTimer = undefined;
          void this.#runCanonicalRescan();
        }, this.#options.canonicalRescanDelayMs ?? CANONICAL_RESCAN_DELAY_MS);
      } else {
        for (const roomPromise of this.#rooms.values()) {
          void roomPromise.then((room) => {
            if (room.dirtyRevision > room.materializedRevision && !room.canonicalBlocked) {
              this.#scheduleMaterialization(room);
            }
          });
        }
      }
    }
  }

  async #reconcileCanonicalChanges(
    changed: readonly string[],
    _current: CanonicalFileMap,
    massChange: boolean,
  ): Promise<void> {
    if (changed.length === 0) return;
    const hierarchyChanges = changed.some((path) => {
      const relativePath = canonicalRelativePath(path, this.#options.projectRoot);
      return (
        relativePath === "notebook.json" ||
        relativePath.endsWith("/section.json") ||
        relativePath.endsWith("/page.json")
      );
    });
    let hierarchy;
    if (hierarchyChanges || massChange) {
      try {
        hierarchy = await this.#options.hierarchy.load();
        this.#canonicalErrors.delete("project");
        this.#hierarchyRevision += 1;
      } catch (error) {
        this.#canonicalErrors.set(
          "project",
          `External canonical rescan failed: ${errorMessage(error)}`,
        );
        for (const path of changed) this.#markRoomBlocked(path, errorMessage(error));
        return;
      }
    }

    const affectedPages = new Set<string>();
    for (const path of changed) {
      const identity = pageIdentityFromCanonicalPath(path, this.#options.projectRoot);
      if (identity !== undefined) affectedPages.add(identity.pageId);
    }
    for (const pageId of affectedPages) {
      const room = await this.#roomForPage(pageId);
      if (room === undefined) continue;
      try {
        hierarchy ??= await this.#options.hierarchy.load();
        const section = hierarchy.sections.find((candidate) =>
          candidate.manifest.pageIds.includes(pageId),
        );
        if (section === undefined)
          throw new Error(`Page ${pageId} is no longer referenced by the hierarchy`);
        const canonical = await this.#options.hierarchy.loadPage(section.manifest.id, pageId);
        const next: SynchronizedPageContent = {
          canvas: canonical.canvas,
          markdown: canonical.markdown,
        };
        const previous = room.materializedContent;
        if (massChange || !samePageContent(previous, next)) {
          reconcilePageContentById(room.document, previous, next, "external-canonical");
        }
        room.sectionId = section.manifest.id;
        room.materializedContent = next;
        room.canonicalBlocked = false;
        room.materializationError = undefined;
        const projected = materializePageDocument(room.document);
        if (samePageContent(projected, next)) {
          room.materializedRevision = room.dirtyRevision;
          room.materializationStatus = "saved";
        } else {
          room.materializationStatus = "saving";
        }
        this.#clearPageErrors(pageId);
        this.#publishRoomStatus(room);
      } catch (error) {
        const message = `External canonical change was not applied: ${errorMessage(error)}`;
        room.canonicalBlocked = true;
        room.materializationStatus = "error";
        room.materializationError = message;
        this.#publishRoomStatus(room);
        for (const path of changed) {
          const identity = pageIdentityFromCanonicalPath(path, this.#options.projectRoot);
          if (identity?.pageId === pageId) this.#canonicalErrors.set(path, message);
        }
      }
    }
  }

  async #roomForPage(pageId: string): Promise<HostPageRoom | undefined> {
    for (const [roomId, roomPromise] of this.#rooms) {
      const identity = parsePageRoomId(roomId);
      if (identity?.pageId !== pageId) continue;
      return roomPromise;
    }
    return undefined;
  }

  #expectWrites(expected: CanonicalFileMap): void {
    for (const [path, state] of expected) {
      this.#expectedWrites.set(path, {
        expected: state,
        previous: this.#canonicalFiles.get(path) ?? missingFileState(),
      });
    }
  }

  #completeExpectedWrites(expected: CanonicalFileMap, success: boolean): void {
    for (const [path, value] of expected) {
      const expectedWrite = this.#expectedWrites.get(path);
      if (expectedWrite !== undefined && sameFileState(expectedWrite.expected, value)) {
        this.#expectedWrites.delete(path);
      }
      if (!success) continue;
      if (value.exists) this.#canonicalFiles.set(path, value);
      else this.#canonicalFiles.delete(path);
    }
  }

  #markRoomBlocked(path: string, message: string): void {
    const identity = pageIdentityFromCanonicalPath(path, this.#options.projectRoot);
    if (identity === undefined) return;
    void this.#roomForPage(identity.pageId).then((room) => {
      if (room === undefined) return;
      room.canonicalBlocked = true;
      room.materializationStatus = "error";
      room.materializationError = message;
      this.#publishRoomStatus(room);
    });
  }

  #clearPageErrors(pageId: string): void {
    for (const path of this.#canonicalErrors.keys()) {
      if (pageIdentityFromCanonicalPath(path, this.#options.projectRoot)?.pageId === pageId) {
        this.#canonicalErrors.delete(path);
      }
    }
  }

  #publishRoomStatus(room: HostPageRoom): void {
    this.#pageStatuses.set(`${this.#projectId}:${room.identity.pageId}`, {
      status: room.materializationStatus,
      revision: room.dirtyRevision,
      dirty: this.#roomIsDirty(room),
      ...(room.materializationError === undefined ? {} : { error: room.materializationError }),
    });
  }
}

async function loadRuntimeDocument(
  snapshotPath: string,
  updatesPath: string,
  canonical: Parameters<typeof createPageDocument>[0],
): Promise<Y.Doc> {
  const snapshot = await readOptional(snapshotPath);
  const updates = await readOptional(updatesPath);
  if (snapshot === undefined && updates === undefined) return createPageDocument(canonical);
  const document = new Y.Doc();
  if (snapshot !== undefined && snapshot.length > 0) Y.applyUpdate(document, snapshot);
  if (updates !== undefined) {
    for (const update of parseUpdateFrames(updates)) Y.applyUpdate(document, update);
  }
  materializePageDocument(document);
  return document;
}

function synchronizationGenerationPath(projectRoot: string): string {
  return join(projectRoot, ".squillpad-runtime", "synchronization-generation");
}

async function compactRoom(room: HostPageRoom): Promise<void> {
  await assertRuntimePath(room.projectRoot, room.snapshotPath);
  await assertRuntimePath(room.projectRoot, room.updatesPath);
  await atomicWrite(room.snapshotPath, Y.encodeStateAsUpdate(room.document));
  await atomicWrite(room.updatesPath, new Uint8Array());
}

function takeBufferedRuntimeUpdate(room: HostPageRoom): Uint8Array | undefined {
  if (room.runtimeFlushTimer !== undefined) {
    clearTimeout(room.runtimeFlushTimer);
    room.runtimeFlushTimer = undefined;
  }
  if (room.bufferedRuntimeUpdates.length === 0) return undefined;
  const updates = room.bufferedRuntimeUpdates;
  room.bufferedRuntimeUpdates = [];
  room.bufferedRuntimeBytes = 0;
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

async function appendRuntimeUpdate(room: HostPageRoom, frame: Uint8Array): Promise<void> {
  await assertRuntimePath(room.projectRoot, room.updatesPath);
  const handle = await open(
    room.updatesPath,
    fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error("Runtime journals must be regular files without hard links");
    }
    await handle.writeFile(frame);
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await syncDirectory(filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(filePath: string): Promise<void> {
  try {
    const directory = await open(resolve(filePath, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is unavailable on some supported platforms and is best effort for runtime data.
  }
}

async function readOptional(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function quarantineCorruptState(filePath: string): Promise<void> {
  try {
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

function frameUpdate(update: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + update.length);
  new DataView(frame.buffer).setUint32(0, update.length);
  frame.set(update, 4);
  return frame;
}

function parseUpdateFrames(bytes: Uint8Array): readonly Uint8Array[] {
  const result: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("Truncated synchronization update header");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    offset += 4;
    if (length === 0 || offset + length > bytes.length) {
      throw new Error("Truncated synchronization update payload");
    }
    result.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return result;
}

function sendSyncStepOne(client: WebSocket, document: Y.Doc): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, document);
  send(client, encoding.toUint8Array(encoder));
}

function sendAwareness(client: WebSocket, awareness: Awareness, ids: readonly number[]): void {
  if (ids.length > 0) send(client, awarenessMessage(awareness, ids));
}

function awarenessMessage(awareness: Awareness, ids: readonly number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [...ids]));
  return encoding.toUint8Array(encoder);
}

function awarenessClientIds(update: Uint8Array): readonly number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}

function send(client: WebSocket, message: Uint8Array): void {
  if (client.readyState !== WebSocket.OPEN) return;
  if (client.bufferedAmount + message.byteLength > 8 * 1024 * 1024) {
    client.close(4408, "Too much pending outbound data");
    return;
  }
  client.send(message);
}

function rawBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function roomFromUrl(url: string | undefined): string | undefined {
  const match = /^\/sync\/([^/?]+)(?:\?.*)?$/.exec(url ?? "");
  try {
    return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function rejectClientLimitUpgrade(socket: NodeJS.ReadWriteStream): void {
  socket.end(
    "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n",
  );
}

function isExternalOrigin(origin: unknown): boolean {
  return origin === "external-canonical";
}

function samePageContent(left: SynchronizedPageContent, right: SynchronizedPageContent): boolean {
  return (
    JSON.stringify(left.canvas) === JSON.stringify(right.canvas) &&
    JSON.stringify(left.markdown) === JSON.stringify(right.markdown)
  );
}

function canonicalPageFiles(
  sectionId: string,
  pageId: string,
  content: SynchronizedPageContent,
  previous: SynchronizedPageContent,
): CanonicalFileMap {
  const files: CanonicalFileMap = new Map();
  const pageDirectory = `sections/${sectionId}/pages/${pageId}`;
  files.set(
    `${pageDirectory}/canvas.jsonl`,
    presentFileState(serializeCanvasJsonLines(content.canvas)),
  );
  for (const [objectId, source] of Object.entries(content.markdown)) {
    files.set(
      `${pageDirectory}/markdown/${objectId}.md`,
      presentFileState(canonicalMarkdown(source)),
    );
  }
  for (const objectId of Object.keys(previous.markdown)) {
    const path = `${pageDirectory}/markdown/${objectId}.md`;
    if (!files.has(path)) files.set(path, missingFileState());
  }
  return files;
}

function canonicalMarkdown(source: string): string {
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  return withoutBom.replace(/\r\n?/g, "\n");
}

async function scanCanonicalFiles(projectRoot: string): Promise<CanonicalFileMap> {
  const files: CanonicalFileMap = new Map();
  await visit(projectRoot, "");
  return files;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".squillpad-runtime" || entry.name === ".git") continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name).split(sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && CANONICAL_PATH.test(relativePath)) {
        try {
          files.set(
            relativePath,
            presentFileState(UTF8_DECODER.decode(await readFile(absolutePath))),
          );
        } catch (error) {
          files.set(relativePath, { exists: true, readError: errorMessage(error) });
        }
      }
    }
  }
}

async function collectWatchDirectories(root: string, result: Set<string>): Promise<void> {
  result.add(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".squillpad-runtime" || entry.name === ".git" || !entry.isDirectory()) {
      continue;
    }
    await collectWatchDirectories(join(root, entry.name), result);
  }
}

function changedCanonicalPaths(
  previous: CanonicalFileMap,
  current: CanonicalFileMap,
): readonly string[] {
  const paths = new Set([...previous.keys(), ...current.keys()]);
  return [...paths].filter(
    (path) =>
      !sameFileState(
        previous.get(path) ?? missingFileState(),
        current.get(path) ?? missingFileState(),
      ),
  );
}

function presentFileState(contents: string): CanonicalFileState {
  return { exists: true, contents };
}

function missingFileState(): CanonicalFileState {
  return { exists: false };
}

function sameFileState(left: CanonicalFileState, right: CanonicalFileState): boolean {
  return (
    left.exists === right.exists &&
    left.contents === right.contents &&
    left.readError === right.readError
  );
}

function pageIdentityFromCanonicalPath(
  path: string,
  projectRoot: string,
): { sectionId: string; pageId: string } | undefined {
  const relativePath = canonicalRelativePath(path, projectRoot);
  const match = new RegExp(
    `^sections/(${UUID})/pages/(${UUID})/(?:page\\.json|canvas\\.jsonl|markdown/${UUID}\\.md)$`,
  ).exec(relativePath);
  if (match === null) return undefined;
  return { sectionId: match[1] as string, pageId: match[2] as string };
}

function isIgnoredPath(path: string, root: string): boolean {
  const relativePath = relative(root, path).split(sep).join("/");
  return (
    relativePath === ".squillpad-runtime" ||
    relativePath.startsWith(".squillpad-runtime/") ||
    relativePath === ".git" ||
    relativePath.startsWith(".git/")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function canonicalRelativePath(path: string, projectRoot: string): string {
  return isAbsolute(path)
    ? relative(projectRoot, path).split(sep).join("/")
    : path.split(sep).join("/");
}

function firstError(errors: ReadonlyMap<string, string>): string | undefined {
  return errors.values().next().value;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertRuntimePath(root: string, path: string): Promise<void> {
  if (!isWithin(root, path)) throw new Error("Runtime path escaped the project root");
  let current = root;
  const segments = relative(root, path).split(sep);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (
        status.isSymbolicLink() ||
        (status.isFile() && status.nlink !== 1) ||
        (index < segments.length - 1
          ? !status.isDirectory()
          : !status.isDirectory() && !status.isFile())
      ) {
        throw new Error("Runtime synchronization paths must be real files and directories");
      }
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}
