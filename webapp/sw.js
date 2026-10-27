/* Per-user cache-first shell. Active bundle name lives in cache "plc-meta". */
const META = 'plc-meta';

async function activeCacheName() {
  try {
    const c = await caches.open(META);
    const r = await c.match('/active');
    if (!r) return null;
    const j = await r.json();
    return j.cacheName || null;
  } catch {
    return null;
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Địa chỉ gốc luôn đi qua trang đăng nhập (login.js tự vào trang chính nếu phiên còn hợp lệ).
  // Không để cache của bundle trả index.html cho '/', nếu không trình duyệt cũ bỏ qua bước đăng nhập.
  if (req.mode === 'navigate' && url.pathname === '/') {
    e.respondWith(Response.redirect('/login.html' + url.search, 302));
    return;
  }

  // API always hits the network (auth, version check, bundle download).
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));
    return;
  }

  e.respondWith((async () => {
    const name = await activeCacheName();
    if (name) {
      const cache = await caches.open(name);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // SPA-ish: directory / → index.html
      if (url.pathname === '/' || url.pathname.endsWith('/')) {
        const idx = await cache.match(new URL('index.html', self.location.origin).href);
        if (idx) return idx;
      }
    }

    // Login shell / first visit: network, then any matching cache.
    try {
      const net = await fetch(req);
      return net;
    } catch {
      const all = await caches.keys();
      for (const k of all) {
        if (k === META) continue;
        const hit = await caches.open(k).then((c) => c.match(req, { ignoreSearch: true }));
        if (hit) return hit;
      }
      // Offline login page fallback
      if (url.pathname.endsWith('login.html') || url.pathname === '/') {
        for (const k of all) {
          if (k === META) continue;
          const idx = await caches.open(k).then((c) => c.match(new URL('index.html', self.location.origin)));
          if (idx) return idx;
        }
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
