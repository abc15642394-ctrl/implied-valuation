// 收盤通知發送端的測試。用 node 直接跑，不裝任何東西：
//
//     node .github/scripts/test_notify.mjs
//
// 只測 notify.mjs 的純函式（decide 與它的零件）。那些函式刻意不碰網路、不碰
// secret、不印東西，所以這裡餵假資料就能把判斷邏輯全部走一遍。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decide, loadValuation, loadThresholds, latestRecord, gapAt,
  readSettings, staleDue, daysSince, parseGistState, STALE_PUSH_DAYS,
  readSecrets, SECRET_KEYS
} from './notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; return; }
  failures.push(detail ? `${name}\n       ${detail}` : name);
};
const eq = (name, got, want) => ok(name,
  JSON.stringify(got) === JSON.stringify(want),
  `得到 ${JSON.stringify(got)}\n       應為 ${JSON.stringify(want)}`);

const V = loadValuation();
const TH = loadThresholds();

// ---- 1. 數學與門檻值的來源 ----

function testFoundations() {
  eq('四個基準數字沒跑掉', [0.05, 0.15, 0.30]
    .map((g) => V.dcfParts(10, g, 0.05, 0.10, 0.02).total.toFixed(2)),
    ['158.19', '237.86', '418.27']);

  // 門檻值必須真的從 app.js 讀到，不是靜悄悄用了退回值。
  // 用退回值的話畫面與通知會各用一套門檻，而那種不一致幾乎發現不了。
  ok('門檻值是從 docs/app.js 讀出來的，不是退回值', TH.fromSource === true);
  eq('門檻值等於 app.js 裡的 ±5', [TH.good, TH.bad], [-5, 5]);

  // 常數名稱被改掉時要能察覺（會退回 ±5 並在 log 警告）
  const fake = loadThresholds('var GAP_OK = -5; var GAP_NG = 5;');
  ok('讀不到時會標記 fromSource=false', fake.fromSource === false);
  eq('讀不到時退回 ±5', [fake.good, fake.bad], [-5, 5]);
}

// ---- 2. 「最新一筆」的排序要跟 store.js 的 recordsOf 一致 ----

function testLatestRecord() {
  const recs = [
    { id: 'a', stockId: 's1', date: '2026-11-01', createdAt: '2026-11-01T01:00:00Z' },
    { id: 'b', stockId: 's1', date: '2026-11-10', createdAt: '2026-11-10T01:00:00Z' },
    { id: 'c', stockId: 's1', date: '2026-11-10', createdAt: '2026-11-10T09:00:00Z' },
    { id: 'd', stockId: 's2', date: '2026-11-30', createdAt: '2026-11-30T01:00:00Z' }
  ];
  eq('取日期最新的那一筆', latestRecord(recs, 's1').id, 'c');
  ok('同一天比 createdAt（不是陣列順序）', latestRecord(recs, 's1').id === 'c');
  eq('不會拿到別檔的紀錄', latestRecord(recs, 's2').id, 'd');
  eq('沒有紀錄回 null', latestRecord(recs, 's9'), null);
}

// ---- 3. 落差算不出來時必須跳過，不可以當成 0 ----
//
// 這是這個專案最在意的一條：「還沒估」與「估 0%」意義完全不同，
// 混在一起會算出一個看似正常的假數字，而那比沒有數字危險得多。

function testGapGuards() {
  const s = readSettings({ settings: { discountRate: 10, perpetualGrowth: 2, defaultCagr6_10: 5 } });
  const base = { eps: 10, myCagr1_5: 15, cagr6_10: 5 };

  ok('正常情況算得出落差', gapAt(V, base, s, 237.86) !== null);
  eq('現價＝合理價時落差約 0',
    Math.abs(gapAt(V, base, s, 237.86)) < 0.05, true);

  eq('沒填現價 → null', gapAt(V, base, s, null), null);
  eq('現價 0 → null', gapAt(V, base, s, 0), null);
  eq('EPS 0 → null', gapAt(V, { ...base, eps: 0 }, s, 100), null);
  eq('EPS 負 → null', gapAt(V, { ...base, eps: -3 }, s, 100), null);
  eq('myCagr1_5 是 null（未估）→ null', gapAt(V, { ...base, myCagr1_5: null }, s, 100), null);

  // 「未估」不能被當成 0%
  const asZero = gapAt(V, { ...base, myCagr1_5: 0 }, s, 100);
  ok('估 0% 算得出落差（跟「未估」是兩回事）', asZero !== null);

  // cagr6_10 缺值要吃設定的預設，不是 0。差別實測有 9.9%／2.46pp，足以讓紅綠燈翻面。
  const withDefault = gapAt(V, { eps: 10, myCagr1_5: 15 }, s, 300);
  const withExplicit = gapAt(V, { eps: 10, myCagr1_5: 15, cagr6_10: 5 }, s, 300);
  eq('cagr6_10 缺值會吃 defaultCagr6_10', withDefault, withExplicit);

  // 折現率不大於永續成長率時整組退回 10/2（否則 DCF 會算出無限大或負數）
  const broken = readSettings({ settings: { discountRate: 2, perpetualGrowth: 5 } });
  eq('壞掉的折現率組合退回 10/2',
    [broken.discountRate, broken.perpetualGrowth], [10, 2]);
}

