// sw.js — Service Worker robusto para PWA + segundo plano no Android
const CACHE_NAME = 'whisper-v3';
const PRECACHE = [
  './index.html',
  './manifest.json',
  './whisper.worker.js',
  './icon-192.png',
  './icon-512.png'
];

// ── Install: pre-cacheia o shell do app ──────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .catch(() => {}) // nao falha se offline na instalacao
  );
});

// ── Activate: remove caches antigos e assume controle ───────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
        )
      ),
      self.clients.claim() // assume controle de todas as abas imediatamente
    ])
  );
});

// ── Fetch: cache-first para o shell, network-first para CDN ─────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Modelos, ffmpeg e CDN: sempre rede (sao grandes e ja tem cache proprio)
  if (
    url.includes('huggingface.co') ||
    url.includes('cdn.jsdelivr.net') ||
    url.includes('ffmpeg')
  ) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request)
      )
    );
    return;
  }

  // Shell do app: cache-first para funcionar offline
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Atualiza cache com a versao nova
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Keepalive para segundo plano no Android ──────────────────────────
// O Android pode suspender abas, mas o SW continua vivo.
// Mantemos um canal de mensagens aberto com a aba ativa para
// "acordar" ela quando necessario.

let keepAliveInterval = null;

self.addEventListener('message', event => {
  const { type } = event.data || {};

  // A aba avisa o SW que uma transcricao esta em andamento
  if (type === 'TRANSCRIPTION_STARTED') {
    // Ping periodico para evitar que o Android mate o SW
    if (!keepAliveInterval) {
      keepAliveInterval = setInterval(() => {
        self.clients.matchAll().then(clients => {
          clients.forEach(client =>
            client.postMessage({ type: 'SW_KEEPALIVE' })
          );
        });
      }, 20000); // a cada 20s
    }
  }

  // Transcricao terminou ou foi cancelada: para o ping
  if (type === 'TRANSCRIPTION_ENDED') {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
  }

  // A aba responde ao ping (confirma que ainda esta viva)
  if (type === 'SW_KEEPALIVE_ACK') {
    // noop — so manter o canal aberto ja basta
  }
});

// Notificacao de conclusao via SW (funciona mesmo com aba em background)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
