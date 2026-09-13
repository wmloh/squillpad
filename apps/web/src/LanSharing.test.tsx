import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanSharing } from "./LanSharing";

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

describe("LanSharing", () => {
  it("renders sharing links in a compact animated disclosure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          enabled: true,
          clientLimit: 5,
          connectedClients: 1,
          clientSlotsUsed: 1,
          connections: [
            { url: "http://192.168.1.4:4173/#access_token=test", qr: "data:image/png;base64,qr" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LanSharing host />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector("summary")?.textContent).toBe("Sharing");
    expect(container.querySelector("summary")?.classList.contains("save-status")).toBe(true);
    expect(container.querySelector(".lan-sharing--enabled")).not.toBeNull();
    expect(container.querySelector("[data-animated-menu]")).not.toBeNull();
    expect(container.textContent).toContain(
      "Anyone with this link can read and edit this notebook.",
    );
    expect(container.textContent).toContain("http://192.168.1.4:4173/#access_token=test");
    expect(container.querySelector("img")).toBeNull();
    const qrToggle = container.querySelector<HTMLButtonElement>(".lan-sharing__qr-toggle");
    expect(qrToggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => qrToggle?.click());
    expect(qrToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,qr");
    expect(container.querySelector("img")?.classList.contains("lan-sharing__qr")).toBe(true);
    expect(container.querySelectorAll(".toggle-switch input[type='checkbox']")).toHaveLength(2);
    expect(container.querySelector(".lan-sharing__capacity")?.textContent).toContain("1 of 5");
  });

  it("lets only the host apply a bounded in-memory client limit", async () => {
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(init ?? {});
      return new Response(
        JSON.stringify({
          enabled: true,
          clientLimit: init?.method === "POST" ? 12 : 5,
          clientSlotsUsed: 1,
          connections: [],
        }),
        { status: 200 },
      );
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LanSharing host />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const input = container.querySelector<HTMLInputElement>("#lan-sharing-client-limit");
    expect(input?.value).toBe("5");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "12");
    await act(async () => {
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input?.value).toBe("12");

    const apply = container.querySelector<HTMLButtonElement>(".lan-sharing__limit-control button");
    expect(apply?.disabled).toBe(false);
    await act(async () => apply?.click());
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toBe(JSON.stringify({ clientLimit: 12 }));
    expect(input?.value).toBe("12");
  });

  it("does not render or fetch sharing data for non-hosts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LanSharing />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector(".lan-sharing")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a gray status capsule when sharing is disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: false, connections: [] }), { status: 200 }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LanSharing host />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector(".lan-sharing--disabled")).not.toBeNull();
    expect(container.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Sharing: disabled",
    );
    expect(container.querySelector("[data-animated-menu]")).not.toBeNull();
  });

  it("keeps a gray status capsule when sharing status fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LanSharing host />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector(".lan-sharing--error")).not.toBeNull();
    expect(container.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Sharing: unavailable",
    );
  });
});
