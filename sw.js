// Shotgun — service worker
//
// Cache-first for the app shell, versioned so a deploy can force a refresh.
// Bump CACHE_NAME (shotgun-v1 -> shotgun-v2 ...) whenever shipped files
// change; old caches are cleared automatically on activate.
//
// All paths below are relative — this app deploys under a GitHub Pages
// sub-path (/shotgun/) and the service worker's own scope resolves them
// correctly from wherever it's registered.

const CACHE_NAME = 'shotgun-v1';

const PRECACHE_FILES = [
  'index.html',
  'manifest.json',
  'css/styles.css',
  'js/app.js',
  'js/api.js',
  'js/config.js',
  'js/flow-order.js',
  'js/backends/local-backend.js',
  'js/backends/spotify-backend.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name.startsWith('shotgun-') && name !== CACHE_NAME).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
