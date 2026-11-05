// 離線快取 app shell。改版時 bump CACHE 版號以淘汰舊快取。
var CACHE = 'iv-calc-v2';
var SHELL = [
  './',
  'index.html',
  'app.css',
  'valuation.js',
  'store.js',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// cache-first：離線可用，上線後靠 bump 版號更新。
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (hit) {
      if (hit) return hit;
      return fetch(event.request).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      }).catch(function () {
        // 離線且沒快取時，導覽請求退回首頁
        if (event.request.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    })
  );
});
