import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  CORE_MODEL_VERSION,
  isAutosaveIntervalSeconds,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  isLaserPointerSettings,
  isMarkdownBoxAppearance,
  isMarkdownColorStyleLibrary,
  isProfileDrawingPalettes,
  isProfileSettings,
  isProfileSettingsExport,
  isSectionColor,
  isSynchronizedInkColors,
  type CanvasRecord,
  type AutosaveIntervalSeconds,
  type LaserPointerSettings,
  type MarkdownBoxAppearanceInput,
  type MarkdownColorStyleLibrary,
  type NotebookHierarchy,
  type ProfileDrawingPalettes,
  type ProfileSettings,
  type ProfileSettingsExport,
  type SynchronizedInkColors,
} from "@squillpad/core-model";
import {
  HierarchyError,
  type ProjectHierarchyService,
  type ProjectStorageDiagnostics,
  type RuntimeCacheCleanupResult,
} from "@squillpad/storage";
import { isClientLimit, MAX_CLIENT_LIMIT, MIN_CLIENT_LIMIT } from "@squillpad/synchronization";

import type {
  HostSynchronizationService,
  HostSynchronizationStatus,
} from "./host-synchronization.js";
import type {
  RepositoryMergePageOverride,
  RepositorySynchronizationService,
} from "./repository-synchronization.js";

import {
  AuthenticationError,
  expiredSessionCookieHeader,
  isCanvasToolbarHeight,
  sessionCookieHeader,
  type AuthenticationService,
} from "./authentication.js";
import { createRequestGuard, isLoopbackAddress, type HostSecurityOptions } from "./security.js";

const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_ASSET_BYTES = 25 * 1024 * 1024;
const PRESENCE_CLIENT_ID_HEADER = "x-squillpad-presence-id";
const PRESENCE_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface HostServerOptions extends HostSecurityOptions {
  readonly cleanupRuntimeCache?: () => Promise<RuntimeCacheCleanupResult>;
  readonly authentication?: AuthenticationService;
  readonly sharing?: () => unknown;
  readonly setSharingEnabled?: (enabled: boolean) => Promise<void>;
  readonly setClientLimit?: (limit: number) => Promise<void>;
  readonly onHierarchyMutation?: (
    action: string,
    hierarchy: NotebookHierarchy,
  ) => Promise<void> | void;
  readonly stopHosting?: () => Promise<void>;
  readonly hierarchy?: ProjectHierarchyService;
  readonly storageDiagnostics?: () => Promise<ProjectStorageDiagnostics>;
  readonly synchronization?: HostSynchronizationService;
  readonly repositorySynchronization?: RepositorySynchronizationService;
  readonly webRoot?: string;
}

