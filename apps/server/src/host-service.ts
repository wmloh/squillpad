import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

import {
  DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  DEFAULT_LAN_SHARING_ENABLED,
  readAutosaveIntervalSeconds,
  readLanSharingDefault,
  type NotebookHierarchy,
  type NotebookManifest,
} from "@squillpad/core-model";
import {
  openProject,
  ProfileSettingsStore,
  ProjectHierarchyService,
  type ProjectSession,
} from "@squillpad/storage";
import { DEFAULT_CLIENT_LIMIT } from "@squillpad/synchronization";

import { createHostServer } from "./app.js";
import { AuthenticationService } from "./authentication.js";
import { HostSynchronizationService } from "./host-synchronization.js";
import { RepositorySynchronizationService } from "./repository-synchronization.js";
import { createAccessToken } from "./security.js";
import type { StructuredLogger } from "./logging.js";

export interface HostConnection {
  readonly url: string;
  readonly qr: string;
}

export interface HostSharing {
  readonly enabled: boolean;
  readonly defaultEnabled?: boolean;
  readonly clientLimit?: number;
  readonly connectedClients?: number;
  readonly clientSlotsUsed?: number;
  readonly connections: readonly HostConnection[];
}

export interface HostServiceOptions {
  readonly projectPath?: string;
  readonly port?: number;
  readonly webRoot?: string;
  readonly logger?: StructuredLogger;
}

