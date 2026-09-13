import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as Y from "yjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  serializeCanonicalJson,
  serializeCanvasJsonLines,
  type InkCanvasRecord,
  type MarkdownCanvasRecord,
} from "@squillpad/core-model";
import {
  HOST_STOPPED_CLOSE_CODE,
  HOST_STOPPED_CLOSE_REASON,
  REPOSITORY_OPERATION_CLOSE_CODE,
  REPOSITORY_OPERATION_CLOSE_REASON,
  PageSyncClient,
  createPageDocument,
  materializePageDocument,
  replacePageContent,
  updateMarkdownSource,
} from "@squillpad/synchronization";
import {
  createProject,
  ProjectHierarchyService,
  type StoredPageContent,
  type ProjectSession,
} from "@squillpad/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createHostServer } from "./app.js";
import {
  HostSynchronizationService,
  type HostSynchronizationOptions,
} from "./host-synchronization.js";

const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const INK_ID = "423e4567-e89b-42d3-a456-426614174003";

const sessions = new Set<ProjectSession>();
const cleanups = new Set<() => Promise<void>>();
const synchronizationGenerations = new Map<string, string>();

afterEach(async () => {
  vi.useRealTimers();
  synchronizationGenerations.clear();
  vi.restoreAllMocks();
  await Promise.all([...cleanups].map((cleanup) => cleanup()));
  cleanups.clear();
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
});

