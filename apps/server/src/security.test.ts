import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createProject, ProjectHierarchyService } from "@squillpad/storage";
import { createPageDocument, PageSyncClient } from "@squillpad/synchronization";
import { createHostServer } from "./app.js";
import { HostSynchronizationService } from "./host-synchronization.js";
import { createAccessToken, createRequestGuard } from "./security.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(token: string | undefined = createAccessToken()) {
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
  const server = createHostServer({
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