export interface HostService {
  readonly origin: string;
  readonly authorizedUrl: string;
  readonly port: number;
  readonly projectPath?: string;
  readonly projectId?: string;
  readonly accessToken?: string;
  readonly sharing: () => HostSharing;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Starts one host server and owns its project and synchronization lifecycles. */
export async function startHostService(options: HostServiceOptions = {}): Promise<HostService> {
  const port = options.port ?? 0;
  assertPort(port);
  const allowedOrigins: string[] = ["http://127.0.0.1:5173", "http://localhost:5173"];

  let session: ProjectSession | undefined;
  let notebook: NotebookManifest | undefined;
  let token: string | undefined;
  let profileSettings: ProfileSettingsStore | undefined;
  let synchronization: HostSynchronizationService | undefined;
  let server: ReturnType<typeof createHostServer> | undefined;
  let sharing: HostSharing = {
    enabled: false,
    connections: [],
  };

  try {
    if (options.projectPath !== undefined) session = await openProject(options.projectPath);
    notebook = session === undefined ? undefined : await session.loadNotebook();
    const projectOpen = session !== undefined && notebook !== undefined;
    profileSettings = projectOpen
      ? await ProfileSettingsStore.open(session!.projectRoot)
      : undefined;
    const defaultSharingEnabled = projectOpen
      ? (readLanSharingDefault(notebook!.settings.metadata) ?? DEFAULT_LAN_SHARING_ENABLED)
      : false;
    token = projectOpen ? createAccessToken() : undefined;
    sharing = projectOpen
      ? {
          enabled: defaultSharingEnabled,
          defaultEnabled: defaultSharingEnabled,
          clientLimit: DEFAULT_CLIENT_LIMIT,
          connectedClients: 0,
          clientSlotsUsed: 1,
          connections: [],
        }
      : {
          enabled: false,
          connections: [],
        };
    const authentication =
      session === undefined || token === undefined
        ? undefined
        : await AuthenticationService.open(session.projectRoot, token, profileSettings);
    const hierarchy = session === undefined ? undefined : new ProjectHierarchyService(session);
    synchronization =
      session === undefined || hierarchy === undefined || notebook === undefined
        ? undefined
        : new HostSynchronizationService({
            hierarchy,
            projectId: notebook.projectId,
            projectRoot: session.projectRoot,
            sharingEnabled: defaultSharingEnabled,
            autosaveIntervalSeconds:
              readAutosaveIntervalSeconds(notebook.settings.metadata) ??
              DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
            ...(options.logger === undefined ? {} : { logger: options.logger }),
          });
    await synchronization?.ready();
    const projectSession = session;
    const repositorySynchronization =
      projectSession === undefined || synchronization === undefined || hierarchy === undefined
        ? undefined
        : new RepositorySynchronizationService({
            projectRoot: projectSession.projectRoot,
            flushCanonical: () => synchronization!.flush(),
            flushProfileSettings: () => profileSettings?.flush() ?? Promise.resolve(),
            cleanupOrphanImageAssets: () => projectSession.cleanupOrphanImageAssets(),
            reloadCanonical: async (projectId) => {
              await synchronization!.reloadCanonicalProject(projectId);
              await profileSettings?.reload();
            },
            beginExclusiveProfileOperation: async () =>
              profileSettings === undefined
                ? () => undefined
                : profileSettings.beginRepositoryOperation(),
            beginExclusiveCanonicalOperation: async () => {
              const release = await synchronization!.beginRepositoryOperation();
              try {
                await hierarchy.settled();
                return release;
              } catch (error) {
                release();
                throw error;
              }
            },
          });

    let closePromise: Promise<void> | undefined;
    const close = (notifyClients = false): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        let failure: unknown;
        try {
          await repositorySynchronization?.settled();
          await synchronization?.close({ notifyClients });
          await profileSettings?.flush();
        } catch (error) {
          failure = error;
        }
        try {
          if (server !== undefined) await closeServer(server);
        } catch (error) {
          failure ??= error;
        }
        try {
          await session?.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) {
          if (failure instanceof Error) throw failure;
          throw new Error("Host close failed with a non-Error value");
        }
      })();
      return closePromise;
    };

    let sharingTransition: Promise<void> = Promise.resolve();
    const makeConnections = async (connectionPort: number): Promise<readonly HostConnection[]> => {
      if (token === undefined) return [];
      const connections = await Promise.all(
        discoverLanAddresses().map(async (host) => {
          const connectionOrigin = `http://${host}:${connectionPort}`;
          if (!allowedOrigins.includes(connectionOrigin)) allowedOrigins.push(connectionOrigin);
          const url = `${connectionOrigin}/#access_token=${token}`;
          return {
            url,
            qr: await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 4 }),
          };
        }),
      );
      return connections;
    };
    const setSharingEnabled = async (enabled: boolean): Promise<void> => {
      const transition = sharingTransition.then(async () => {
        if (!projectOpen) throw new Error("LAN sharing requires an open project");
        if (sharing.enabled === enabled) return;
        if (!enabled) {
          sharing = { ...sharing, enabled: false, connections: [] };
          await synchronization?.setSharingEnabled(false);
          return;
        }
        const address = server?.address();
        if (address === undefined || address === null || typeof address === "string") {
          throw new Error("The host is not listening");
        }
        const connections = await makeConnections(address.port);
        await synchronization?.setSharingEnabled(true);
        sharing = { ...sharing, enabled: true, connections };
      });
      sharingTransition = transition.catch(() => undefined);
      await transition;
    };
    const setClientLimit = async (limit: number): Promise<void> => {
      const transition = sharingTransition.then(async () => {
        if (!projectOpen || synchronization === undefined) {
          throw new Error("Client limits require an open project");
        }
        synchronization.setClientLimit(limit);
        sharing = { ...sharing, clientLimit: limit };
      });
      sharingTransition = transition.catch(() => undefined);
      await transition;
    };
    const onHierarchyMutation = (action: string, next: NotebookManifest | undefined): void => {
      if (next === undefined) return;
      if (action === "update-lan-sharing-default") {
        sharing = {
          ...sharing,
          defaultEnabled:
            readLanSharingDefault(next.settings.metadata) ?? DEFAULT_LAN_SHARING_ENABLED,
        };
      }
      if (action === "update-autosave-frequency") {
        synchronization?.setAutosaveIntervalSeconds(
          readAutosaveIntervalSeconds(next.settings.metadata) ?? DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
        );
      }
    };
    const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
    const currentSharing = (): HostSharing => {
      const synchronizationStatus = synchronization?.status();
      return {
        ...sharing,
        ...(synchronizationStatus === undefined
          ? {}
          : {
              clientLimit: synchronizationStatus.clientLimit,
              connectedClients: synchronizationStatus.connectedClients,
              clientSlotsUsed: synchronizationStatus.clientSlotsUsed,
            }),
      };
    };
    server = createHostServer({
      ...(token === undefined ? {} : { token }),
      ...(authentication === undefined
        ? {}
        : {
            authentication,
            authenticate: (credential) => authentication.acceptsCredential(credential),
          }),
      allowedOrigins,
      sharing: currentSharing,
      ...(projectOpen
        ? {
            sharingEnabled: () => sharing.enabled,
            setSharingEnabled,
            setClientLimit,
            onHierarchyMutation: (action: string, next: NotebookHierarchy) => {
              onHierarchyMutation(action, next.notebook);
            },
          }
        : {}),
      ...(hierarchy === undefined ? {} : { hierarchy }),
      ...(projectSession === undefined
        ? {}
        : {
            cleanupRuntimeCache: async () => {
              await synchronization?.flush();
              return synchronization === undefined
                ? projectSession.cleanupRuntimeCache()
                : synchronization.cleanupRuntimeCache();
            },
            storageDiagnostics: () => projectSession.storageDiagnostics(),
          }),
      ...(synchronization === undefined ? {} : { synchronization }),
      ...(repositorySynchronization === undefined ? {} : { repositorySynchronization }),
      stopHosting: () => close(true),
      webRoot: options.webRoot ?? defaultWebRoot,
    });
    await listen(server, port, projectOpen ? "0.0.0.0" : "127.0.0.1");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing host address");
    const actualPort = address.port;
    const origin = `http://127.0.0.1:${actualPort}`;
    if (projectOpen && sharing.enabled) {
      sharing = { ...sharing, connections: await makeConnections(actualPort) };
    }

    const flush = async (): Promise<void> => {
      await repositorySynchronization?.settled();
      await synchronization?.flush();
      await profileSettings?.flush();
    };

    return {
      origin,
      authorizedUrl: token === undefined ? origin : `${origin}/#access_token=${token}`,
      port: actualPort,
      ...(session === undefined ? {} : { projectPath: session.projectRoot }),
      ...(notebook === undefined ? {} : { projectId: notebook.projectId }),
      ...(token === undefined ? {} : { accessToken: token }),
      sharing: currentSharing,
      flush,
      close,
    };
  } catch (error) {
    await synchronization?.close().catch(() => undefined);
    if (server !== undefined) await closeServer(server).catch(() => undefined);
    await session?.close().catch(() => undefined);
    throw error;
  }
}

function discoverLanAddresses(): readonly string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === "IPv4" && !entry.internal)
          .map((entry) => entry.address),
      ),
    ),
  ];
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid host port");
  }
}

async function listen(
  server: ReturnType<typeof createHostServer>,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function closeServer(server: ReturnType<typeof createHostServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
    server.closeAllConnections();
  });
}