// ---- 4. 「電腦太久沒推」只在第 7、14、21 天響 ----

function testStaleSchedule() {
  const want = {};
  for (let d = 0; d <= 30; d++) want[d] = (d >= 7 && (d - 7) % 7 === 0);
  const got = {};
  for (let d = 0; d <= 30; d++) got[d] = staleDue(d);
  eq('第 0–30 天的響法完全符合「第 7 天起每 7 天一次」', got, want);

  eq('第 7 天會響', staleDue(7), true);
  eq('第 14 天會響', staleDue(14), true);
  eq('第 21 天會響', staleDue(21), true);
  eq('第 6 天不響', staleDue(6), false);
  eq('第 8 天不響（刻意不是超過就天天響）', staleDue(8), false);
  eq('第 13 天不響', staleDue(13), false);
  eq('從沒推過（null）不響', staleDue(null), false);
  eq('門檻常數就是 7', STALE_PUSH_DAYS, 7);

  const now = Date.parse('2026-11-14T12:00:00Z');
  eq('daysSince 算得對', daysSince('2026-11-07T12:00:00Z', now), 7);
  eq('daysSince 吃到 null 回 null', daysSince(null, now), null);
  eq('daysSince 吃到爛字串回 null', daysSince('不是日期', now), null);
}

// ---- 5. decide()：跨門檻才推 ----

// 做一份狀態：一檔股票、一筆紀錄，落差由現價決定。
function makeState({ ticker = '2330', eps = 10, my = 15, lastPushAt = null } = {}) {
  return {
    schemaVersion: 2,
    settings: { discountRate: 10, perpetualGrowth: 2, defaultCagr6_10: 5 },
    stocks: [{ id: 's1', ticker, name: '測試檔', market: 'TW' }],
    records: [{ id: 'r1', stockId: 's1', date: '2026-11-01',
                createdAt: '2026-11-01T00:00:00Z', eps, myCagr1_5: my, cagr6_10: 5 }],
    aiDraft: {}, lastExportAt: null, lastPushAt
  };
}
// 兩個交易所的日期不一樣（TWSE 結構性落後一個交易日，第三包實測過），所以這支
// 必須能一次塞多檔、每一檔帶自己的日期。
//
// **先前它只吃一檔、日期還是帶預設值的參數**，而全檔每一處都用那個預設值——
// 結果「通知內文把一檔的收盤日套用到全部」那個 bug 在結構上不可能被測到。
// 光加斷言沒有用，因為 fixture 本身只有一個日期。這是改成 rows 的唯一理由。
//
//     prices(['2330', 100])                       → 一檔，日期用預設
//     prices(['1111', 100, '2026-11-12'],         → 兩檔，分屬兩個交易所的日期
//            ['6666', 200, '2026-11-13'])
const prices = (...rows) => {
  const out = {};
  for (const [ticker, p, date, name] of rows) {
    // 名稱可以指定：decide() 用的是 prices 裡的名稱（`now_.name || st.name`），
    // 而名稱長度直接決定內文長度，三檔列舉那條路徑要用長名稱才測得到最壞情況。
    out[ticker] = [name || '測試檔', p, date || '2026-11-13'];
  }
  return out;
};

// 找出讓落差落在某一帶的現價：合理價附近落差≈0（mid），價格拉高落差變大（bad），
// 壓低則落差變負（good）。
const FAIR_15 = V.dcfParts(10, 0.15, 0.05, 0.10, 0.02).total;   // 237.86

function gapForPrice(p) {
  return gapAt(V, { eps: 10, myCagr1_5: 15, cagr6_10: 5 },
    readSettings(makeState()), p);
}

