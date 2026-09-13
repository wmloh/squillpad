import { afterEach, describe, expect, it, vi } from "vitest";

import { LatestValuePublisher } from "./latest-value-publisher";

afterEach(() => vi.useRealTimers());

describe("LatestValuePublisher", () => {
  it("publishes immediately and coalesces subsequent values to the rate limit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const published: string[] = [];
    const publisher = new LatestValuePublisher<string, string>(1_000 / 30, (_key, value) => {
      published.push(value);
    });

    publisher.publish("page", "one");
    publisher.publish("page", "two");
    publisher.publish("page", "three");
    expect(published).toEqual(["one"]);

    vi.advanceTimersByTime(34);
    expect(published).toEqual(["one", "three"]);
  });

  it("flushes the final value and cancels a pending publication", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const published: string[] = [];
    const publisher = new LatestValuePublisher<string, string>(100, (_key, value) => {
      published.push(value);
    });

    publisher.publish("page", "one");
    publisher.publish("page", "stale");
    publisher.flush("page", "final");
    vi.advanceTimersByTime(100);

    expect(published).toEqual(["one", "final"]);
  });
});
