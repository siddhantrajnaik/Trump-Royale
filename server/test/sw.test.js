// Service worker routing.
//
// Two failure modes here would be serious: intercepting the Socket.IO transport
// would break every game, and serving the shell cache-first would strand
// players on stale code after a deploy. The worker cannot be registered in a
// headless test, so it is loaded into a sandbox with stubbed globals and its
// fetch decisions are exercised directly.
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('./harness');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'sw.js'), 'utf8');

// Rewrite a warmed cache so its bodies are identifiable as cache hits.
function relabel(cacheMap) {
  const out = new Map();
  for (const [url] of cacheMap) out.set(url, makeResponse("CACHED:" + url));
  return out;
}

function makeResponse(body, init) {
  const status = (init && init.status) || 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    headers: (init && init.headers) || {},
    clone() { return makeResponse(body, init); },
  };
}

// Boot the worker in a sandbox and hand back its captured handlers plus the
// fake cache, so tests can drive it.
function bootWorker(opts) {
  const options = opts || {};
  const store = new Map();              // cacheName -> Map(url -> response)
  const listeners = {};
  const netLog = [];

  const cacheApi = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        add: async (url) => {
          const res = await sandbox.fetch({ url: absolute(url), method: 'GET' });
          if (!res.ok) throw new Error('add failed ' + url);
          m.set(absolute(url), res);
        },
        put: async (req, res) => { m.set(req.url, res); },
        keys: async () => [...m.keys()].map(url => ({ url })),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (req) => {
      const url = typeof req === 'string' ? absolute(req) : req.url;
      for (const m of store.values()) if (m.has(url)) return m.get(url);
      return undefined;
    },
  };

  const absolute = (u) => new URL(u, 'https://trump.example').href;

  const sandbox = {
    URL,
    Response: makeResponse,
    setTimeout,
    clearTimeout,
    Promise,
    console,
    caches: cacheApi,
    fetch: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      netLog.push(url);
      if (options.offline) throw new Error('offline');
      if (options.slow && !url.includes('/icons/')) {
        await new Promise(r => setTimeout(r, options.slow));
      }
      return makeResponse('NETWORK:' + url);
    },
    self: null,
  };
  sandbox.self = {
    location: { origin: 'https://trump.example' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {},
  };
  sandbox.globalThis = sandbox;

  // Shorten the network race so the timeout path is testable quickly.
  const src = SW_SRC.replace('const NET_TIMEOUT_MS = 2500;', 'const NET_TIMEOUT_MS = 30;');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  return { listeners, store, netLog, absolute, sandbox };
}

// Drive one fetch event; returns the response the worker chose, or null when it
// declined to handle the request (letting the browser do it).
async function dispatchFetch(w, url, method) {
  let responded = null;
  const event = {
    request: { url: w.absolute(url), method: method || 'GET' },
    respondWith: (p) => { responded = p; },
  };
  await w.listeners.fetch(event);
  return responded ? await responded : null;
}

async function install(w) {
  let done;
  await w.listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
}

test('sw: install precaches the shell', async () => {
  const w = bootWorker();
  await install(w);
  const cached = [...w.store.values()][0];
  const paths = [...cached.keys()].map(u => new URL(u).pathname);
  for (const need of ['/', '/index.html', '/app.js', '/style.css', '/sound.js', '/socket.io/socket.io.js']) {
    assert.ok(paths.includes(need), 'precached ' + need);
  }
  assert.ok(paths.some(p => p.startsWith('/icons/')), 'precached the icons');
});

test('sw: the Socket.IO transport is never intercepted', async () => {
  const w = bootWorker();
  await install(w);

  for (const url of [
    '/socket.io/?EIO=4&transport=polling',
    '/socket.io/?EIO=4&transport=websocket&sid=abc',
    '/socket.io/',
  ]) {
    const res = await dispatchFetch(w, url);
    assert.strictEqual(res, null, 'declined to handle ' + url);
  }

  // The client library is an ordinary static file and may be served.
  const lib = await dispatchFetch(w, '/socket.io/socket.io.js');
  assert.ok(lib, 'the client library is handled');
});

test('sw: non-GET and cross-origin requests pass straight through', async () => {
  const w = bootWorker();
  await install(w);
  assert.strictEqual(await dispatchFetch(w, '/app.js', 'POST'), null, 'POST ignored');

  let responded = null;
  await w.listeners.fetch({
    request: { url: 'https://cdn.example.com/thing.js', method: 'GET' },
    respondWith: (p) => { responded = p; },
  });
  assert.strictEqual(responded, null, 'cross-origin ignored');
});

test('sw: the shell is network-first, so a deploy lands on the next load', async () => {
  const w = bootWorker();
  await install(w);
  const res = await dispatchFetch(w, '/app.js');
  assert.ok(String(res.body).startsWith('NETWORK:'), 'served from the network, not the cache');
  assert.ok(w.netLog.some(u => u.endsWith('/app.js')), 'the network was actually consulted');
});

test('sw: falls back to cache when the server is unreachable', async () => {
  const online = bootWorker();
  await install(online);
  const warm = [...online.store.values()][0];

  const offline = bootWorker({ offline: true });
  offline.store.set('tcr-v2', relabel(warm));
  const res = await dispatchFetch(offline, '/app.js');
  assert.ok(res, 'something was served');
  assert.ok(String(res.body).startsWith('CACHED:'), 'it came from the cache, not a 503');
});

test('sw: a sleeping server does not block the shell', async () => {
  // Render's free tier can take ~50s to wake. The cached shell must win the
  // race rather than the player staring at a blank page.
  const online = bootWorker();
  await install(online);
  const warm = [...online.store.values()][0];

  const slow = bootWorker({ slow: 400 });      // network far slower than the 30ms race
  slow.store.set('tcr-v2', relabel(warm));
  const started = Date.now();
  const res = await dispatchFetch(slow, '/index.html');
  const elapsed = Date.now() - started;

  assert.ok(res, 'the shell was served');
  assert.ok(String(res.body).startsWith('CACHED:'), 'served from cache while the server wakes');
  assert.ok(elapsed < 300, 'and it did not wait for the slow network (took ' + elapsed + 'ms)');
});

test('sw: activate drops caches from previous versions', async () => {
  const w = bootWorker();
  await install(w);
  w.store.set('tcr-OLD', new Map());
  let done;
  await w.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(!w.store.has('tcr-OLD'), 'the stale cache was deleted');
  assert.ok(w.store.has('tcr-v2'), 'the current cache survives');
});
