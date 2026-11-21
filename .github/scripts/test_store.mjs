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

// 結構性檢查**一律先剝掉註解**。
//
// 這個陷阱在 build 26 這一輪踩了兩次：修完之後我習慣在註解裡引用被換掉的舊寫法
// （「先前寫 `if (!Store.canPush()) return null;`」），而掃全文的斷言會把那段註解
// 當成還沒改——`notify.mjs` 的 `e2.message` 也是同一回事。
// 剝掉整行註解與區塊註解的續行，斷言看到的就只有真的會執行的程式。
function codeOnly(text) {
  return String(text).split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
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

// ---- 5b. 回歸：pushCopiedAt 有值但 pushEndpoint 空著時也要清 ----
//
// 這是修 5 的時候自己留下的洞：條件寫成 `prevEndpoint && j.endpoint !== prevEndpoint`，
// 那個 `prevEndpoint &&` 讓「pushCopiedAt 有值、pushEndpoint 是空字串」這個狀態
// 漏掉清除，於是訂閱完 pushState() 回 'on'——而他從沒複製過那個新 endpoint，
// GitHub 上什麼都沒有。
//
// 這個狀態怎麼來的：markPushCopied() 在「查不到訂閱」時只寫 pushCopiedAt、
// 不寫 pushEndpoint。要走到那裡，訂閱得在「顯示訂閱資訊」與「按複製」之間消失，
// 機率極低——但這一格存在的唯一理由就是防靜默失敗，留著洞不划算。
async function testCopiedWithoutEndpoint() {
  const { S } = loadStore({ push: true });

  S.setDeviceConfig({
    vapidKey: vapidPublicKey(),
    pushCopiedAt: '2026-11-01T00:00:00Z',
    pushEndpoint: ''
  });
  eq('起始狀態是 off（沒有訂閱）', (await S.pushState()).kind, 'off');

  const r = await S.enablePush();
  ok('訂閱成功', r.ok === true);
  eq('訂到了一個 endpoint', r.sub.endpoint.endsWith('/A'), true);
  eq('pushCopiedAt 必須被清掉（他沒複製過這個新 endpoint）',
    S.deviceConfig().pushCopiedAt, '');
  eq('所以狀態是 uncopied，不是 on', (await S.pushState()).kind, 'uncopied');
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
  // indexOf 相減的寫法在「字串根本不存在」時會回 -1 而假通過。
  // 同組上面那條 includes 擋得住不存在的情況，但這一條自己也該誠實：
  // 兩個都找得到才比較順序。
  const iRefresh = app.indexOf('return refreshPushUi();');
  const iFallback = app.indexOf('if (fallbackText) pushMsg(fallbackText, true);');
  ok('fallback 訊息排在 refreshPushUi 之後',
    iRefresh !== -1 && iFallback !== -1 && iRefresh < iFallback,
    `refreshPushUi=${iRefresh} fallback=${iFallback}`);
}

// ---- 7b. 結構性檢查：手機卡片的欄位順序 ----
//
// build 26 修的真缺陷。`#stockTable` 的手機卡片是 `display: grid` ＋ `order`，
// 而**沒設 order 又沒被隱藏的欄位會拿到預設的 order: 0**，也就是排到代號
// （order 1）前面去。先前 `count`（筆數）與 `date`（更新）兩欄都沒被提到，
// 所以每一張卡片最上面兩格是「筆數 3」「更新 11-20」，代號與落差被推到第二行
// ——而追蹤清單是預設分頁，那是打開 app 第一眼看到的東西。
//
// 過去的回歸檢查只量「四張表有沒有橫向溢出」，從來沒有檢查排列順序，所以這個
// 缺陷活了很久。這一條就是把那個檢查變成機器做的：**每一欄都必須有明確歸屬。**
function testMainCardColumns() {
  const app = read('docs/app.js');
  const css = read('docs/app.css');

  // rowHtml() 實際發出哪些 data-col
  const body = app.slice(app.indexOf('function rowHtml(row)'), app.indexOf('function refreshMainRow'));
  const cols = [];
  for (const m of body.matchAll(/(?:cell\('|priceCell\(s, '|editCell\(r, ')([a-zA-Z0-9_]+)'/g)) {
    if (cols.indexOf(m[1]) === -1) cols.push(m[1]);
  }
  eq('主表發出 13 欄', cols.length, 13);

  const orders = {};
  for (const m of css.matchAll(/#stockTable tbody td\[data-col="([a-zA-Z0-9_]+)"\][^{]*\{([^}]*)\}/g)) {
    const o = m[2].match(/order:\s*(\d+)/);
    if (o) orders[m[1]] = parseInt(o[1], 10);
  }
  const hidden = new Set();
  for (const m of css.matchAll(/((?:#stockTable tbody td\[data-col="[a-zA-Z0-9_]+"\][,\s]*)+)\{([^}]*)\}/g)) {
    if (m[2].indexOf('display: none') !== -1) {
      for (const h of m[1].matchAll(/data-col="([a-zA-Z0-9_]+)"/g)) hidden.add(h[1]);
    }
  }

  const unplaced = cols.filter((c) => !hidden.has(c) && orders[c] === undefined);
  ok('每一欄都要嘛有 order、要嘛被明確隱藏（沒有的會排到代號前面）',
    unplaced.length === 0, `沒有歸屬的欄位：${unplaced.join('、')}`);

  const named = new Set([...Object.keys(orders), ...hidden]);
  const ghosts = [...named].filter((c) => cols.indexOf(c) === -1).sort();
  ok('CSS 沒有指名主表不發的欄位（欄位改名後的遺留）',
    ghosts.length === 0, `幽靈欄位：${ghosts.join('、')}`);

  // 代號必須是視覺上的第一格
  const visible = cols.filter((c) => !hidden.has(c));
  const first = visible.slice().sort((a, b) => orders[a] - orders[b])[0];
  eq('卡片的第一格是代號', first, 'ticker');

  // 「點卡片展開」那套規則 app.js 從來沒有實作（expanded 只用在 AI 試算頁）
  eq('主表沒有殘留的 tr.expanded 規則',
    (css.match(/#stockTable tbody tr\.expanded/g) || []).length, 0);

  // 上面那一條刪掉主表的死規則，所以這裡要確認**沒有順手刪掉真的在用的那一套**：
  // AI 試算頁的展開是真的，JS 會加 class、CSS 也有對應規則，兩邊缺一邊就壞。
  //
  // （第一版我在這裡寫「整個 app.js 只有一個地方會加 expanded」，並拿它當保護。
  //  突變測試顯示那條抓不到「主表也加 expanded」——但想清楚之後，那個突變
  //  **不是真缺陷**：主表多掛一個沒有任何 CSS 的 class 是惰性的。
  //  斷言應該測「壞了會痛的事」，所以改成測 AI 那一套的兩邊都還在。）
  const iAi = app.indexOf('function aiRowHtml');
  const iEnd = app.indexOf('function aiRows');
  ok('AI 試算頁的列還是會加 expanded（展開互動的 JS 那一半）',
    iAi !== -1 && iEnd > iAi && app.slice(iAi, iEnd).indexOf('class="expanded"') !== -1,
    'aiRowHtml 不再加 expanded，展開互動壞了');
  ok('而且 CSS 那一半也還在（#aiTable 的 tr.expanded 規則）',
    /#aiTable tbody tr\.expanded/.test(css), '#aiTable 的 expanded 規則被刪掉了');
}

// ---- 7c. 結構性檢查：帶入鍵問的是「是不是副本」，不是「能不能推」----
//
// build 26 修的真缺陷。canPush() 是 token && gistId，所以「還沒設定 gist 的正本」
// 與「token 剛好過期的電腦」都會被誤判成手機而失去帶入鍵——而他的 classic token
// 有到期日，到期那天 Mac 上的帶入鍵會無聲消失。
function testPendingCloseUsesReplica() {
  const app = read('docs/app.js');
  const fn = codeOnly(app.slice(app.indexOf('function pendingClose(stock)'),
                                app.indexOf('function closeBtn(stock)')));
  ok('pendingClose 不再用 !Store.canPush() 當判準',
    !/if \(!Store\.canPush\(\)\) return null;/.test(fn), '又改回 canPush 了');
  ok('pendingClose 問的是 backupState().kind === \'replica\'',
    fn.indexOf("backupState().kind === 'replica'") !== -1);
  // 另外三處既有的寫法不能被改壞（它們是這個判斷的其他三個出口）
  ok('renderFreshTag 仍然同時看 canPush 與 canPull',
    app.indexOf('if (Store.canPush() || !Store.canPull()') !== -1);
  ok('saveQuick 仍然同時看 canPush 與 canPull',
    app.indexOf('if (!Store.canPush() && Store.canPull())') !== -1);
}

// ---- 7d. 結構性檢查：6-10 年留空＝設定的預設值，不是 0% ----
//
// 2% vs 5% 實測會讓市場隱含差 2.46pp，而落差門檻是 ±5pp——足以讓紅綠燈翻面。
// 先前主計算器存 0%、快速估值視窗存預設值，同一個欄位兩種行為。
function testG610Default() {
  // 這裡同樣要 codeOnly：註解裡引用了舊寫法 `v.g610 === null ? 0 : v.g610`，
  // 掃全文的話會因為自己的註解而誤判（而且先前是「剛好沒撞到」才通過的）。
  const app = codeOnly(read('docs/app.js'));
  ok('沒有任何地方把留空的 6-10 年當成 0',
    !/cagr6_10: v\.g610 === null \? 0/.test(app) && !/var g610 = v\.g610 === null \? 0/.test(app),
    '還有地方把它當成 0%');
  ok('helper 存在', app.indexOf('function g610OrDefault(v)') !== -1);
  ok('helper 回的是 settings().defaultCagr6_10',
    /function g610OrDefault\(v\) \{\s*\n\s*return \(v === null \|\| v === undefined\) \? settings\(\)\.defaultCagr6_10 : v;/.test(app));
  // 顯示與儲存都要走它，否則會變成「畫面用 0% 算、存進去用 5%」
  // 五個呼叫點：主計算器的顯示、快速估值視窗的顯示、以及三處儲存
  //（加入追蹤的新增與編輯、快速估值的存檔）。減 1 是扣掉函式定義本身。
  eq('兩處顯示與三處儲存都走 helper（共 5 個呼叫點）',
    (app.match(/g610OrDefault\(/g) || []).length - 1, 5);
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
  await testCopiedWithoutEndpoint();
  await testLostVsOff();
  testCopyFallbackOrdering();
  testMainCardColumns();
  testPendingCloseUsesReplica();
  testG610Default();
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