function testDecideCrossing() {
  const mid = FAIR_15;                 // 落差 ≈ 0
  // 往上找一個落差 ≥ +5pp 的價、往下找一個 ≤ -5pp 的價
  let high = mid, low = mid;
  while (gapForPrice(high) < 6 && high < mid * 20) high *= 1.1;
  while (gapForPrice(low) > -6 && low > mid / 50) low *= 0.9;

  ok('找得到落差 ≥ +5pp 的價', gapForPrice(high) >= 5,
    `high=${high.toFixed(1)} gap=${gapForPrice(high)}`);
  ok('找得到落差 ≤ -5pp 的價', gapForPrice(low) <= -5,
    `low=${low.toFixed(1)} gap=${gapForPrice(low)}`);

  const run = (oldP, newP, extra = {}) => decide({
    V, th: TH, state: makeState(extra),
    oldPrices: prices(['2330', oldP]), newPrices: prices(['2330', newP]),
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest: false
  });

  eq('沒跨門檻 → 不推', run(mid, mid * 1.01).length, 0);
  eq('mid → bad 會推', run(mid, high).filter((m) => m.kind === 'gap').length, 1);
  eq('mid → good 會推', run(mid, low).filter((m) => m.kind === 'gap').length, 1);
  eq('bad → mid 會推（跨回來也算）', run(high, mid).filter((m) => m.kind === 'gap').length, 1);
  eq('good → bad 會推', run(low, high).filter((m) => m.kind === 'gap').length, 1);
  eq('bad → bad 不推（還在同一帶）', run(high, high * 1.05).filter((m) => m.kind === 'gap').length, 0);

  // 訊息內容該提到轉去哪一帶與依據的收盤日
  const msg = run(mid, low).find((m) => m.kind === 'gap');
  ok('訊息標題提到轉為低估', msg.title.includes('低估'), msg.title);
  ok('訊息內文寫出依據的收盤日', msg.body.includes('2026-11-13'), msg.body);
  eq('落差類的 tag 是 iv-gap', msg.tag, 'iv-gap');
}

function testDecideSkips() {
  const run = (state, oldP, newP) => decide({
    V, th: TH, state,
    oldPrices: oldP === null ? {} : prices(['2330', oldP]),
    newPrices: newP === null ? {} : prices(['2330', newP]),
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest: false
  });
  const mid = FAIR_15;
  let high = mid;
  while (gapForPrice(high) < 6 && high < mid * 20) high *= 1.1;

  // 「未估」這一條要用**會讓 bug 現形**的價格組合。
  // 如果哪天有人把 myCagr1_5 的 null 當成 0%，落差就會等於市場隱含本身；
  // 120 → 250 這組會讓隱含從 5% 以下跨到 15% 以上，也就是會「跨門檻」而誤推。
  // （先前我挑的價格讓兩邊剛好落在同一帶，所以就算 bug 在也測得過——
  //   突變測試才抓出那條斷言是巧合通過的。）
  eq('未估 1-5 年 → 跳過不推（價格組合刻意會讓 null 當 0 的 bug 現形）',
    run(makeState({ my: null }), 120, 250).length, 0);
  eq('未估 1-5 年 → 跳過不推（另一組價格）', run(makeState({ my: null }), mid, high).length, 0);
  eq('EPS ≤ 0 → 跳過不推', run(makeState({ eps: 0 }), mid, high).length, 0);
  eq('名錄裡沒有這一檔 → 跳過不報錯', run(makeState({ ticker: '9999' }), mid, high).length, 0);
  eq('缺前一次收盤 → 跳過（第一次跑沒有基準）', run(makeState(), null, high).length, 0);
  eq('缺這一次收盤 → 跳過', run(makeState(), mid, null).length, 0);
  eq('沒有任何紀錄的股票 → 跳過',
    run({ ...makeState(), records: [] }, mid, high).length, 0);
  eq('空的 state 不會爆', decide({
    V, th: TH, state: {}, oldPrices: {}, newPrices: {},
    now: Date.now(), forceTest: false
  }).length, 0);
}