describe("host synchronization", () => {
  it("persists the canonical baseline before accepting incremental edits", async () => {
    const fixture = await startHost(undefined, { materializeDelayMs: 60_000 });
    await fixture.hierarchy.savePageContent(fixture.sectionId, fixture.pageId, [markdownRecord()], {
      [MARKDOWN_ID]: "canonical baseline",
    });
    const value = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(value.destroy()));
    await synced(value);
    const directory = join(fixture.root, ".squillpad-runtime", "sync");
    const snapshot = (await readdir(directory)).find((name) => name.endsWith(".snapshot"));
    expect(snapshot).toBeDefined();
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, await readFile(join(directory, snapshot!)));
      expect(materializePageDocument(restored).markdown[MARKDOWN_ID]).toBe("canonical baseline");
    } finally {
      restored.destroy();
    }
    const cleanup = await fixture.synchronization.cleanupRuntimeCache();
    expect(cleanup.removedFileCount).toBe(0);
    await access(join(directory, snapshot!));
    updateMarkdownSource(value.document, MARKDOWN_ID, "journal edit");
    const journal = join(directory, snapshot!.replace(/\.snapshot$/, ".updates"));
    await eventually(async () => (await readFile(journal)).length > 0);
    const replay = new Y.Doc();
    try {
      Y.applyUpdate(replay, await readFile(join(directory, snapshot!)));
      const bytes = await readFile(journal);
      for (let offset = 0; offset < bytes.length; ) {
        const length = bytes.readUInt32BE(offset);
        offset += 4;
        Y.applyUpdate(replay, bytes.subarray(offset, offset + length));
        offset += length;
      }
      expect(materializePageDocument(replay).markdown[MARKDOWN_ID]).toBe("journal edit");
    } finally {
      replay.destroy();
    }
  });

  it("broadcasts immediately while merging rapid runtime updates into one journal frame", async () => {
    const fixture = await startHost(undefined, {
      materializeDelayMs: 60_000,
      runtimeFlushDelayMs: 500,
    });
    const sender = client(fixture.url, fixture.projectId, fixture.pageId);
    const receiver = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(sender.destroy()));
    cleanups.add(() => Promise.resolve(receiver.destroy()));
    await Promise.all([synced(sender), synced(receiver)]);
    const directory = join(fixture.root, ".squillpad-runtime", "sync");
    const snapshot = (await readdir(directory)).find((name) => name.endsWith(".snapshot"));
    if (snapshot === undefined) throw new Error("Missing runtime snapshot");
    const journal = join(directory, snapshot.replace(/\.snapshot$/, ".updates"));

    replacePageContent(sender.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "one" },
    });
    updateMarkdownSource(sender.document, MARKDOWN_ID, "two");
    updateMarkdownSource(sender.document, MARKDOWN_ID, "three");

    await eventually(
      () => materializePageDocument(receiver.document).markdown[MARKDOWN_ID] === "three",
    );
    expect((await readFile(journal)).length).toBe(0);
    await eventually(async () => (await readFile(journal)).length > 0);
    expect(countUpdateFrames(await readFile(journal))).toBe(1);
  });

  it("enforces the client limit, reserves the host slot, and keeps existing clients", async () => {
    const fixture = await startHost(undefined, { clientLimit: 2 });
    expect(fixture.synchronization.status()).toMatchObject({
      clientLimit: 2,
      connectedClients: 0,
      clientSlotsUsed: 1,
    });

    const host = client(fixture.url, fixture.projectId, fixture.pageId);
    const collaborator = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(host.destroy()));
    cleanups.add(() => Promise.resolve(collaborator.destroy()));
    await Promise.all([synced(host), synced(collaborator)]);
    expect(fixture.synchronization.status()).toMatchObject({
      clientLimit: 2,
      connectedClients: 2,
      clientSlotsUsed: 2,
    });

    const room = `${fixture.url}/${fixture.synchronization.status().synchronizationGeneration}:${fixture.projectId}:${fixture.pageId}`;
    expect(await rejectedSocket(room)).toBe(429);

    fixture.synchronization.setClientLimit(1);
    expect(fixture.synchronization.status()).toMatchObject({
      clientLimit: 1,
      connectedClients: 2,
      clientSlotsUsed: 2,
    });
    expect(await rejectedSocket(room)).toBe(429);
    expect(host.provider.wsconnected).toBe(true);
    expect(collaborator.provider.wsconnected).toBe(true);
  });

  it("closes rooms from another project without resetting the socket", async () => {
    const fixture = await startHost();
    const socket = new WebSocket(
      `${fixture.url}/${fixture.synchronization.status().synchronizationGeneration}:00000000-0000-4000-8000-000000000000:${fixture.pageId}`,
    );
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for room closure")),
        4_000,
      );
      socket.once("error", () => undefined);
      socket.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(closeCode).toBe(4404);
  });

  it("keeps repository-operation reconnects transient for live clients", async () => {
    const fixture = await startHost();
    const value = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(value.destroy()));
    await synced(value);

    const statuses: string[] = [];
    const unsubscribe = value.subscribe((status) => statuses.push(status));
    const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
      value.provider.once("closed", resolve);
    });
    const release = await fixture.synchronization.beginRepositoryOperation();
    try {
      await expect(closed).resolves.toEqual({
        code: REPOSITORY_OPERATION_CLOSE_CODE,
        reason: REPOSITORY_OPERATION_CLOSE_REASON,
      });
      expect(value.status).not.toBe("error");
    } finally {
      release();
      unsubscribe();
    }

    await synced(value);
    expect(statuses).not.toContain("error");
  });

  it("handles reset upgrade sockets without crashing the host", async () => {
    const fixture = await startHost();
    const address = fixture.server.address();
    if (address === null || typeof address === "string") throw new Error("Missing host address");
    const socket = new PassThrough();
    fixture.server.emit(
      "upgrade",
      {
        url: "/not-a-sync-route",
        headers: { host: `127.0.0.1:${address.port}` },
        socket: { localPort: address.port, remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      socket,
      Buffer.alloc(0),
    );

    expect(() =>
      socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    ).not.toThrow();
  });

  it("synchronizes Markdown and ink bidirectionally, including offline edits", async () => {
    const fixture = await startHost();
    const left = client(fixture.url, fixture.projectId, fixture.pageId);
    const right = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(left.destroy()));
    cleanups.add(() => Promise.resolve(right.destroy()));
    await Promise.all([synced(left), synced(right)]);

    replacePageContent(left.document, {
      canvas: [markdownRecord(), inkRecord(10)],
      markdown: { [MARKDOWN_ID]: "shared" },
    });
    await eventually(() => materializePageDocument(right.document).canvas.length === 2);
    expect(materializePageDocument(right.document).markdown[MARKDOWN_ID]).toBe("shared");

    updateMarkdownSource(right.document, MARKDOWN_ID, "shared from right");
    await eventually(
      () => materializePageDocument(left.document).markdown[MARKDOWN_ID] === "shared from right",
    );

    right.provider.disconnect();
    await eventually(() => right.status === "offline");
    const offline = materializePageDocument(right.document);
    replacePageContent(right.document, {
      markdown: { [MARKDOWN_ID]: "offline text" },
      canvas: offline.canvas.map((record) =>
        record.id === INK_ID ? { ...record, position: [80, 90] } : record,
      ),
    });
    right.provider.connect();
    await synced(right);
    await eventually(() => {
      const page = materializePageDocument(left.document);
      return (
        page.markdown[MARKDOWN_ID] === "offline text" &&
        page.canvas.find((record) => record.id === INK_ID)?.position[0] === 80
      );
    });
  });

  it("reports an orderly host shutdown to connected clients", async () => {
    const fixture = await startHost();
    const value = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(value.destroy()));
    await synced(value);
    const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
      value.provider.on("closed", resolve);
    });

    await fixture.synchronization.close({ notifyClients: true });

    await expect(closed).resolves.toEqual({
      code: HOST_STOPPED_CLOSE_CODE,
      reason: HOST_STOPPED_CLOSE_REASON,
    });
    expect(value.status).toBe("host-stopped");
  });

  it("reports an unannounced host disconnect to connected clients", async () => {
    const fixture = await startHost();
    const value = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(value.destroy()));
    await synced(value);

    await fixture.synchronization.close();

    await eventually(() => value.status === "host-disconnected");
  });

  it("keeps disabled-sharing edits in memory until a manual page save", async () => {
    let saves = 0;
    const save = async (sectionId: string, pageId: string, content: StoredPageContent) => {
      saves += 1;
      const current = await fixturePromise;
      await current.hierarchy.savePageContent(sectionId, pageId, content.canvas, content.markdown);
    };
    const fixturePromise = startHost(save, {
      sharingEnabled: false,
      autosaveIntervalSeconds: 0,
    });
    const fixture = await fixturePromise;
    const value = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(value.destroy()));
    await synced(value);

    replacePageContent(value.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "memory only" },
    });
    await eventually(
      () =>
        fixture.synchronization.status().canonical?.[`${fixture.projectId}:${fixture.pageId}`]
          ?.dirty === true,
    );
    expect(saves).toBe(0);
    expect((await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown).toEqual(
      {},
    );

    await fixture.synchronization.flushPage(fixture.pageId);
    expect(saves).toBe(1);
    expect(
      (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[MARKDOWN_ID],
    ).toBe("memory only");
    expect(
      fixture.synchronization.status().canonical?.[`${fixture.projectId}:${fixture.pageId}`]?.dirty,
    ).toBe(false);
  });

  it("autosaves within the selected interval during continuous editing", async () => {
    let saves = 0;
    let resolveSave: (() => void) | undefined;
    const saveCompleted = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const fixturePromise = startHost(
      async (sectionId, pageId, content) => {
        saves += 1;
        const current = await fixturePromise;
        await current.hierarchy.savePageContent(
          sectionId,
          pageId,
          content.canvas,
          content.markdown,
        );
        resolveSave?.();
      },
      { sharingEnabled: false, autosaveIntervalSeconds: 10 },
    );
    const fixture = await fixturePromise;
    const sender = client(fixture.url, fixture.projectId, fixture.pageId);
    const receiver = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(sender.destroy()));
    cleanups.add(() => Promise.resolve(receiver.destroy()));
    await Promise.all([synced(sender), synced(receiver)]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const receivedFirst = new Promise<void>((resolve) => {
      receiver.document.on("update", () => {
        if (materializePageDocument(receiver.document).markdown[MARKDOWN_ID] === "first") resolve();
      });
    });
    replacePageContent(sender.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "first" },
    });
    await receivedFirst;
    const autosaveCalls = () => timeoutSpy.mock.calls.filter(([, delay]) => delay === 10_000);
    await eventually(() => autosaveCalls().length === 1);
    const statusKey = `${fixture.projectId}:${fixture.pageId}`;
    const firstRevision = fixture.synchronization.status().canonical?.[statusKey]?.revision ?? 0;
    const received = new Promise<void>((resolve) => {
      receiver.document.on("update", () => {
        if (materializePageDocument(receiver.document).markdown[MARKDOWN_ID] === "second")
          resolve();
      });
    });
    updateMarkdownSource(sender.document, MARKDOWN_ID, "second");
    await received;
    await eventually(
      () =>
        (fixture.synchronization.status().canonical?.[statusKey]?.revision ?? 0) > firstRevision,
    );
    expect(autosaveCalls()).toHaveLength(1);

    const autosaveCallIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 10_000);
    const callback = timeoutSpy.mock.calls[autosaveCallIndex]?.[0];
    const timer = timeoutSpy.mock.results[autosaveCallIndex]?.value;
    if (typeof callback !== "function" || timer === undefined) {
      throw new Error("Missing autosave timer");
    }
    callback();
    clearTimeout(timer);

    await saveCompleted;
    expect(saves).toBe(1);
    expect(
      (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[MARKDOWN_ID],
    ).toBe("second");
  });

  it("does not cancel real-time persistence when the disabled-mode interval changes", async () => {
    let saves = 0;
    const fixturePromise = startHost(
      async (sectionId, pageId, content) => {
        saves += 1;
        const current = await fixturePromise;
        await current.hierarchy.savePageContent(
          sectionId,
          pageId,
          content.canvas,
          content.markdown,
        );
      },
      { materializeDelayMs: 80 },
    );
    const fixture = await fixturePromise;
    const value = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(value.destroy()));
    await synced(value);

    replacePageContent(value.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "real-time save" },
    });
    await eventually(
      () =>
        fixture.synchronization.status().canonical?.[`${fixture.projectId}:${fixture.pageId}`]
          ?.dirty === true,
    );
    fixture.synchronization.setAutosaveIntervalSeconds(300);

    await eventually(async () => {
      if (saves !== 1) return false;
      return (
        (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[
          MARKDOWN_ID
        ] === "real-time save"
      );
    });
    expect(
      (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[MARKDOWN_ID],
    ).toBe("real-time save");
  });

  it("broadcasts laser pointer presence without materializing it", async () => {
    const fixture = await startHost();
    const sender = client(fixture.url, fixture.projectId, fixture.pageId);
    const receiver = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(sender.destroy()));
    cleanups.add(() => Promise.resolve(receiver.destroy()));
    await Promise.all([synced(sender), synced(receiver)]);
    let remotePresence: readonly { readonly state: Readonly<Record<string, unknown>> }[] = [];
    const unsubscribe = receiver.subscribePresence((presence) => {
      remotePresence = presence;
    });
    const laser = {
      active: true,
      color: "#ef3e58",
      id: "laser-gesture",
      points: [{ x: 12, y: 34 }],
    };
    sender.setPresence({ laser: [laser] });
    await eventually(() => remotePresence.some((entry) => entry.state.laser !== undefined));
    expect(remotePresence.map((entry) => entry.state.laser)).toContainEqual([laser]);
    const nextLaser = { ...laser, active: false, id: "next-laser" };
    sender.setPresenceField("laser", [laser, nextLaser]);
    await eventually(() =>
      remotePresence.some(
        (entry) => Array.isArray(entry.state.laser) && entry.state.laser.length === 2,
      ),
    );
    expect(remotePresence[0]?.state.laser).toEqual([laser, nextLaser]);
    const geometry = {
      kind: "move",
      elementIds: [INK_ID],
      delta: { x: 5, y: 8 },
    };
    sender.setPresenceField("geometry", geometry);
    await eventually(() => remotePresence.some((entry) => entry.state.geometry !== undefined));
    expect(remotePresence[0]?.state).toMatchObject({ laser: [laser, nextLaser], geometry });
    sender.setPresenceField("geometry", undefined);
    await eventually(() => remotePresence.every((entry) => entry.state.geometry === undefined));
    expect(remotePresence[0]?.state.laser).toEqual([laser, nextLaser]);
    expect(materializePageDocument(receiver.document)).toEqual({ canvas: [], markdown: {} });
    sender.setPresence(null);
    await eventually(() => remotePresence.length === 0);
    unsubscribe();
  });

  it("tracks named project presence independently for each client", async () => {
    const fixture = await startHost();
    expect(
      fixture.synchronization.updateProjectPresence("first-client", "alice", "192.168.1.20"),
    ).toEqual([{ id: "first-client", username: "alice", ipAddress: "192.168.1.20" }]);
    expect(
      fixture.synchronization.updateProjectPresence("second-client", "alice", "192.168.1.21"),
    ).toEqual([
      { id: "first-client", username: "alice", ipAddress: "192.168.1.20" },
      { id: "second-client", username: "alice", ipAddress: "192.168.1.21" },
    ]);
    expect(fixture.synchronization.removeProjectPresence("first-client")).toEqual([
      { id: "second-client", username: "alice", ipAddress: "192.168.1.21" },
    ]);
  });

  it("restores runtime history after host restart and recovers corrupt snapshots", async () => {
    const fixture = await startHost();
    const first = client(fixture.url, fixture.projectId, fixture.pageId);
    await synced(first);
    replacePageContent(first.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "survives restart" },
    });
    await eventually(async () => {
      try {
        const canonical = await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId);
        return canonical.markdown[MARKDOWN_ID] === "survives restart";
      } catch {
        return false;
      }
    });
    first.destroy();
    await fixture.stop();

    const restarted = await restartHost(fixture);
    const second = client(restarted.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(second.destroy()));
    await synced(second);
    expect(materializePageDocument(second.document).markdown[MARKDOWN_ID]).toBe("survives restart");

    second.destroy();
    await restarted.stop();
    const syncDirectory = join(fixture.root, ".squillpad-runtime", "sync");
    const snapshot = (await import("node:fs/promises"))
      .readdir(syncDirectory)
      .then((names) => names.find((name) => name.endsWith(".snapshot")));
    const snapshotName = await snapshot;
    if (snapshotName === undefined) throw new Error("Missing runtime snapshot");
    await writeFile(join(syncDirectory, snapshotName), "corrupt");
    const recovered = await restartHost(fixture);
    cleanups.add(recovered.stop);
    const third = client(recovered.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(third.destroy()));
    await synced(third);
    expect(materializePageDocument(third.document).markdown[MARKDOWN_ID]).toBe("survives restart");
    await eventually(async () => {
      try {
        const names = await (await import("node:fs/promises")).readdir(syncDirectory);
        return names.some((name) => name.includes(".corrupt-"));
      } catch {
        return false;
      }
    });
    await access(join(fixture.root, ".squillpad-runtime", ".gitignore"));
  });

  it("fences stale host and device CRDT state after a canonical snapshot replacement", async () => {
    const fixture = await startHost();
    const oldGeneration = fixture.synchronization.status().synchronizationGeneration;
    const oldClient = client(fixture.url, fixture.projectId, fixture.pageId, oldGeneration);
    cleanups.add(() => Promise.resolve(oldClient.destroy()));
    await synced(oldClient);
    replacePageContent(oldClient.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "stale device value" },
    });
    await fixture.synchronization.flush();
    oldClient.provider.disconnect();

    await fixture.hierarchy.savePageContent(fixture.sectionId, fixture.pageId, [markdownRecord()], {
      [MARKDOWN_ID]: "authoritative remote value",
    });
    await fixture.synchronization.reloadCanonicalProject(fixture.projectId);
    const newGeneration = fixture.synchronization.status().synchronizationGeneration;
    expect(newGeneration).not.toBe(oldGeneration);

    oldClient.provider.connect();
    await eventually(() => oldClient.status === "project-reloaded");
    expect(materializePageDocument(oldClient.document).markdown[MARKDOWN_ID]).toBe(
      "stale device value",
    );

    const currentClient = client(fixture.url, fixture.projectId, fixture.pageId, newGeneration);
    cleanups.add(() => Promise.resolve(currentClient.destroy()));
    await synced(currentClient);
    expect(materializePageDocument(currentClient.document).markdown[MARKDOWN_ID]).toBe(
      "authoritative remote value",
    );
    expect(
      (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[MARKDOWN_ID],
    ).toBe("authoritative remote value");
  });

  it("ingests an external Markdown edit without waiting for a page reload", async () => {
    const fixture = await startHost();
    const clientValue = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(clientValue.destroy()));
    await synced(clientValue);
    replacePageContent(clientValue.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "before" },
    });
    await eventually(async () => {
      try {
        return (
          (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[
            MARKDOWN_ID
          ] === "before"
        );
      } catch {
        return false;
      }
    });

    await writeFile(markdownPath(fixture, MARKDOWN_ID), "edited outside the app\n", "utf8");
    await eventually(
      () =>
        materializePageDocument(clientValue.document).markdown[MARKDOWN_ID] ===
        "edited outside the app\n",
    );
    expect(
      (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[MARKDOWN_ID],
    ).toBe("edited outside the app\n");
  });

  it("reconciles an externally edited canvas record by stable object ID", async () => {
    const fixture = await startHost();
    const clientValue = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(clientValue.destroy()));
    await synced(clientValue);
    const initialInk = inkRecord(10);
    replacePageContent(clientValue.document, {
      canvas: [markdownRecord(), initialInk],
      markdown: { [MARKDOWN_ID]: "canvas" },
    });
    await eventually(async () => {
      try {
        const page = await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId);
        return page.canvas.some((record) => record.id === INK_ID);
      } catch {
        return false;
      }
    });

    const movedInk = { ...initialInk, position: [88, 99] as const };
    await writeFile(
      canvasPath(fixture),
      serializeCanvasJsonLines([markdownRecord(), movedInk]),
      "utf8",
    );
    await eventually(() => {
      const record = materializePageDocument(clientValue.document).canvas.find(
        (candidate) => candidate.id === INK_ID,
      );
      return record?.position[0] === 88 && record.position[1] === 99;
    });

    await writeFile(canvasPath(fixture), serializeCanvasJsonLines([markdownRecord()]), "utf8");
    await eventually(() => materializePageDocument(clientValue.document).canvas.length === 1);
  });

  it("coalesces a multi-file external rescan and keeps malformed files untouched", async () => {
    const fixture = await startHost();
    const clientValue = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(clientValue.destroy()));
    await synced(clientValue);
    const initialInk = inkRecord(4);
    replacePageContent(clientValue.document, {
      canvas: [markdownRecord(), initialInk],
      markdown: { [MARKDOWN_ID]: "initial" },
    });
    await eventually(async () => {
      try {
        return (
          (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[
            MARKDOWN_ID
          ] === "initial"
        );
      } catch {
        return false;
      }
    });

    await Promise.all([
      writeFile(markdownPath(fixture, MARKDOWN_ID), "from a branch\n", "utf8"),
      writeFile(
        canvasPath(fixture),
        serializeCanvasJsonLines([markdownRecord(), { ...initialInk, position: [64, 65] }]),
        "utf8",
      ),
    ]);
    await eventually(() => {
      const page = materializePageDocument(clientValue.document);
      const ink = page.canvas.find((record) => record.id === INK_ID);
      return page.markdown[MARKDOWN_ID] === "from a branch\n" && ink?.position[0] === 64;
    });

    const malformed = "{ this is not JSONL }\n";
    await writeFile(canvasPath(fixture), malformed, "utf8");
    await eventually(
      () =>
        fixture.synchronization.status().canonical?.[`${fixture.projectId}:${fixture.pageId}`]
          ?.status === "error",
    );
    expect(await readFile(canvasPath(fixture), "utf8")).toBe(malformed);
    await expect(fixture.stop()).rejects.toThrow();
  });

  it("rescans externally changed hierarchy manifests while the host is open", async () => {
    const fixture = await startHost();
    const tree = await fixture.hierarchy.load();
    const section = tree.sections[0];
    if (section === undefined) throw new Error("Missing fixture section");
    const sectionFile = join(fixture.root, "sections", section.manifest.id, "section.json");
    await writeFile(
      sectionFile,
      serializeCanonicalJson({ ...section.manifest, title: "Edited by Git" }),
      "utf8",
    );
    await eventually(() => (fixture.synchronization.status().hierarchyRevision ?? 0) > 0);
    expect((await fixture.hierarchy.load()).sections[0]?.manifest.title).toBe("Edited by Git");
  });

  it("debounces rapid synchronized edits and persists the final revision", async () => {
    let calls = 0;
    const save = async (sectionId: string, pageId: string, content: StoredPageContent) => {
      calls += 1;
      const current = await fixturePromise;
      await current.hierarchy.savePageContent(sectionId, pageId, content.canvas, content.markdown);
    };
    const fixturePromise = startHost(save, { materializeDelayMs: 60 });
    const fixture = await fixturePromise;
    const clientValue = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(clientValue.destroy()));
    await synced(clientValue);
    replacePageContent(clientValue.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "one" },
    });
    updateMarkdownSource(clientValue.document, MARKDOWN_ID, "two");
    updateMarkdownSource(clientValue.document, MARKDOWN_ID, "three");

    await eventually(async () => {
      try {
        return (
          (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[
            MARKDOWN_ID
          ] === "three"
        );
      } catch {
        return false;
      }
    });
    expect(calls).toBe(1);
  });

  it("reports a failed canonical save instead of claiming the page is saved", async () => {
    let fail = true;
    const save = async (sectionId: string, pageId: string, content: StoredPageContent) => {
      if (fail) throw new Error("injected canonical write failure");
      const current = await fixturePromise;
      await current.hierarchy.savePageContent(sectionId, pageId, content.canvas, content.markdown);
    };
    const fixturePromise = startHost(save);
    const fixture = await fixturePromise;
    const clientValue = client(fixture.url, fixture.projectId, fixture.pageId);
    cleanups.add(() => Promise.resolve(clientValue.destroy()));
    await synced(clientValue);
    replacePageContent(clientValue.document, {
      canvas: [markdownRecord()],
      markdown: { [MARKDOWN_ID]: "unsaved" },
    });
    await eventually(
      () =>
        fixture.synchronization.status().canonical?.[`${fixture.projectId}:${fixture.pageId}`]
          ?.status === "error",
    );
    expect((await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown).toEqual(
      {},
    );
    await expect(fixture.synchronization.flush()).rejects.toThrow(
      "injected canonical write failure",
    );

    fail = false;
    updateMarkdownSource(clientValue.document, MARKDOWN_ID, "saved after retry");
    await eventually(
      () =>
        fixture.synchronization.status().canonical?.[`${fixture.projectId}:${fixture.pageId}`]
          ?.status === "saved",
    );
    expect(
      (await fixture.hierarchy.loadPage(fixture.sectionId, fixture.pageId)).markdown[MARKDOWN_ID],
    ).toBe("saved after retry");
  });
});

