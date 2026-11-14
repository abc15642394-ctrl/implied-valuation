// 收盤通知的發送端。由 .github/workflows/prices.yml 在抓完收盤價之後呼叫。
//
//     node .github/scripts/notify.mjs --new docs/prices.json --old /tmp/prev.json
//
// 只推兩種（使用者自己選的），沒事就完全不響：
//   1. 落差跨過 ±5pp 的門檻  —— 門檻值從 docs/app.js 讀出來，不在這裡抄第二份
//   2. 電腦太久沒推上 gist   —— 手機上看到的估值已經過期了
//
// ## 這個檔案最重要的一條規則：**Actions 的 log 是公開的**
//
// 這個 repo 是公開的，workflow 的 log 任何人都看得到。而通知內容裡有他的股票代號
// 與落差數字——**那就是他的估值**，整個 gist 走 secret 就是為了不公開它。
// 所以這裡**只准印筆數與固定字串**，絕對不准印代號、名稱、落差值或訊息內文。
// 連例外訊息都要攔：fetch 失敗的 message 可能帶著含 gist id 的網址。
//
// ## 為什麼拆成 decide() 與 main()
//
// 沿用 build_prices.py 已經驗證有效的結構（它把 build(sources) 拆出來就是為了可測）。
// decide() 是純函式：不碰網路、不碰 secret、不印任何東西。所以本機餵假資料就能
// 驗完所有判斷邏輯，**不需要任何 dry-run 旗標**——也就沒有「不小心把內文印進
// 公開 log」這個風險存在的空間。

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 電腦幾天沒推上 gist 就提醒。跟 app.js 的 BACKUP_NUDGE_DAYS 同一個數字，
// 意思也一樣：超過一週沒推，手機上那份就該被懷疑了。
export const STALE_PUSH_DAYS = 7;

// 一則通知塞不下太多檔，列到第三檔就改成「等 N 檔」。
const MAX_LISTED = 3;

// ---- 把 app 的數學原封不動載進來 ----
//
// 絕對不要在這裡重寫二分搜尋。通知說的落差必須跟他畫面上看到的是同一個數字，
// 而兩份實作遲早會因為某個邊界條件而分歧——那時候他會更不信任哪一邊都說不清。
export function loadValuation() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs/valuation.js'), 'utf8'), ctx);
  return ctx.window.Valuation;
}

// 門檻值從 app.js 讀出來，不在這裡抄一份常數。抄了就會有一天畫面說紅燈、
// 通知說沒事——而那種不一致幾乎不可能被發現。
export function loadThresholds(appSource) {
  const src = appSource !== undefined
    ? appSource
    : fs.readFileSync(path.join(ROOT, 'docs/app.js'), 'utf8');
  const good = src.match(/var\s+GAP_GOOD\s*=\s*(-?[\d.]+)\s*;/);
  const bad = src.match(/var\s+GAP_BAD\s*=\s*(-?[\d.]+)\s*;/);
  if (good && bad) {
    return { good: parseFloat(good[1]), bad: parseFloat(bad[1]), fromSource: true };
  }
  return { good: -5, bad: 5, fromSource: false };
}

// ---- 純邏輯 ----

function num(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// 跟 store.js 的 readSettings 一致，包含「折現率不大於永續成長率就整組退回 10/2」
// 那條保險——不然 DCF 會算出無限大或負數。
export function readSettings(state) {
  const s = (state && state.settings) || {};
  const out = {
    discountRate: num(s.discountRate, 10),
    perpetualGrowth: num(s.perpetualGrowth, 2),
    defaultCagr6_10: num(s.defaultCagr6_10, 5)
  };
  if (!(out.discountRate > out.perpetualGrowth)) {
    out.discountRate = 10;
    out.perpetualGrowth = 2;
  }
  return out;
}

// 排序方式必須跟 store.js 的 recordsOf 一致：date 新→舊，同一天再比 createdAt。
// 不一致的話，同一天估過兩次的那些檔會拿到不同的「最新一筆」，
// 通知算出來的落差就跟畫面不一樣。
export function latestRecord(records, stockId) {
  let best = null;
  for (const r of records) {
    if (!r || r.stockId !== stockId) continue;
    if (!best) { best = r; continue; }
    const d = String(r.date || '');
    const bd = String(best.date || '');
    if (d > bd || (d === bd && String(r.createdAt || '') > String(best.createdAt || ''))) {
      best = r;
    }
  }
  return best;
}

// 落差＝市場隱含 − 我估。跟 app.js 的 computeRecord 同一條式子。
// 算不出來（股價超出可反推範圍、EPS ≤ 0）回 null，**不可以當成 0**。
export function gapAt(V, rec, settings, price) {
  if (!(price > 0)) return null;
  if (!(rec.eps > 0)) return null;
  if (rec.myCagr1_5 === null || rec.myCagr1_5 === undefined
      || !Number.isFinite(rec.myCagr1_5)) return null;
  const g610 = num(rec.cagr6_10, settings.defaultCagr6_10) / 100;
  const res = V.impliedCagr1_5(price, rec.eps, g610,
    settings.discountRate / 100, settings.perpetualGrowth / 100);
  if (res.status !== 'ok') return null;
  return res.cagr * 100 - rec.myCagr1_5;
}

export function bandOf(gap, th) {
  if (gap === null) return null;
  if (gap <= th.good) return 'good';
  if (gap >= th.bad) return 'bad';
  return 'mid';
}

const BAND_NAME = { good: '低估', mid: '中間', bad: '市場更樂觀' };

function priceOf(prices, ticker) {
  const row = prices && prices[ticker];
  if (!Array.isArray(row)) return null;
  const p = parseFloat(row[1]);
  return p > 0 ? { name: String(row[0] || ''), price: p, date: String(row[2] || '') } : null;
}

export function daysSince(iso, now) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}