function testDecideStaleAndTest() {
  const iso = (d) => new Date(Date.parse('2026-11-14T12:00:00Z') - d * 86400000).toISOString();
  const run = (days, forceTest = false) => decide({
    V, th: TH, state: makeState({ lastPushAt: days === null ? null : iso(days) }),
    oldPrices: prices(['2330', FAIR_15]), newPrices: prices(['2330', FAIR_15]),
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest
  });

  eq('第 7 天推「太久沒推」', run(7).filter((m) => m.kind === 'stale').length, 1);
  eq('第 6 天不推', run(6).filter((m) => m.kind === 'stale').length, 0);
  eq('第 8 天不推', run(8).filter((m) => m.kind === 'stale').length, 0);
  eq('第 14 天推', run(14).filter((m) => m.kind === 'stale').length, 1);
  eq('從沒推過不推（沒有基準可講）', run(null).filter((m) => m.kind === 'stale').length, 0);
  eq('太久沒推的 tag 是 iv-stale', run(7).find((m) => m.kind === 'stale').tag, 'iv-stale');

  // 兩種提醒的 tag 必須不同，否則後到的會把前一則擠掉
  const both = decide({
    V, th: TH, state: makeState({ lastPushAt: iso(7) }),
    oldPrices: prices(['2330', FAIR_15]), newPrices: prices(['2330', FAIR_15 * 3]),
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest: true
  });
  const tags = both.map((m) => m.tag);
  eq('三種同時發生時 tag 不重複', tags.length, new Set(tags).size);
  ok('測試通知一定會出現（不管有沒有跨門檻）',
    both.some((m) => m.kind === 'test'), JSON.stringify(tags));
  eq('沒開 forceTest 就沒有測試通知',
    run(0).filter((m) => m.kind === 'test').length, 0);

  // 每一則都必須有標題與內文：sw.js 雖然有預設文案，但那是最後一道保險，
  // 不該讓它常態被用到（Apple 要求每一則推播都真的顯示通知）。
  for (const m of both) {
    ok(`${m.kind} 有非空標題`, typeof m.title === 'string' && m.title.length > 0);
    ok(`${m.kind} 有非空內文`, typeof m.body === 'string' && m.body.length > 0);
    ok(`${m.kind} 內文不超過 120 字（鎖定畫面會截斷）`, m.body.length <= 120,
      `${m.body.length} 字`);
  }
}

// ---- 5b. 通知內文：日期、單檔文案、長度 ----
//
// 這一組全部是「上線之後逐字讀回才發現」的問題。共同的根因是測試的 fixture
// 只有一個日期、而且只測單檔，所以結構上看不到這些路徑。

// 兩檔分屬不同交易所日期的狀態。不能重用 makeState（它只放一檔）。
function twoStockState() {
  return {
    schemaVersion: 2,
    settings: { discountRate: 10, perpetualGrowth: 2, defaultCagr6_10: 5 },
    stocks: [
      { id: 'a', ticker: '1111', name: '上市股', market: 'TW' },
      { id: 'b', ticker: '6666', name: '上櫃股', market: 'TW' }
    ],
    records: [
      { id: 'ra', stockId: 'a', date: '2026-11-01', createdAt: '2026-11-01T00:00:00Z',
        eps: 10, myCagr1_5: 15, cagr6_10: 5 },
      { id: 'rb', stockId: 'b', date: '2026-11-01', createdAt: '2026-11-01T00:00:00Z',
        eps: 10, myCagr1_5: 15, cagr6_10: 5 }
    ],
    aiDraft: {}, lastExportAt: null, lastPushAt: null
  };
}

