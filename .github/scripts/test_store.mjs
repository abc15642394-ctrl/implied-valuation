// 資料層的回歸測試。用 node 直接跑，不裝任何東西：
//
//     node .github/scripts/test_store.mjs
//
// 為什麼要有這個檔案：這個專案已經有好幾次「語法過但行為錯」的經驗
// （lastPushAt 推不出去、priceCell 三個呼叫點、帶入鍵漏到主表）。
// 語法檢查與 grep 證明不了行為，所以把會痛的那幾條鎖在這裡。
//
// 兩個重點：
//   1. 一律用 vm.runInNewContext 自己給 globals。Node 21+ 的 global.navigator
//      是唯讀的，直接賦值會失敗，而失敗的樣子是「測試報錯」不是「程式錯」——
//      先前就這樣吃過三個假失敗。
//   2. store.js / valuation.js 原封不動載入，不改一個字。測的必須是上線的那份。

import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; return true; }
  failures.push(detail ? `${name}\n       ${detail}` : name);
  return false;
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  return ok(name, g === w, `得到 ${g}\n       應為 ${w}`);
}

// ---- 載入 ----

// 假的 localStorage。回傳 store 本身，測試可以直接塞壞資料進去。
function makeLocalStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

// pushManager 的假物件。nextEndpoint 可以在測試中途改，用來模擬
// 「換公鑰 → 退訂重訂 → endpoint 變了」。
function makePushManager(state) {
  const sub = (ep) => ({
    endpoint: 'https://web.push.apple.com/' + ep,
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; },
    unsubscribe() { state.current = null; return Promise.resolve(true); }
  });
  return {
    getSubscription: () => Promise.resolve(state.current),
    subscribe(opts) {
      // 真實行為：同一組公鑰會回既有訂閱，換了公鑰則丟 InvalidStateError。
      if (state.current && state.key !== String(opts.applicationServerKey)) {
        const e = new Error('different applicationServerKey');
        e.name = 'InvalidStateError';
        return Promise.reject(e);
      }
      state.key = String(opts.applicationServerKey);
      state.current = sub(state.nextEndpoint);
      return Promise.resolve(state.current);
    }
  };
}

function loadStore({ push = false } = {}) {
  const localStorage = makeLocalStorage();
  const pushState = { current: null, key: null, nextEndpoint: 'A' };

  const Notification = function () {};
  Notification.permission = 'granted';
  Notification.requestPermission = () => Promise.resolve('granted');

  const win = push ? { PushManager: function () {}, Notification } : {};
  const navigator = push
    ? { serviceWorker: { register: () => {}, ready: Promise.resolve({ pushManager: makePushManager(pushState) }) } }
    : {};

  const ctx = {
    window: win, localStorage, console, JSON, Date, Math, Array, Object, String,
    parseFloat, parseInt, isFinite, navigator, Notification, Promise,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Uint8Array, Buffer
  };
  vm.runInNewContext(read('docs/valuation.js'), ctx);
  ctx.Valuation = ctx.window.Valuation;
  vm.runInNewContext(read('docs/store.js'), ctx);
  return { S: ctx.window.Store, V: ctx.window.Valuation, localStorage, pushState };
}

// base64url 的 P-256 公鑰，跟 `npx web-push generate-vapid-keys` 產出的同一種東西
function vapidPublicKey() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- 1. 數學基準 ----
//
// 這四個數字是整個 app 的意義所在，動到就是算錯股票。valuation.js 從來沒改過，
// 但第六包的發送端要重用它，所以這裡順便確認它在 node 裡載起來結果一致。
function testMath() {
  const { V } = loadStore();
  const fair = (g15) => V.dcfParts(10, g15, 0.05, 0.10, 0.02).total.toFixed(2);
  eq('合理價 EPS10／1-5年 5%', fair(0.05), '158.19');
  eq('合理價 EPS10／1-5年 15%', fair(0.15), '237.86');
  eq('合理價 EPS10／1-5年 30%', fair(0.30), '418.27');
  const r = V.impliedCagr1_5(121.5, 1.49, 0.02, 0.10, 0.02);
  eq('市場隱含 121.5／EPS1.49', [r.status, (r.cagr * 100).toFixed(2)], ['ok', '53.08']);
}

