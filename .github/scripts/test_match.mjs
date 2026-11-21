// 「從一段 LINE 訊息裡找出是哪一檔」的測試（`Store.matchTickers`）。
//
//     node .github/scripts/test_match.mjs
//
// ## 為什麼這一支要單獨存在
//
// 這是整個專案裡規則最細、最容易改壞又最難發現的一段。它有四個互相牽制的守門：
//   CODE_RE        代號前後要有邊界
//   AFTER_RE       代號後面不能接「年月日季元塊點％萬億股張」（那是年份或數量）
//   BEFORE_RE      代號前面不能是「目標價／現價／收盤／成本」這類詞（那是價格）
//   MIN_DIR_NAME   名錄的名稱至少三個字
//
// 而壞掉的樣子是：**他在 LINE 點一條訊息，app 篩出錯的股票、或什麼都不顯示。**
// 不會報錯，只會「怪怪的」。
//
// build 22 當時跑過 15 項測試全中，但那是臨時跑的、沒有變成檔案，所以 build 22→24
// 之間這段邏輯完全沒有保護。補這一支就是為了把它鎖住。
//
// ## 兩個做法上的重點
//
// 1. **用真的 `docs/prices.json`，不要自己編名錄。** 「1243 個兩字名稱」這種碰撞
//    只有真資料才會出現；縮小的假名錄會讓測試看起來很綠但什麼都沒守住。
// 2. `matchTickers` 讀的是 `store.js` 模組私有的 `closes`，只能透過 `loadCloses()`
//    設定，而那支走 `fetch('prices.json')`——在 Node 裡相對路徑 fetch 不會成功。
//    所以在 vm context 裡給一個**假的 `fetch`**，把真的 prices.json 餵回去。
//    這樣連 `loadCloses()` 本身也一起測到了，而且不必為了測試在 store.js 加 setter。

import fs from 'node:fs';
import vm from 'node:vm';
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

const PRICES = JSON.parse(read('docs/prices.json'));

// tracked：要先放進追蹤清單的股票（模擬他自己的資料）
function loadStore(tracked) {
  const data = {};
  const localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
  const ctx = {
    window: {}, localStorage, console, JSON, Date, Math, Array, Object, String,
    parseFloat, parseInt, isFinite, navigator: {}, Promise, Uint8Array,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    // 假的 fetch：把真的名錄餵給 loadCloses()
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(PRICES) })
  };
  vm.runInNewContext(read('docs/valuation.js'), ctx);
  ctx.Valuation = ctx.window.Valuation;
  vm.runInNewContext(read('docs/store.js'), ctx);
  const S = ctx.window.Store;
  (tracked || []).forEach((t) => S.upsertStock(t));
  return S.loadCloses().then(() => S);
}

// 回傳命中的代號陣列，方便斷言
const codes = (S, text) => S.matchTickers(text).map((h) => h.code);

// ---- 1. 名錄載入（順便驗假 fetch 真的有效）----

async function testDirectoryLoaded() {
  const S = await loadStore();
  ok('名錄載入成功（假 fetch 有效）', S.hasCloses() === true);
  ok('名錄有 2300 檔以上', Object.keys(PRICES).length > 2300,
    `${Object.keys(PRICES).length} 檔`);
  // 刻意**不**寫死「剛好 2 個」。現在確實是 2 個（TWSE 比 TPEx 慢一個交易日），
  // 但那是從兩次抽樣推論的，不是保證——哪天兩邊對齊就只有 1 個日期，
  // 寫死 2 的話每日的 workflow 會紅，他收到一封「壞了」的信而其實什麼都沒壞。
  // 真正要鎖的是「日期是每個交易所一個，不是每一檔一個」。
  const nDates = S.closeDates().length;
  ok('日期是每個交易所一個（1–2 個），不是每一檔一個', nDates >= 1 && nDates <= 2,
    `${nDates} 個：${S.closeDates().join('、')}`);
  // 這一條是整份測試的前提：名錄沒載進來的話下面全部會變成「沒命中」而假通過。
  ok('名錄裡有 2330', !!PRICES['2330']);
}