function testBodyDatesAndWording() {
  const mid = FAIR_15;
  const run = (state, oldP, newP) => decide({
    V, th: TH, state, oldPrices: oldP, newPrices: newP,
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest: false
  }).find((m) => m.kind === 'gap');

  // ① 兩檔分屬 11-12 與 11-13（實際的 prices.json 就是這樣：1378 檔 11-12、997 檔 11-13）。
  //    內文只寫一個日期的話，另一檔的日期就是錯的。
  const two = run(twoStockState(),
    prices(['1111', mid, '2026-11-11', '上市股'], ['6666', mid, '2026-11-12', '上櫃股']),
    prices(['1111', mid * 3, '2026-11-12', '上市股'], ['6666', mid * 3, '2026-11-13', '上櫃股']));
  ok('兩檔都跨了門檻', two && two.title.includes('2 檔'), two && two.title);
  ok('內文寫出 2026-11-12', two.body.includes('2026-11-12'), two.body);
  ok('內文也寫出 2026-11-13（不能只拿其中一檔的日期套用到全部）',
    two.body.includes('2026-11-13'), two.body);

  // 只有一個日期時不要變成「2026-11-13、2026-11-13」
  const same = run(twoStockState(),
    prices(['1111', mid, '2026-11-13'], ['6666', mid, '2026-11-13']),
    prices(['1111', mid * 3, '2026-11-13'], ['6666', mid * 3, '2026-11-13']));
  eq('同一個日期只出現一次',
    (same.body.match(/2026-11-13/g) || []).length, 1);

  // ⑤ 單檔時標題已經寫了名稱與分帶，內文不該再重複一次。
  const single = decide({
    V, th: TH, state: makeState(),
    oldPrices: prices(['2330', mid]), newPrices: prices(['2330', mid * 0.35]),
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest: false
  }).find((m) => m.kind === 'gap');
  ok('單檔標題有名稱與分帶', single.title.includes('測試檔') && single.title.includes('低估'),
    single.title);
  ok('單檔內文不重複名稱', !single.body.includes('測試檔'), single.body);
  ok('單檔內文不重複分帶名', !single.body.includes('低估'), single.body);
  ok('單檔內文仍然有落差數字', /-?\d+\.\d+pp/.test(single.body), single.body);

  // ⑩ 列舉是最長的那條路徑，先前完全沒測過長度。
  //
  // 必須測到**五檔**，不是三檔：MAX_LISTED 是 3，三檔的時候「列 3」與「列全部」
  // 長度一樣，所以把 MAX_LISTED 改大也測不出來（突變測試抓到的）。
  // 五檔時正確行為是「列 3 檔 ＋ 等 5 檔」；若有人把 MAX_LISTED 拿掉，
  // 五個長名稱全列出來就會衝破 120。
  const LONG = ['台灣積體電路製造', '環球晶圓', '世界先進積體電路', '南亞科技', '力積電子製造服務'];
  const manyState = (k) => ({
    schemaVersion: 2,
    settings: { discountRate: 10, perpetualGrowth: 2, defaultCagr6_10: 5 },
    stocks: LONG.slice(0, k).map((nm, i) => ({ id: 's' + i, ticker: '100' + i, name: nm, market: 'TW' })),
    records: LONG.slice(0, k).map((_, i) => ({ id: 'r' + i, stockId: 's' + i,
      date: '2026-11-01', createdAt: '2026-11-01T00:00:00Z',
      eps: 10, myCagr1_5: 15, cagr6_10: 5 })),
    aiDraft: {}, lastExportAt: null, lastPushAt: null
  });
  // 刻意讓兩個交易所的日期都出現
  const manyPrices = (k, p) => prices(...LONG.slice(0, k).map((nm, i) =>
    ['100' + i, p, i % 2 ? '2026-11-13' : '2026-11-12', nm]));

  for (const k of [1, 2, 3, 4, 5]) {
    const m = run(manyState(k), manyPrices(k, mid), manyPrices(k, mid * 3));
    ok(`${k} 檔時內文不超過 120 字（鎖定畫面會截斷）`, m.body.length <= 120,
      `${m.body.length} 字：${m.body}`);
  }

  const m5 = run(manyState(5), manyPrices(5, mid), manyPrices(5, mid * 3));
  ok('五檔時只列前 3 檔，其餘收成「等 5 檔」',
    m5.body.includes('等 5 檔') && m5.body.split('轉為').length - 1 === 3, m5.body);
  ok('五檔時兩個交易所的日期都在', m5.body.includes('2026-11-12') && m5.body.includes('2026-11-13'),
    m5.body);
}

// ---- 5c. gist 內容解析：錯誤訊息絕對不能夾帶他的資料 ----
//
// V8 的 JSON 錯誤訊息會夾帶輸入的前 10 個字，而 Actions 的 log 是公開的。
// 這一組是行為測試（不是結構檢查）：直接拿會洩漏的輸入餵進去，斷言丟出來的
// 訊息裡找不到那些字。
function testGistParseNoLeak() {
  // 刻意長得像他真實資料的假內容
  const secret = '台積電 2330 我估 18.5% 這是我的筆記';
  const cases = [
    ['完全不是 JSON', secret],
    ['被截斷的 JSON', '{"schemaVersion":2,"stocks":[{"ticker":"2330","name":"台積電"'],
    ['GitHub 回了 HTML', '<html><body>Not Found</body></html>'],
    ['空字串', ''],
    ['是陣列不是物件', '[1,2,3]'],
    ['null', 'null'],
    ['schemaVersion 不是 2', '{"schemaVersion":1,"stocks":[]}'],
    // 下面三個是 build 25 補的。build 24 抽出 parseGistState() 就是為了「錯誤訊息
    // 全部自己控制」，但它自己留了一條 `JSON.stringify(state.schemaVersion)`
    // ——當時的註解寫「schemaVersion 只會是小整數」，那是假設不是保證。
    // 而上面那條案例用的值是 `1`（安全值），所以測不出來：同一種盲點又來一次。
    ['schemaVersion 是字串', '{"schemaVersion":"台積電 2330 我估 18.5%","stocks":[]}'],
    ['schemaVersion 是物件', '{"schemaVersion":{"note":"富喬 1815 成本 70.5"},"stocks":[]}'],
    ['schemaVersion 是陣列', '{"schemaVersion":["2330","1815"],"stocks":[]}']
  ];
  // 這份清單必須涵蓋**上面每一個案例裡出現過的字**，否則某個案例會因為
  // 「偵測器沒看那個字」而假通過——build 25 第一次跑就是這樣：物件那條案例裡的
  // 富喬／1815／70.5 都不在清單上，所以它看起來是綠的。
  const leaky = ['台積電', '2330', '18.5', '筆記', 'ticker', 'stocks', 'Not Found',
    '富喬', '1815', '70.5', 'note'];

  for (const [name, text] of cases) {
    let msg = null;
    try { parseGistState(text); } catch (e) { msg = e.message; }
    ok(`${name} → 會丟錯`, msg !== null, '居然沒丟錯');
    if (msg === null) continue;
    const found = leaky.filter((x) => msg.includes(x));
    ok(`${name} → 訊息不夾帶內容`, found.length === 0,
      `訊息「${msg}」夾帶了 ${found.join('、')}`);
  }

  // 合法的要過
  const good = parseGistState('{"schemaVersion":2,"stocks":[],"records":[]}');
  eq('合法的 v2 state 解得出來', good.schemaVersion, 2);
}

