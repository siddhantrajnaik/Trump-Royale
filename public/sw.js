// Service worker for Trump Card Royal.
//
// This is a multiplayer game, so there is no useful offline mode - without the
// server there is nothing to play. What the cache buys is a shell that paints
// immediately: Render's free tier sleeps after 15 idle minutes and a cold start
// takes the better part of a minute, during which a plain page load is a blank
// screen. Here the UI appears at once and only the socket waits.
//
// Every strategy below is network-first so a deploy is picked up on the next
// load. A cache-first shell would strand players on old code, which is exactly
// the failure this is meant to avoid.
const VERSION = 'tcr-v2';
const NET_TIMEOUT_MS = 2500;

const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/sound.js',
  '/music.js',
  '/manifest.webmanifest',
  '/socket.io/socket.io.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // A missing entry must not abort the whole install.
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  const copy = response.clone();
  caches.open(VERSION).then(cache => cache.put(request, copy)).catch(() => {});
}

// Race the network against a short timer. Whichever answers first wins, but the
// network response still refreshes the cache when it eventually lands.
function networkFirst(request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };

    const timer = setTimeout(() => {
      caches.match(request).then(hit => { if (hit) finish(hit); });
    }, NET_TIMEOUT_MS);

    fetch(request).then((res) => {
      clearTimeout(timer);
      if (res && res.ok) putInCache(request, res);
      finish(res);
    }).catch(() => {
      clearTimeout(timer);
      caches.match(request).then((hit) => {
        finish(hit || new Response(
          'Offline - Trump Card Royal needs a connection to reach the table.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } }
        ));
      });
    });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The realtime transport must never be intercepted; only the client library,
  // which is an ordinary static file, is cacheable.
  if (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js') return;

  // Icons change only when the app is rebuilt, and the cache is versioned.
  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then((res) => {
        if (res && res.ok) putInCache(request, res);
        return res;
      }))
    );
    return;
  }

  event.respondWith(networkFirst(request));
});
