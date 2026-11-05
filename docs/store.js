// 資料層：localStorage 單一 key，所有寫入都經過這裡（順便蓋 updatedAt）。
// 成長率、折現率在這層一律以「百分比數字」儲存（15 代表 15%），
// 要送進 Valuation 前才除以 100。
(function (global) {
  'use strict';

  var STORAGE_KEY = 'iv-calc-v1';
  var SCHEMA_VERSION = 1;

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: { discountRate: 10, perpetualGrowth: 2, defaultCagr6_10: 5 },
      stocks: [],
      lastExportAt: null
    };
  }

  var state = defaultState();

  function newId() {
    return 'st_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

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

  // 把任意外來物件正規化成一筆乾淨的股票紀錄（匯入與新增共用）。
  function normalizeStock(raw, defaults) {
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      ticker: String(raw.ticker || '').trim().toUpperCase(),
      name: String(raw.name || '').trim(),
      market: raw.market === 'US' ? 'US' : 'TW',
      price: num(raw.price, 0),
      eps: num(raw.eps, 0),
      myCagr1_5: numOrNull(raw.myCagr1_5),
      cagr6_10: num(raw.cagr6_10, defaults.defaultCagr6_10),
      status: raw.status === 'held' ? 'held' : 'watch',
      tags: Array.isArray(raw.tags)
        ? raw.tags.map(function (t) { return String(t).trim(); }).filter(Boolean)
        : [],
      note: String(raw.note || ''),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso()
    };
  }

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
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      console.error('讀取 localStorage 失敗', err);
    }

    if (!raw) {
      state = defaultState();
      return state;
    }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('資料毀損，改用空白狀態', err);
      state = defaultState();
      return state;
    }

    state = mergeIntoState(defaultState(), parsed);
    return state;
  }

  function mergeIntoState(base, incoming) {
    var settings = incoming && incoming.settings ? incoming.settings : {};
    base.settings = {
      discountRate: num(settings.discountRate, base.settings.discountRate),
      perpetualGrowth: num(settings.perpetualGrowth, base.settings.perpetualGrowth),
      defaultCagr6_10: num(settings.defaultCagr6_10, base.settings.defaultCagr6_10)
    };
    // 折現率若不大於永續成長率，整個模型會壞掉（Infinity 或負合理價），
    // 遇到毀損資料就退回安全預設。
    if (!(base.settings.discountRate > base.settings.perpetualGrowth)) {
      base.settings.discountRate = 10;
      base.settings.perpetualGrowth = 2;
    }

    var list = incoming && Array.isArray(incoming.stocks) ? incoming.stocks : [];
    base.stocks = list.map(function (s) { return normalizeStock(s, base.settings); });
    base.lastExportAt = incoming && typeof incoming.lastExportAt === 'string'
      ? incoming.lastExportAt
      : null;
    return base;
  }

  function getState() {
    return state;
  }

  function validateSettings(patch) {
    var dr = num(patch.discountRate, state.settings.discountRate);
    var pg = num(patch.perpetualGrowth, state.settings.perpetualGrowth);
    if (!isFinite(dr) || !isFinite(pg)) return '折現率與永續成長率都必須是數字';
    if (dr <= pg) {
      return '折現率必須大於永續成長率，否則永續價值公式會算出無限大或負數';
    }
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

  function addStock(raw) {
    var stock = normalizeStock(raw, state.settings);
    stock.updatedAt = nowIso();
    state.stocks.push(stock);
    persist();
    return stock;
  }

  // D3：沒有代號的紀錄無法被唯一識別，匯入時要略過而不是變成一列空白
  function hasTicker(raw) {
    return !!String((raw && raw.ticker) || '').trim();
  }

  function findStock(id) {
    for (var i = 0; i < state.stocks.length; i++) {
      if (state.stocks[i].id === id) return state.stocks[i];
    }
    return null;
  }

  // 代號＋市場是唯一鍵；重複列會讓匯入只覆蓋其中一列、另一列變孤兒。
  function findByTicker(market, ticker) {
    var key = (market === 'US' ? 'US' : 'TW') + ':' + String(ticker || '').trim().toUpperCase();
    for (var i = 0; i < state.stocks.length; i++) {
      if (stockKey(state.stocks[i]) === key) return state.stocks[i];
    }
    return null;
  }

  function updateStock(id, patch) {
    var stock = findStock(id);
    if (!stock) return null;
    Object.keys(patch).forEach(function (key) {
      if (key === 'id') return;
      stock[key] = patch[key];
    });
    stock.updatedAt = nowIso();
    persist();
    return stock;
  }

  function removeStock(id) {
    state.stocks = state.stocks.filter(function (s) { return s.id !== id; });
    persist();
  }

  function allTags() {
    var seen = {};
    state.stocks.forEach(function (s) {
      s.tags.forEach(function (t) { seen[t] = true; });
    });
    return Object.keys(seen).sort();
  }

  // ---- 匯出 / 匯入 ----

  function exportJson() {
    state.lastExportAt = nowIso();
    persist();

    var payload = JSON.stringify(state, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var stamp = new Date().toISOString().slice(0, 10);
    var a = document.createElement('a');
    a.href = url;
    a.download = '隱含估值-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // 唯一鍵：findByTicker 與匯入合併都靠它。
  function stockKey(stock) {
    return stock.market + ':' + stock.ticker;
  }

  // 先看會發生什麼，確認後才真的寫入。
  function previewImport(incoming) {
    if (!incoming || typeof incoming !== 'object') {
      return { ok: false, error: '這不是有效的 JSON 物件' };
    }
    if (incoming.schemaVersion !== SCHEMA_VERSION) {
      return {
        ok: false,
        error: '資料版本不符（檔案是 ' + incoming.schemaVersion + '，本站是 ' + SCHEMA_VERSION + '）'
      };
    }
    if (!Array.isArray(incoming.stocks)) {
      return { ok: false, error: '檔案裡找不到 stocks 清單' };
    }

    var existing = {};
    state.stocks.forEach(function (s) { existing[stockKey(s)] = true; });

    var added = 0;
    var overwritten = 0;
    var skipped = 0;
    incoming.stocks.forEach(function (raw) {
      if (!hasTicker(raw)) { skipped++; return; }
      var s = normalizeStock(raw, state.settings);
      if (existing[stockKey(s)]) { overwritten++; } else { added++; }
    });

    return { ok: true, added: added, overwritten: overwritten, skipped: skipped };
  }

  function applyImport(incoming) {
    var byKey = {};
    state.stocks.forEach(function (s) { byKey[stockKey(s)] = s; });

    incoming.stocks.forEach(function (raw) {
      if (!hasTicker(raw)) return;
      var s = normalizeStock(raw, state.settings);
      var key = stockKey(s);
      if (byKey[key]) {
        // 保留原本的 id，其餘整筆換掉
        s.id = byKey[key].id;
        var idx = state.stocks.indexOf(byKey[key]);
        state.stocks[idx] = s;
      } else {
        state.stocks.push(s);
        byKey[key] = s;
      }
    });

    if (incoming.settings) {
      var merged = {
        discountRate: num(incoming.settings.discountRate, state.settings.discountRate),
        perpetualGrowth: num(incoming.settings.perpetualGrowth, state.settings.perpetualGrowth),
        defaultCagr6_10: num(incoming.settings.defaultCagr6_10, state.settings.defaultCagr6_10)
      };
      if (!validateSettings(merged)) {
        state.settings = merged;
      }
    }

    persist();
  }

  // ---- 資料安全 ----

  // 向瀏覽器申請持久儲存，大幅降低 iOS 在空間不足時回收資料的機率。
  function requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) {
      return Promise.resolve(null);
    }
    return navigator.storage.persisted()
      .then(function (already) {
        return already ? true : navigator.storage.persist();
      })
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
    load: load,
    getState: getState,
    validateSettings: validateSettings,
    updateSettings: updateSettings,
    addStock: addStock,
    findStock: findStock,
    findByTicker: findByTicker,
    updateStock: updateStock,
    removeStock: removeStock,
    allTags: allTags,
    exportJson: exportJson,
    previewImport: previewImport,
    applyImport: applyImport,
    requestPersistence: requestPersistence,
    canPersist: canPersist,
    daysSinceExport: daysSinceExport
  };
})(window);
