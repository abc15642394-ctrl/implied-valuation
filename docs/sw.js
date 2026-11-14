// 快取策略：app shell 走 network-first，資源走 cache-first。
//
// 為什麼不是 cache-first：HTML 與 JS 必須是同一版才能運作（JS 會去抓 HTML 裡的元素）。
// cache-first 一旦快取到不成對的組合，就會永遠供應下去，使用者無法自救。
// network-first 讓每次連線都拿到成對的最新版，離線才回退快取。
var CACHE = 'iv-calc-v23';

// 這些檔案彼此相依，必須同版
var SHELL = ['./', 'index.html', 'app.css', 'valuation.js', 'store.js', 'app.js'];
// 這些獨立，快取多久都無所謂
var ASSETS = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

// 每天會變的資料檔。刻意不放進 ASSETS：ASSETS 是 cache-first 的意思，
// 而這個檔案一旦 cache-first 就會被永遠凍結在第一次抓到的版本。
// 它的抓取策略由下面 fetch handler 裡的專屬分支決定，不是由這個清單決定。
var DATA = ['prices.json'];

function isData(url) {
  return /\/prices\.json$/.test(new URL(url).pathname);
}

function isShell(url) {
  var path = new URL(url).pathname;
  return /(\/|\.html|\.css|\.js)$/.test(path) && !/sw\.js$/.test(path);
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 關鍵：一般的 cache.addAll 會命中瀏覽器 HTTP 快取。GitHub Pages 每個檔案都是
      // max-age=600 且各自獨立計時，所以可能拿到「舊 index.html ＋ 新 app.js」。
      // { cache: 'reload' } 強制繞過 HTTP 快取，確保整組 shell 來自同一次部署。
      return Promise.all(SHELL.concat(ASSETS).concat(DATA).map(function (url) {
        return fetch(url, { cache: 'reload' }).then(function (res) {
          if (res && res.ok) return cache.put(url, res);
        }).catch(function () { /* 單一檔案失敗不阻擋安裝 */ });
      }));
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

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // prices.json 每天都會換。它的副檔名是 .json，不符合 isShell 的正則，
  // 所以如果不特別處理就會掉到最下面的 cache-first——第一次抓到就再也不更新，
  // CACHE 版本沒變的話連重裝都救不回來。
  //
  // 也不能併進下面的 shell 分支：那一支離線找不到時會回 index.html，
  // 對一個 JSON 檔來說是錯的東西。
  if (isData(req.url)) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req);      // 離線時給最後一次抓到的價
      })
    );
    return;
  }

  if (isShell(req.url)) {
    // network-first：連線時永遠拿到成對的最新版
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
    );
    return;
  }

  // 其餘資源 cache-first
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});

// ---- 推播 ----
//
// Apple 的硬規則：**每一則推播都必須真的顯示通知。** 收到 push 卻不顯示（例如
// 只想拿來在背景偷偷更新資料）會被 iOS 直接撤銷通知權限，而且不會有任何錯誤訊息
// ——下次就是靜悄悄地再也收不到。所以這個 handler 的每一條路徑，包含 payload
// 壞掉、解不開、完全是空的，最後都一定要走到 showNotification。
self.addEventListener('push', function (event) {
  var d = {};
  try { d = (event.data && event.data.json()) || {}; }
  catch (e) { d = {}; }                    // 解不開也不能靜默，往下用預設文案

  var title = (typeof d.title === 'string' && d.title) ? d.title : '隱含估值追蹤';
  var body = (typeof d.body === 'string' && d.body) ? d.body : '有新的收盤資料，打開看看。';

  event.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // tag 相同的通知會互相取代。兩種提醒刻意用不同的 tag，否則「落差跨門檻」
    // 會把「電腦太久沒推」擠掉，而那兩件事要同時看得到。
    tag: (typeof d.tag === 'string' && d.tag) ? d.tag : 'iv-push',
    data: { url: (typeof d.url === 'string' && d.url) ? d.url : './' }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './';
  // 已經開著就聚焦到那一個，不要每次都開新視窗。
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
          return list[i].focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// 訂閱會過期，而過期是靜默的——他只會發現「怎麼好久沒收到通知」。
// 這裡沒辦法自己重新訂閱：applicationServerKey 存在 localStorage，service worker
// 讀不到。所以能做的是顯示一則通知叫他回來按一次。
//
// iOS 對這個事件的支援不確定，所以 app 端另外有一道：每次啟動比對訂閱的 endpoint
// 有沒有變，變了就在 topbar 標出來。兩道是刻意的重複，不是漏改。
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(self.registration.showNotification('通知需要重新開啟', {
    // 每一個名稱都要跟 index.html 裡按鈕上的字一模一樣，否則他照著找不到。
    // 先前漏掉「收盤通知設定」這一步，而同步視窗裡並沒有「開啟通知」那顆鈕。
    body: '這支手機的推播訂閱失效了。打開 app → 同步 → 收盤通知設定 → 開啟通知。',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'iv-sub-changed',
    data: { url: './' }
  }));
});
