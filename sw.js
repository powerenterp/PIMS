/* POWER-IMS service worker
   Does the job the app already asks for:
   - The page sends a "CACHE_URLS" message with files to keep for offline use
     (the Supabase library, fonts, logo right away; the Excel/PDF libraries when idle).
   - The app itself (the page) and its two style sheets (pims.css, pims-overrides.css) are fetched network-first: online you always get the newest version,
     offline or on a very slow connection you get the last copy saved on this phone.
   Never touched: sign-in, data and every other request to Supabase. Only files that were
   explicitly saved through CACHE_URLS (and font files) are ever answered from the saved copy. */
const CACHE = 'pims-shell-v3';
const CSS_FILES = ['pims.css', 'pims-overrides.css'];   // the app's two style sheets: needed offline too
const SHELL = self.registration.scope + '__shell';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {                       // keep the style sheets from the very first visit
    try { const c = await caches.open(CACHE); await c.addAll(CSS_FILES.map((f) => self.registration.scope + f)); } catch (_) {}
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pims-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* The page asks us to keep a list of files for offline use */
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'CACHE_URLS' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const raw of d.urls.slice(0, 40)) {
      try {
        const url = new URL(raw, self.location.href).href;
        if (!/^https?:/.test(url)) continue;
        if (await cache.match(url)) continue;                       // already saved
        let res;
        try { res = await fetch(url, { mode: 'cors', credentials: 'omit' }); }
        catch (_) { res = await fetch(url, { mode: 'no-cors', credentials: 'omit' }); }   // some hosts send no CORS headers
        if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
      } catch (_) { /* offline or blocked: try again next time the page asks */ }
    }
  })());
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

/* style sheets: newest when online, saved copy when offline or slow. Saved without the ?v=… part, so a version bump never loses the fallback. */
async function cssRequest(req, url) {
  const cache = await caches.open(CACHE);
  const key = new Request(url.origin + url.pathname);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(key)) || Response.error();
  }
}

async function pageRequest(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok) {
      cache.put(req, res.clone());
      cache.put(SHELL, res.clone());            // last good page, whatever its file name is
    }
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match(SHELL));
    return hit || Response.error();
  }
}

/* answer from the saved copy at once, refresh it quietly in the background */
async function savedThenRefresh(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    if (req.mode === 'navigate') { e.respondWith(pageRequest(req)); return; }
    if (/\.css$/.test(url.pathname)) { e.respondWith(cssRequest(req, url)); return; }
    if (/\/icons\//.test(url.pathname)) { e.respondWith(savedThenRefresh(req)); return; }
    return;
  }
  // other websites: fonts always; everything else only if it was saved through CACHE_URLS
  if (url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') { e.respondWith(savedThenRefresh(req)); return; }
  e.respondWith((async () => {
    const hit = await (await caches.open(CACHE)).match(req);
    if (!hit) return fetch(req);                                   // not saved: behave as if there were no service worker
    fetch(req).then(async (res) => { if (res && (res.ok || res.type === 'opaque')) (await caches.open(CACHE)).put(req, res.clone()); }).catch(() => {});
    return hit;
  })());
});