// 電腦太久沒推：第 7 天響一次，之後每 7 天一次。
// 刻意不是「超過 7 天就天天響」——那會變成他每天都要忽略的雜訊，
// 而雜訊會連帶讓他忽略真正要看的那一種。
export function staleDue(days) {
  return days !== null && days >= STALE_PUSH_DAYS
    && (days - STALE_PUSH_DAYS) % 7 === 0;
}

/**
 * 純函式：決定要送哪些通知。不碰網路、不碰 secret、不印任何東西。
 *
 * 落差的基準刻意是「前一次收盤 → 這一次收盤」，不是他的 currentPrice：
 *   (a) 他選的是「跨過門檻」，那本質上是價格事件；
 *   (b) 用 currentPrice 當基準的話，他不按「帶入」就會天天收到同一則；
 *   (c) 不需要任何狀態檔，所以不必把他的估值 commit 進這個公開 repo。
 */
export function decide({ V, th, state, oldPrices, newPrices, now, forceTest }) {
  const out = [];

  if (forceTest) {
    out.push({
      kind: 'test',
      tag: 'iv-test',
      title: '測試通知',
      body: '收到這則就表示整條路都通了：Actions → Apple → 這支手機。'
    });
  }

  const settings = readSettings(state);
  const stocks = Array.isArray(state && state.stocks) ? state.stocks : [];
  const records = Array.isArray(state && state.records) ? state.records : [];

  const crossed = [];
  for (const st of stocks) {
    if (!st || !st.ticker) continue;
    const rec = latestRecord(records, st.id);
    if (!rec) continue;

    const now_ = priceOf(newPrices, st.ticker);
    const then_ = priceOf(oldPrices, st.ticker);
    if (!now_ || !then_) continue;              // 名錄裡沒有這一檔，跳過不報錯

    const gNew = gapAt(V, rec, settings, now_.price);
    const gOld = gapAt(V, rec, settings, then_.price);
    const bNew = bandOf(gNew, th);
    const bOld = bandOf(gOld, th);
    if (!bNew || !bOld || bNew === bOld) continue;

    crossed.push({
      name: now_.name || st.name || st.ticker,
      ticker: st.ticker,
      from: bOld, to: bNew,
      gap: gNew,
      price: now_.price,
      prevPrice: then_.price,
      date: now_.date
    });
  }

  if (crossed.length) {
    // 最戲劇性的排前面：跨到 good／bad 的比跨回 mid 的值得先看。
    crossed.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    const listed = crossed.slice(0, MAX_LISTED).map((c) =>
      `${c.name} 轉為${BAND_NAME[c.to]} ${c.gap > 0 ? '+' : ''}${c.gap.toFixed(1)}pp`);
    const rest = crossed.length - listed.length;
    const one = crossed[0];
    out.push({
      kind: 'gap',
      tag: 'iv-gap',
      title: crossed.length === 1
        ? `${one.name} 落差轉為${BAND_NAME[one.to]}`
        : `${crossed.length} 檔的落差換了帶`,
      body: listed.join('、') + (rest > 0 ? `，等 ${crossed.length} 檔` : '')
        + `（依 ${one.date} 收盤）`
    });
  }

  const days = daysSince(state && state.lastPushAt, now);
  if (staleDue(days)) {
    out.push({
      kind: 'stale',
      tag: 'iv-stale',
      title: `電腦 ${days} 天沒推資料了`,
      body: '手機上的估值是那時候的。在 LINE 查到的數字，可能已經不是你最新的判斷。'
    });
  }

  return out;
}