// ---- 5d. 五個 secret 一定要去頭尾空白 ----
//
// 這一組鎖的是 2026-11-16 到 11-20「五次執行全部靜默跳過」那個真實事故：
// 貼進 GitHub 的 GIST_ID 尾端多了空白字元，網址變成 `.../gists/xxx%0A` → 必定 404。
// app 那一邊早就有這道紀律（store.js 讀與寫都 trim），發送端漏了。
function testSecretsTrimmed() {
  const dirty = {
    GIST_ID: ' abc123def456\n',
    VAPID_PUBLIC_KEY: '\tBNx...\t',
    VAPID_PRIVATE_KEY: 'xyz\r\n',
    VAPID_SUBJECT: '  mailto:a@example.com  ',
    PUSH_SUB: '\n{"endpoint":"x"}\n'
  };
  const out = readSecrets(dirty);
  eq('GIST_ID 的換行被去掉', out.GIST_ID, 'abc123def456');
  eq('公鑰的 tab 被去掉', out.VAPID_PUBLIC_KEY, 'BNx...');
  eq('私鑰的 CRLF 被去掉', out.VAPID_PRIVATE_KEY, 'xyz');
  eq('subject 的空白被去掉', out.VAPID_SUBJECT, 'mailto:a@example.com');
  eq('PUSH_SUB 的換行被去掉', out.PUSH_SUB, '{"endpoint":"x"}');

  // 尾端一個換行會變成什麼：這就是那五天的實際原因
  ok('沒 trim 的話網址會被編碼成 %0A',
    encodeURIComponent(' abc123def456\n').includes('%0A'));
  ok('trim 之後網址乾淨', !encodeURIComponent(out.GIST_ID).includes('%'));

  eq('缺的 key 回空字串', readSecrets({}).GIST_ID, '');
  eq('env 是 undefined 也不爆', readSecrets(undefined).GIST_ID, '');
  eq('不是字串的值回空字串', readSecrets({ GIST_ID: 123 }).GIST_ID, '');
  eq('只有空白的值 trim 完是空的（會被當成沒設）', readSecrets({ GIST_ID: '   ' }).GIST_ID, '');
  eq('五個 key 不多不少', SECRET_KEYS.length, 5);

  // main() 不准再直接讀 process.env 的那五個——繞過 trim 就等於沒修
  const src = fs.readFileSync(path.join(ROOT, '.github/scripts/notify.mjs'), 'utf8');
  for (const k of SECRET_KEYS) {
    ok(`main() 不直接讀 process.env.${k}`, !src.includes('process.env.' + k));
    ok(`main() 不直接讀 env.${k}`, !new RegExp('[^.\\w]env\\.' + k).test(src));
  }

  // 跟 workflow 對帳：那邊傳了什麼 secret，這邊就該讀什麼
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/prices.yml'), 'utf8');
  const inYml = [...yml.matchAll(/\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)].map((m) => m[1]);
  eq('workflow 傳的 secret 跟 SECRET_KEYS 一字不差',
    [...new Set(inYml)].sort(), [...SECRET_KEYS].sort());
}