// ---- 2. AFTER_RE：代號後面接量詞就不是股票 ----
//
// 台股代號真的會跟年份撞：2024 志聯、2025 千興、2027 大成鋼、2028 威致、2030 彰源
//（只有 2026 碰巧不是）。所以「2027 年才看得到貢獻」不可以篩成大成鋼。

async function testAfterGuard() {
  const S = await loadStore();
  eq('「2027 年才看得到貢獻」→ 沒命中', codes(S, '2027 年才看得到貢獻'), []);
  eq('「2025 年預算」→ 沒命中', codes(S, '2025 年預算'), []);
  eq('「2330 股」→ 沒命中（量詞）', codes(S, '手上有 2330 股'), []);
  // 這兩條原本用 1500，但**1500 不是股票代號**，所以它們是因為「名錄沒這檔」而通過，
  // 守門根本沒被測到。換成 2330（台積電，真代號）才測得到東西。
  eq('「2330 元」→ 沒命中（量詞）', codes(S, '大概 2330 元'), []);
  eq('「2330 張」→ 沒命中（量詞）', codes(S, '買了 2330 張'), []);
  // 這一條測的是 CODE_RE 的位數（30 與 12 不是 4–5 碼），**不是** AFTER_RE。
  // 原本的標籤寫錯了。
  eq('「30%」「12 元」→ 沒命中（不是 4–5 碼，CODE_RE 不收）',
    codes(S, '營收成長 30%，EPS 預估 12 元'), []);

  // 同一個代號，後面沒有量詞時要認得出來
  eq('「大成鋼 2027 這次法說會」→ 2027', codes(S, '大成鋼 2027 這次法說會'), ['2027']);
  eq('「2330 這檔」→ 2330', codes(S, '2330 這檔還能買嗎'), ['2330']);

  // 一段訊息裡同時有「年份用法」與「真的在講那一檔」——不能因為前者就整個放棄。
  //
  // ⚠️ 這一條**不能**當成「代號掃描有掃全部出現位置」的證據：句子裡有「大成鋼」
  // 三個字，名稱比對就會命中，代號那條路徑被遮住了。真正測代號掃描的在第 8 組
  // （testTrackedYearGuard），那裡用的句子刻意不含名稱。
  ok('「2027 年…不過大成鋼 2027…」→ 要命中（名稱命中仍然有效）',
    codes(S, '2027 年營收會起來，不過大成鋼 2027 這次法說有講').includes('2027'),
    JSON.stringify(codes(S, '2027 年營收會起來，不過大成鋼 2027 這次法說有講')));
}

// ---- 3. BEFORE_RE：價格前綴後面的數字是價格，不是代號 ----

async function testBeforeGuard() {
  const S = await loadStore();
  // 每一個都用 2330（真代號）。原本「目標價 1500」用的 1500 不是代號，
  // 所以那一條是空心的——不管有沒有 BEFORE_RE 都會通過。
  for (const t of ['目標價 2330 應該不難', '現價 2330 買得下手嗎', '收盤 2330',
                   '成本 2330', '上看 2330', '均價 2330', '漲到 2330', '跌到 2330']) {
    eq(`「${t}」→ 沒命中`, codes(S, t), []);
  }
  // 沒有價格前綴時同一個數字要認得出來
  eq('「2330 昨天漲停」→ 2330', codes(S, '2330 昨天漲停'), ['2330']);
}

// ---- 4. MIN_DIR_NAME：名錄的名稱至少三個字 ----
//
// 名錄裡有 1243 個兩字名稱，兩字詞在中文句子裡太容易撞到。

