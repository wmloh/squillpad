const TOKEN_KEY = "squillpad:host-access";

/** Consume fragment credentials before navigation; keep them out of request URLs and history. */
export function consumeAccessToken(): string | undefined {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("access_token");
  if (token !== null) {
    history.replaceState(null, "", location.pathname + location.search);
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* Memory-only access still works. */
      }
      return token;
    }
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export let accessToken = consumeAccessToken();

export function clearAccessToken(): void {
  accessToken = undefined;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* The in-memory credential is still cleared. */
  }
}

export function accessHeaders(): Record<string, string> {
  return accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` };
}

/** Validates the root URL shape accepted by a SquillPad host. */
export function parseHostUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete host URL, including http:// or https://.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Host URLs must use http:// or https://.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Host URLs must not contain account credentials.");
  }
  if (url.pathname !== "/" || url.search !== "") {
    throw new Error("Use the host root URL; keep any access token in the # fragment.");
  }
  return url;
}

/** Checks same-origin hosts; other hosts validate access after top-level navigation. */
export async function validateHostUrl(value: string): Promise<URL> {
  const url = parseHostUrl(value);
  // The destination's origin guard intentionally rejects cross-origin fetch probes.
  if (url.origin !== location.origin) return url;
  const healthUrl = new URL("/health", url);
  let response: Response;
  try {
    response = await fetch(healthUrl, {
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("The host could not be reached. Check the address and local network.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    (body as Record<string, unknown>).status !== "ok"
  ) {
    throw new Error("That URL is not responding as a SquillPad host.");
  }
  return url;
}
