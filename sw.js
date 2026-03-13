// Service Worker — cache de assets estáticos para PWA offline
const CACHE = 'whisper-cursos-v1';
const ASSETS = [
  './',
  './index.html',
  './whisper.worker.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Rede primeiro; fallback para cache (funciona offline para assets locais)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
