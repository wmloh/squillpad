import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createProject, ProjectHierarchyService } from "@squillpad/storage";
import {
  createPageDocument,
  PageSyncClient,
  replacePageContent,
  updateMarkdownSource,
  materializePageDocument,
} from "@squillpad/synchronization";
import { createHostServer } from "./app.js";
import { AuthenticationService } from "./authentication.js";
import { HostSynchronizationService } from "./host-synchronization.js";
import { createAccessToken, createRequestGuard } from "./security.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(token: string | undefined = createAccessToken(), authenticated = false) {
  const directory = await mkdtemp(join(tmpdir(), "security-"));
  const session = await createProject(join(directory, "project"));
  cleanups.push(() => session.close());
  const hierarchy = new ProjectHierarchyService(session);
  const notebook = await hierarchy.load();
  const section = notebook.sections[0]!;
  const pageId = section.pages[0]!.id;
  const projectId = notebook.notebook.projectId;
  const synchronization = new HostSynchronizationService({
    hierarchy,
    projectId,
    projectRoot: session.projectRoot,
  });
  await synchronization.ready();
  const webRoot = join(directory, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<title>Notebook</title>");
  await writeFile(join(directory, "private.txt"), "PRIVATE SENTINEL");
  const authentication = authenticated
    ? await AuthenticationService.open(session.projectRoot, token)
    : undefined;
  const server = createHostServer({
    ...(authentication === undefined ? {} : { authentication }),
    hierarchy,
    synchronization,
    webRoot,
    ...(token === undefined ? {} : { token }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await synchronization.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  const generation = synchronization.status().synchronizationGeneration;
  return {
    directory,
    authentication,
    hierarchy,
    base,
    token,
    synchronization,
    sectionId: section.manifest.id,
    pageId,
    projectId,
    room: `${base.replace("http:", "ws:")}/sync/${generation}:${projectId}:${pageId}`,
  };
}

function rejectedSocket(
  url: string,
  headers: Record<string, string> = {},
  protocols: string[] = [],
) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { headers });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("Unauthorized connection opened"));
    });
    socket.on("error", () => undefined);
  });
}

function requestFromRemote(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  const { body, ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        ...requestOptions,
        localAddress: "127.0.0.2",
        headers: {
          ...requestOptions.headers,
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += String(chunk);
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: responseBody }),
        );
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

