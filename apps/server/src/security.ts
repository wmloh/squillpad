import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { requestCredential } from "./authentication.js";

export interface HostSecurityOptions {
  readonly token?: string;
  readonly allowedOrigins?: readonly string[];
  readonly authenticate?: (
    credential: string | undefined,
    request: IncomingMessage,
    websocket: boolean,
  ) => boolean;
  readonly sharingEnabled?: () => boolean;
}

export function createAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Applies the same host, origin and credential policy before HTTP and WS routing. */
export function createRequestGuard(options: HostSecurityOptions = {}) {
  if (options.token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.token)) {
    throw new Error("Access token must contain 256 bits encoded as base64url");
  }
  const expected = options.token === undefined ? undefined : Buffer.from(options.token);
  const configured = options.allowedOrigins ?? [];
  for (const origin of configured) {
    if (new URL(origin).origin !== origin) throw new Error("Expected an exact application origin");
  }
  return (request: IncomingMessage, websocket = false): number | undefined => {
    if ((request.url?.length ?? 0) > 4096) return 414;
    const loopback = isLoopbackAddress(request.socket.remoteAddress);
    if (options.sharingEnabled?.() === false && !loopback) return 403;
    if (expected === undefined && !loopback) return 403;
    try {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "");
      if (
        !path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((part) => part === ".." || part === ".")
      )
        return 400;
    } catch {
      return 400;
    }
    const port = request.socket.localPort;
    const origins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
      ...configured,
    ]);
    const host = request.headers.host;
    if (host === undefined || ![...origins].some((origin) => new URL(origin).host === host)) {
      return 403;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return 403;
    if (request.headers["sec-fetch-site"] === "cross-site") return 403;
    const publicAuthenticationRoute =
      !websocket &&
      (request.url === "/api/auth/status" ||
        request.url === "/api/auth/login" ||
        request.url === "/api/auth/register");
    const protectedResource =
      websocket || (request.url?.startsWith("/api") && !publicAuthenticationRoute);
    if (expected !== undefined && protectedResource) {
      const value = requestCredential(request, websocket);
      if (options.authenticate !== undefined) {
        return options.authenticate(value, request, websocket) ? undefined : 401;
      }
      const supplied = Buffer.from(value ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return 401;
    }
    return undefined;
  };
}

/** Returns whether an address identifies the local host. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "");
}