async function testNameLength() {
  const S = await loadStore();
  const two = Object.values(PRICES).filter((v) => v[0].length === 2).length;
  ok('名錄真的有一千多個兩字名稱', two > 1000, `${two} 個`);

  const sentence = '統一發票開獎，大同電鍋很好用，中鋼結構補強';
  // 這句話裡有三個兩字名稱（統一 1216、中鋼 2002、大同 2371），全都要擋掉
  eq('「統一發票…大同電鍋…中鋼結構」→ 沒命中', codes(S, sentence), []);

  // 三個字以上的名稱要認得出來
  eq('「台積電法說會」→ 2330', codes(S, '台積電法說會'), ['2330']);
  ok('「元大美債20年」→ 命中 00679B',
    codes(S, '元大美債20年值得買嗎').includes('00679B'),
    JSON.stringify(codes(S, '元大美債20年值得買嗎')));
}

// ---- 5. CODE_RE：4–5 碼、可帶一個英文字母，前後要有邊界 ----

async function testCodeShape() {
  const S = await loadStore();
  eq('非 4 碼的 ETF 0050', codes(S, '0050 定期定額'), ['0050']);
  eq('5 碼的 00636', codes(S, '00636 這檔'), ['00636']);
  eq('帶字母的 00679B', codes(S, '00679B 怎麼看'), ['00679B']);

  // 邊界：代號黏在別的字元裡就不算。
  //
  // **只有「字母相鄰」這一種測得到。** 數字相鄰（`12330`、`23301`）本質上測不到：
  // CODE_RE 貪婪比對 4–5 碼，會把整串吃成 `12330`，而那不在名錄裡——有沒有邊界
  // 都一樣不命中，所以那種斷言永遠不可能紅（實測確認過，突變測試也只觸發字母那條）。
  // 同理 `2330X`：拿掉邊界後抓到的是 `2330X`，那也不在名錄。
  // 這就是為什麼下面只留 A2330 一條有效斷言，別再加一堆測不到的邊界案例。
  eq('「A2330」→ 沒命中（左邊黏英文；這是唯一測得到的邊界情況）',
    codes(S, '型號 A2330'), []);
  // 下面兩條只記錄意圖，不可能紅（見上），所以不算在守門的保護裡
  eq('「12330」→ 沒命中（記錄意圖；貪婪比對使它不可能紅）',
    codes(S, '編號 12330 的案子'), []);
  eq('「2330X」→ 沒命中（記錄意圖；同上）', codes(S, '型號 2330X'), []);

  // ---- 六位數字：原本的 CODE_RE 寫 {4,5}，所以這一整個家族永遠比對不到 ----
  //
  // 拿正式站 2386 檔實測，`{4,5}` 有 **60 檔掃不到**，全部是六位數字的 ETF 與
  // 存託憑證，其中 `006208` 富邦台50 是最多人持有的台股 ETF 之一。
  // 第三包的紀錄早就寫著「非 4 碼的全是 ETF，**不可以用長度過濾**」，而 5 位數的
  // 上限等於換了一種方式做長度過濾。
  //
  // **這個洞之所以從來沒被看到，是因為這份測試只測到 0050（4 碼）、00636（5 碼）、
  // 00679B（5 碼＋一個字母）——沒有任何一個六位數字的案例。** 看起來涵蓋了 ETF，
  // 其實漏掉一整個家族。所以下面這幾條不是補充，是補洞。
  eq('六位數 ETF 006208（富邦台50）', codes(S, '006208 這波還能買嗎'), ['006208']);
  eq('六位數 ETF 006205（富邦上証）', codes(S, '手上有 006205'), ['006205']);
  eq('六位數存託憑證 910322（康師傅-DR）', codes(S, '910322 法說會怎麼說'), ['910322']);

  // 放寬到 6 碼之後，守門一樣要生效（否則就是用誤判換到覆蓋率）
  eq('「006208 股」→ 沒命中（量詞）', codes(S, '買了 006208 股'), []);
  eq('「現價 006208」→ 沒命中（價格前綴）', codes(S, '現價 006208'), []);
  // 七位數字：貪婪比對吃掉 6 位之後右邊還有數字，邊界不成立
  eq('七位數字 → 沒命中', codes(S, '編號 1006205 的案子'), []);
  eq('一般的六位數字（不在名錄）→ 沒命中', codes(S, '營收 123456 千元'), []);
}

