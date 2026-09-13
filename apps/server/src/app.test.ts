import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProject,
  ProfileSettingsStore,
  ProjectHierarchyService,
  type ProjectSession,
} from "@squillpad/storage";
import {
  DEFAULT_PROFILE_SETTINGS,
  LASER_POINTER_SETTINGS_METADATA_KEY,
  MARKDOWN_BOX_APPEARANCE_METADATA_KEY,
  MARKDOWN_COLOR_KEYS,
  MARKDOWN_COLOR_STYLES_METADATA_KEY,
  SECTION_COLOR_METADATA_KEY,
  SYNCHRONIZED_INK_COLORS_METADATA_KEY,
  AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY,
  LAN_SHARING_DEFAULT_METADATA_KEY,
} from "@squillpad/core-model";

import { createHostServer } from "./app.js";
import { AuthenticationService } from "./authentication.js";
import { HostSynchronizationService } from "./host-synchronization.js";
import type { RepositorySynchronizationService } from "./repository-synchronization.js";

const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";

const servers = new Set<ReturnType<typeof createHostServer>>();
const sessions = new Set<ProjectSession>();
const synchronizations = new Set<HostSynchronizationService>();

afterEach(async () => {
  for (const server of servers) {
    server.close();
  }
  servers.clear();
  await Promise.all([...synchronizations].map((synchronization) => synchronization.close()));
  synchronizations.clear();
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
});