// ---- 2. deviceConfig：加通知欄位不能洗掉 gist 設定 ----
//
// build 23 把 deviceConfig / setDeviceConfig 整個重寫（欄位從 2 個變 5 個）。
// 他的電腦↔手機同步整個靠這兩支，所以這一組是 build 23 風險最高的地方。
function testDeviceConfig() {
  const { S, localStorage } = loadStore();
  const EMPTY = { gistId: '', token: '', vapidKey: '', pushEndpoint: '', pushCopiedAt: '' };

  eq('全新裝置：五個欄位都是空字串', S.deviceConfig(), EMPTY);
  ok('全新裝置不能推', S.canPush() === false);
  ok('全新裝置不能拉', S.canPull() === false);

  S.setDeviceConfig({ gistId: 'abc123', token: 'ghp_xxx' });
  eq('存得住 gistId', S.deviceConfig().gistId, 'abc123');
  eq('存得住 token', S.deviceConfig().token, 'ghp_xxx');
  ok('有 token＋gistId 就能推', S.canPush() === true);

  // 這一條就是重寫最容易弄壞的地方：只改一個欄位時，其他欄位必須原封不動。
  S.setDeviceConfig({ vapidKey: 'BKxx' });
  eq('加 vapidKey 之後 gistId 還在', S.deviceConfig().gistId, 'abc123');
  eq('加 vapidKey 之後 token 還在', S.deviceConfig().token, 'ghp_xxx');
  ok('加 vapidKey 之後仍然能推', S.canPush() === true);

  S.setDeviceConfig({ pushEndpoint: 'https://web.push.apple.com/AAA' });
  eq('五個欄位同時存在且正確', S.deviceConfig(), {
    gistId: 'abc123', token: 'ghp_xxx', vapidKey: 'BKxx',
    pushEndpoint: 'https://web.push.apple.com/AAA', pushCopiedAt: ''
  });

  // 手機的狀態：有 gist id、沒 token。
  S.setDeviceConfig({ token: '' });
  ok('清掉 token 之後不能推', S.canPush() === false);
  ok('清掉 token 之後還是能拉', S.canPull() === true);
  eq('清 token 沒波及 vapidKey', S.deviceConfig().vapidKey, 'BKxx');

  // 舊格式搬遷：他電腦上現在存的就是這種只有兩個欄位的。
  localStorage.data['iv-device-v1'] = JSON.stringify({ gistId: 'old999', token: 'old_tok' });
  eq('舊格式讀得到 gistId', S.deviceConfig().gistId, 'old999');
  eq('舊格式的新欄位補成空字串', S.deviceConfig().vapidKey, '');
  ok('舊格式仍然能推', S.canPush() === true);

  // 壞掉的 JSON 不能讓整個 app 起不來。
  localStorage.data['iv-device-v1'] = '{{{壞掉';
  eq('壞掉的 JSON 退回全空', S.deviceConfig(), EMPTY);
}

// ---- 3. 秘密不能進 state ----
//
// 「推上 gist」推的就是整個 state，而 secret gist 是「有網址就看得到」。
// token 或 endpoint 一旦被序列化進去，等於明文公開。
function testNoSecretsInState() {
  const { S } = loadStore();
  S.setDeviceConfig({
    gistId: 'GISTID_SENTINEL', token: 'TOKEN_SENTINEL',
    vapidKey: 'VAPID_SENTINEL', pushEndpoint: 'ENDPOINT_SENTINEL'
  });
  S.load();
  const json = JSON.stringify(S.getState());
  for (const s of ['TOKEN_SENTINEL', 'GISTID_SENTINEL', 'VAPID_SENTINEL', 'ENDPOINT_SENTINEL']) {
    ok('state 不含 ' + s, !json.includes(s));
  }
  eq('state 的頂層欄位沒有變多', Object.keys(S.getState()).sort(),
    ['aiDraft', 'lastExportAt', 'lastPushAt', 'records', 'schemaVersion', 'settings', 'stocks']);
}

