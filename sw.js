/* QUINTO · service worker: l'app si apre anche senza rete; i dati restano gestiti da Firebase. */
const CACHE = 'quinto-v5';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './tigers-stemma.png', './csi-logo-s.png', './forza-tigers-intro.mp3', './icons/icon-192.png'];
const CDN = ['unpkg.com', 'cdnjs.cloudflare.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.json') || url.pathname.endsWith('config.js')) {
      // pagina, configurazione e dati (csi.json, trailer): prima la rete, così gli aggiornamenti arrivano subito
      e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put(req, c)); return r; }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
    } else if (!url.pathname.endsWith('.mp4') && (!url.pathname.endsWith('.mp3') || url.pathname.endsWith('intro.mp3'))) {
      e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const c = res.clone(); caches.open(CACHE).then((k) => k.put(req, c)); return res; })));
    }
  } else if (CDN.includes(url.hostname)) {
    // librerie e caratteri: dalla cache, aggiornati in background
    e.respondWith(caches.match(req).then((hit) => { const net = fetch(req).then((res) => { caches.open(CACHE).then((k) => k.put(req, res.clone())); return res; }).catch(() => hit); return hit || net; }));
  }
});
