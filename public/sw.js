const VERSION = new URL(self.location.href).searchParams.get("v") || "current";
const CACHE = `amp-dashboard-v${VERSION}`;
const APP_FILES = ["./", `app.css?v=${VERSION}`, `app.js?v=${VERSION}`, "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname.includes("/api/")) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
