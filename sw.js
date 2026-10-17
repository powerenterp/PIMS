/* POWER-IMS service worker
 *
 * What it does
 *  - Pages: network-first (you always get the newest version when online),
 *    falling back to the last cached copy when offline or the network is slow.
 *  - Libraries, fonts, logo, icons: stale-while-revalidate (instant + works offline).
 *  - Supabase API / auth / realtime calls are NEVER touched – they go straight to
 *    the network, so data behaviour is exactly what it was before.
 *
 * Bump VERSION when you change this file to drop old caches.
 */
const VERSION = 'pims-v1';
const PAGES = VERSION + '-pages';
const ASSETS = VERSION + '-assets';

const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];
const PAGE_NETWORK_TIMEOUT = 4000; // ms to wait for the network before using the cached page

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(ASSETS);
    await Promise.allSettled(
      ['./manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png']
        .map((u) => cache.add(u))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('pims-') && !k.startsWith(VERSION + '-')).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) event.waitUntil(cacheUrls(data.urls));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(event, req));
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    event.respondWith(staleWhileRevalidate(event, req, false));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname) || isPublicStorage(url)) {
    event.respondWith(staleWhileRevalidate(event, req, true));
    return;
  }
  // Anything else (Supabase REST/auth/realtime, etc.) -> default browser handling.
});

function isPublicStorage(url) {
  return url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/storage/v1/object/public/');
}

/* ───────────── strategies ───────────── */

async function networkFirstPage(event, req) {
  const cache = await caches.open(PAGES);
  const cached = await cache.match(req, { ignoreSearch: true });

  const networkPromise = fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') {
      event.waitUntil(cache.put(req.url.split('#')[0], res.clone()).catch(() => {}));
    }
    return res;
  });

  try {
    if (!cached) return await networkPromise;           // nothing to fall back to: just wait
    return await Promise.race([
      networkPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_NETWORK_TIMEOUT))
    ]);
  } catch (_) {
    if (cached) return cached;
    const keys = await cache.keys();                    // any cached copy of the app is better than nothing
    if (keys.length) { const any = await cache.match(keys[0]); if (any) return any; }
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Offline</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:15vh 24px">' +
      '<h1>You are offline</h1><p>POWER-IMS has not been saved for offline use on this device yet.<br>' +
      'Connect once and open the app, then it will work offline.</p>' +
      '<button onclick="location.reload()" style="padding:10px 18px;font-size:16px">Try again</button>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(event, req, forceCors) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(req.url);

  const refresh = (async () => {
    try {
      // Re-request cross-origin libs in CORS mode so we cache a real (non-opaque) response.
      const res = await fetch(forceCors ? new Request(req.url, { mode: 'cors', credentials: 'omit' }) : req);
      if (res && res.ok && res.type !== 'opaque') {
        await cache.put(req.url, res.clone());
        if (res.url.startsWith('https://fonts.googleapis.com/')) event.waitUntil(cacheFontFiles(res.clone()));
      }
      return res;
    } catch (_) {
      return null;
    }
  })();

  if (cached) { event.waitUntil(refresh); return cached; }

  const fresh = await refresh;
  if (fresh) return fresh;
  try { return await fetch(req); } catch (_) { return Response.error(); }
}

/* ───────────── helpers ───────────── */

async function cacheFontFiles(cssResponse) {
  try {
    const css = await cssResponse.text();
    const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]);
    const cache = await caches.open(ASSETS);
    await Promise.allSettled([...new Set(urls)].map(async (u) => {
      if (await cache.match(u)) return;
      const r = await fetch(new Request(u, { mode: 'cors', credentials: 'omit' }));
      if (r.ok) await cache.put(u, r);
    }));
  } catch (_) { /* best effort */ }
}

async function cacheUrls(urls) {
  const pages = await caches.open(PAGES);
  const assets = await caches.open(ASSETS);
  await Promise.allSettled(urls.map(async (raw) => {
    const url = new URL(raw, self.location.href);
    if (url.origin === self.location.origin && (url.pathname.endsWith('/') || /\.html?$/.test(url.pathname))) {
      const res = await fetch(url.href, { cache: 'reload' });
      if (res.ok) await pages.put(url.href, res);
      return;
    }
    const res = await fetch(new Request(url.href, { mode: 'cors', credentials: 'omit' }));
    if (!res.ok) return;
    await assets.put(url.href, res.clone());
    if (url.hostname === 'fonts.googleapis.com') await cacheFontFiles(res.clone());
  }));
}
