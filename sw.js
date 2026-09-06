// Smart Queue - Service Worker
// Purpose: cache the app shell so the patient's Digital Token Pass (and the
// rest of the UI) still opens and renders even with zero cell signal inside
// the hospital. This does NOT change any existing app logic — it only adds
// an offline-first cache layer in front of static files.

const CACHE_NAME = 'smart-queue-shell-v2';

// Files needed to render the app + token pass fully offline.
// NOTE: keep this list in sync if you rename/move index.html, style.css, etc.
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './new.css',
  './new.js',
  './fonts/noto-sans-devanagari-devanagari-400-normal.woff2',
  './fonts/noto-sans-devanagari-devanagari-600-normal.woff2',
  './fonts/noto-sans-devanagari-devanagari-700-normal.woff2',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch((err) => console.log('SW install cache error (non-fatal):', err))
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

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Live data (queue status, doctor availability, etc.) should always try the
  // network first — we never want to show stale API data when online.
  if (url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ offline: true, error: 'No connection — showing cached pass only.' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // App shell files: cache-first, so the Token Pass screen opens instantly
  // and works with zero signal once it's been visited at least once.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
