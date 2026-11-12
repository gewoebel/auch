const CACHE = "auch-v10";
const CACHE_PREFIX = "auch-";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./questions.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(APP_SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith(CACHE_PREFIX) &&
              key !== CACHE
          )
          .map((key) => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);

  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(scope.pathname)
  ) {
    return;
  }

  // Externe Firebase-Verbindungen werden nicht zwischengespeichert.
  const cacheKey =
    request.mode === "navigate"
      ? new URL("./index.html", self.registration.scope).href
      : request;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      try {
        const response = await fetch(request, {
          cache: "no-cache"
        });

        if (response.ok) {
          const copy = response.clone();

          event.waitUntil(
            cache.put(cacheKey, copy).catch(() => {})
          );
        }

        return response;
      } catch (error) {
        const cached = await cache.match(cacheKey);

        if (cached) return cached;

        return new Response(
          "Die Datei ist offline nicht verfügbar. Bitte die Internetverbindung prüfen.",
          {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      }
    })()
  );
});
