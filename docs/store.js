// 資料層：localStorage 單一 key，所有寫入都經過這裡。
//
// 兩層結構：
//   stocks  —— 股票身分與分類（代號、名稱、市場、狀態、分類標籤）
//   records —— 每次估值的快照（日期、標籤、股價、EPS、成長率、備註）
// 一檔股票可以有很多筆 record，走勢就是從這些快照看出來的。
//
// 成長率、折現率一律以「百分比數字」儲存（15 代表 15%），送進 Valuation 前才除以 100。
(function (global) {
  'use strict';

  var STORAGE_KEY = 'iv-calc-v1';   // key 不動，靠 schemaVersion 分辨格式
  var SCHEMA_VERSION = 2;

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: { discountRate: 10, perpetualGrowth: 2, defaultCagr6_10: 5 },
      stocks: [],
      records: [],
      lastExportAt: null
    };
  }

  var state = defaultState();

  function newId(prefix) {
    return prefix + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() { return new Date().toISOString(); }
  function today() { return new Date().toISOString().slice(0, 10); }

  function num(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) ? n : fallback;
  }

  // 「我估的成長率」可以是「還沒估」，那跟「估 0%」意義完全不同：
  // 前者不該算出合理價與落差，後者會算出一個看似正常的假數字。
  function numOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = parseFloat(value);
    return isFinite(n) ? n : null;
  }

  // 'YYYY-MM-DD'；收到 ISO 時間戳就截前 10 碼
  function normalizeDate(value) {
    var s = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return today();
  }

  function cleanTags(raw) {
    if (!Array.isArray(raw)) return [];
    var seen = {};
    var out = [];
    raw.forEach(function (t) {
      var v = String(t).trim();
      if (!v || seen[v]) return;   // 去重，否則 'AI,AI,AI' 會原樣存成三個
      seen[v] = true;
      out.push(v);
    });
    return out;
  }

  function normalizeStock(raw) {
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId('st_'),
      ticker: String(raw.ticker || '').trim().toUpperCase(),
      name: String(raw.name || '').trim(),
      market: raw.market === 'US' ? 'US' : 'TW',
      status: raw.status === 'held' ? 'held' : 'watch',
      tags: cleanTags(raw.tags)
    };
  }

  function normalizeRecord(raw, stockId, defaults) {
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId('rc_'),
      stockId: stockId,
      date: normalizeDate(raw.date || raw.updatedAt),
      label: String(raw.label || '').trim(),
      price: num(raw.price, 0),
      eps: num(raw.eps, 0),
      myCagr1_5: numOrNull(raw.myCagr1_5),
      cagr6_10: num(raw.cagr6_10, defaults.defaultCagr6_10),
      note: String(raw.note || ''),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt
        : (typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso())
    };
  }

  // ---- 持久化 ----

  // 寫入失敗（無痕模式、封鎖網站資料、空間滿）會讓資料只存在記憶體裡，
  // 重新整理就全沒了。所以失敗必須讓上層知道，不能假裝成功。
  var lastWriteOk = true;

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      lastWriteOk = true;
      return true;
    } catch (err) {
      console.error('寫入 localStorage 失敗', err);
      lastWriteOk = false;
      return false;
    }
  }

  function canPersist() { return lastWriteOk; }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch (err) { console.error('讀取 localStorage 失敗', err); }

    if (!raw) { state = defaultState(); return state; }

    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { console.error('資料毀損，改用空白狀態', err); state = defaultState(); return state; }

    state = adopt(parsed);
    return state;
  }

  function readSettings(incoming) {
    var base = defaultState().settings;
    var s = (incoming && incoming.settings) || {};
    var out = {
      discountRate: num(s.discountRate, base.discountRate),
      perpetualGrowth: num(s.perpetualGrowth, base.perpetualGrowth),
      defaultCagr6_10: num(s.defaultCagr6_10, base.defaultCagr6_10)
    };
    // 折現率若不大於永續成長率，整個模型會壞掉（Infinity 或負合理價）
    if (!(out.discountRate > out.perpetualGrowth)) {
      out.discountRate = 10;
      out.perpetualGrowth = 2;
    }
    return out;
  }

  // v1 每一筆同時是「股票」也是「一次快照」，拆成一個 stock ＋ 一筆 record。
  // 同代號同市場的多筆 v1 資料會合併成一檔、多筆紀錄。
  function migrateV1(list, settings) {
    var stocks = [];
    var records = [];
    var byKey = {};
    list.forEach(function (raw) {
      if (!String((raw && raw.ticker) || '').trim()) return;
      var s = normalizeStock(raw);
      var key = stockKey(s);
      if (byKey[key]) { s = byKey[key]; } else { byKey[key] = s; stocks.push(s); }
      records.push(normalizeRecord(raw, s.id, settings));
    });
    return { stocks: stocks, records: records };
  }

  // 把任意外來資料（v1 或 v2）轉成目前的格式
  function adopt(incoming) {
    var out = defaultState();
    out.settings = readSettings(incoming);

    if (incoming && incoming.schemaVersion === 2 && Array.isArray(incoming.records)) {
      var ids = {};
      out.stocks = (Array.isArray(incoming.stocks) ? incoming.stocks : [])
        .filter(function (s) { return String((s && s.ticker) || '').trim(); })
        .map(function (s) { var n = normalizeStock(s); ids[n.id] = true; return n; });
      out.records = incoming.records
        .filter(function (r) { return r && ids[r.stockId]; })   // 丟掉沒有歸屬的孤兒紀錄
        .map(function (r) { return normalizeRecord(r, r.stockId, out.settings); });
    } else {
      var m = migrateV1(Array.isArray(incoming && incoming.stocks) ? incoming.stocks : [], out.settings);
      out.stocks = m.stocks;
      out.records = m.records;
    }

    out.lastExportAt = incoming && typeof incoming.lastExportAt === 'string' ? incoming.lastExportAt : null;
    return out;
  }

  function getState() { return state; }

  // ---- 設定 ----

  function validateSettings(patch) {
    var dr = num(patch.discountRate, state.settings.discountRate);
    var pg = num(patch.perpetualGrowth, state.settings.perpetualGrowth);
    if (!isFinite(dr) || !isFinite(pg)) return '折現率與永續成長率都必須是數字';
    if (dr <= pg) return '折現率必須大於永續成長率，否則永續價值公式會算出無限大或負數';
    if (dr <= 0) return '折現率必須大於 0';
    return null;
  }

  function updateSettings(patch) {
    var error = validateSettings(patch);
    if (error) return { ok: false, error: error };
    state.settings = {
      discountRate: num(patch.discountRate, state.settings.discountRate),
      perpetualGrowth: num(patch.perpetualGrowth, state.settings.perpetualGrowth),
      defaultCagr6_10: num(patch.defaultCagr6_10, state.settings.defaultCagr6_10)
    };
    persist();
    return { ok: true };
  }

  // ---- 股票 ----

  function stockKey(stock) { return stock.market + ':' + stock.ticker; }

  function findStock(id) {
    for (var i = 0; i < state.stocks.length; i++) {
      if (state.stocks[i].id === id) return state.stocks[i];
    }
    return null;
  }

  function findByTicker(market, ticker) {
    var key = (market === 'US' ? 'US' : 'TW') + ':' + String(ticker || '').trim().toUpperCase();
    for (var i = 0; i < state.stocks.length; i++) {
      if (stockKey(state.stocks[i]) === key) return state.stocks[i];
    }
    return null;
  }

  // 已存在就更新身分欄位，不存在就新建。回傳該 stock。
  function upsertStock(raw) {
    var incoming = normalizeStock(raw);
    var existing = findByTicker(incoming.market, incoming.ticker);
    if (existing) {
      existing.name = incoming.name || existing.name;
      existing.status = incoming.status;
      if (incoming.tags.length) existing.tags = incoming.tags;
      persist();
      return existing;
    }
    state.stocks.push(incoming);
    persist();
    return incoming;
  }

  function updateStock(id, patch) {
    var stock = findStock(id);
    if (!stock) return null;
    Object.keys(patch).forEach(function (k) {
      if (k === 'id') return;
      stock[k] = k === 'tags' ? cleanTags(patch[k]) : patch[k];
    });
    persist();
    return stock;
  }

  // 刪除股票連同它的所有紀錄
  function removeStock(id) {
    state.stocks = state.stocks.filter(function (s) { return s.id !== id; });
    state.records = state.records.filter(function (r) { return r.stockId !== id; });
    persist();
  }

  // ---- 紀錄 ----

  function addRecord(stockId, raw) {
    var rec = normalizeRecord(raw || {}, stockId, state.settings);
    rec.createdAt = nowIso();
    state.records.push(rec);
    persist();
    return rec;
  }

  function findRecord(id) {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === id) return state.records[i];
    }
    return null;
  }

  function updateRecord(id, patch) {
    var rec = findRecord(id);
    if (!rec) return null;
    Object.keys(patch).forEach(function (k) {
      if (k === 'id' || k === 'stockId') return;
      rec[k] = patch[k];
    });
    persist();
    return rec;
  }

  // 刪掉最後一筆紀錄時，該檔股票也就沒有存在的意義了，一併移除。
  function removeRecord(id) {
    var rec = findRecord(id);
    if (!rec) return { removedStock: false };
    var stockId = rec.stockId;
    state.records = state.records.filter(function (r) { return r.id !== id; });
    var left = recordsOf(stockId).length;
    if (left === 0) {
      state.stocks = state.stocks.filter(function (s) { return s.id !== stockId; });
      persist();
      return { removedStock: true, stockId: stockId };
    }
    persist();
    return { removedStock: false, stockId: stockId };
  }

  // 新到舊；同一天的用 createdAt 再分
  function recordsOf(stockId) {
    return state.records
      .filter(function (r) { return r.stockId === stockId; })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
      });
  }

  function latestRecord(stockId) {
    var list = recordsOf(stockId);
    return list.length ? list[0] : null;
  }

  function countOf(stockId) {
    var n = 0;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].stockId === stockId) n++;
    }
    return n;
  }

  function allTags() {
    var seen = {};
    state.stocks.forEach(function (s) { s.tags.forEach(function (t) { seen[t] = true; }); });
    return Object.keys(seen).sort();
  }

  // ---- 匯出 / 匯入 ----

  function exportJson() {
    state.lastExportAt = nowIso();
    persist();
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '隱含估值-' + today() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // 同時接受 v1 與 v2 檔案；v1 走跟 load() 一樣的搬遷。
  function parseIncoming(incoming) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return { ok: false, error: '這不是有效的 JSON 物件' };
    }
    var v = incoming.schemaVersion;
    if (v !== 1 && v !== 2) {
      return { ok: false, error: '資料版本不符（檔案是 ' + v + '，本站支援 1 與 2）' };
    }
    if (!Array.isArray(incoming.stocks)) {
      return { ok: false, error: '檔案裡找不到 stocks 清單' };
    }
    if (v === 2 && !Array.isArray(incoming.records)) {
      return { ok: false, error: '檔案裡找不到 records 清單' };
    }
    return { ok: true, data: adopt(incoming) };
  }

  function previewImport(incoming) {
    var p = parseIncoming(incoming);
    if (!p.ok) return p;

    var existing = {};
    state.stocks.forEach(function (s) { existing[stockKey(s)] = true; });

    var newStocks = 0;
    var mergedStocks = 0;
    p.data.stocks.forEach(function (s) {
      if (existing[stockKey(s)]) { mergedStocks++; } else { newStocks++; }
    });

    var skipped = (Array.isArray(incoming.stocks) ? incoming.stocks.length : 0) - p.data.stocks.length;
    return {
      ok: true,
      newStocks: newStocks,
      mergedStocks: mergedStocks,
      records: p.data.records.length,
      skipped: skipped > 0 ? skipped : 0
    };
  }

  // 匯入採「合併」：同代號的股票沿用既有 id，紀錄整批加進去（以 id 去重）。
  function applyImport(incoming) {
    var p = parseIncoming(incoming);
    if (!p.ok) return p;

    var byKey = {};
    state.stocks.forEach(function (s) { byKey[stockKey(s)] = s; });
    var haveRecord = {};
    state.records.forEach(function (r) { haveRecord[r.id] = true; });

    p.data.stocks.forEach(function (s) {
      var key = stockKey(s);
      var target = byKey[key];
      if (!target) {
        state.stocks.push(s);
        byKey[key] = s;
        target = s;
      } else {
        if (s.name) target.name = s.name;
        if (s.tags.length) target.tags = cleanTags(target.tags.concat(s.tags));
      }
      p.data.records
        .filter(function (r) { return r.stockId === s.id; })
        .forEach(function (r) {
          if (haveRecord[r.id]) return;
          haveRecord[r.id] = true;
          state.records.push({
            id: r.id, stockId: target.id, date: r.date, label: r.label,
            price: r.price, eps: r.eps, myCagr1_5: r.myCagr1_5,
            cagr6_10: r.cagr6_10, note: r.note, createdAt: r.createdAt
          });
        });
    });

    if (!validateSettings(p.data.settings)) state.settings = p.data.settings;
    persist();
    return { ok: true };
  }

  // ---- 資料安全 ----

  function requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(null);
    return navigator.storage.persisted()
      .then(function (already) { return already ? true : navigator.storage.persist(); })
      .catch(function () { return null; });
  }

  function daysSinceExport() {
    if (!state.lastExportAt) return null;
    var then = new Date(state.lastExportAt).getTime();
    if (!isFinite(then)) return null;
    return Math.floor((Date.now() - then) / 86400000);
  }

  global.Store = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    today: today,
    load: load,
    getState: getState,
    validateSettings: validateSettings,
    updateSettings: updateSettings,
    findStock: findStock,
    findByTicker: findByTicker,
    upsertStock: upsertStock,
    updateStock: updateStock,
    removeStock: removeStock,
    addRecord: addRecord,
    findRecord: findRecord,
    updateRecord: updateRecord,
    removeRecord: removeRecord,
    recordsOf: recordsOf,
    latestRecord: latestRecord,
    countOf: countOf,
    allTags: allTags,
    exportJson: exportJson,
    previewImport: previewImport,
    applyImport: applyImport,
    requestPersistence: requestPersistence,
    canPersist: canPersist,
    daysSinceExport: daysSinceExport
  };
})(window);