// ---- 以下開始碰外界 ----

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback; }
}

// PUSH_SUB 收單一物件或陣列（將來 Mac 也能訂一份）。
function parseSubs(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return []; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((s) => s && typeof s.endpoint === 'string' && s.keys
    && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');
}

// 抓 gist。不帶 token——secret gist 允許未登入讀取（build 18 實機確認過），
// 所以手機與 Actions 都只需要 gist id。
//
// 例外一律不往外丟原訊息：它可能含有帶 gist id 的網址，而 log 是公開的。
async function fetchGist(gistId) {
  const url = `https://api.github.com/gists/${encodeURIComponent(gistId)}?_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`GitHub 回應 ${res.status}`);
  const g = await res.json();
  const files = g.files || {};
  const f = files['iv-data.json'] || files[Object.keys(files)[0]];
  if (!f) throw new Error('gist 裡沒有檔案');
  let text = f.content;
  if (f.truncated && f.raw_url) {
    const r2 = await fetch(f.raw_url, { cache: 'no-store' });
    if (!r2.ok) throw new Error(`抓 gist 內容回應 ${r2.status}`);
    text = await r2.text();
  }
  const state = JSON.parse(text);
  if (state.schemaVersion !== 2) {
    throw new Error(`gist 裡的 schemaVersion 是 ${state.schemaVersion}，不是 2`);
  }
  return state;
}

async function main() {
  const env = process.env;
  const need = ['GIST_ID', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'PUSH_SUB'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    // 通知沒設好，不能讓每日收盤價的 job 跟著失敗——那是比通知重要的產出。
    console.log(`通知沒設定（缺 ${missing.length} 個 secret），跳過。`);
    return 0;
  }

  const subs = parseSubs(env.PUSH_SUB);
  if (!subs.length) {
    console.log('PUSH_SUB 解不出有效的訂閱（要有 endpoint 與 keys.p256dh／keys.auth），跳過。');
    return 0;
  }

  const newPrices = readJson(arg('--new') || path.join(ROOT, 'docs/prices.json'), null);
  const oldPrices = readJson(arg('--old') || '', {});
  if (!newPrices) {
    console.log('讀不到這一次的 prices.json，跳過。');
    return 0;
  }

  const th = loadThresholds();
  if (!th.fromSource) {
    console.log('⚠️ 從 docs/app.js 讀不到 GAP_GOOD／GAP_BAD，改用預設 ±5。請檢查常數名稱有沒有被改掉。');
  }

  let state;
  try {
    state = await fetchGist(env.GIST_ID);
  } catch (e1) {
    // 網路抖動不值得寄一封失敗信給他。重試一次，還是不行就安靜跳過。
    try {
      state = await fetchGist(env.GIST_ID);
    } catch (e2) {
      console.log(`抓 gist 失敗兩次，跳過這一次（${e2.message}）。`);
      return 0;
    }
  }

  const forceTest = String(env.FORCE_TEST || '').toLowerCase() === 'true';
  const messages = decide({
    V: loadValuation(), th, state,
    oldPrices: oldPrices || {}, newPrices,
    now: Date.now(), forceTest
  });

  // 從這裡開始到結束，log 只准出現數字與固定字串。
  console.log(`追蹤 ${(state.stocks || []).length} 檔；決定要送 ${messages.length} 則`
    + `（${messages.map((m) => m.kind).join('／') || '無'}）；訂閱 ${subs.length} 個`);

  if (!messages.length) return 0;

  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  let sent = 0;
  let dead = 0;
  let failed = 0;
  for (const sub of subs) {
    for (const m of messages) {
      const payload = JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: './' });
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) { dead++; }
        else { failed++; console.log(`  一則送失敗，HTTP ${code || '不明'}`); }
      }
    }
  }

  console.log(`送出 ${sent} 則；訂閱已失效 ${dead}；其他失敗 ${failed}`);

  if (dead) {
    // 這個他必須知道，所以讓 job 失敗、GitHub 寄信。
    // 訂閱失效是靜默的，不報的話他只會覺得「怎麼好久沒通知」。
    console.log('有訂閱已經失效（404／410）。到 app 的「同步 → 收盤通知設定」'
      + '重新按「開啟通知」，再把新的訂閱資訊貼回 PUSH_SUB。');
    return 1;
  }
  if (failed && !sent) return 1;
  return 0;
}

// 直接執行時才跑 main，被 import 當模組時不跑（測試要用那些純函式）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // 例外訊息可能帶著含 gist id 的網址，而 log 是公開的，所以只印類型。
      console.log(`通知腳本出錯：${err && err.name ? err.name : '不明錯誤'}`);
      process.exit(1);
    });
}
