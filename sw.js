/* QUINTO · service worker: l'app si apre anche senza rete; i dati restano gestiti da Firebase. */
const CACHE = 'quinto-v8';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './tigers-stemma.png', './csi-logo-s.png', './icons/icon-192.png'];
const CDN = ['unpkg.com', 'cdnjs.cloudflare.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.json') || url.pathname.endsWith('config.js')) {
      // pagina, configurazione e dati (csi.json, trailer): prima la rete, così gli aggiornamenti arrivano subito
      e.respondWith(fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }).then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put(req, c)); return r; }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
    } else if (!url.pathname.endsWith('.mp4') && (!url.pathname.endsWith('.mp3') || url.pathname.endsWith('intro.mp3'))) {
      e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const c = res.clone(); caches.open(CACHE).then((k) => k.put(req, c)); return res; })));
    }
  } else if (CDN.includes(url.hostname)) {
    // librerie e caratteri: dalla cache, aggiornati in background
    e.respondWith(caches.match(req).then((hit) => { const net = fetch(req).then((res) => { caches.open(CACHE).then((k) => k.put(req, res.clone())); return res; }).catch(() => hit); return hit || net; }));
  }
});

/* notifiche: arrivano dal postino (vedi push/worker.js) anche con l'app chiusa */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { t: 'QUINTO', b: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.t || 'QUINTO', {
    body: d.b || '', icon: 'icons/icon-192.png', tag: d.tag, renotify: !!d.tag,
    data: { u: d.u || '#home', m: d.m || '', p: d.p || '' }, actions: Array.isArray(d.a) ? d.a : [],
  }));
});
self.addEventListener('notificationclick', (e) => {
  const n = e.notification, d = n.data || {}; n.close();
  e.waitUntil((async () => {
    // risposta "Sì / No" direttamente dalla notifica (Android)
    if ((e.action === 'yes' || e.action === 'no') && d.m && d.p) {
      try {
        const s = await self.registration.pushManager.getSubscription();
        const r = await fetch(d.p + '/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: s && s.endpoint, match: d.m, answer: e.action }) });
        if (!r.ok) throw new Error();
        return self.registration.showNotification(e.action === 'yes' ? 'Presenza confermata 👍' : 'Assenza segnata', { body: 'Grazie, lo staff lo vede subito.', icon: 'icons/icon-192.png', tag: 'pres-' + d.m });
      } catch (x) { /* se non riesce si apre la pagina delle presenze */ }
    }
    const hash = d.u && d.u[0] === '#' ? d.u : '#home';
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all.find((w) => w.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ go: hash }); return c.focus(); }
    return self.clients.openWindow(self.registration.scope + hash);
  })());
});
