// Keeps the app's own files on the device so it opens without a network.
// Answers from the copy on the device straight away and refreshes that copy in the background.
const CACHE = 'hanyu-shell-v28';   // change this on every release so devices pick up the new files
const SHELL = ['./', 'index.html', 'style.css', 'boot.js', 'app.js', 'vendor/ts-fsrs.umd.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    if (hit) { fresh.catch(() => {}); return hit; }
    return fresh;
  }));
});