async function startHost(
  materializePage?: (
    sectionId: string,
    pageId: string,
    content: StoredPageContent,
  ) => Promise<void>,
  options: HostTimingOptions = {},
) {
  const root = join(await mkdtemp(join(tmpdir(), "squillpad-sync-")), "project");
  const session = await createProject(root);
  sessions.add(session);
  const hierarchy = new ProjectHierarchyService(session);
  const tree = await hierarchy.load();
  const sectionId = tree.sections[0]?.manifest.id as string;
  const pageId = tree.sections[0]?.pages[0]?.id as string;
  return launch(
    {
      root,
      session,
      hierarchy,
      sectionId,
      pageId,
      projectId: tree.notebook.projectId,
    },
    materializePage,
    options,
  );
}

async function restartHost(fixture: Awaited<ReturnType<typeof startHost>>) {
  return launch(fixture);
}

async function launch<T extends HostFixtureBase>(
  fixture: T,
  materializePage?: (
    sectionId: string,
    pageId: string,
    content: StoredPageContent,
  ) => Promise<void>,
  options: HostTimingOptions = {},
) {
  const synchronization = new HostSynchronizationService({
    hierarchy: fixture.hierarchy,
    projectId: fixture.projectId,
    projectRoot: fixture.root,
    ...(materializePage === undefined ? {} : { materializePage }),
    ...options,
  });
  await synchronization.ready();
  const server = createHostServer({ hierarchy: fixture.hierarchy, synchronization });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host address");
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await synchronization.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  cleanups.add(stop);
  const url = `ws://127.0.0.1:${address.port}/sync`;
  synchronizationGenerations.set(url, synchronization.status().synchronizationGeneration);
  return {
    ...fixture,
    server,
    synchronization,
    stop,
    url,
  };
}

