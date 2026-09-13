import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositorySynchronization } from "./RepositorySynchronization";
import { RepositorySnapshotReview } from "./RepositorySnapshotReview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe("RepositorySynchronization", () => {
  it("shows host setup instructions in an accessible hover tooltip", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ available: true, configured: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await renderSynchronization();

    const button = container!.querySelector<HTMLButtonElement>(".repository-sync-button");
    expect(button?.textContent).toContain("Sync");
    await act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return Promise.resolve();
    });
    expect(container!.querySelector("dialog")?.textContent).toContain(
      "Cross-host snapshot synchronization",
    );
    const help = container!.querySelector<HTMLButtonElement>(".repository-sync-help");
    expect(help?.getAttribute("aria-describedby")).toBe("repository-sync-instructions");
    expect(container!.querySelector('[role="tooltip"]')?.textContent).toContain(
      "Configure SSH keys or a Git credential manager outside SquillPad.",
    );
    expect(container!.querySelector(".repository-sync-instructions")).toBeNull();
    expect(container!.querySelector('input[type="url"]')).not.toBeNull();
  });

  it("does not expose the button when the host rejects the capability request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "host only" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    await renderSynchronization();
    expect(container!.querySelector(".repository-sync-button")).toBeNull();
  });

  it("marks the sync action with the active theme", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ available: true, configured: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outcome: "up-to-date",
            message: "Local and GitHub snapshots are up to date.",
            remoteUpdateAvailable: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await renderSynchronization("dark");
    const launcher = container!.querySelector<HTMLButtonElement>(".repository-sync-button");
    await act(() => {
      launcher?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return Promise.resolve();
    });

    expect(container!.querySelector(".repository-sync-run-button--dark")).not.toBeNull();
  });

  it("checks configured repositories on launch and waits for approval before syncing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: true,
            configured: true,
            remoteUrl: "https://github.com/example/notebook.git",
            branch: "main",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outcome: "sync-needed",
            message: "GitHub has a newer project snapshot ready for review.",
            remoteUpdateAvailable: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container!.querySelector("dialog")).not.toBeNull();
    expect(container!.textContent).toContain(
      "GitHub has a newer project snapshot ready for review.",
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "/api/repository-sync/run",
    );
  });

  it("shows both snapshots and all three conflict choices in the sync view", async () => {
    const localCommit = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Local Author",
      message: "Add text box",
      changedPaths: ["sections/section/pages/page/canvas.jsonl"],
      affectedPages: [{ sectionId: "section", pageId: "page", title: "Page" }],
    };
    const remoteCommit = {
      ...localCommit,
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      author: "GitHub Author",
      message: "Add line",
    };
    const page = {
      manifest: { id: "page", title: "Page" },
      canvas: [
        {
          id: "323e4567-e89b-42d3-a456-426614174002",
          kind: "shape",
          position: [20, 30],
          z: 0,
          geometry: { kind: "line", start: [0, 0], end: [100, 80] },
          style: {
            strokeColor: "#000000",
            strokeWidth: 2,
            fillColor: null,
            opacity: 1,
          },
        },
      ],
      markdown: {},
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          available: true,
          configured: true,
          remoteUrl: "https://github.com/example/notebook.git",
          branch: "main",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "up-to-date",
          message: "Local and GitHub snapshots are up to date.",
          remoteUpdateAvailable: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          outcome: "up-to-date",
          publishLocal: { insertions: 0, deletions: 0 },
          applyRemote: { insertions: 0, deletions: 0 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "conflict",
          message: "Local and GitHub both changed.",
          conflict: {
            local: localCommit,
            remote: remoteCommit,
            publishLocal: { insertions: 3, deletions: 1 },
            applyRemote: { insertions: 1, deletions: 3 },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          hierarchy: {
            notebook: {},
            sections: [
              {
                manifest: { id: "section", title: "Notes", pageIds: ["page"] },
                pages: [{ id: "page", title: "Page" }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          hierarchy: {
            notebook: {},
            sections: [
              {
                manifest: { id: "section", title: "Notes", pageIds: ["page"] },
                pages: [{ id: "page", title: "Page" }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page));
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "/api/repository-sync/check",
    );
    await act(async () => {
      container!.querySelector<HTMLButtonElement>(".repository-sync-button")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(".repository-sync-actions .repository-sync-run-button")
        ?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "/api/repository-sync/run",
    );

    expect(container!.querySelector('[aria-label="Snapshot review"]')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Snapshot changes"]')).not.toBeNull();
    expect(
      [
        ...container!.querySelectorAll<HTMLElement>(
          ".repository-sync-review-diff .repository-change-bar__segment",
        ),
      ].map((segment) => segment.style.width),
    ).toEqual(["75%", "25%", "25%", "75%"]);
    expect(
      container!.querySelectorAll(".repository-sync-preview-canvases .spatial-canvas"),
    ).toHaveLength(2);
    const actions = [
      ...container!.querySelectorAll<HTMLButtonElement>(".repository-sync-review-actions button"),
    ].map((button) => button.textContent?.trim());
    expect(actions).toEqual([
      "Combine both changes",
      "Use GitHub snapshot for local contents",
      "Use local snapshot for GitHub contents",
    ]);
  });

  it("keeps the GitHub review pane on the fetched GitHub page when local IDs differ", async () => {
    const localCommit = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Local Author",
      message: "Local project",
      changedPaths: ["notebook.json"],
      affectedPages: [{ sectionId: "local-section", pageId: "local-page", title: "Page" }],
    };
    const remoteCommit = {
      ...localCommit,
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      author: "GitHub Author",
      message: "GitHub project",
      affectedPages: [],
    };
    const localHierarchy = {
      notebook: {},
      sections: [
        {
          manifest: { id: "local-section", title: "Section 1", pageIds: ["local-page"] },
          pages: [{ id: "local-page", title: "Page" }],
        },
      ],
    };
    const remoteHierarchy = {
      notebook: {},
      sections: [
        {
          manifest: { id: "remote-section", title: "Section 1", pageIds: ["remote-page"] },
          pages: [{ id: "remote-page", title: "Page" }],
        },
      ],
    };
    const remotePage = { manifest: { id: "remote-page", title: "Page" }, canvas: [], markdown: {} };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/repository-sync/history/snapshot") {
        const body = JSON.parse(String(init?.body)) as { commit: string };
        return jsonResponse({
          hierarchy: body.commit === localCommit.commit ? localHierarchy : remoteHierarchy,
        });
      }
      if (path === "/api/repository-sync/history/page") {
        const body = JSON.parse(String(init?.body)) as { commit: string };
        expect(body.commit).toBe(remoteCommit.commit);
        return jsonResponse(remotePage);
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RepositorySnapshotReview
          busy={false}
          onResult={() => undefined}
          review={{ kind: "conflict", local: localCommit, remote: remoteCommit }}
          theme="light"
        />,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    const panes = container.querySelectorAll<HTMLElement>(".repository-sync-preview-canvas");
    expect(panes[0]?.textContent).toContain("This page is not present in this snapshot.");
    expect(panes[1]?.querySelector(".spatial-canvas")).not.toBeNull();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Review section"]')?.value).toBe(
      "remote-section",
    );
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Review page"]')?.value).toBe(
      "remote-page",
    );
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="Local-only page"]'),
    ).not.toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/repository-sync/history/page",
      ),
    ).toHaveLength(1);
  });

  it("shows a side-by-side review before applying a newer GitHub snapshot", async () => {
    const local = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Local Author",
      message: "Current snapshot",
      changedPaths: ["sections/section/pages/page/canvas.jsonl"],
      affectedPages: [{ sectionId: "section", pageId: "page", title: "Page" }],
    };
    const remote = {
      ...local,
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      author: "GitHub Author",
      message: "Newer GitHub snapshot",
    };
    const hierarchy = {
      notebook: {},
      sections: [
        {
          manifest: { id: "section", title: "Notes", pageIds: ["page"] },
          pages: [{ id: "page", title: "Page" }],
        },
      ],
    };
    const page = { manifest: { id: "page", title: "Page" }, canvas: [], markdown: {} };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          available: true,
          configured: true,
          remoteUrl: "https://github.com/example/notebook.git",
          branch: "main",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "sync-needed",
          message: "GitHub has a newer project snapshot ready for visual review.",
          remoteUpdateAvailable: true,
          review: {
            kind: "remote-update",
            local,
            remote,
            publishLocal: { insertions: 2, deletions: 1 },
            applyRemote: { insertions: 1, deletions: 2 },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ hierarchy }))
      .mockResolvedValueOnce(jsonResponse({ hierarchy }))
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page));
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(container!.querySelector('[aria-label="Snapshot review"]')).not.toBeNull();
    expect(container!.textContent).toContain("Review the newer GitHub snapshot");
    expect(
      container!.querySelectorAll(".repository-sync-preview-canvases .spatial-canvas"),
    ).toHaveLength(2);
    expect(
      [
        ...container!.querySelectorAll<HTMLButtonElement>(".repository-sync-review-actions button"),
      ].map((button) => button.textContent?.trim()),
    ).toEqual(["Use GitHub snapshot for local contents"]);
    expect(
      container!.querySelector<HTMLButtonElement>(
        ".repository-sync-actions .repository-sync-run-button",
      )?.disabled,
    ).toBe(true);
    expect(
      container!.querySelector<HTMLButtonElement>(
        ".repository-sync-actions button:not(.repository-sync-run-button)",
      )?.disabled,
    ).toBe(true);
    expect(
      container!.querySelector<HTMLButtonElement>('[aria-label="Refresh change comparison"]')
        ?.disabled,
    ).toBe(true);
    expect(container!.querySelector<HTMLButtonElement>('[aria-label="Sync"]')?.disabled).toBe(true);

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Close synchronization dialog"]')
        ?.click();
      await Promise.resolve();
    });
    const sync = container!.querySelector<HTMLButtonElement>('[aria-label="Sync"]');
    expect(sync?.disabled).toBe(false);
    expect(sync?.title).toBe("Reopen the snapshot review to finish or close it");
    await act(async () => {
      sync?.click();
      await Promise.resolve();
    });
    expect(container!.querySelector('[aria-label="Snapshot review"]')).not.toBeNull();
  });

  it("locks parent and sibling actions while a review mutation is running", async () => {
    const local = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Local Author",
      message: "Local snapshot",
      changedPaths: ["notebook.json"],
      affectedPages: [],
    };
    const remote = {
      ...local,
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      author: "GitHub Author",
      message: "GitHub snapshot",
    };
    const hierarchy = {
      notebook: {},
      sections: [
        {
          manifest: { id: "section", title: "Notes", pageIds: ["page"] },
          pages: [{ id: "page", title: "Page" }],
        },
      ],
    };
    const page = { manifest: { id: "page", title: "Page" }, canvas: [], markdown: {} };
    let resolveMutation: ((response: Response) => void) | undefined;
    const mutation = new Promise<Response>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (String(input)) {
        case "/api/repository-sync/status":
          return jsonResponse({
            available: true,
            configured: true,
            remoteUrl: "https://github.com/example/notebook.git",
            branch: "main",
          });
        case "/api/repository-sync/check":
          return jsonResponse({
            outcome: "conflict",
            message: "Local and GitHub both changed.",
            remoteUpdateAvailable: true,
            review: { kind: "conflict", local, remote },
          });
        case "/api/repository-sync/history/snapshot":
          return jsonResponse({ hierarchy });
        case "/api/repository-sync/history/page":
          return jsonResponse(page);
        case "/api/pages/section/page":
          return jsonResponse(page);
        case "/api/repository-sync/resolve":
          return mutation;
        case "/api/repository-sync/comparison":
          return jsonResponse({
            configured: true,
            outcome: "up-to-date",
            publishLocal: { insertions: 0, deletions: 0 },
            applyRemote: { insertions: 0, deletions: 0 },
          });
        default:
          throw new Error(`Unexpected request: ${String(input)}`);
      }
    });

    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    const overwrite = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Use GitHub snapshot for local contents"),
    );
    expect(overwrite?.disabled).toBe(false);
    await act(async () => {
      overwrite?.click();
      await Promise.resolve();
    });

    expect(
      container!.querySelector<HTMLButtonElement>(
        ".repository-sync-actions .repository-sync-run-button",
      )?.disabled,
    ).toBe(true);
    expect(
      container!.querySelector<HTMLButtonElement>(
        ".repository-sync-actions button:not(.repository-sync-run-button)",
      )?.disabled,
    ).toBe(true);
    expect(
      container!.querySelector<HTMLButtonElement>('[aria-label="Close synchronization dialog"]')
        ?.disabled,
    ).toBe(true);
    expect(
      [
        ...container!.querySelectorAll<HTMLButtonElement>(".repository-sync-review-actions button"),
      ].every((button) => button.disabled),
    ).toBe(true);

    const resolveCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/repository-sync/resolve",
    );
    expect(resolveCalls).toHaveLength(1);
    const sibling = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Use local snapshot for GitHub contents"),
    );
    sibling?.click();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/repository-sync/resolve"),
    ).toHaveLength(1);

    resolveMutation?.(jsonResponse({ outcome: "synced", message: "Resolution committed." }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  });

  it("does not refresh comparison before reloading a replaced project", async () => {
    const local = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Local Author",
      message: "Current snapshot",
      changedPaths: ["notebook.json"],
      affectedPages: [],
    };
    const remote = {
      ...local,
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      author: "GitHub Author",
      message: "Newer GitHub snapshot",
    };
    const hierarchy = { notebook: {}, sections: [] };
    let resolveMutation: ((response: Response) => void) | undefined;
    const mutation = new Promise<Response>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (String(input)) {
        case "/api/repository-sync/status":
          return jsonResponse({ available: true, configured: true });
        case "/api/repository-sync/check":
          return jsonResponse({
            outcome: "sync-needed",
            message: "GitHub has a newer project snapshot ready for review.",
            remoteUpdateAvailable: true,
            review: { kind: "remote-update", local, remote },
          });
        case "/api/repository-sync/history/snapshot":
          return jsonResponse({ hierarchy });
        case "/api/repository-sync/apply-remote":
          return mutation;
        default:
          throw new Error(`Unexpected request: ${String(input)}`);
      }
    });
    let reloads = 0;
    await renderSynchronization("light", () => {
      reloads += 1;
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    const apply = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Use GitHub snapshot for local contents"),
    );
    await act(async () => {
      apply?.click();
      resolveMutation?.(
        jsonResponse({
          outcome: "synced",
          message: "Applied the reviewed GitHub project snapshot.",
          projectReloaded: true,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/repository-sync/comparison"),
    ).toHaveLength(0);
    expect(reloads).toBe(1);
  });

  it("requires an explicit per-element choice and keeps the candidate editor toolbar visible", async () => {
    const conflictPath = "sections/section/pages/page/canvas.jsonl#element";
    const local = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Local Author",
      message: "Move locally",
      changedPaths: ["sections/section/pages/page/canvas.jsonl"],
      affectedPages: [{ sectionId: "section", pageId: "page", title: "Page" }],
    };
    const remote = {
      ...local,
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      author: "GitHub Author",
      message: "Move remotely",
    };
    const hierarchy = {
      notebook: {},
      sections: [
        {
          manifest: { id: "section", title: "Notes", pageIds: ["page"] },
          pages: [{ id: "page", title: "Page" }],
        },
      ],
    };
    const element = {
      id: "element",
      kind: "shape" as const,
      position: [20, 30],
      z: 0,
      geometry: { kind: "line" as const, start: [0, 0], end: [100, 80] },
      style: { strokeColor: "#000000", strokeWidth: 2, fillColor: null, opacity: 1 },
    };
    const localPage = {
      manifest: { id: "page", title: "Page" },
      canvas: [element],
      markdown: {},
    };
    const remotePage = {
      ...localPage,
      canvas: [{ ...element, position: [180, 30], z: 5 }],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ hierarchy }))
      .mockResolvedValueOnce(jsonResponse({ hierarchy }))
      .mockResolvedValueOnce(jsonResponse(localPage))
      .mockResolvedValueOnce(jsonResponse(remotePage))
      .mockResolvedValueOnce(
        jsonResponse({
          candidateId: "candidate",
          baseCommit: "fedcbafedcbafedcbafedcbafedcbafedcbafedc",
          local,
          remote,
          hierarchy,
          mergeable: true,
          conflicts: [
            {
              kind: "canvas-record",
              path: conflictPath,
              message: `Both snapshots changed ${conflictPath}.`,
              editable: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(localPage))
      .mockResolvedValueOnce(jsonResponse({ outcome: "synced", message: "Combined snapshots." }));

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RepositorySnapshotReview
          busy={false}
          onResult={() => undefined}
          review={{ kind: "conflict", local, remote }}
          theme="light"
        />,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    await act(async () => {
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Combine both changes"))
        ?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    const apply = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Apply combined snapshot"),
    );
    expect(
      container.querySelector(".repository-sync-candidate-canvas .canvas-toolbar"),
    ).not.toBeNull();
    expect(apply?.disabled).toBe(true);

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(
          `[aria-label="Resolve ${conflictPath}"] button:last-child`,
        )
        ?.click();
      await Promise.resolve();
    });
    expect(apply?.disabled).toBe(false);

    await act(async () => {
      apply?.click();
      await Promise.resolve();
    });
    const requestBody = fetchMock.mock.calls.at(-1)?.[1]?.body;
    if (typeof requestBody !== "string") throw new Error("Expected a JSON request body");
    const request = JSON.parse(requestBody) as {
      resolvedConflictPaths: string[];
      pages: Array<{ page: typeof remotePage }>;
    };
    expect(request.resolvedConflictPaths).toEqual([conflictPath]);
    expect(request.pages[0]?.page.canvas[0]?.position[0]).toBe(180);
    expect(request.pages[0]?.page.canvas[0]?.z).toBe(5);
  });

  it("does not prompt when the automatic check finds no pending changes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ available: true, configured: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outcome: "up-to-date",
            message: "Local and GitHub snapshots are up to date.",
            remoteUpdateAvailable: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container!.querySelector("dialog")).toBeNull();
  });

  it("does not prompt for host-local changes when GitHub has no newer snapshot", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: true,
            configured: true,
            remoteUrl: "https://github.com/example/notebook.git",
            branch: "main",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outcome: "sync-needed",
            message: "This host has local project changes ready for synchronization review.",
            remoteUpdateAvailable: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container!.querySelector("dialog")).toBeNull();
  });

  it("opens history in a larger nested dialog with linked read-only comparison canvases", async () => {
    const commit = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Example Author",
      message: "Add comparison fixture",
      changedPaths: ["sections/section/pages/page/canvas.jsonl"],
      affectedPages: [{ sectionId: "section", pageId: "page", title: "Page" }],
    };
    const page = {
      manifest: { id: "page", title: "Page" },
      canvas: [
        {
          id: "common-element",
          kind: "shape",
          position: [20, 30],
          z: 0,
          geometry: { kind: "rectangle", width: 80, height: 40 },
          style: {
            strokeColor: "#000000",
            strokeWidth: 2,
            fillColor: null,
            opacity: 1,
          },
        },
      ],
      markdown: {},
    };
    const currentPage = {
      ...page,
      canvas: [
        ...page.canvas,
        {
          ...page.canvas[0],
          id: "changed-element",
          position: [120, 30],
        },
        {
          ...page.canvas[0],
          id: "current-only",
          position: [220, 30],
        },
      ],
    };
    const historicalPage = {
      ...page,
      canvas: [
        ...page.canvas,
        {
          ...page.canvas[0],
          id: "changed-element",
          position: [160, 30],
        },
        {
          ...page.canvas[0],
          id: "historical-only",
          position: [220, 30],
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          available: true,
          configured: true,
          remoteUrl: "https://github.com/example/notebook.git",
          branch: "main",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "up-to-date",
          message: "Local and GitHub snapshots are up to date.",
          remoteUpdateAvailable: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          outcome: "up-to-date",
          publishLocal: { insertions: 0, deletions: 0 },
          applyRemote: { insertions: 0, deletions: 0 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ commits: [commit] }))
      .mockResolvedValueOnce(
        jsonResponse({
          commit: commit.commit,
          changes: { insertions: 4, deletions: 2 },
          hierarchy: {
            notebook: {},
            sections: [
              {
                manifest: { id: "section", title: "Notes", pageIds: ["page"] },
                pages: [{ id: "page", title: "Page" }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          notebook: {},
          sections: [
            {
              manifest: { id: "section", title: "Notes", pageIds: ["page"] },
              pages: [{ id: "page", title: "Page" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(historicalPage))
      .mockResolvedValueOnce(jsonResponse(currentPage));
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    await act(async () => {
      container!.querySelector<HTMLButtonElement>(".repository-sync-button")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(".repository-sync-actions button:last-child")
        ?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "/api/repository-sync/history",
    );
    expect(container!.querySelector(".repository-sync-history-dialog")).not.toBeNull();
    expect(container!.querySelectorAll("dialog")).toHaveLength(2);
    expect(container!.querySelectorAll(".spatial-canvas.read-only")).toHaveLength(2);
    expect(container!.querySelector(".repository-sync-preview-canvases")).not.toBeNull();
    expect(
      container!.querySelector(".repository-sync-preview .repository-change-bar"),
    ).not.toBeNull();
    expect(
      container!.querySelector(".repository-sync-preview .repository-change-bar")?.textContent,
    ).toContain("+4 insertions");
    expect(
      container!.querySelector(".repository-sync-preview .repository-change-bar")?.textContent,
    ).toContain("−2 deletions");

    const toggles = container!.querySelectorAll<HTMLInputElement>(
      ".repository-sync-preview-toggles input[type='checkbox']",
    );
    expect(toggles).toHaveLength(3);
    expect(toggles[0]?.checked).toBe(true);
    expect(toggles[1]?.checked).toBe(true);
    expect(toggles[2]?.checked).toBe(false);

    const canvases = container!.querySelectorAll<HTMLElement>(".spatial-canvas");
    await act(async () => {
      canvases[0]?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 60,
          deltaY: -120,
        }),
      );
      await Promise.resolve();
    });
    const worldTransforms = [...container!.querySelectorAll<HTMLElement>(".canvas-world")].map(
      (world) => world.style.transform,
    );
    expect(worldTransforms[0]).toBe(worldTransforms[1]);

    await act(async () => {
      toggles[2]?.click();
      await Promise.resolve();
    });
    expect(
      [
        ...container!.querySelectorAll<HTMLElement>('[data-canvas-element-id="common-element"]'),
      ].map((element) => element.style.opacity),
    ).toEqual(["0.25", "0.25"]);
    expect(
      [
        ...container!.querySelectorAll<HTMLElement>('[data-canvas-element-id="changed-element"]'),
      ].map((element) => element.style.opacity),
    ).toEqual(["", ""]);
    expect(
      container!.querySelector<HTMLElement>('[data-canvas-element-id="current-only"]')?.style
        .opacity,
    ).toBe("");
    expect(
      container!.querySelector<HTMLElement>('[data-canvas-element-id="historical-only"]')?.style
        .opacity,
    ).toBe("");

    await act(async () => {
      toggles[0]?.click();
      await Promise.resolve();
    });
    expect(container!.querySelector(".repository-sync-preview-canvases")).toBeNull();
    expect(container!.querySelectorAll(".spatial-canvas.read-only")).toHaveLength(1);

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(".repository-sync-history-dialog .repository-sync-close")
        ?.click();
      await Promise.resolve();
    });
    expect(container!.querySelector(".repository-sync-history-dialog")).toBeNull();
    expect(container!.querySelector(".repository-sync-dialog")).not.toBeNull();
  });

  it("compares two selected historical snapshots in older-to-newer order", async () => {
    const newerCommit = {
      commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      timestamp: "2026-09-09T12:00:00.000Z",
      author: "Newer Author",
      message: "Newer snapshot",
      changedPaths: ["sections/section/pages/page/canvas.jsonl"],
      affectedPages: [{ sectionId: "section", pageId: "page", title: "Page" }],
    };
    const olderCommit = {
      ...newerCommit,
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Older Author",
      message: "Older snapshot",
    };
    const hierarchy = {
      notebook: {},
      sections: [
        {
          manifest: { id: "section", title: "Notes", pageIds: ["page"] },
          pages: [{ id: "page", title: "Page" }],
        },
      ],
    };
    const page = { manifest: { id: "page", title: "Page" }, canvas: [], markdown: {} };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ available: true, configured: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "up-to-date",
          message: "Local and GitHub snapshots are up to date.",
          remoteUpdateAvailable: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          outcome: "up-to-date",
          publishLocal: { insertions: 0, deletions: 0 },
          applyRemote: { insertions: 0, deletions: 0 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ commits: [newerCommit, olderCommit] }))
      .mockResolvedValueOnce(
        jsonResponse({
          commit: newerCommit.commit,
          changes: { insertions: 4, deletions: 2 },
          hierarchy,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(hierarchy))
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(
        jsonResponse({
          commit: olderCommit.commit,
          changes: { insertions: 0, deletions: 0 },
          hierarchy,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          commit: newerCommit.commit,
          changes: { insertions: 8, deletions: 3 },
          hierarchy,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page));

    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      container!.querySelector<HTMLButtonElement>(".repository-sync-button")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(".repository-sync-actions button:last-child")
        ?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    for (const label of ["Older snapshot", "Newer snapshot"]) {
      expect(
        [...container!.querySelectorAll<HTMLOptionElement>(`[aria-label="${label}"] option`)].map(
          (option) => option.value,
        ),
      ).toContain("current");
    }

    const olderEntry = [
      ...container!.querySelectorAll<HTMLElement>(".repository-sync-commit-entry"),
    ].find((entry) => entry.textContent?.includes("Older snapshot"));
    await act(async () => {
      olderEntry?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(
      container!.querySelector<HTMLSelectElement>('[aria-label="Older snapshot"]')?.value,
    ).toBe(olderCommit.commit);
    expect(
      container!.querySelector<HTMLSelectElement>('[aria-label="Newer snapshot"]')?.value,
    ).toBe(newerCommit.commit);
    expect(container!.textContent).toContain(
      "Reordered the selections so the comparison runs older → newer.",
    );
    expect(
      container!.querySelector(".repository-sync-preview .repository-change-bar")?.textContent,
    ).toContain("+8 insertions");
    expect(
      fetchMock.mock.calls
        .filter(([input]) => String(input) === "/api/repository-sync/history/snapshot")
        .map(([, init]) => JSON.parse(String(init?.body))),
    ).toContainEqual({ commit: newerCommit.commit, compareTo: olderCommit.commit });
  });

  it("allows restoring the newest Git snapshot when live current content has drifted", async () => {
    const commit = {
      commit: "1234567890abcdef1234567890abcdef12345678",
      timestamp: "2026-09-08T12:00:00.000Z",
      author: "Example Author",
      message: "Authoritative Git snapshot",
      changedPaths: ["sections/section/pages/page/canvas.jsonl"],
      affectedPages: [{ sectionId: "section", pageId: "page", title: "Page" }],
    };
    const historicalPage = {
      manifest: { id: "page", title: "Page" },
      canvas: [],
      markdown: {},
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          available: true,
          configured: true,
          remoteUrl: "https://github.com/example/notebook.git",
          branch: "main",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "up-to-date",
          message: "Local and GitHub snapshots are up to date.",
          remoteUpdateAvailable: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          outcome: "up-to-date",
          publishLocal: { insertions: 0, deletions: 0 },
          applyRemote: { insertions: 0, deletions: 0 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ commits: [commit] }))
      .mockResolvedValueOnce(
        jsonResponse({
          commit: commit.commit,
          changes: { insertions: 0, deletions: 0 },
          hierarchy: {
            notebook: {},
            sections: [
              {
                manifest: { id: "section", title: "Notes", pageIds: ["page"] },
                pages: [{ id: "page", title: "Page" }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          notebook: {},
          sections: [
            {
              manifest: { id: "section", title: "Notes", pageIds: ["page"] },
              pages: [{ id: "page", title: "Page" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(historicalPage))
      .mockResolvedValueOnce(
        jsonResponse({
          ...historicalPage,
          canvas: [
            {
              id: "523e4567-e89b-42d3-a456-426614174004",
              kind: "shape",
              position: [20, 30],
              z: 0,
              geometry: { kind: "rectangle", width: 80, height: 40 },
              style: {
                strokeColor: "#000000",
                strokeWidth: 2,
                fillColor: null,
                opacity: 1,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "confirmation-required",
          message: `Type RESTORE ${commit.commit.slice(0, 7)} to restore this snapshot.`,
          confirmation: {
            phrase: `RESTORE ${commit.commit.slice(0, 7)}`,
            deletedPaths: [],
          },
        }),
      );
    await renderSynchronization();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    await act(async () => {
      container!.querySelector<HTMLButtonElement>(".repository-sync-button")?.click();
      await Promise.resolve();
      container!
        .querySelector<HTMLButtonElement>(".repository-sync-actions button:last-child")
        ?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const restore = container!.querySelector<HTMLButtonElement>(
      ".repository-sync-history-dialog button.danger",
    );
    expect(restore?.disabled).toBe(false);
    await act(async () => {
      restore?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const restoreCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/repository-sync/history/restore",
    );
    expect(restoreCall).toBeDefined();
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toEqual({
      commit: commit.commit,
      head: commit.commit,
    });
    expect(container!.textContent).toContain(`RESTORE ${commit.commit.slice(0, 7)}`);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderSynchronization(
  theme: "light" | "dark" = "light",
  onProjectReload?: () => void,
): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RepositorySynchronization
        theme={theme}
        {...(onProjectReload === undefined ? {} : { onProjectReload })}
      />,
    );
    await Promise.resolve();
  });
}
