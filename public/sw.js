// Service worker: keeps a copy of the player and its media on the device,
// so slideshows and videos keep playing when the store's internet drops.
const SHELL = 'shell-v1';
const MEDIA = 'media-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

let syncing = Promise.resolve();
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'cache' && Array.isArray(e.data.urls)) {
    syncing = syncing.then(() => syncMedia(e.data.urls)).catch(() => {});
    e.waitUntil(syncing);
  }
  // The player page itself (so the TV can start up even with no internet).
  if (e.data && e.data.type === 'shell' && Array.isArray(e.data.urls)) {
    e.waitUntil(caches.open(SHELL).then((c) => c.addAll(e.data.urls)).catch(() => {}));
  }
});

async function syncMedia(urls) {
  const cache = await caches.open(MEDIA);
  const want = new Set(urls.map((u) => new URL(u, self.location.origin).href));
  for (const req of await cache.keys()) if (!want.has(req.url)) await cache.delete(req);
  for (const url of want) {
    if (await cache.match(url)) continue;
    try {
      const res = await fetch(url);
      if (res.status === 200) await cache.put(url, res);
    } catch (err) { /* try again next time */ }
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/media/')) e.respondWith(mediaResponse(e.request));
  else if (url.pathname.startsWith('/tv/') || url.pathname.startsWith('/static/player')) e.respondWith(networkFirst(e.request));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

// Serve media from the device cache, including byte ranges (needed for video).
async function mediaResponse(req) {
  const cached = await (await caches.open(MEDIA)).match(req.url);
  if (!cached) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return cached;
  const blob = await cached.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : blob.size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, blob.size - Number(m[2])); end = blob.size - 1; }
  end = Math.min(end, blob.size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
