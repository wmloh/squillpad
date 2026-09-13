interface PublisherEntry<Value> {
  lastPublishedAt: number;
  pending: Value | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Publishes the latest value at a bounded rate with an explicit final flush. */
export class LatestValuePublisher<Key, Value> {
  readonly #entries = new Map<Key, PublisherEntry<Value>>();

  constructor(
    readonly intervalMs: number,
    readonly publishValue: (key: Key, value: Value) => void,
    readonly now: () => number = Date.now,
  ) {}

  publish(key: Key, value: Value): void {
    const current = this.#entries.get(key) ?? {
      lastPublishedAt: Number.NEGATIVE_INFINITY,
      pending: undefined,
      timer: undefined,
    };
    const remaining = this.intervalMs - (this.now() - current.lastPublishedAt);
    if (remaining <= 0 && current.timer === undefined) {
      current.lastPublishedAt = this.now();
      this.#entries.set(key, current);
      this.publishValue(key, value);
      return;
    }
    current.pending = value;
    if (current.timer === undefined) {
      current.timer = setTimeout(
        () => {
          current.timer = undefined;
          const pending = current.pending;
          current.pending = undefined;
          if (pending === undefined) return;
          current.lastPublishedAt = this.now();
          this.publishValue(key, pending);
        },
        Math.max(0, remaining),
      );
    }
    this.#entries.set(key, current);
  }

  flush(key: Key, value: Value): void {
    const current = this.#entries.get(key);
    if (current?.timer !== undefined) clearTimeout(current.timer);
    this.#entries.set(key, {
      lastPublishedAt: this.now(),
      pending: undefined,
      timer: undefined,
    });
    this.publishValue(key, value);
  }

  cancel(key: Key): void {
    const current = this.#entries.get(key);
    if (current?.timer !== undefined) clearTimeout(current.timer);
    this.#entries.delete(key);
  }

  destroy(): void {
    for (const current of this.#entries.values()) {
      if (current.timer !== undefined) clearTimeout(current.timer);
    }
    this.#entries.clear();
  }
}