export function createHostServer(options: HostServerOptions = {}): Server {
  const guard = createRequestGuard({
    ...options,
    ...(options.authentication === undefined
      ? {}
      : {
          authenticate: (
            _credential: string | undefined,
            request: IncomingMessage,
            websocket: boolean,
          ) => options.authentication!.acceptsRequest(request, websocket),
        }),
  });
  const loginAttempts = new Map<string, readonly number[]>();
  const server = createServer((request, response) => {
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && options.allowedOrigins?.includes(requestOrigin)) {
      response.setHeader("access-control-allow-origin", requestOrigin);
      response.setHeader("vary", "origin");
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    const rejection = guard(request);
    if (rejection !== undefined) {
      sendJson(response, rejection, { error: "Request denied" });
      return;
    }
    if (
      options.repositorySynchronization?.mutationActive === true &&
      (request.url === "/api/auth/preferences" || request.url?.startsWith("/api/profile/"))
    ) {
      sendJson(response, 409, {
        error: "Repository snapshot operation in progress; retry shortly",
      });
      return;
    }
    if (request.url?.startsWith("/api/auth/")) {
      void handleAuthenticationRequest(request, response, options.authentication, loginAttempts);
      return;
    }
    if (request.url?.startsWith("/api/profile/")) {
      void handleProfileSettingsRequest(request, response, options.authentication);
      return;
    }
    if (request.url === "/api/host/stop") {
      if (options.authentication !== undefined && !options.authentication.isHostRequest(request)) {
        sendJson(response, 403, {
          error: "Stopping the host requires the current host access token",
        });
        return;
      }
      void handleStopHostingRequest(request, response, options.stopHosting);
      return;
    }
    if (request.url === "/api/presence") {
      handlePresenceRequest(request, response, options);
      return;
    }
    if (request.method === "GET" && request.url === "/api/sharing") {
      const authorizationError = sharingAuthorizationError(options.authentication, request);
      if (authorizationError !== undefined) {
        sendJson(response, authorizationError.status, { error: authorizationError.message });
        return;
      }
      sendJson(response, 200, options.sharing?.() ?? { enabled: false });
      return;
    }
    if (request.url === "/api/sharing") {
      const authorizationError = sharingAuthorizationError(options.authentication, request);
      if (authorizationError !== undefined) {
        sendJson(response, authorizationError.status, { error: authorizationError.message });
        return;
      }
      void handleSharingRequest(
        request,
        response,
        options.setSharingEnabled,
        options.setClientLimit,
        options.sharing,
      );
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { coreModelVersion: CORE_MODEL_VERSION, status: "ok" });
      return;
    }

    if (request.url?.startsWith("/api/repository-sync")) {
      if (options.authentication !== undefined && !options.authentication.isHostRequest(request)) {
        sendJson(response, 403, {
          error: "Repository synchronization is available only on the host",
        });
        return;
      }
      void handleRepositorySynchronization(request, response, options.repositorySynchronization);
      return;
    }

    if (request.method === "GET" && request.url === "/api/sync/status") {
      const status = options.synchronization?.status();
      if (status === undefined) {
        sendJson(response, 200, { activeRooms: 0, connectedClients: 0 });
        return;
      }
      sendJson(
        response,
        200,
        sharingAuthorizationError(options.authentication, request) === undefined
          ? status
          : clientSynchronizationStatus(status),
      );
      return;
    }
    if (request.url === "/api/sync/save") {
      if (options.authentication !== undefined) {
        const authorizationError = localHostAuthorizationError(options.authentication, request);
        if (authorizationError !== undefined) {
          sendJson(response, authorizationError.status, { error: authorizationError.message });
          return;
        }
      }
      void handleManualSaveRequest(request, response, options.synchronization);
      return;
    }

    if (request.url === "/api/storage/diagnostics") {
      if (options.authentication !== undefined && !options.authentication.isHostRequest(request)) {
        sendJson(response, 403, {
          error: "Storage diagnostics are available only on the host",
        });
        return;
      }
      void handleStorageDiagnostics(request, response, options.storageDiagnostics);
      return;
    }

    if (request.url === "/api/storage/runtime-cache/cleanup") {
      if (options.authentication !== undefined && !options.authentication.isHostRequest(request)) {
        sendJson(response, 403, {
          error: "Runtime cache cleanup is available only on the host",
        });
        return;
      }
      void handleRuntimeCacheCleanup(request, response, options.cleanupRuntimeCache);
      return;
    }

    if (request.url?.startsWith("/api/hierarchy")) {
      if (options.repositorySynchronization?.mutationActive === true) {
        sendJson(response, 409, {
          error: "Repository snapshot operation in progress; retry shortly",
        });
        return;
      }
      void handleHierarchyRequest(
        request,
        response,
        options.hierarchy,
        options.authentication,
        options.onHierarchyMutation,
      );
      return;
    }

    if (request.url?.startsWith("/api/pages/")) {
      if (options.repositorySynchronization?.mutationActive === true) {
        sendJson(response, 409, {
          error: "Repository snapshot operation in progress; retry shortly",
        });
        return;
      }
      void handlePageRequest(request, response, options.hierarchy);
      return;
    }

    if (options.webRoot !== undefined && (request.method === "GET" || request.method === "HEAD")) {
      void serveWebApplication(request, response, options.webRoot);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });
  options.synchronization?.attach(server, guard, options.authentication);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

function handlePresenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HostServerOptions,
): void {
  const synchronization = options.synchronization;
  if (synchronization === undefined) {
    sendJson(response, 200, { participants: [] });
    return;
  }
  const clientId = presenceClientId(request);
  if (request.method === "GET") {
    const username = options.authentication?.status(request).username;
    sendJson(response, 200, {
      participants:
        username === undefined || clientId === undefined
          ? synchronization.listProjectPresence()
          : synchronization.updateProjectPresence(clientId, username, observedIpAddress(request)),
    });
    return;
  }
  if (request.method === "POST") {
    if (clientId === undefined) {
      sendJson(response, 400, { error: "A valid presence client ID is required" });
      return;
    }
    sendJson(response, 200, { participants: synchronization.removeProjectPresence(clientId) });
    return;
  }
  sendJson(response, 405, { error: "Method not allowed" });
}