// ---- 4. VAPID 公鑰的驗證 ----
//
// 自己先驗長度與開頭 byte，否則貼錯一個字只會拿到一個看不出原因的 DOMException。
// 透過 enablePush 的錯誤訊息間接測（vapidKeyBytes 刻意不 export）。
async function testVapidKey() {
  const { S } = loadStore({ push: true });
  const good = vapidPublicKey();
  const KEY_ERR = 'VAPID 公鑰沒填';
  const rejects = async (key) => {
    S.setDeviceConfig({ vapidKey: key });
    const r = await S.enablePush();
    return !!(r.error && r.error.includes(KEY_ERR));
  };

  eq('真實金鑰是 87 個字（UI 文案寫給他看的數字）', good.length, 87);
  ok('正確的公鑰會被接受', (await rejects(good)) === false);

  // 這兩種是貼上時最常見的雜訊，不能因此拒收
  ok('結尾多了 = 號仍接受', (await rejects(good + '=')) === false);
  ok('前後有空白仍接受', (await rejects('  ' + good + '\n')) === false);

  ok('空字串擋掉', await rejects(''));
  ok('只貼一半擋掉', await rejects(good.slice(0, 40)));
  ok('64 bytes（少了開頭 0x04）擋掉',
    await rejects(Buffer.from(crypto.randomBytes(64)).toString('base64url')));
  ok('65 bytes 但開頭不是 0x04 擋掉',
    await rejects(Buffer.concat([Buffer.from([3]), crypto.randomBytes(64)]).toString('base64url')));
  ok('完全不是 base64 擋掉', await rejects('這不是金鑰！！！'));
}

// ---- 5. 回歸：換 endpoint 必須清掉 pushCopiedAt ----
//
// 這是 build 23 寫出來、上線前抓到的 bug。失敗模式最壞：
// 他換一組 VAPID 金鑰重新訂閱，endpoint 變了，但 pushCopiedAt 還留著，
// 於是 pushState() 回 'on'，畫面說「訂閱資訊也複製過了」——而 GitHub 上還是舊的
// endpoint，他一則通知都收不到，也看不到任何警告。
//
// 「訂閱悄悄失效」本來就是這個功能唯一的失敗模式，而這個 bug 正好讓偵測它的
// 那套機制失效。所以這一條一定要鎖住。
async function testEndpointChangeInvalidatesCopy() {
  const { S, pushState } = loadStore({ push: true });

  S.setDeviceConfig({ vapidKey: vapidPublicKey() });
  await S.enablePush();
  eq('剛訂閱完、還沒複製 → uncopied', (await S.pushState()).kind, 'uncopied');

  await S.markPushCopied();
  eq('複製過之後 → on', (await S.pushState()).kind, 'on');

  // 換一組金鑰再按「開啟通知」：退訂重訂，endpoint 從 A 變成 B
  pushState.nextEndpoint = 'B';
  S.setDeviceConfig({ vapidKey: vapidPublicKey() });
  const r = await S.enablePush();

  ok('重新訂閱成功', r.ok === true);
  ok('endpoint 真的換了', r.sub.endpoint.endsWith('/B'));
  eq('換 endpoint 之後必須回 uncopied，不能回 on', (await S.pushState()).kind, 'uncopied');
  eq('pushCopiedAt 被清掉了', S.deviceConfig().pushCopiedAt, '');
  eq('pushEndpoint 更新成新的', S.deviceConfig().pushEndpoint.slice(-1), 'B');

  // 重新複製之後才回到 on
  await S.markPushCopied();
  eq('重新複製後 → on', (await S.pushState()).kind, 'on');
}

