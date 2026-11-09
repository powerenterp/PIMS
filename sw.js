/* POWER-IMS service worker
   Does the job the app already asks for:
   - The page sends a "CACHE_URLS" message with files to keep for offline use
     (the Supabase library, fonts, logo right away; the Excel/PDF libraries when idle).
   - The app itself (the page), its style sheets and its script files (js/…) are fetched network-first: online you always get the newest version,
     offline or on a very slow connection you get the last copy saved on this phone.
   Never touched: sign-in, data and every other request to Supabase. Only files that were
   explicitly saved through CACHE_URLS (and font files) are ever answered from the saved copy. */
const CACHE = 'pims-shell-v5';
const CSS_FILES = ['pims.css', 'pims-overrides.css'];   // the app's two style sheets: needed offline too
const JS_FILES = ['js/01-part-01.js', 'js/02-part-02.js', 'js/03-part-03.js', 'js/04-part-04.js', 'js/05-01-core.js', 'js/05-02-supabase.js', 'js/05-03-auth.js', 'js/05-04-admin.js', 'js/05-05-sysadmin.js', 'js/05-06-owner-store.js', 'js/05-07-stock-ui.js', 'js/05-08-render.js', 'js/05-09-credit-report.js', 'js/05-10-receipts-export.js', 'js/05-11-import-backup.js', 'js/05-12-ui-v6.js', 'js/06-part-06.js', 'js/07-part-07.js', 'js/08-part-08.js', 'js/09-part-09.js', 'js/10-part-10.js', 'js/11-part-11.js', 'js/12-part-12.js', 'js/13-part-13.js', 'js/14-part-14.js', 'js/15-part-15.js', 'js/16-part-16.js', 'js/17-part-17.js', 'js/18-part-18.js', 'js/19-part-19.js', 'js/20-part-20.js', 'js/21-pims-gate.js', 'js/22-pims-enhancements.js', 'js/23-pims-mobile-v2.js', 'js/24-pims-form-fit.js', 'js/25-float.js', 'js/26-float2.js', 'js/27-float3.js', 'js/28-scan.js', 'js/29-install.js', 'js/30-import.js', 'js/31-accent.js'];   // the app's script files (js/…), needed offline too
const SHELL = self.registration.scope + '__shell';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {                       // keep the style sheets from the very first visit
    try { const c = await caches.open(CACHE); await c.addAll(CSS_FILES.concat(JS_FILES).map((f) => self.registration.scope + f)); } catch (_) {}
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
    if (/\.(css|js)$/.test(url.pathname)) { e.respondWith(cssRequest(req, url)); return; }   // style and script files: newest online, saved copy offline
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