interface HostFixtureBase {
  readonly root: string;
  readonly session: ProjectSession;
  readonly hierarchy: ProjectHierarchyService;
  readonly sectionId: string;
  readonly pageId: string;
  readonly projectId: string;
}

type HostTimingOptions = Pick<
  HostSynchronizationOptions,
  | "materializeDelayMs"
  | "canonicalRescanDelayMs"
  | "runtimeFlushDelayMs"
  | "runtimeFlushSizeBytes"
  | "sharingEnabled"
  | "clientLimit"
  | "autosaveIntervalSeconds"
>;

function client(
  url: string,
  projectId: string,
  pageId: string,
  generation = fixtureSynchronizationGeneration(url),
): PageSyncClient {
  return new PageSyncClient({
    document: createPageDocument(),
    projectId,
    pageId,
    synchronizationGeneration: generation,
    serverUrl: url,
    disableIndexedDb: true,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
}

function fixtureSynchronizationGeneration(url: string): string {
  const generation = synchronizationGenerations.get(url);
  if (generation === undefined) throw new Error("Missing fixture synchronization generation");
  return generation;
}

function rejectedSocket(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("Client-limit connection unexpectedly opened"));
    });
    socket.on("error", () => undefined);
  });
}

function synced(value: PageSyncClient): Promise<void> {
  if (value.status === "synchronized") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `Client did not synchronize (${value.status}, connected=${value.provider.wsconnected}, connecting=${value.provider.wsconnecting}, url=${value.provider.url})`,
          ),
        ),
      4_000,
    );
    value.provider.on("closed", (event: { code: number; reason: string }) => {
      clearTimeout(timeout);
      reject(new Error(`Synchronization closed (${event.code}): ${event.reason}`));
    });
    const unsubscribe = value.subscribe((status) => {
      if (status !== "synchronized") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function markdownRecord(): MarkdownCanvasRecord {
  return {
    id: MARKDOWN_ID,
    kind: "markdown" as const,
    position: [0, 0],
    z: 0,
    width: 320,
    height: 160,
    source: `markdown/${MARKDOWN_ID}.md`,
  };
}

function inkRecord(x = 0): InkCanvasRecord {
  return {
    id: INK_ID,
    kind: "ink" as const,
    position: [x, 20],
    z: 1,
    points: [
      [0, 0],
      [20, 10],
    ],
    style: { color: "#000000", width: 3, opacity: 1, highlighter: false },
  };
}

function markdownPath(fixture: HostFixtureBase, objectId: string): string {
  return join(
    fixture.root,
    "sections",
    fixture.sectionId,
    "pages",
    fixture.pageId,
    "markdown",
    `${objectId}.md`,
  );
}

function countUpdateFrames(bytes: Buffer): number {
  let count = 0;
  for (let offset = 0; offset < bytes.length; count += 1) {
    const length = bytes.readUInt32BE(offset);
    offset += 4 + length;
  }
  return count;
}

function canvasPath(fixture: HostFixtureBase): string {
  return join(fixture.root, "sections", fixture.sectionId, "pages", fixture.pageId, "canvas.jsonl");
}