// ---- 6. 回歸：訂閱不見了要分得出 lost 與 off ----
async function testLostVsOff() {
  const { S } = loadStore({ push: true });
  eq('從沒訂閱過 → off', (await S.pushState()).kind, 'off');

  S.setDeviceConfig({ vapidKey: vapidPublicKey() });
  await S.enablePush();
  await S.markPushCopied();

  // 訂閱被系統清掉，但本機還記得 endpoint
  const sub = await S.currentPushSub();
  await sub.unsubscribe();
  eq('訂閱不見了但記得 endpoint → lost', (await S.pushState()).kind, 'lost');

  // 自己關掉：設定也清掉，所以是 off 不是 lost
  await S.disablePush();
  eq('自己關掉 → off', (await S.pushState()).kind, 'off');
  eq('關掉會清 pushEndpoint', S.deviceConfig().pushEndpoint, '');
}

// ---- 7. 結構性檢查：fallback 訊息的順序修正還在 ----
//
// 這一條沒有 DOM 測不到行為，但那個 bug 的成因是「refreshPushUi 非同步設訊息，
// 呼叫端同步設 fallback，所以 fallback 被蓋掉」。修法是三個具體的語法改動，
// 任何一個被改回去 bug 就復活，所以至少把它們鎖在這裡。
function testCopyFallbackOrdering() {
  const app = read('docs/app.js');
  ok('refreshPushUi 的早退回 Promise（不是裸 return，否則 .then 會丟 TypeError）',
    app.includes('      return Promise.resolve();\n    }'));
  ok('refreshPushUi 的主路徑有 return', app.includes('return Store.pushState().then(function (s) {'));
  ok('finish 把 refreshPushUi 串起來等它', app.includes('return refreshPushUi();'));
  ok('fallback 訊息排在 refreshPushUi 之後',
    app.indexOf('return refreshPushUi();') < app.indexOf('if (fallbackText) pushMsg(fallbackText, true);'));
}

// ---- 8. 結構性檢查：三處版本號一致 ----
//
// 不一致的話 versionMatches() 會 hardReset 一次，再不一致就跳「版本不一致」擋版。
function testBuildNumbers() {
  const html = read('docs/index.html').match(/app-build" content="(\d+)"/);
  const app = read('docs/app.js').match(/var BUILD = (\d+);/);
  const sw = read('docs/sw.js').match(/var CACHE = 'iv-calc-v(\d+)';/);
  ok('三處都找得到版本號', !!(html && app && sw));
  if (html && app && sw) {
    eq('index.html / app.js / sw.js 版本號一致',
      [html[1], app[1], sw[1]], [html[1], html[1], html[1]]);
  }
}

// ---- 9. 結構性檢查：公開 repo 裡不能寫死 gist id ----
function testNoHardcodedGist() {
  for (const f of ['docs/app.js', 'docs/store.js', 'docs/index.html', 'docs/sw.js']) {
    const s = read(f);
    ok(f + ' 沒有寫死 32 位的 gist id', !/\b[0-9a-f]{32}\b/.test(s));
    ok(f + ' 沒有寫死 gist 的 raw 網址', !s.includes('gist.githubusercontent.com/'));
  }
}

// ---- 跑 ----

const run = async () => {
  testMath();
  testDeviceConfig();
  testNoSecretsInState();
  await testVapidKey();
  await testEndpointChangeInvalidatesCopy();
  await testLostVsOff();
  testCopyFallbackOrdering();
  testBuildNumbers();
  testNoHardcodedGist();

  console.log(`通過 ${passed} 項`);
  if (failures.length) {
    console.log(`\n失敗 ${failures.length} 項：`);
    failures.forEach((f) => console.log('  ❌ ' + f));
    process.exit(1);
  }
  console.log('全部通過');
};

run().catch((err) => {
  console.error('測試本身爆掉了：', err);
  process.exit(1);
});