function presenceClientId(request: IncomingMessage): string | undefined {
  const value = request.headers[PRESENCE_CLIENT_ID_HEADER];
  if (typeof value !== "string" || !PRESENCE_CLIENT_ID_PATTERN.test(value)) return undefined;
  return value;
}

function observedIpAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress?.trim();
  if (address === undefined || address.length === 0) return "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

async function handleSharingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  setSharingEnabled: ((enabled: boolean) => Promise<void>) | undefined,
  setClientLimit: ((limit: number) => Promise<void>) | undefined,
  sharing: (() => unknown) | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const body = await readJsonObject(request, 16 * 1024);
    const enabled = body.enabled;
    const clientLimit = body.clientLimit;
    if (enabled === undefined && clientLimit === undefined) {
      throw new Error("enabled or clientLimit must be provided");
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    const parsedClientLimit =
      clientLimit === undefined ? undefined : requiredClientLimit(clientLimit);
    if (enabled !== undefined && setSharingEnabled === undefined) {
      sendJson(response, 503, { error: "LAN sharing is unavailable" });
      return;
    }
    if (parsedClientLimit !== undefined && setClientLimit === undefined) {
      sendJson(response, 503, { error: "The client limit is unavailable" });
      return;
    }
    if (parsedClientLimit !== undefined) await setClientLimit!(parsedClientLimit);
    if (enabled !== undefined) await setSharingEnabled!(enabled);
    const current = sharing?.();
    sendJson(
      response,
      200,
      current ?? {
        ...(enabled === undefined ? {} : { enabled }),
        ...(parsedClientLimit === undefined ? {} : { clientLimit: parsedClientLimit }),
      },
    );
  } catch (error) {
    sendJson(response, 400, { error: errorMessage(error) });
  }
}

async function handleManualSaveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  synchronization: HostSynchronizationService | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (synchronization === undefined) {
    sendJson(response, 503, { error: "No project is open" });
    return;
  }
  try {
    const body = await readJsonObject(request, 16 * 1024);
    await synchronization.flushPage(requiredString(body, "pageId"));
    sendJson(response, 200, { saved: true });
  } catch (error) {
    sendJson(response, 400, { error: errorMessage(error) });
  }
}

function handleStopHostingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  stopHosting: (() => Promise<void>) | undefined,
): void {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (stopHosting === undefined) {
    sendJson(response, 503, { error: "Host shutdown is unavailable" });
    return;
  }
  response.setHeader("connection", "close");
  response.once("finish", () => {
    void stopHosting().catch(() => undefined);
  });
  sendJson(response, 202, { stopping: true });
}