it("generates independent 256-bit URL-safe access tokens", () => {
  expect(createAccessToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(createAccessToken()).not.toBe(createAccessToken());
});

it("blocks non-loopback requests while sharing is disabled before API authentication", () => {
  let sharingEnabled = false;
  const guard = createRequestGuard({
    token: "t".repeat(43),
    sharingEnabled: () => sharingEnabled,
  });
  const request = {
    url: "/api/sync/status",
    headers: { host: "127.0.0.1:4173" },
    socket: { localPort: 4173, remoteAddress: "192.168.1.20" },
  } as unknown as IncomingMessage;

  expect(guard(request)).toBe(403);
  sharingEnabled = true;
  expect(guard(request)).toBe(401);
});

it("protects every HTTP API and WS rooms before loading project data", async () => {
  const f = await fixture();
  for (const path of [
    "/api/hierarchy",
    "/api/sync/status",
    "/api/sharing",
    `/api/pages/${f.sectionId}/${f.pageId}`,
  ]) {
    expect((await fetch(f.base + path)).status).toBe(401);
    expect(
      (await fetch(f.base + path, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
  }
  expect(await rejectedSocket(f.room)).toBe(401);
  expect(await rejectedSocket(f.room, {}, ["squillpad", "squillpad-token.wrong"])).toBe(401);
  expect(f.synchronization.status().activeRooms).toBe(0);
  const response = await fetch(f.base + "/api/hierarchy", {
    headers: { authorization: `Bearer ${f.token}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const client = new PageSyncClient({
    document: createPageDocument(),
    serverUrl: f.base.replace("http:", "ws:") + "/sync",
    projectId: f.projectId,
    pageId: f.pageId,
    synchronizationGeneration: f.synchronization.status().synchronizationGeneration,
    accessToken: f.token,
    disableIndexedDb: true,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  cleanups.push(() => {
    client.destroy();
    client.document.destroy();
    return Promise.resolve();
  });
  await expect.poll(() => client.status).toBe("synchronized");
});

it("does not let a remote bearer holder read or mutate LAN sharing controls", async () => {
  const f = await fixture();
  const authorization = `Bearer ${f.token}`;
  const sharing = await requestFromRemote(`${f.base}/api/sharing`, {
    headers: { authorization },
  });
  expect(sharing.status).toBe(403);

  const sharingUpdate = await requestFromRemote(`${f.base}/api/sharing`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(sharingUpdate.status).toBe(403);

  const sharingDefault = await requestFromRemote(`${f.base}/api/hierarchy/commands`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ action: "update-lan-sharing-default", enabled: false }),
  });
  expect(sharingDefault.status).toBe(403);

  const status = await requestFromRemote(`${f.base}/api/sync/status`, {
    headers: { authorization },
  });
  expect(status.status).toBe(200);
  const statusBody = JSON.parse(status.body) as Record<string, unknown>;
  expect(statusBody).not.toHaveProperty("activeRooms");
  expect(statusBody).not.toHaveProperty("connectedClients");
  expect(statusBody).not.toHaveProperty("clientLimit");
  expect(statusBody).not.toHaveProperty("clientSlotsUsed");
});

it("rejects foreign and null origins, DNS rebinding hosts, and cross-site requests", async () => {
  const f = await fixture();
  const authorization = `Bearer ${f.token}`;
  for (const origin of ["https://evil.example", "null", f.base + ".evil.example"]) {
    expect(
      (await fetch(f.base + "/api/hierarchy", { headers: { authorization, origin } })).status,
    ).toBe(403);
    expect(
      await rejectedSocket(f.room, { origin }, ["squillpad", `squillpad-token.${f.token}`]),
    ).toBe(403);
  }
  const rebound = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      f.base + "/api/hierarchy",
      { headers: { authorization, host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.end();
  });
  expect(rebound).toBe(403);
  expect(
    (
      await fetch(f.base + "/api/hierarchy", {
        headers: { authorization, "sec-fetch-site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(f.base + "/api/hierarchy", { headers: { authorization, origin: f.base } })).status,
  ).toBe(200);
});

it("does not read traversal paths, symlink assets, or malicious object identifiers", async () => {
  const f = await fixture();
  await symlink(join(f.directory, "private.txt"), join(f.directory, "web", "leak.txt"));
  expect((await fetch(f.base + "/leak.txt")).status).toBe(404);
  for (const path of [
    "/../private.txt",
    "/%2e%2e/private.txt",
    "/%2e%2e%5cprivate.txt",
    "/%ZZ",
    "/api/pages/%2e%2e/private.txt",
  ]) {
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = httpRequest(
        f.base,
        { path, headers: { authorization: `Bearer ${f.token}` } },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += String(chunk);
          });
          response.on("end", () => resolve({ status: response.statusCode!, text }));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(result.status).toBe(400);
    expect(result.text).not.toContain("PRIVATE SENTINEL");
  }
  const response = await fetch(`${f.base}/api/pages/${f.sectionId}/${f.pageId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ canvas: [], markdown: { "../../private": "overwritten" } }),
  });
  expect(response.status).toBe(400);
  expect(await readFile(join(f.directory, "private.txt"), "utf8")).toBe("PRIVATE SENTINEL");
});

it("rejects malformed WS paths without crashing the host", async () => {
  const f = await fixture();
  expect(
    await rejectedSocket(f.base.replace("http:", "ws:") + "/sync/%ZZ", {}, [
      "squillpad",
      `squillpad-token.${f.token}`,
    ]),
  ).toBe(400);
  expect((await fetch(f.base + "/health")).status).toBe(200);
  expect(f.synchronization.status().activeRooms).toBe(0);
});

it("rejects symlinked synchronization runtime directories", async () => {
  const f = await fixture();
  await symlink(f.directory, join(f.directory, "project", ".squillpad-runtime", "sync"), "dir");
  const code = await new Promise<number>((resolve) => {
    const socket = new WebSocket(f.room, ["squillpad", `squillpad-token.${f.token}`]);
    socket.on("close", (code) => resolve(code));
    socket.on("error", () => undefined);
  });
  expect(code).toBe(4404);
  expect(f.synchronization.status().activeRooms).toBe(0);
});

it("rejects runtime hard links without modifying the file outside the project", async () => {
  const f = await fixture();
  const sync = join(f.directory, "project", ".squillpad-runtime", "sync");
  await mkdir(sync);
  const outside = join(f.directory, "outside.updates");
  await writeFile(outside, "");
  const roomId = f.room.slice(f.room.lastIndexOf("/") + 1);
  const key = createHash("sha256").update(roomId).digest("hex");
  await link(outside, join(sync, `${key}.updates`));
  const code = await new Promise<number>((resolve) => {
    const socket = new WebSocket(f.room, ["squillpad", `squillpad-token.${f.token}`]);
    socket.on("close", resolve);
    socket.on("error", () => undefined);
  });
  expect(code).toBe(4404);
  expect(await readFile(outside, "utf8")).toBe("");
});

it("closes invalid protocol messages and oversized synchronization frames", async () => {
  const f = await fixture();
  for (const [data, expectedCode] of [
    [new Uint8Array([127]), 4400],
    [new Uint8Array(8 * 1024 * 1024 + 1), 1009],
  ] as const) {
    const code = await new Promise<number>((resolve) => {
      const socket = new WebSocket(f.room, ["squillpad", `squillpad-token.${f.token}`]);
      socket.once("message", () => socket.send(data));
      socket.on("close", (code) => resolve(code));
      socket.on("error", () => undefined);
    });
    expect(code).toBe(expectedCode);
  }
});

it("scopes invitations to registration and keeps administration local", async () => {
  const f = await fixture(createAccessToken(), true);
  const auth = f.authentication!;
  const invite = {
    authorization: `Bearer ${auth.invitationToken}`,
    "content-type": "application/json",
  };
  expect(auth.invitationToken).not.toBe(f.token);
  const status = await requestFromRemote(`${f.base}/api/auth/status`, {
    headers: invite,
  });
  expect(JSON.parse(status.body)).toMatchObject({
    authenticated: false,
    hostAuthorized: false,
    canRegister: true,
  });
  expect((await requestFromRemote(`${f.base}/api/hierarchy`, { headers: invite })).status).toBe(
    401,
  );
  expect(await rejectedSocket(f.room, invite)).toBe(401);
  expect(
    (
      await requestFromRemote(`${f.base}/api/auth/register`, {
        method: "POST",
        headers: invite,
        body: JSON.stringify({ username: "invited", password: "x" }),
      })
    ).status,
  ).toBe(201);
  const session = await auth.login("invited", "x");
  const cookie = `squillpad_session=${session}`;
  expect(
    (
      await requestFromRemote(`${f.base}/api/hierarchy`, {
        headers: { ...invite, cookie },
      })
    ).status,
  ).toBe(200);
  for (const path of [
    "/api/auth/accounts",
    "/api/auth/reset-password",
    "/api/auth/remove-account",
    "/api/host/stop",
    "/api/repository-sync/status",
    "/api/sharing",
    "/api/storage/diagnostics",
    "/api/storage/runtime-cache/cleanup",
    "/api/profile/settings/all",
  ]) {
    for (const credential of [auth.invitationToken, f.token!]) {
      const result = await requestFromRemote(`${f.base}${path}`, {
        method:
          path.includes("reset-password") ||
          path.includes("remove-account") ||
          path.includes("stop") ||
          path.includes("cleanup")
            ? "POST"
            : "GET",
        headers: {
          authorization: `Bearer ${credential}`,
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "invited", password: "changed" }),
      });
      expect(result.status, path).toBe(403);
    }
  }
  const headers = {
    authorization: `Bearer ${f.token}`,
    "content-type": "application/json",
  };
  expect((await fetch(`${f.base}/api/auth/accounts`, { headers })).status).toBe(200);
  expect(
    (
      await fetch(`${f.base}/api/auth/reset-password`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username: "invited", password: "changed" }),
      })
    ).status,
  ).toBe(200);
  expect(auth.acceptsCredential(await auth.login("invited", "changed"))).toBe(true);
});