// ---- 6. 去重與順序 ----

async function testDedupeAndOrder() {
  const S = await loadStore();
  // 名稱與代號都命中同一檔，只能出現一次
  // 原本句尾是「收 1085」，但 1085 不是代號，所以「收」這個價格前綴沒被測到。
  // 換成真代號 2454（聯發科）之後，同一句話同時測到兩件事：
  //   ① 去重：台積電（名稱）＋ 2330（代號）只能算一筆
  //   ② BEFORE_RE：「收 2454」要被擋掉，不可以變成第二筆
  eq('「台積電 2330 昨天收 2454」→ 只有一筆 2330（去重＋價格前綴）',
    codes(S, '台積電 2330 昨天收 2454'), ['2330']);
  // 多檔時照出現順序
  eq('兩檔照順序', codes(S, '聯發科 2454 跟台積電 2330 都在漲'), ['2454', '2330']);
}

// ---- 7. 追蹤清單那一層：刻意比名錄寬鬆 ----

async function testTrackedLayer() {
  const S = await loadStore([{ ticker: '1815', name: '富喬', market: 'TW' }]);

  // 兩字名稱在名錄層會被擋，但在追蹤層要認——那是他自己的股票
  const r = S.matchTickers('富喬最近怎麼了');
  eq('追蹤的兩字名稱會命中', r.map((h) => h.code), ['1815']);
  eq('而且標成 tracked，不是 directory', r[0].source, 'tracked');

  // 沒追蹤的兩字名稱仍然擋掉（對照組，證明上面那條是「追蹤」的效果）
  const S2 = await loadStore();
  eq('沒追蹤的兩字名稱擋掉（對照組）', codes(S2, '富喬最近怎麼了'), []);

  // 價格前綴對追蹤層刻意不設限：他追蹤的股票，訊息提到它的價格就是在講它
  const S3 = await loadStore([{ ticker: '2330', name: '台積電', market: 'TW' }]);
  eq('追蹤了 2330 時「現價 2330」會命中（刻意放寬）',
    codes(S3, '現價 2330 買得下手嗎'), ['2330']);
  eq('沒追蹤時同一句話擋掉（對照組）',
    codes(await loadStore(), '現價 2330 買得下手嗎'), []);
}

// ---- 8. 回歸：追蹤層的代號也要避開年份 ----
//
// build 25 修的。跟年份撞的那五檔是真的股票，所以一旦他追蹤了其中一檔
//（大成鋼 2027 是很有可能的），一句「2027 年營收會起來」就會把他篩到大成鋼去。
//
// 名稱比對刻意**不**套這條守門——名稱後面接「年」是正常中文（「大成鋼年營收」）。

