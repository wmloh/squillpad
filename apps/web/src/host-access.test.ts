import { afterEach, expect, it, vi } from "vitest";
import { consumeAccessToken, parseHostUrl, validateHostUrl } from "./host-access";

afterEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("checks the health endpoint without transmitting fragment credentials", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
  vi.stubGlobal("fetch", fetchMock);
  const url = `${location.origin}/#access_token=${"b".repeat(43)}`;
  expect((await validateHostUrl(url)).href).toBe(url);
  expect(fetchMock.mock.calls[0]?.[0].href).toBe(`${location.origin}/health`);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
});

it("allows navigation to another host without a cross-origin credential probe", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const target = "http://tablet.example:4173/";
  expect((await validateHostUrl(target)).href).toBe(target);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("removes credentials from the URL and preserves tab access across reloads", () => {
  const token = "a".repeat(43);
  history.replaceState(null, "", "/#access_token=" + token);
  expect(consumeAccessToken()).toBe(token);
  expect(location.hash).toBe("");
  expect(consumeAccessToken()).toBe(token);
  expect(localStorage.length).toBe(0);
});

it("rejects malformed tokens and leaves ordinary page routes alone", () => {
  history.replaceState(null, "", "/#access_token=bad");
  expect(consumeAccessToken()).toBeUndefined();
  expect(location.hash).toBe("");
  history.replaceState(null, "", "/#project/page");
  expect(consumeAccessToken()).toBeUndefined();
  expect(location.hash).toBe("#project/page");
});

it("accepts authorized root host links without moving credentials into the query", () => {
  const url = parseHostUrl("http://tablet.example:4173/#access_token=" + "b".repeat(43));
  expect(url.origin).toBe("http://tablet.example:4173");
  expect(url.search).toBe("");
  expect(url.hash).toContain("access_token=");
});

it("rejects host paths and embedded account credentials", () => {
  expect(() => parseHostUrl("http://user:pass@example.test/")).toThrow(
    "must not contain account credentials",
  );
  expect(() => parseHostUrl("http://example.test/notebook")).toThrow("host root URL");
});
