const CACHE_NAME = "squillpad-shell-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./squillpad-tab-icon.png",
  "./squillpad-light.png",
  "./squillpad-dark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("squillpad-shell-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/sync")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response.ok &&
          (request.destination === "script" ||
            request.destination === "style" ||
            request.destination === "font" ||
            request.destination === "document")
        ) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (
          (await cache.match(request)) ??
          (request.mode === "navigate" ? await cache.match("./index.html") : undefined) ??
          Response.error()
        );
      }),
  );
});