describe("host server", () => {
  it("can be constructed without listening", () => {
    const server = createHostServer();
    servers.add(server);
    expect(server.listening).toBe(false);
  });

  it("exposes storage diagnostics and a runtime-only cleanup operation", async () => {
    let cleaned = false;
    const server = createHostServer({
      storageDiagnostics: () =>
        Promise.resolve({
          canonicalBytes: 120,
          canonicalFileCount: 3,
          runtimeCacheBytes: cleaned ? 4 : 40,
          runtimeCacheFileCount: cleaned ? 1 : 2,
          measuredAt: "2026-09-06T00:00:00.000Z",
        }),
      cleanupRuntimeCache: () => {
        cleaned = true;
        return Promise.resolve({ removedBytes: 36, removedFileCount: 1 });
      },
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;

    expect(await (await fetch(`${base}/api/storage/diagnostics`)).json()).toMatchObject({
      canonicalBytes: 120,
      runtimeCacheBytes: 40,
    });
    expect(
      await (await fetch(`${base}/api/storage/runtime-cache/cleanup`, { method: "POST" })).json(),
    ).toEqual({ removedBytes: 36, removedFileCount: 1 });
    expect(cleaned).toBe(true);
  });

  it("acknowledges a host stop request before running the shutdown callback", async () => {
    let stopped = false;
    const server = createHostServer({
      stopHosting: async () => {
        stopped = true;
      },
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/host/stop`, {
      method: "POST",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toEqual({ stopping: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(true);
  });

  it("serves the production web build and exposes synchronization status", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "squillpad-web-"));
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>SquillPad</title>");
    await writeFile(join(webRoot, "assets", "app.js"), "export const ready = true;");
    await writeFile(join(webRoot, "manifest.webmanifest"), '{"name":"SquillPad"}');
    const server = createHostServer({ webRoot });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;

    expect(await (await fetch(`${base}/`)).text()).toContain("SquillPad");
    const rootResponse = await fetch(`${base}/`);
    expect(rootResponse.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(rootResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(await (await fetch(`${base}/projects/example`)).text()).toContain("SquillPad");
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toContain("ready = true");
    expect((await fetch(`${base}/manifest.webmanifest`)).headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    expect(await (await fetch(`${base}/api/sync/status`)).json()).toEqual({
      activeRooms: 0,
      connectedClients: 0,
    });
  });

  it("serves canonical hierarchy queries and commands", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const server = createHostServer({ hierarchy: new ProjectHierarchyService(session) });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;

    const initial = await fetch(`${base}/api/hierarchy`);
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as { sections: readonly unknown[] };
    expect(initialBody.sections).toHaveLength(1);

    const created = await fetch(`${base}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create-section", title: "Research" }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      sections: readonly { manifest: { title: string } }[];
    };
    expect(createdBody.sections.map((section) => section.manifest.title)).toEqual([
      "Section 1",
      "Research",
    ]);

    const renamed = await fetch(`${base}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rename-project", title: "Research notebook" }),
    });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as { readonly notebook: { readonly title: string } };
    expect(renamedBody.notebook.title).toBe("Research notebook");

    const sharingDefault = await fetch(`${base}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update-lan-sharing-default", enabled: false }),
    });
    expect(sharingDefault.status).toBe(200);
    const sharingDefaultBody = (await sharingDefault.json()) as {
      notebook: { settings: { metadata: Record<string, unknown> } };
    };
    expect(sharingDefaultBody.notebook.settings.metadata[LAN_SHARING_DEFAULT_METADATA_KEY]).toBe(
      false,
    );

    const autosave = await fetch(`${base}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update-autosave-frequency", intervalSeconds: 300 }),
    });
    expect(autosave.status).toBe(200);
    const autosaveBody = (await autosave.json()) as {
      notebook: { settings: { metadata: Record<string, unknown> } };
    };
    expect(autosaveBody.notebook.settings.metadata[AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY]).toBe(
      300,
    );
  });

  it("returns a transient conflict when repository work owns mutable project data", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const hierarchy = new ProjectHierarchyService(session);
    const repositorySynchronization = { mutationActive: true } as RepositorySynchronizationService;
    const server = createHostServer({ hierarchy, repositorySynchronization });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Repository snapshot operation in progress; retry shortly",
    });
    const legacyPreferences = await fetch(`http://127.0.0.1:${address.port}/api/auth/preferences`, {
      method: "POST",
    });
    expect(legacyPreferences.status).toBe(409);
    expect(await legacyPreferences.json()).toEqual({
      error: "Repository snapshot operation in progress; retry shortly",
    });
  });

  it("flushes a loaded page through the host-only save endpoint", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const hierarchy = new ProjectHierarchyService(session);
    const tree = await hierarchy.load();
    const section = tree.sections[0];
    if (section === undefined) throw new Error("Missing fixture section");
    const synchronization = new HostSynchronizationService({
      hierarchy,
      projectId: tree.notebook.projectId,
      projectRoot: root,
      sharingEnabled: false,
    });
    synchronizations.add(synchronization);
    await synchronization.ready();
    const server = createHostServer({ hierarchy, synchronization });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/sync/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: section.pages[0]?.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
  });

  it("registers with the host token and later authenticates with username and password", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const token = "t".repeat(43);
    const authentication = await AuthenticationService.open(root, token);
    const server = createHostServer({
      authentication,
      authenticate: (credential) => authentication.acceptsCredential(credential),
      hierarchy: new ProjectHierarchyService(session),
      sharing: () => ({ enabled: true, connections: [{ url: "secret" }] }),
      token,
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;
    const hostHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const remoteSharing = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${base}/api/sharing`,
        { localAddress: "127.0.0.2", headers: { authorization: `Bearer ${token}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(remoteSharing).toBe(403);

    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: hostHeaders,
      body: JSON.stringify({ username: "reader", password: "a secure passphrase" }),
    });
    expect(registered.status).toBe(201);
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toMatch(/^squillpad_session=/);
    const preferences = await fetch(`${base}/api/auth/preferences`, {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ toolbarHeight: 68 }),
    });
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toEqual({ toolbarHeight: 68 });
    const palmRejection = await fetch(`${base}/api/auth/preferences`, {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ palmRejection: true }),
    });
    expect(palmRejection.status).toBe(200);
    expect(await palmRejection.json()).toEqual({ palmRejection: true });
    const drawingPalettes = {
      pen: {
        custom: true,
        selectedIndex: 1,
        slots: [
          { color: "#111111", width: 2, opacity: 1 },
          { color: "#222222", width: 3, opacity: 0.9 },
          { color: "#333333", width: 4, opacity: 0.8 },
          { color: "#444444", width: 5, opacity: 0.7 },
          { color: "#555555", width: 6, opacity: 0.6 },
          { color: "#666666", width: 7, opacity: 0.5 },
        ],
      },
      highlighter: {
        custom: false,
        selectedIndex: 0,
        slots: [
          { color: "#111111", width: 10, opacity: 0.35 },
          { color: "#222222", width: 10, opacity: 0.35 },
          { color: "#333333", width: 10, opacity: 0.35 },
          { color: "#444444", width: 10, opacity: 0.35 },
          { color: "#555555", width: 10, opacity: 0.35 },
          { color: "#666666", width: 10, opacity: 0.35 },
        ],
      },
      shape: {
        custom: false,
        selectedIndex: 0,
        slots: [
          { color: "#111111", width: 3, opacity: 1 },
          { color: "#222222", width: 3, opacity: 1 },
          { color: "#333333", width: 3, opacity: 1 },
          { color: "#444444", width: 3, opacity: 1 },
          { color: "#555555", width: 3, opacity: 1 },
          { color: "#666666", width: 3, opacity: 1 },
        ],
      },
    };
    const savedPalettes = await fetch(`${base}/api/auth/preferences`, {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ drawingPalettes }),
    });
    expect(savedPalettes.status).toBe(200);
    expect(await savedPalettes.json()).toEqual({ drawingPalettes });
    expect(
      await (await fetch(`${base}/api/auth/status`, { headers: { cookie: cookie! } })).json(),
    ).toMatchObject({
      username: "reader",
      toolbarHeight: 68,
      palmRejection: true,
      drawingPalettes,
    });
    expect((await fetch(`${base}/api/hierarchy`, { headers: { cookie: cookie! } })).status).toBe(
      200,
    );
    expect((await fetch(`${base}/api/sharing`, { headers: { cookie: cookie! } })).status).toBe(403);
    expect(
      (
        await fetch(`${base}/api/sharing`, {
          method: "POST",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/sharing`, {
          method: "POST",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({ clientLimit: 12 }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/hierarchy/commands`, {
          method: "POST",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({ action: "update-autosave-frequency", intervalSeconds: 0 }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/sync/save`, {
          method: "POST",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({ pageId: "00000000-0000-4000-8000-000000000000" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/repository-sync/status`, { headers: { cookie: cookie! } })).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/storage/diagnostics`, { headers: { cookie: cookie! } })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/storage/runtime-cache/cleanup`, {
          method: "POST",
          headers: { cookie: cookie! },
        })
      ).status,
    ).toBe(403);

    const loggedIn = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "a secure passphrase" }),
    });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({ username: "other", password: "another secure passphrase" }),
      }),
    ).toMatchObject({ status: 403 });
  });

  it("serves settings-only profile records and portable imports", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const token = "p".repeat(43);
    const profileStore = await ProfileSettingsStore.open(root);
    const authentication = await AuthenticationService.open(root, token, profileStore);
    const server = createHostServer({
      authentication,
      authenticate: (credential) => authentication.acceptsCredential(credential),
      token,
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "profile-reader", password: "a secure passphrase" }),
    });
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeDefined();

    const settings = {
      ...DEFAULT_PROFILE_SETTINGS,
      application: { theme: "dark" as const, pageBackground: "ruled" as const },
      keyboardPanSpeedMultiplier: 2.5,
    };
    const saved = await fetch(`${base}/api/profile/settings`, {
      method: "PUT",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ settings });

    const exportedResponse = await fetch(`${base}/api/profile/settings/export`, {
      headers: { cookie: cookie! },
    });
    const exported = (await exportedResponse.json()) as Record<string, unknown>;
    expect(exported).toMatchObject({ format: "squillpad-profile-settings", schemaVersion: 1 });
    expect(exported).not.toHaveProperty("username");
    expect(exported).not.toHaveProperty("password");

    const imported = {
      ...exported,
      settings: {
        ...settings,
        application: { theme: "light" as const, pageBackground: "blank" as const },
      },
    };
    const importedResponse = await fetch(`${base}/api/profile/settings/import`, {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ export: imported }),
    });
    expect(importedResponse.status).toBe(200);
    expect(await importedResponse.json()).toEqual({ settings: imported.settings });

    const allProfiles = await fetch(`${base}/api/profile/settings/all`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allProfiles.status).toBe(200);
    expect(await allProfiles.json()).toMatchObject({
      profiles: [{ username: "profile-reader", settings: imported.settings }],
    });
    expect(
      (
        await fetch(`${base}/api/profile/settings/all`, {
          headers: { cookie: cookie! },
        })
      ).status,
    ).toBe(403);
  });

  it("returns authenticated project presence with observed addresses and explicit removal", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const hierarchy = new ProjectHierarchyService(session);
    const notebook = await hierarchy.load();
    const synchronization = new HostSynchronizationService({
      hierarchy,
      projectId: notebook.notebook.projectId,
      projectRoot: root,
    });
    synchronizations.add(synchronization);
    await synchronization.ready();
    const token = "t".repeat(43);
    const authentication = await AuthenticationService.open(root, token);
    const server = createHostServer({
      authentication,
      authenticate: (credential) => authentication.acceptsCredential(credential),
      hierarchy,
      synchronization,
      token,
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "a secure passphrase" }),
    });
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeDefined();

    const firstHeaders = {
      cookie: cookie!,
      "x-squillpad-presence-id": "reader-client-one",
    };
    const first = await fetch(`${base}/api/presence`, { headers: firstHeaders });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      participants: [{ id: "reader-client-one", username: "reader", ipAddress: "127.0.0.1" }],
    });

    const second = await fetch(`${base}/api/presence`, {
      headers: { ...firstHeaders, "x-squillpad-presence-id": "reader-client-two" },
    });
    expect(await second.json()).toEqual({
      participants: [
        { id: "reader-client-one", username: "reader", ipAddress: "127.0.0.1" },
        { id: "reader-client-two", username: "reader", ipAddress: "127.0.0.1" },
      ],
    });

    const left = await fetch(`${base}/api/presence`, {
      method: "POST",
      headers: firstHeaders,
    });
    expect(await left.json()).toEqual({
      participants: [{ id: "reader-client-two", username: "reader", ipAddress: "127.0.0.1" }],
    });
  });

  it("rejects hierarchy deletion commands without explicit confirmation", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const service = new ProjectHierarchyService(session);
    const sectionId = (await service.load()).sections[0]?.manifest.id as string;
    const server = createHostServer({ hierarchy: service });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete-section", sectionId }),
    });
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: "Deleting a section requires explicit confirmation" });
    expect((await service.load()).sections).toHaveLength(1);
  });

  it("persists synchronized ink colors through the hierarchy command API", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const server = createHostServer({ hierarchy: new ProjectHierarchyService(session) });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update-ink-colors",
        pen: "#fb923c",
        highlighter: "#c4b5fd",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      notebook: {
        settings: {
          metadata: {
            [SYNCHRONIZED_INK_COLORS_METADATA_KEY]: {
              pen: "#fb923c",
              highlighter: "#c4b5fd",
            },
          },
        },
      },
    });
  });

  it("persists section colors through the hierarchy command API", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const hierarchy = new ProjectHierarchyService(session);
    const sectionId = (await hierarchy.load()).sections[0]?.manifest.id as string;
    const server = createHostServer({ hierarchy });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update-section-color",
        sectionId,
        color: "#ef4444",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sections: [
        {
          manifest: {
            id: sectionId,
            metadata: { [SECTION_COLOR_METADATA_KEY]: "#ef4444" },
          },
        },
      ],
    });
  });

  it("persists Markdown appearance through the hierarchy command API", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const server = createHostServer({ hierarchy: new ProjectHierarchyService(session) });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update-markdown-box-appearance", opacity: 0, fontSize: 22 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      notebook: {
        settings: {
          metadata: {
            [MARKDOWN_BOX_APPEARANCE_METADATA_KEY]: { opacity: 0, fontSize: 22 },
          },
        },
      },
    });
  });

  it("persists Markdown color styles through the hierarchy command API", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const server = createHostServer({ hierarchy: new ProjectHierarchyService(session) });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const colors = Object.fromEntries(
      MARKDOWN_COLOR_KEYS.map((key) => [key, { light: "#123456", dark: "#654321" }]),
    );

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update-markdown-color-styles",
        library: { styles: [{ id: MARKDOWN_ID, name: "Lecture", colors }] },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      notebook: {
        settings: {
          metadata: {
            [MARKDOWN_COLOR_STYLES_METADATA_KEY]: {
              styles: [{ id: MARKDOWN_ID, name: "Lecture" }],
            },
          },
        },
      },
    });
  });

  it("persists laser pointer decay settings through the hierarchy command API", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const server = createHostServer({ hierarchy: new ProjectHierarchyService(session) });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/hierarchy/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update-laser-pointer-settings", decaySeconds: 2.7 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      notebook: {
        settings: {
          metadata: {
            [LASER_POINTER_SETTINGS_METADATA_KEY]: { decaySeconds: 2.7 },
          },
        },
      },
    });
  });

  it("loads and persists native Markdown page content without HTML conversion", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const service = new ProjectHierarchyService(session);
    const hierarchy = await service.load();
    const sectionId = hierarchy.sections[0]?.manifest.id as string;
    const pageId = hierarchy.sections[0]?.pages[0]?.id as string;
    const server = createHostServer({ hierarchy: service });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const url = `http://127.0.0.1:${address.port}/api/pages/${sectionId}/${pageId}`;
    const source = "# Native source\n\n| A | B |\n| - | - |\n| *one* | <future-syntax> |\n";

    const saved = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        canvas: [
          {
            id: MARKDOWN_ID,
            kind: "markdown",
            position: [-25, 40],
            z: 0,
            width: 420,
            height: 160,
            source: `markdown/${MARKDOWN_ID}.md`,
          },
        ],
        markdown: { [MARKDOWN_ID]: source },
      }),
    });
    expect(saved.status).toBe(200);

    const loaded = await fetch(url);
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({
      canvas: [{ id: MARKDOWN_ID, position: [-25, 40] }],
      markdown: { [MARKDOWN_ID]: source },
    });
  });

  it("stores and serves page-local image assets through the guarded API", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "squillpad-server-")), "project");
    const session = await createProject(root);
    sessions.add(session);
    const service = new ProjectHierarchyService(session);
    const hierarchy = await service.load();
    const sectionId = hierarchy.sections[0]?.manifest.id as string;
    const pageId = hierarchy.sections[0]?.pages[0]?.id as string;
    const server = createHostServer({ hierarchy: service });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}/api/pages/${sectionId}/${pageId}`;
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

    const stored = await fetch(`${base}/assets`, { method: "PUT", body: bytes });
    expect(stored.status).toBe(201);
    const { asset } = (await stored.json()) as { asset: string };
    expect(asset).toMatch(/^assets\/[0-9a-f]{64}\.png$/);

    const loaded = await fetch(`${base}/${asset}`);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("cache-control")).toContain("immutable");
    expect(loaded.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(bytes);

    const head = await fetch(`${base}/${asset}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
  });
});
