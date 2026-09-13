import { describe, expect, it } from "vitest";

import { isClientReadOnly } from "./App";

describe("client read-only policy", () => {
  it("leaves a connected client editable until the host becomes unavailable", () => {
    expect(
      isClientReadOnly({
        hostDisconnected: false,
        hostStopped: false,
      }),
    ).toBe(false);
  });

  it("keeps a client read-only after the host stops or disconnects", () => {
    expect(
      isClientReadOnly({
        hostDisconnected: true,
        hostStopped: false,
      }),
    ).toBe(true);
    expect(
      isClientReadOnly({
        hostDisconnected: false,
        hostStopped: true,
      }),
    ).toBe(true);
  });
});
