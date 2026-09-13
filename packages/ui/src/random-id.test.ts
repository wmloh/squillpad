import { expect, it, vi } from "vitest";
import { randomId } from "./random-id";

it("creates valid distinct UUIDs without the secure-context randomUUID API", () => {
  const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("Unavailable on HTTP LAN origins");
  });
  try {
    const ids = Array.from({ length: 100 }, () => randomId());
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(100);
  } finally {
    randomUUID.mockRestore();
  }
});
