import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoryChangeSummary } from "./RepositoryChangeSummary";

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

describe("RepositoryChangeSummary", () => {
  it("shows both directional ratios and exact counts for a conflict", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          outcome: "conflict",
          publishLocal: { insertions: 3, deletions: 1 },
          applyRemote: { insertions: 1, deletions: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<RepositoryChangeSummary />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Publish local+3 insertions · −1 deletion");
    expect(container.textContent).toContain("Apply remote+1 insertion · −3 deletions");
    const segments = container.querySelectorAll<HTMLElement>(".repository-change-bar__segment");
    expect(segments[0]?.style.width).toBe("75%");
    expect(segments[1]?.style.width).toBe("25%");

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Refresh change comparison"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the track neutral when both counts are zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          outcome: "up-to-date",
          publishLocal: { insertions: 0, deletions: 0 },
          applyRemote: { insertions: 0, deletions: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<RepositoryChangeSummary />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Up to date+0 insertions · −0 deletions");
    const segments = container.querySelectorAll<HTMLElement>(".repository-change-bar__segment");
    expect([...segments].map((segment) => segment.style.width)).toEqual(["0%", "0%"]);
  });

  it("forwards a fetched conflict review to the synchronization dialog", async () => {
    const review = {
      kind: "conflict" as const,
      local: {
        commit: "1234567890abcdef1234567890abcdef12345678",
        timestamp: "2026-09-08T12:00:00.000Z",
        author: "Local",
        message: "Local snapshot",
        changedPaths: [],
        affectedPages: [],
      },
      remote: {
        commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        timestamp: "2026-09-08T12:00:00.000Z",
        author: "GitHub",
        message: "GitHub snapshot",
        changedPaths: [],
        affectedPages: [],
      },
    };
    const onReview = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          outcome: "conflict",
          publishLocal: { insertions: 1, deletions: 0 },
          applyRemote: { insertions: 0, deletions: 1 },
          review,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<RepositoryChangeSummary onReview={onReview} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onReview).toHaveBeenCalledWith(review);
  });
});
