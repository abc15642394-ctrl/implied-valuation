// 收盤通知發送端的測試。用 node 直接跑，不裝任何東西：
//
//     node .github/scripts/test_notify.mjs
//
// 只測 notify.mjs 的純函式（decide 與它的零件）。那些函式刻意不碰網路、不碰
// secret、不印東西，所以這裡餵假資料就能把判斷邏輯全部走一遍。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decide, loadValuation, loadThresholds, latestRecord, gapAt,
  readSettings, staleDue, daysSince, STALE_PUSH_DAYS
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
const prices = (ticker, p, date = '2026-11-13') => ({ [ticker]: ['測試檔', p, date] });

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
    oldPrices: prices('2330', oldP), newPrices: prices('2330', newP),
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
    oldPrices: oldP === null ? {} : prices('2330', oldP),
    newPrices: newP === null ? {} : prices('2330', newP),
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
    oldPrices: prices('2330', FAIR_15), newPrices: prices('2330', FAIR_15),
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
    oldPrices: prices('2330', FAIR_15), newPrices: prices('2330', FAIR_15 * 3),
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

// ---- 6. 公開 log 的紀律 ----
//
// 這個 repo 是公開的，workflow 的 log 任何人都看得到，而通知內容就是他的估值。
// 所以每一個 console.log 的參數都必須是固定字串或數字，不能是代號、名稱、落差值。
function testNoLeakyLogs() {
  const src = fs.readFileSync(path.join(ROOT, '.github/scripts/notify.mjs'), 'utf8');

  // 抓出所有 console.log(...) 的內容
  const calls = [...src.matchAll(/console\.log\(([\s\S]*?)\);\n/g)].map((m) => m[1]);
  ok('有找到 console.log 來檢查', calls.length > 0);

  // 這些識別字一旦出現在 log 的參數裡，就等於把他的估值印進公開 log
  const banned = ['m.title', 'm.body', 'c.name', 'st.ticker', 'c.ticker', 'c.gap',
    '.endpoint', 'payload', 'JSON.stringify(m', 'env.GIST_ID', 'env.PUSH_SUB'];
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
