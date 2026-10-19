// Cache-first app shell so the app runs with no network and no server.
const CACHE = 'plc-v8';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'mqtt-lite.js', 'db.js', 'dash.js',
  'vendor/uPlot.iife.min.js', 'vendor/uPlot.min.css', 'vendor/gridstack-all.js', 'vendor/gridstack.min.css', 'manifest.json', 'icon.svg',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