// ---- 5e. 自己丟的 gist 錯誤要印得出原因，別人丟的不准印 ----
//
// 先前一律只印 e2.name，五種原因（404／403／沒有檔案／不是 JSON／schemaVersion
// 不對）**全部印成同一個字「Error」**。出事的時候 log 等於什麼都沒說。
// 而 fetchGist／parseGistState 自己丟的訊息全部是手寫固定字串，上面那一組
// testGistParseNoLeak 已經證明它們不夾帶內容——所以它們可以印。
function testGistErrorReason() {
  const secret = '台積電 2330 我估 18.5% 這是我的筆記';
  const leaky = ['台積電', '2330', '18.5', '筆記', 'ticker', 'stocks', '富喬', '1815', '70.5'];

  // 每個案例帶自己的標籤——五個共用一個斷言名字的話，紅了也分不出是哪一個。
  const cases = [
    ['完全不是 JSON', secret],
    ['schemaVersion 是字串', '{"schemaVersion":"' + secret + '"}'],
    ['是陣列不是物件', '[1,2,3]'],
    ['空字串', ''],
    ['schemaVersion 是 1', '{"schemaVersion":1,"stocks":[]}']
  ];
  for (const [label, text] of cases) {
    let e = null;
    try { parseGistState(text); } catch (err) { e = err; }
    ok(`${label} → 會丟錯`, e !== null);
    if (!e) continue;
    ok(`${label} → 有 .reason 記號`, typeof e.reason === 'string' && e.reason.length > 0,
      JSON.stringify({ name: e.name, reason: e.reason }));
    eq(`${label} → .reason 跟 .message 是同一句`, e.reason, e.message);
    const found = leaky.filter((x) => String(e.reason).includes(x));
    ok(`${label} → .reason 一樣不夾帶內容`, found.length === 0, `夾帶了 ${found.join('、')}`);
  }

  // 不是我們丟的就不准有記號，否則那道防線會被繞過
  ok('TypeError 沒有 .reason', new TypeError('fetch failed').reason === undefined);
  ok('一般 Error 沒有 .reason', new Error('x').reason === undefined);

  const src = fs.readFileSync(path.join(ROOT, '.github/scripts/notify.mjs'), 'utf8');
  // fetchGist 與 parseGistState 裡的每一個 throw 都要走 gistError
  const start = src.indexOf('async function fetchGist');
  const end = src.indexOf('async function main');
  const zone = src.slice(start, end);
  ok('fetchGist／parseGistState 裡找得到 throw', zone.includes('throw '));
  ok('那一段裡沒有裸的 throw new Error（全部要走 gistError）',
    !zone.includes('throw new Error('), '還有裸的 throw new Error');
  eq('六處 throw 全部走 gistError', (zone.match(/throw gistError\(/g) || []).length, 6);
  // 只看 console.log 的參數，不要掃整個檔案——註解裡本來就會提到 `e2.message`
  // 這五個字（在說明「絕對不要印它」），掃全檔會把自己的註解當成違規。
  // 「log 不准印 .message」那一條由 testNoLeakyLogs 負責，它掃的是 console.log 的參數。
  const logs = [...src.matchAll(/console\.log\(([\s\S]*?)\);\n/g)].map((m) => m[1]);
  ok('有一行 log 印出 gist 失敗的原因',
    logs.some((c) => c.includes('why')), '找不到印 why 的那一行');
  ok('why 是從 .reason 來的，不是從 .message',
    /const why = \(e2 && e2\.reason\)/.test(src), '不是 e2.reason');
}

// ---- 5f. 測試通知不可以被抓 gist 擋住 ----
//
// 「送一則測試通知」驗的是 Actions → Apple → 手機，跟 gist 無關。先前 forceTest
// 排在 fetchGist 之後，gist 一失敗就 return 0——**最需要它來分辨問題的時候反而
// 送不出去**。11-16 那次手動測試加上四次排程全部靜默，就是這個順序造成的。
function testForceTestIndependentOfGist() {
  const run = (state, forceTest) => decide({
    V, th: TH, state, oldPrices: {}, newPrices: {},
    now: Date.parse('2026-11-14T12:00:00Z'), forceTest
  });
  eq('抓不到 gist（state 為 null）＋勾了測試 → 還是送一則 test',
    run(null, true).map((m) => m.kind), ['test']);
  eq('抓不到 gist 且沒勾 → 什麼都不送', run(null, false).length, 0);
  eq('state 是 undefined 也不爆', run(undefined, true).map((m) => m.kind), ['test']);

  const src = fs.readFileSync(path.join(ROOT, '.github/scripts/notify.mjs'), 'utf8');
  const iForce = src.indexOf('const forceTest =');
  const iFetch = src.indexOf('await fetchGist');
  ok('forceTest 在 await fetchGist 之前就算好',
    iForce !== -1 && iFetch !== -1 && iForce < iFetch, `forceTest=${iForce} fetchGist=${iFetch}`);
  ok('抓 gist 失敗後，沒勾測試才 return 0', src.includes('if (!forceTest) return 0;'));
  // state 可能是 null，那一行 log 不能直接讀 .stocks。
  // **這裡一定要比對完整的 log 片段，不能只找 `(state && state.stocks)`**——
  // decide() 裡本來就有 `Array.isArray(state && state.stocks)`，只找那個子字串的話
  // 不管 log 有沒有守門都會通過（空心斷言，突變測試抓到的）。
  ok('log 那一行有守住 null state',
    src.includes('追蹤 ${((state && state.stocks) || []).length} 檔'),
    '那一行 log 直接讀了 state.stocks');
}

// ---- 6. 公開 log 的紀律 ----
//
// 這個 repo 是公開的，workflow 的 log 任何人都看得到，而通知內容就是他的估值。
// 所以每一個 console.log 的參數都必須是固定字串或數字，不能是代號、名稱、落差值。
function testNoLeakyLogs() {
  const src = fs.readFileSync(path.join(ROOT, '.github/scripts/notify.mjs'), 'utf8');

  // 抓出所有 console.log(...) 的內容
  const calls = [...src.matchAll(/console\.log\(([\s\S]*?)\);\n/g)].map((m) => m[1]);
  ok('有找到 console.log 來檢查', calls.length > 0);

  // 這些識別字一旦出現在 log 的參數裡，就等於把他的估值印進公開 log。
  //
  // `.message` 是後來補的，而它正是 ② 當初逃掉的原因：先前只有一條
  // 「最外層 catch 不印 err.message」的正則，**漏掉了內層的 e2.message**。
  // 實測 V8 的 JSON 錯誤訊息會夾帶輸入的前 10 個字
  // （`Unexpected token '台', "台積電 2330 我"... is not valid JSON`），
  // 所以任何 `.message` 進到 log 就是一條洩漏管道。自己寫的固定字串不受影響
  // ——那些是模板字面，不含 `.message`。
  const banned = ['m.title', 'm.body', 'c.name', 'st.ticker', 'c.ticker', 'c.gap',
    '.endpoint', 'payload', 'JSON.stringify(m', 'env.GIST_ID', 'env.PUSH_SUB',
    '.message'];
  for (const c of calls) {
    for (const b of banned) {
      ok(`log 裡沒有 ${b}`, !c.includes(b), `出現在：${c.slice(0, 70)}`);
    }
  }

  // m.kind 是 'gap'／'stale'／'test' 這種固定字串，印出來沒有洩漏，是允許的
  ok('允許印 m.kind（固定字串，不含他的資料）',
    calls.some((c) => c.includes('m.kind')));

  // 例外訊息可能帶著含 gist id 的網址，所以 catch 不能直接印 err.message
  ok('最外層 catch 不直接印 err.message',
    !/catch \(err\) \{\s*\n\s*\/\/[\s\S]*?console\.log\(`[^`]*\$\{err\.message\}/.test(src));
  ok('最外層 catch 只印錯誤類型', src.includes('err.name ? err.name'));
}

// ---- 7. 缺 secret 時必須 exit 0 ----
//
// 通知沒設好不能讓每日收盤價的 job 失敗——收盤價是比通知重要的產出。
async function testMissingSecretsExitZero() {
  const { execFile } = await import('node:child_process');
  const run = (env) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, '.github/scripts/notify.mjs')],
      { env: { ...env, PATH: process.env.PATH }, cwd: ROOT, timeout: 20000 },
      (err, stdout) => resolve({ code: err ? err.code : 0, out: String(stdout) }));
  });

  const full = {
    GIST_ID: 'x', VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'x',
    VAPID_SUBJECT: 'mailto:x@example.com', PUSH_SUB: '{}'
  };

  const none = await run({});
  eq('五個 secret 全缺 → exit 0', none.code, 0);
  ok('全缺時會說「通知沒設定」', none.out.includes('通知沒設定'), none.out.trim());

  for (const k of Object.keys(full)) {
    const partial = { ...full };
    delete partial[k];
    const r = await run(partial);
    eq(`缺 ${k} → exit 0`, r.code, 0);
  }

  // secret 都在但 PUSH_SUB 解不出訂閱 → 也只是跳過，不失敗
  const badSub = await run({ ...full, PUSH_SUB: 'not json' });
  eq('PUSH_SUB 不是 JSON → exit 0', badSub.code, 0);
  ok('會說 PUSH_SUB 解不出訂閱', badSub.out.includes('PUSH_SUB'), badSub.out.trim());
}

// ---- 跑 ----

const run = async () => {
  testFoundations();
  testLatestRecord();
  testGapGuards();
  testStaleSchedule();
  testDecideCrossing();
  testDecideSkips();
  testDecideStaleAndTest();
  testBodyDatesAndWording();
  testGistParseNoLeak();
  testSecretsTrimmed();
  testGistErrorReason();
  testForceTestIndependentOfGist();
  testNoLeakyLogs();
  await testMissingSecretsExitZero();

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
