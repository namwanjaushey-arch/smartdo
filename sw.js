// Network-first service worker: always tries the live site, falls back to the last saved copy when offline.
// It never touches Supabase requests (a different address), so data is never served stale.
const V = 'sd-v1'
const SHELL = ['/', '/styles.css', '/config.js', '/util.js', '/api.js', '/store.js', '/core.js', '/app.js', '/shop.js', '/money.js', '/public.js', '/admin.js', '/upgrade.js', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png']
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => undefined)))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const r = e.request
  if (r.method !== 'GET') return
  const u = new URL(r.url)
  if (u.origin !== location.origin) return
  const nav = r.mode === 'navigate'
  e.respondWith(
    fetch(r).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then((c) => c.put(nav ? '/' : r, copy)) }
      return res
    }).catch(() => caches.match(nav ? '/' : r).then((m) => m || (nav ? caches.match('/') : undefined)))
  )
})
