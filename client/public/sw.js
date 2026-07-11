// NEBULA service worker: cache the app shell + cached artwork for fast loads.
// Media streams and API calls always go to the network.
const CACHE = 'nebula-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // never cache streams, HLS or API data
  if (url.pathname.startsWith('/api/')) {
    // …except artwork, which is immutable enough to cache
    const art = /^\/api\/(img|thumb\/|frame\/)/.test(url.pathname);
    if (!art) return;
  }
  // navigations (index.html): network first, so UI updates arrive immediately
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetching = fetch(e.request).then((res) => {
        if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => { });
        }
        return res;
      }).catch(() => hit);
      return hit || fetching;
    })
  );
});