it.each(["logout", "reset", "remove", "evict"] as const)(
  "disconnects revoked sockets on %s while unrelated sessions keep collaborating",
  async (action) => {
    const f = await fixture(createAccessToken(), true);
    const auth = f.authentication!;
    const token = await auth.register("victim", "x");
    const otherToken = await auth.register("unrelated", "x");
    const connect = async (credential: string, cookie?: string) => {
      class SessionWebSocket extends WebSocket {
        constructor(address: string, protocols?: string | string[]) {
          super(address, protocols, cookie === undefined ? {} : { headers: { cookie } });
        }
      }
      const value = new PageSyncClient({
        document: createPageDocument(),
        projectId: f.projectId,
        pageId: f.pageId,
        synchronizationGeneration: f.synchronization.status().synchronizationGeneration,
        serverUrl: `${f.base.replace("http:", "ws:")}/sync`,
        disableIndexedDb: true,
        accessToken: credential,
        WebSocketPolyfill: SessionWebSocket as unknown as typeof globalThis.WebSocket,
      });
      cleanups.push(async () => value.destroy());
      await expect.poll(() => value.status).toBe("synchronized");
      return value;
    };
    const victim = await connect(auth.invitationToken, `squillpad_session=${token}`);
    const survivor = await connect(otherToken);
    const sameAccountToken = await auth.login("victim", "x");
    const sameAccount = await connect(sameAccountToken);
    const id = "323e4567-e89b-42d3-a456-426614174002";
    replacePageContent(survivor.document, {
      canvas: [
        {
          id,
          kind: "markdown",
          position: [0, 0],
          z: 0,
          width: 320,
          height: 160,
          source: `markdown/${id}.md`,
        },
      ],
      markdown: { [id]: "before revocation" },
    });
    await expect
      .poll(() => materializePageDocument(victim.document).markdown[id])
      .toBe("before revocation");
    const closed = new Promise<number>((resolve) =>
      victim.provider.on("closed", (event: { code: number }) => resolve(event.code)),
    );
    if (action === "logout")
      await auth.logout({
        headers: { cookie: `squillpad_session=${token}` },
      } as IncomingMessage);
    if (action === "reset") await auth.resetPassword("victim", "new");
    if (action === "remove") await auth.removeAccount("victim");
    if (action === "evict") for (let i = 0; i < 9; i++) await auth.login("victim", "x");
    expect(await closed).toBe(4401);
    expect(await rejectedSocket(f.room, {}, ["squillpad", `squillpad-token.${token}`])).toBe(401);
    const observer = await connect(otherToken);
    updateMarkdownSource(survivor.document, id, action);
    updateMarkdownSource(victim.document, id, "forbidden");
    await expect.poll(() => materializePageDocument(observer.document).markdown[id]).toBe(action);
    expect(materializePageDocument(survivor.document).markdown[id]).toBe(action);
    expect(materializePageDocument(victim.document).markdown[id]).toBe("forbidden");
    await f.synchronization.flush();
    expect((await f.hierarchy.loadPage(f.sectionId, f.pageId)).markdown[id]).toBe(action);
    expect(survivor.provider.wsconnected).toBe(true);
    if (action === "reset" || action === "remove") {
      await expect.poll(() => sameAccount.provider.wsconnected).toBe(false);
      expect(materializePageDocument(sameAccount.document).markdown[id]).toBe("before revocation");
    } else {
      await expect
        .poll(() => materializePageDocument(sameAccount.document).markdown[id])
        .toBe(action);
    }
  },
);

it("revokes a cookie-authenticated socket while its room is still loading", async () => {
  const f = await fixture(createAccessToken(), true);
  const auth = f.authentication!;
  const token = await auth.register("pending", "x");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadPage = f.hierarchy.loadPage.bind(f.hierarchy);
  const loading = vi.spyOn(f.hierarchy, "loadPage").mockImplementationOnce(async (...args) => {
    await pending;
    return loadPage(...args);
  });
  const socket = new WebSocket(f.room, ["squillpad", `squillpad-token.${auth.invitationToken}`], {
    localAddress: "127.0.0.2",
    headers: { cookie: `squillpad_session=${token}` },
  });
  const received: unknown[] = [];
  socket.on("message", (message) => received.push(message));
  const closed = new Promise<number>((resolve) => socket.on("close", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    await expect.poll(() => loading.mock.calls.length).toBe(1);
    await auth.logout({
      headers: { cookie: `squillpad_session=${token}` },
    } as IncomingMessage);
    expect(await closed).toBe(4401);
    expect(received).toEqual([]);
  } finally {
    release();
    loading.mockRestore();
    socket.terminate();
  }
});