async function testTrackedYearGuard() {
  const S = await loadStore([{ ticker: '2027', name: '大成鋼', market: 'TW' }]);

  eq('追蹤了 2027 時，「2027 年營收會起來」不可以命中',
    codes(S, '2027 年營收會起來'), []);
  eq('「2027 年」「2027 月」「2027 季」都擋',
    [codes(S, 'XX 2027 年'), codes(S, 'XX 2027 月'), codes(S, 'XX 2027 季')],
    [[], [], []]);

  // 但真的在講這一檔的時候要認得出來
  eq('「大成鋼 2027 法說會」→ 命中', codes(S, '大成鋼 2027 法說會'), ['2027']);
  eq('名稱命中不受年份守門影響（名稱後面接「年」是正常中文）',
    codes(S, '大成鋼年營收創高'), ['2027']);

  // 一段訊息同時有兩種用法：任一次出現通過守門就算命中。
  //
  // **句子刻意不含「大成鋼」三個字**，否則名稱比對會先命中，代號掃描的行為就被遮住
  // ——先前那條斷言就是這樣，所以「只看第一次出現」那個突變測不出來。
  // 而且要斷言 `source`：只看第一次的話追蹤層會失手，改由**名錄層**命中，
  // 代號一樣是 2027 但 source 會變成 'directory'。
  const scan = S.matchTickers('2027 年營收會起來，法說有提到 2027 這檔');
  eq('代號出現兩次、第二次通過守門 → 要命中', scan.map((h) => h.code), ['2027']);
  eq('而且要由追蹤層命中（不是退給名錄層）', scan[0] && scan[0].source, 'tracked');

  // 其餘四檔也一起確認
  for (const [code, name] of [['2024', '志聯'], ['2025', '千興'],
                              ['2028', '威致'], ['2030', '彰源']]) {
    const Sx = await loadStore([{ ticker: code, name: name, market: 'TW' }]);
    eq(`追蹤 ${code} ${name} 時「${code} 年」不命中`, codes(Sx, `到 ${code} 年才看得到`), []);
    eq(`但「${name} ${code}」命中`, codes(Sx, `${name} ${code} 這次法說`), [code]);
  }
}

// ---- 9. 邊界 ----

async function testEdges() {
  const S = await loadStore([{ ticker: '1815', name: '富喬', market: 'TW' }]);
  for (const t of ['', '   ', '\n\t', '沒有任何股票的一句話']) {
    eq(`${JSON.stringify(t)} → 沒命中、不丟錯`, codes(S, t), []);
  }
  eq('null 不丟錯', codes(S, null), []);
  eq('undefined 不丟錯', codes(S, undefined), []);

  // 名錄還沒載進來時（離線、404）不可以炸，只是比對不到名錄那一層
  const data = {};
  const ctx = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console, JSON, Date, Math, Array, Object, String, parseFloat, parseInt, isFinite,
    navigator: {}, Promise, Uint8Array, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch: () => Promise.reject(new Error('offline'))
  };
  vm.runInNewContext(read('docs/valuation.js'), ctx);
  ctx.Valuation = ctx.window.Valuation;
  vm.runInNewContext(read('docs/store.js'), ctx);
  const S2 = ctx.window.Store;
  S2.upsertStock({ ticker: '1815', name: '富喬', market: 'TW' });
  await S2.loadCloses();
  ok('名錄抓不到時 hasCloses 為 false', S2.hasCloses() === false);
  eq('名錄抓不到時，追蹤清單那一層仍然有效',
    S2.matchTickers('富喬最近怎麼了').map((h) => h.code), ['1815']);
  eq('名錄抓不到時，名錄那一層安靜跳過', S2.matchTickers('台積電法說會').map((h) => h.code), []);
}

