import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostStopControl } from "./HostStopControl";

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

describe("HostStopControl", () => {
  it("measures repository changes when the stop-hosting menu opens", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          outcome: "publish-local",
          publishLocal: { insertions: 8, deletions: 2 },
          applyRemote: { insertions: 2, deletions: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <HostStopControl
          onStopHosting={() => undefined}
          onSyncNow={() => undefined}
          stopping={false}
          theme="light"
        />,
      );
    });
    const details = container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repository-sync/comparison",
      expect.objectContaining({ method: "GET" }),
    );
    expect(container.textContent).toContain("Publish local+8 insertions · −2 deletions");
  });
});