async function handleRepositorySynchronization(
  request: IncomingMessage,
  response: ServerResponse,
  synchronization: RepositorySynchronizationService | undefined,
): Promise<void> {
  if (synchronization === undefined) {
    sendJson(response, 503, {
      error: "Open a project on this host before configuring GitHub sync",
    });
    return;
  }
  try {
    if (request.method === "GET" && request.url === "/api/repository-sync/status") {
      sendJson(response, 200, await synchronization.status());
      return;
    }
    if (request.method === "GET" && request.url === "/api/repository-sync/check") {
      sendJson(response, 200, await synchronization.check());
      return;
    }
    if (request.method === "GET" && request.url === "/api/repository-sync/comparison") {
      const status = await synchronization.status();
      sendJson(
        response,
        200,
        status.configured
          ? { configured: true, ...(await synchronization.comparison()) }
          : { configured: false },
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/configure") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.configure(
          requiredString(body, "url"),
          optionalString(body, "note"),
          optionalString(body, "confirmation"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/run") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.synchronize(
          optionalString(body, "note"),
          optionalString(body, "confirmation"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/apply-remote") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.applyRemoteSnapshot(
          requiredString(body, "localCommit"),
          requiredString(body, "remoteCommit"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/merge/preview") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.mergePreview(
          requiredString(body, "localCommit"),
          requiredString(body, "remoteCommit"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/merge/page") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.mergeCandidatePage(
          requiredString(body, "candidateId"),
          requiredString(body, "sectionId"),
          requiredString(body, "pageId"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/merge/apply") {
      const body = await readJsonObject(request);
      sendJson(
        response,
        200,
        await synchronization.applyMergeCandidate(
          requiredString(body, "candidateId"),
          requiredString(body, "localCommit"),
          requiredString(body, "remoteCommit"),
          mergePageOverrides(body),
          requiredStringArray(body, "resolvedConflictPaths"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/resolve") {
      const body = await readJsonObject(request, 64 * 1024);
      const choice = requiredString(body, "choice");
      if (choice !== "local" && choice !== "remote") {
        throw new Error("choice must be local or remote");
      }
      sendJson(
        response,
        200,
        await synchronization.resolveConflict(
          choice,
          requiredString(body, "localCommit"),
          requiredString(body, "remoteCommit"),
        ),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/repository-sync/history") {
      sendJson(response, 200, { commits: await synchronization.history() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/history/snapshot") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.historicalSnapshot(
          requiredString(body, "commit"),
          optionalString(body, "compareTo"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/history/page") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.historicalPage(
          requiredString(body, "commit"),
          requiredString(body, "sectionId"),
          requiredString(body, "pageId"),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/repository-sync/history/restore") {
      const body = await readJsonObject(request, 64 * 1024);
      sendJson(
        response,
        200,
        await synchronization.restore(
          requiredString(body, "commit"),
          requiredString(body, "head"),
          optionalString(body, "confirmation"),
        ),
      );
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: errorMessage(error) });
  }
}

async function handleAuthenticationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authentication: AuthenticationService | undefined,
  loginAttempts: Map<string, readonly number[]>,
): Promise<void> {
  if (authentication === undefined) {
    sendJson(response, 503, { error: "No project is open" });
    return;
  }
  try {
    if (request.method === "GET" && request.url === "/api/auth/status") {
      sendJson(response, 200, authentication.status(request));
      return;
    }
    if (request.method === "POST" && request.url === "/api/auth/login") {
      const body = await readJsonObject(request, 16 * 1024);
      const username = requiredString(body, "username");
      const attemptKey = request.socket.remoteAddress ?? "unknown";
      enforceLoginRateLimit(loginAttempts, attemptKey);
      recordLoginFailure(loginAttempts, attemptKey);
      const sessionToken = await authentication.login(username, requiredString(body, "password"));
      loginAttempts.delete(attemptKey);
      response.setHeader("set-cookie", sessionCookieHeader(sessionToken, requestIsSecure(request)));
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/auth/register") {
      if (!authentication.canRegister(request)) {
        throw new AuthenticationError(
          403,
          "A current invitation or local host access token is required",
        );
      }
      const body = await readJsonObject(request, 16 * 1024);
      const sessionToken = await authentication.register(
        requiredString(body, "username"),
        requiredString(body, "password"),
      );
      response.setHeader("set-cookie", sessionCookieHeader(sessionToken, requestIsSecure(request)));
      sendJson(response, 201, { authenticated: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/auth/logout") {
      await authentication.logout(request);
      response.setHeader("set-cookie", expiredSessionCookieHeader());
      sendJson(response, 200, { loggedOut: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/auth/preferences") {
      const body = await readJsonObject(request, 16 * 1024);
      const toolbarHeight = body.toolbarHeight;
      const palmRejection = body.palmRejection;
      const drawingPalettes = body.drawingPalettes;
      if (toolbarHeight !== undefined) {
        if (!isCanvasToolbarHeight(toolbarHeight)) {
          throw new Error("toolbarHeight must be an integer between 24 and 120 pixels");
        }
        await authentication.updateToolbarHeight(request, toolbarHeight);
      }
      if (palmRejection !== undefined) {
        if (typeof palmRejection !== "boolean") {
          throw new Error("palmRejection must be a boolean");
        }
        await authentication.updatePalmRejection(request, palmRejection);
      }
      if (drawingPalettes !== undefined) {
        await authentication.updateDrawingPalettes(
          request,
          requiredProfileDrawingPalettes(drawingPalettes),
        );
      }
      if (
        toolbarHeight === undefined &&
        palmRejection === undefined &&
        drawingPalettes === undefined
      ) {
        throw new Error("At least one profile preference is required");
      }
      sendJson(response, 200, {
        ...(toolbarHeight === undefined ? {} : { toolbarHeight }),
        ...(palmRejection === undefined ? {} : { palmRejection }),
        ...(drawingPalettes === undefined ? {} : { drawingPalettes }),
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/auth/accounts") {
      requireHostAuthorization(authentication, request);
      sendJson(response, 200, { accounts: authentication.listAccounts() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/auth/reset-password") {
      requireHostAuthorization(authentication, request);
      const body = await readJsonObject(request, 16 * 1024);
      await authentication.resetPassword(
        requiredString(body, "username"),
        requiredString(body, "password"),
      );
      sendJson(response, 200, { reset: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/auth/remove-account") {
      requireHostAuthorization(authentication, request);
      const body = await readJsonObject(request, 16 * 1024);
      await authentication.removeAccount(requiredString(body, "username"));
      sendJson(response, 200, { removed: true });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error instanceof AuthenticationError ? error.status : 400, {
      error: errorMessage(error),
    });
  }
}

async function handleProfileSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authentication: AuthenticationService | undefined,
): Promise<void> {
  if (authentication === undefined) {
    sendJson(response, 503, { error: "No project is open" });
    return;
  }
  try {
    if (request.method === "GET" && request.url === "/api/profile/settings") {
      sendJson(response, 200, { settings: authentication.profileSettings(request) });
      return;
    }
    if (request.method === "GET" && request.url === "/api/profile/settings/export") {
      sendJson(response, 200, authentication.profileSettingsExport(request));
      return;
    }
    if (request.method === "GET" && request.url === "/api/profile/settings/all") {
      requireHostAuthorization(authentication, request);
      sendJson(response, 200, { profiles: authentication.listProfileSettings() });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/profile/settings") {
      const body = await readJsonObject(request, 256 * 1024);
      sendJson(response, 200, {
        settings: await authentication.saveProfileSettings(request, requiredProfileSettings(body)),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/profile/settings/import") {
      const body = await readJsonObject(request, 256 * 1024);
      const exported = requiredProfileSettingsExport(body);
      sendJson(response, 200, {
        settings: await authentication.mergeProfileSettings(request, exported.settings),
      });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, profileSettingsErrorStatus(error), {
      error: errorMessage(error),
    });
  }
}

function profileSettingsErrorStatus(error: unknown): number {
  if (error instanceof AuthenticationError) return error.status;
  return errorMessage(error).includes("Repository snapshot operation") ? 409 : 400;
}

function requestIsSecure(request: IncomingMessage): boolean {
  return (
    ("encrypted" in request.socket && request.socket.encrypted === true) ||
    request.headers.origin?.startsWith("https://") === true
  );
}

function requireHostAuthorization(
  authentication: AuthenticationService,
  request: IncomingMessage,
): void {
  if (!authentication.isHostRequest(request)) {
    throw new AuthenticationError(403, "The current host access token is required");
  }
}

function requireLocalHostAuthorization(
  authentication: AuthenticationService,
  request: IncomingMessage,
): void {
  const error = localHostAuthorizationError(authentication, request);
  if (error !== undefined) throw error;
}

function requireSharingAuthorization(
  authentication: AuthenticationService | undefined,
  request: IncomingMessage,
): void {
  const error = sharingAuthorizationError(authentication, request);
  if (error !== undefined) throw error;
}

function sharingAuthorizationError(
  authentication: AuthenticationService | undefined,
  request: IncomingMessage,
): AuthenticationError | undefined {
  if (authentication !== undefined) return localHostAuthorizationError(authentication, request);
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return new AuthenticationError(403, "LAN sharing controls require a local host connection");
  }
  return undefined;
}

function localHostAuthorizationError(
  authentication: AuthenticationService,
  request: IncomingMessage,
): AuthenticationError | undefined {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return new AuthenticationError(403, "This host control requires a local host connection");
  }
  if (!authentication.isHostRequest(request)) {
    return new AuthenticationError(403, "The current host access token is required");
  }
  return undefined;
}

function clientSynchronizationStatus(
  status: HostSynchronizationStatus,
): Omit<
  HostSynchronizationStatus,
  "activeRooms" | "connectedClients" | "clientLimit" | "clientSlotsUsed"
> {
  const {
    activeRooms: _activeRooms,
    connectedClients: _connectedClients,
    clientLimit: _clientLimit,
    clientSlotsUsed: _clientSlotsUsed,
    ...clientStatus
  } = status;
  return clientStatus;
}

function enforceLoginRateLimit(attempts: Map<string, readonly number[]>, key: string): void {
  const cutoff = Date.now() - 60_000;
  const recent = (attempts.get(key) ?? []).filter((timestamp) => timestamp >= cutoff);
  attempts.set(key, recent);
  if (recent.length >= 5) {
    throw new AuthenticationError(429, "Too many login attempts; wait one minute and try again");
  }
}

function recordLoginFailure(attempts: Map<string, readonly number[]>, key: string): void {
  attempts.set(key, [...(attempts.get(key) ?? []), Date.now()]);
}

async function handleStorageDiagnostics(
  request: IncomingMessage,
  response: ServerResponse,
  diagnostics: (() => Promise<ProjectStorageDiagnostics>) | undefined,
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (diagnostics === undefined) {
    sendJson(response, 503, { error: "No project is open" });
    return;
  }
  try {
    sendJson(response, 200, await diagnostics());
  } catch (error) {
    sendJson(response, 500, { error: errorMessage(error) });
  }
}

async function handleRuntimeCacheCleanup(
  request: IncomingMessage,
  response: ServerResponse,
  cleanup: (() => Promise<RuntimeCacheCleanupResult>) | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (cleanup === undefined) {
    sendJson(response, 503, { error: "No project is open" });
    return;
  }
  try {
    sendJson(response, 200, await cleanup());
  } catch (error) {
    sendJson(response, 500, { error: errorMessage(error) });
  }
}

async function serveWebApplication(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
): Promise<void> {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://host").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    let filePath = safeWebPath(webRoot, relativePath);
    try {
      if (!(await stat(filePath)).isFile()) throw new Error("Not a file");
    } catch {
      if (extname(relativePath) !== "") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      filePath = safeWebPath(webRoot, "index.html");
    }
    const realRoot = await realpath(webRoot);
    const realFile = await realpath(filePath);
    if (!realFile.startsWith(`${realRoot}${sep}`)) throw new Error("Invalid web asset");
    const contents = await readFile(realFile);
    response.writeHead(200, {
      "content-length": contents.length,
      "content-type": contentType(filePath),
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function safeWebPath(webRoot: string, relativePath: string): string {
  const root = resolve(webRoot);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Web asset path escapes the configured root");
  }
  return candidate;
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function handlePageRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hierarchy: ProjectHierarchyService | undefined,
): Promise<void> {
  if (hierarchy === undefined) {
    sendJson(response, 503, {
      error: "No project is open. Set SQUILLPAD_PROJECT to an existing project directory.",
    });
    return;
  }

  try {
    const assetMatch =
      /^\/api\/pages\/([0-9a-f-]+)\/([0-9a-f-]+)\/assets(?:\/([0-9a-f]{64}\.(?:png|jpe?g|gif|webp)))?$/.exec(
        request.url ?? "",
      );
    if (assetMatch !== null) {
      const sectionId = assetMatch[1] as string;
      const pageId = assetMatch[2] as string;
      assertId(sectionId);
      assertId(pageId);
      const filename = assetMatch[3];
      if (request.method === "PUT" && filename === undefined) {
        const bytes = await readRequestBytes(request, MAX_IMAGE_ASSET_BYTES);
        sendJson(response, 201, {
          asset: await hierarchy.saveImageAsset(sectionId, pageId, bytes),
        });
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && filename !== undefined) {
        const bytes = await hierarchy.loadImageAsset(sectionId, pageId, `assets/${filename}`);
        response.writeHead(200, {
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": bytes.byteLength,
          "content-type": imageContentType(filename),
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const match = /^\/api\/pages\/([0-9a-f-]+)\/([0-9a-f-]+)$/.exec(request.url ?? "");
    if (match === null) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const sectionId = match[1] as string;
    const pageId = match[2] as string;
    assertId(sectionId);
    assertId(pageId);
    if (request.method === "GET") {
      sendJson(response, 200, await hierarchy.loadPage(sectionId, pageId));
      return;
    }
    if (request.method === "PUT") {
      const body = await readJsonObject(request);
      const canvas = requiredArray(body, "canvas") as unknown as readonly CanvasRecord[];
      const markdown = requiredStringRecord(body, "markdown");
      sendJson(response, 200, await hierarchy.savePageContent(sectionId, pageId, canvas, markdown));
      return;
    }
    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error instanceof HierarchyError && error.code === "not-found" ? 404 : 400;
    sendJson(response, status, { error: errorMessage(error) });
  }
}

async function readRequestBytes(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumBytes) throw new Error("Image asset exceeds the 25 MiB limit");
    chunks.push(bytes);
  }
  if (length === 0) throw new Error("Image asset is empty");
  return new Uint8Array(Buffer.concat(chunks));
}

function imageContentType(filename: string): string {
  if (filename.endsWith(".png")) return "image/png";
  if (/\.jpe?g$/.test(filename)) return "image/jpeg";
  if (filename.endsWith(".gif")) return "image/gif";
  return "image/webp";
}

async function handleHierarchyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hierarchy: ProjectHierarchyService | undefined,
  authentication: AuthenticationService | undefined,
  onHierarchyMutation:
    | ((action: string, hierarchy: NotebookHierarchy) => Promise<void> | void)
    | undefined,
): Promise<void> {
  if (hierarchy === undefined) {
    sendJson(response, 503, {
      error: "No project is open. Set SQUILLPAD_PROJECT to an existing project directory.",
    });
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/api/hierarchy") {
      sendJson(response, 200, await hierarchy.load());
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/hierarchy/commands") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const body = await readJsonObject(request);
    const action = requiredString(body, "action");
    if (action === "update-lan-sharing-default") {
      requireSharingAuthorization(authentication, request);
    } else if (action === "update-autosave-frequency" && authentication !== undefined) {
      requireLocalHostAuthorization(authentication, request);
    }
    const result = await executeHierarchyCommand(hierarchy, action, body);
    await onHierarchyMutation?.(action, result);
    sendJson(response, 200, result);
  } catch (error) {
    const status =
      error instanceof AuthenticationError
        ? error.status
        : error instanceof HierarchyError && error.code === "not-found"
          ? 404
          : 400;
    sendJson(response, status, { error: errorMessage(error) });
  }
}

async function executeHierarchyCommand(
  hierarchy: ProjectHierarchyService,
  action: string,
  body: Record<string, unknown>,
) {
  switch (action) {
    case "create-section":
      return hierarchy.createSection(
        optionalString(body, "title") ?? "Untitled Section",
        optionalInteger(body, "targetIndex"),
      );
    case "duplicate-section":
      return hierarchy.duplicateSection(
        requiredString(body, "sourceSectionId"),
        optionalInteger(body, "targetIndex"),
      );
    case "rename-section":
      return hierarchy.renameSection(
        requiredString(body, "sectionId"),
        requiredString(body, "title"),
      );
    case "update-section-color":
      return hierarchy.updateSectionColor(
        requiredString(body, "sectionId"),
        optionalSectionColor(body),
      );
    case "rename-project":
      return hierarchy.renameProject(requiredString(body, "title"));
    case "reorder-sections":
      return hierarchy.reorderSections(requiredStringArray(body, "sectionIds"));
    case "delete-section":
      return hierarchy.deleteSection(requiredString(body, "sectionId"), body.confirmed === true);
    case "create-page":
      return hierarchy.createPage(
        requiredString(body, "sectionId"),
        optionalString(body, "title") ?? "Untitled Page",
        optionalInteger(body, "targetIndex"),
      );
    case "duplicate-page":
      return hierarchy.duplicatePage(
        requiredString(body, "sourceSectionId"),
        requiredString(body, "sourcePageId"),
        requiredString(body, "targetSectionId"),
        optionalInteger(body, "targetIndex"),
      );
    case "rename-page":
      return hierarchy.renamePage(
        requiredString(body, "sectionId"),
        requiredString(body, "pageId"),
        requiredString(body, "title"),
      );
    case "reorder-pages":
      return hierarchy.reorderPages(
        requiredString(body, "sectionId"),
        requiredStringArray(body, "pageIds"),
      );
    case "move-page":
      return hierarchy.movePage(
        requiredString(body, "sourceSectionId"),
        requiredString(body, "targetSectionId"),
        requiredString(body, "pageId"),
        optionalInteger(body, "targetIndex"),
      );
    case "delete-page":
      return hierarchy.deletePage(
        requiredString(body, "sectionId"),
        requiredString(body, "pageId"),
        body.confirmed === true,
      );
    case "update-ink-colors":
      return hierarchy.updateSynchronizedInkColors(requiredInkColors(body));
    case "update-markdown-box-appearance":
      return hierarchy.updateMarkdownBoxAppearance(requiredMarkdownBoxAppearance(body));
    case "update-markdown-color-styles":
      return hierarchy.updateMarkdownColorStyles(requiredMarkdownColorStyles(body));
    case "update-laser-pointer-settings":
      return hierarchy.updateLaserPointerSettings(requiredLaserPointerSettings(body));
    case "update-lan-sharing-default":
      return hierarchy.updateLanSharingDefault(requiredBoolean(body, "enabled"));
    case "update-autosave-frequency":
      return hierarchy.updateAutosaveIntervalSeconds(requiredAutosaveIntervalSeconds(body));
    default:
      throw new Error(`Unknown hierarchy action: ${action}`);
  }
}

function requiredInkColors(body: Record<string, unknown>): SynchronizedInkColors {
  const colors = { pen: body.pen, highlighter: body.highlighter };
  if (!isSynchronizedInkColors(colors)) {
    throw new Error("pen and highlighter must be six-digit hexadecimal colors");
  }
  return colors;
}

function optionalSectionColor(body: Record<string, unknown>): string | undefined {
  const color = body.color;
  if (color === undefined) return undefined;
  if (!isSectionColor(color)) {
    throw new Error("color must be a six-digit hexadecimal color");
  }
  return color;
}

function requiredProfileDrawingPalettes(value: unknown): ProfileDrawingPalettes {
  if (!isProfileDrawingPalettes(value)) {
    throw new Error("drawingPalettes has an invalid profile palette shape");
  }
  return value;
}

function requiredProfileSettings(body: Record<string, unknown>): ProfileSettings {
  if (!isProfileSettings(body.settings)) throw new Error("settings has an invalid profile shape");
  return body.settings;
}

function requiredProfileSettingsExport(body: Record<string, unknown>): ProfileSettingsExport {
  if (!isProfileSettingsExport(body.export)) {
    throw new Error("export is not a valid SquillPad profile-settings file");
  }
  return body.export;
}

function requiredMarkdownBoxAppearance(body: Record<string, unknown>): MarkdownBoxAppearanceInput {
  const appearance = {
    opacity: body.opacity,
    ...(body.fontSize === undefined ? {} : { fontSize: body.fontSize }),
  };
  if (!isMarkdownBoxAppearance(appearance)) {
    throw new Error(
      `opacity must be between zero and one and fontSize must be between ${MARKDOWN_FONT_SIZE_MIN} and ${MARKDOWN_FONT_SIZE_MAX}`,
    );
  }
  return appearance;
}

function requiredMarkdownColorStyles(body: Record<string, unknown>): MarkdownColorStyleLibrary {
  if (!isMarkdownColorStyleLibrary(body.library)) {
    throw new Error("library has an invalid Markdown color-style shape");
  }
  return body.library;
}

function requiredLaserPointerSettings(body: Record<string, unknown>): LaserPointerSettings {
  const settings = { decaySeconds: body.decaySeconds };
  if (!isLaserPointerSettings(settings)) {
    throw new Error("decaySeconds must be between 0.5 and 5 seconds");
  }
  return settings;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function requiredClientLimit(value: unknown): number {
  if (!isClientLimit(value)) {
    throw new Error(
      `clientLimit must be a whole number between ${MIN_CLIENT_LIMIT} and ${MAX_CLIENT_LIMIT}`,
    );
  }
  return value;
}

function requiredAutosaveIntervalSeconds(body: Record<string, unknown>): AutosaveIntervalSeconds {
  const value = body.intervalSeconds;
  if (!isAutosaveIntervalSeconds(value)) {
    throw new Error("intervalSeconds must be one of the supported project intervals");
  }
  return value;
}

async function readJsonObject(
  request: IncomingMessage,
  maximumBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes) throw new Error("Request body is too large");
    chunks.push(new Uint8Array(buffer));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a string`);
  if (key.endsWith("Id")) assertId(value);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  if (key.endsWith("Ids")) for (const id of value) assertId(id as string);
  return value as string[];
}

function requiredArray(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function mergePageOverrides(body: Record<string, unknown>): readonly RepositoryMergePageOverride[] {
  return requiredArray(body, "pages").map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`pages[${index}] must be an object`);
    }
    const override = value as Record<string, unknown>;
    const sectionId = override.sectionId;
    const pageId = override.pageId;
    if (typeof sectionId !== "string" || typeof pageId !== "string") {
      throw new Error(`pages[${index}] must contain sectionId and pageId strings`);
    }
    assertId(sectionId);
    assertId(pageId);
    if (
      typeof override.page !== "object" ||
      override.page === null ||
      Array.isArray(override.page)
    ) {
      throw new Error(`pages[${index}].page must be an object`);
    }
    return { sectionId, pageId, page: override.page };
  });
}

function requiredStringRecord(body: Record<string, unknown>, key: string): Record<string, string> {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error(`${key} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`);
  return value as number;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Invalid identifier");
  }
}
