// Bumping this string forces browsers to fetch fresh files on next load.
const CACHE_NAME = 'scoop-journal-v2';

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/auth.js',
  './js/data.js',
  './js/idb.js',
  './js/supabase-client.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App-shell files: cache-first (fast launch, works offline).
// Everything else (Supabase API calls, images): network-first, since that's
// live data — this service worker does NOT cache or sync your recipes.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin && APP_SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')));

  if (isAppShell) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
  // else: let it hit the network normally (default browser behavior)
});