// ---- 10. 後設檢查：測試自己的數字必須是真代號 ----
//
// 這一包踩到四次同一類錯誤：**斷言因為巧合而通過**。
//   1. 「未估」那條挑的價格剛好讓兩邊落在同一帶
//   2. 長度上限只測三檔，而 MAX_LISTED 就是 3
//   3. 洩漏偵測的關鍵字清單沒涵蓋某個案例的內容
//   4. 用不是代號的數字去示範守門（1500、12330）
//
// 第 4 種最隱蔽：`「目標價 1500」→ 沒命中` 看起來很合理，但 1500 不是股票代號，
// 所以不管有沒有 BEFORE_RE 都會通過。前三次都是靠突變測試或人工比對才發現的。
// 這一條就是把人工比對變成機器檢查——**別再靠我每輪自己想起來要核對。**
function testNoVacuousNumbers() {
  const src = read('.github/scripts/test_match.mjs');

  // 刻意用「不是代號」的數字的地方，每一個都要在這裡寫清楚為什麼。
  // 沒列在這裡的非代號數字會讓這一條紅掉——那通常表示你寫了一條空心斷言。
  const ALLOW = {
    '12330': '刻意不是代號：示範 CODE_RE 貪婪比對把整串吃掉（只記錄意圖，不可能紅）',
    '2330X': '同上：拿掉邊界後抓到的 2330X 也不在名錄，所以那條不可能紅',
    '23301': '只出現在註解裡，跟 12330 一起說明貪婪比對',
    '2300': '不是代號，是「名錄有 2300 檔以上」這個數量門檻',
    '123456': '刻意不是代號：示範「一般的六位數字不會誤命中」'
    // 註：七位數字（1006205）不用列——掃描範圍是 4–6 碼，它根本不在視野裡，
    // 列了反而會被「ALLOW 裡沒有用不到的項目」那一條抓出來。
  };

  // 抓所有單引號字串裡的 4–6 碼數字（可帶一個大寫字母），也就是測試餵進去的訊息。
  // **範圍必須跟 CODE_RE 一致（4–6）。** 先前這裡寫 4–5，所以六位數代號的案例
  // 根本不在它的視野裡——它無法指出「少測了一整個家族」，而那正是 CODE_RE
  // 漏掉 60 檔能活那麼久的原因之一。
  const strings = src.match(/'[^'\n]*'/g) || [];
  const found = new Map();   // 數字 → 它出現在哪個字串
  for (const s of strings) {
    for (const m of s.matchAll(/(?<![0-9A-Za-z])([0-9]{4,6}[A-Z]?)(?![0-9A-Za-z])/g)) {
      if (!found.has(m[1])) found.set(m[1], s);
    }
  }

  ok('有抓到測試裡的數字來檢查', found.size > 0, `${found.size} 個`);

  const vacuous = [];
  for (const [num, where] of found) {
    if (PRICES[num]) continue;        // 真代號，沒問題
    if (ALLOW[num]) continue;         // 刻意的，而且寫了理由
    vacuous.push(`${num}（出現在 ${where}）`);
  }
  ok('測試裡用到的 4–5 碼數字都是真代號（或在 ALLOW 裡寫明理由）',
    vacuous.length === 0,
    `這些不是代號又沒說明：${vacuous.join('、')}\n       ` +
    '→ 用不是代號的數字示範守門，斷言不管有沒有守門都會通過（空心）。');

  // ALLOW 不能放著爛掉：列了卻沒在檔案裡用到，就該刪
  const unused = Object.keys(ALLOW).filter((k) => !found.has(k));
  ok('ALLOW 裡沒有用不到的項目', unused.length === 0,
    `這些已經沒在用了，請刪掉：${unused.join('、')}`);

  // 真代號也要確認它們真的被當成「會命中」的案例用過，而不是全部只出現在否定斷言裡
  ok('2330 是真代號（整份測試的主力）', !!PRICES['2330']);
  ok('2027 是真代號（年份守門的主角）', !!PRICES['2027']);
  // 這一條鎖的是「掃描範圍涵蓋六位數」：少了它，哪天有人把 CODE_RE 收回
  // {4,5}、順手把六位數的案例刪掉，這個後設檢查一樣不會說話。
  ok('掃描範圍涵蓋六位數代號（006208 要在視野裡）', found.has('006208'),
    '六位數的案例沒被掃到，等於又漏掉一整個家族');
  ok('006208 是真代號（六位數家族的代表）', !!PRICES['006208']);
}

// ---- 跑 ----

const run = async () => {
  await testDirectoryLoaded();
  await testAfterGuard();
  await testBeforeGuard();
  await testNameLength();
  await testCodeShape();
  await testDedupeAndOrder();
  await testTrackedLayer();
  await testTrackedYearGuard();
  await testEdges();
  testNoVacuousNumbers();

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
