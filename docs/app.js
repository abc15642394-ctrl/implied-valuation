// UI 層：估值計算器（即時雙向）、追蹤主表（一檔一列）、分頁表（該檔所有紀錄＋走勢圖）。
(function () {
  'use strict';

  var BUILD = 7;            // 必須與 index.html 的 <meta name="app-build"> 一致
  var GAP_GOOD = -5;        // 落差 ≤ -5pp 視為市場低估
  var GAP_BAD = 5;          // 落差 ≥ +5pp 視為市場比我樂觀
  var TV_HEAVY = 60;        // 永續價值佔比 > 60% 要提醒
  var STALE_DAYS = 30;      // 超過 30 天沒更新就標記
  var EXPORT_NUDGE_DAYS = 14;
  var HUGE = 1e12;          // 超過這個量級就不要印出一長串數字

  var sort = { key: 'gap', dir: 'asc' };
  // 單一來源。先前這個物件在初始化與 clearFilters 各寫一次，
  // 加新欄位只改一處就會在「清除篩選」時把 key 弄丟。
  function defaultFilters() { return { text: '', market: '', status: '', tags: [], starred: false }; }
  var filters = defaultFilters();
  var helperTarget = null;  // { kind: 'calc' } 或 { kind: 'record', id: ... }
  var selectedStockId = null;
  var editingRecordId = null;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 超大數字印成 16 位數沒有任何資訊量，只會把版面撐爆。
  function fmtNum(n, digits) {
    if (n === null || !isFinite(n)) return '—';
    if (Math.abs(n) >= HUGE) return (n < 0 ? '< -' : '> ') + '1兆';
    return n.toFixed(digits === undefined ? 2 : digits);
  }

  function fmtPct(n, digits) {
    if (n === null || !isFinite(n)) return '—';
    if (Math.abs(n) >= HUGE) return (n < 0 ? '< -' : '> ') + '1兆%';
    return n.toFixed(digits === undefined ? 2 : digits) + '%';
  }

  function fmtSigned(n, digits, unit) {
    if (n === null || !isFinite(n)) return '—';
    if (Math.abs(n) >= HUGE) return (n < 0 ? '< -1兆' : '> 1兆') + unit;
    return (n > 0 ? '+' : '') + n.toFixed(digits) + unit;
  }

  // 輸入框顯示原始數值，不經 toFixed——否則 EPS 1.495 重新渲染後會變成 1.50，
  // 下次 blur 就把精度永久寫掉了。
  function inputValue(v) {
    return (v === null || v === undefined || !isFinite(v)) ? '' : String(v);
  }

  function numOrNull(raw) {
    var t = String(raw === null || raw === undefined ? '' : raw).trim();
    if (t === '') return null;
    var n = parseFloat(t);
    return isFinite(n) ? n : null;
  }

  // createdAt 存的是 ISO（UTC）。顯示一定要轉本地，否則台北使用者會看到差 8 小時的時間。
  function localTime(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '—';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function daysSince(dateStr) {
    var t = new Date(dateStr).getTime();
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function settings() { return Store.getState().settings; }

  // ---- 計算（吃一筆 record） ----

  function computeRecord(rec, st) {
    var dr = st.discountRate / 100;
    var pg = st.perpetualGrowth / 100;
    var g610 = (rec.cagr6_10 || 0) / 100;

    var out = {
      implied: null, impliedStatus: 'invalid',
      gap: null, fairValue: null, upside: null, tvShare: null
    };

    // 「我估的」沒填就不該有合理價、落差、上漲空間——那是估計值的產物，不是 0%。
    var hasMy = rec.myCagr1_5 !== null && isFinite(rec.myCagr1_5);

    if (rec.eps > 0 && hasMy && dr > pg) {
      var parts = Valuation.dcfParts(rec.eps, rec.myCagr1_5 / 100, g610, dr, pg);
      if (isFinite(parts.total) && parts.total > 0) {
        out.fairValue = parts.total;
        out.tvShare = (parts.terminal / parts.total) * 100;
        if (rec.price > 0) out.upside = (parts.total / rec.price - 1) * 100;
      }
    }

    var res = Valuation.impliedCagr1_5(rec.price, rec.eps, g610, dr, pg);
    out.impliedStatus = res.status;
    if (res.status === 'ok') {
      out.implied = res.cagr * 100;
      if (hasMy) out.gap = out.implied - rec.myCagr1_5;
    }

    return out;
  }

  function statusMessage(status, eps, price) {
    if (status === 'invalid') {
      if (!(eps > 0)) return 'EPS ≤ 0，不適用';
      if (price !== undefined && !(price > 0)) return '股價須 > 0';
      return '輸入不完整';
    }
    if (status === 'above') return '超出上限';
    if (status === 'below') return '低於下限';
    return '—';
  }

  // 星號：點一下切換。有原因時顯示在 title。
  function starHtml(kind, item) {
    var on = item.starred === true;
    var t = on ? (item.starNote ? '已標記：' + item.starNote : '已標記（點一下取消）') : '點一下標記';
    return '<button type="button" class="star' + (on ? ' on' : '') + '" data-star="' + kind
      + '" data-star-id="' + esc(item.id) + '" title="' + esc(t) + '" aria-pressed="' + on + '">'
      + (on ? '★' : '☆') + '</button>';
  }

  function gapState(gap) {
    if (gap <= GAP_GOOD) return 'good';
    if (gap >= GAP_BAD) return 'bad';
    return '';
  }

  // ---- 估值計算器 ----

  function readCalc() {
    var st = settings();
    var dr = numOrNull($('setDiscountRate').value);
    var pg = numOrNull($('setPerpetualGrowth').value);
    return {
      price: numOrNull($('calcPrice').value),
      eps: numOrNull($('calcEps').value),
      g15: numOrNull($('calcG15').value),
      g610: numOrNull($('calcG610').value),
      dr: dr === null ? st.discountRate : dr,
      pg: pg === null ? st.perpetualGrowth : pg
    };
  }

  function showCalcError(text) {
    var el = $('calcError');
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = text;
    el.hidden = false;
  }

  // 只動狀態 class，保留 HTML 裡的基底 class（否則配色會被洗掉）。
  var RES_STATES = ['good', 'bad', 'na', 'tv-heavy'];
  function setRes(id, text, state) {
    var el = $(id);
    el.textContent = text;
    RES_STATES.forEach(function (s) { el.classList.remove(s); });
    if (state) el.classList.add(state);
  }

  function recalcCalculator() {
    var v = readCalc();
    var g610 = v.g610 === null ? 0 : v.g610;

    ['resImplied', 'resFair', 'resGap', 'resUpside', 'resTv'].forEach(function (id) { setRes(id, '—'); });
    $('applyImplied').hidden = true;
    $('applyImplied').dataset.value = '';

    var msg = $('calcMsg');

    if (!(v.dr > v.pg)) {
      msg.textContent = '折現率（' + v.dr + '%）必須大於永續成長率（' + v.pg + '%），否則永續價值公式會算出無限大或負數。';
      return;
    }
    if (v.eps === null) {
      msg.textContent = '填入 EPS 後開始計算。只填股價＋EPS 就會反推市場隱含成長率；再填 1-5 年成長率就會同時算出你的合理價。';
      return;
    }
    if (v.eps <= 0) {
      msg.textContent = 'EPS ≤ 0，此模型不適用（股價對成長率會變成遞減，反推沒有意義）。';
      return;
    }
    if (v.price !== null && v.price <= 0) {
      msg.textContent = '股價必須大於 0，目前是 ' + v.price + '。';
      return;
    }

    var implied = null;

    if (v.price !== null) {
      var res = Valuation.impliedCagr1_5(v.price, v.eps, g610 / 100, v.dr / 100, v.pg / 100);
      if (res.status === 'ok') {
        implied = res.cagr * 100;
        setRes('resImplied', fmtPct(implied));
        $('applyImplied').hidden = false;
        $('applyImplied').dataset.value = implied;
      } else {
        setRes('resImplied', statusMessage(res.status, v.eps, v.price), 'na');
      }
    }

    if (v.g15 !== null) {
      var parts = Valuation.dcfParts(v.eps, v.g15 / 100, g610 / 100, v.dr / 100, v.pg / 100);
      if (isFinite(parts.total) && parts.total > 0) {
        var tv = parts.terminal / parts.total * 100;
        setRes('resFair', fmtNum(parts.total) + ' 元');
        setRes('resTv', fmtPct(tv, 0), tv > TV_HEAVY ? 'tv-heavy' : '');
        if (v.price !== null && v.price > 0) {
          setRes('resUpside', fmtSigned((parts.total / v.price - 1) * 100, 1, '%'));
        }
      }
    }

    if (implied !== null && v.g15 !== null) {
      var gap = implied - v.g15;
      setRes('resGap', fmtSigned(gap, 2, 'pp'), gapState(gap));
    }

    if (v.price === null) {
      msg.textContent = '再填入股價，就會反推出市場正在假設的 1-5 年成長率。';
    } else if (v.g15 === null) {
      msg.textContent = '1-5 年成長率留空時只算市場隱含值。填入你自己的估計，就會同時給出合理價與落差。';
    } else if (implied !== null) {
      var d = implied - v.g15;
      msg.textContent = d <= GAP_GOOD
        ? '市場隱含的成長率比你估的低 ' + Math.abs(d).toFixed(2) + ' 個百分點——市場的要求比你保守，相對低估。'
        : (d >= GAP_BAD
          ? '市場隱含的成長率比你估的高 ' + d.toFixed(2) + ' 個百分點——市場比你樂觀，你得先說服自己它做得到。'
          : '市場隱含的成長率跟你估的差不多，這個價位沒有明顯的預期落差。');
    } else {
      msg.textContent = '股價超出可求解範圍，無法算出落差。';
    }
  }

  // ---- 主表（一檔一列，顯示最新一筆） ----

  function visibleRows() {
    var st = settings();
    var text = filters.text.trim().toLowerCase();

    var rows = Store.getState().stocks.filter(function (s) {
      if (filters.market && s.market !== filters.market) return false;
      if (filters.status && s.status !== filters.status) return false;
      if (text && (s.ticker + ' ' + s.name).toLowerCase().indexOf(text) === -1) return false;
      if (filters.tags.length && !filters.tags.every(function (t) { return s.tags.indexOf(t) !== -1; })) return false;
      if (filters.starred && !Store.stockHasStar(s.id)) return false;
      return true;
    }).map(function (s) {
      var rec = Store.latestRecord(s.id);
      return {
        stock: s,
        rec: rec,
        calc: rec ? computeRecord(rec, st) : null,
        count: Store.countOf(s.id)
      };
    }).filter(function (r) { return !!r.rec; });   // 沒有任何紀錄的股票不該出現

    sortRows(rows);
    return rows;
  }

  function sortValue(row, key) {
    var s = row.stock, r = row.rec, c = row.calc;
    switch (key) {
      case 'ticker': return s.ticker;
      case 'name': return s.name;
      case 'status': return s.status;
      case 'count': return row.count;
      case 'date': return r.date;
      case 'price': return r.price;
      case 'eps': return r.eps;
      case 'myCagr1_5': return r.myCagr1_5;
      case 'implied': return c.implied;
      case 'gap': return c.gap;
      case 'fairValue': return c.fairValue;
      case 'upside': return c.upside;
      default: return null;
    }
  }

  function sortRows(rows) {
    var dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
      var na = va === null || va === undefined || (typeof va === 'number' && !isFinite(va));
      var nb = vb === null || vb === undefined || (typeof vb === 'number' && !isFinite(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string') return va.localeCompare(vb, 'zh-Hant') * dir;
      return (va - vb) * dir;
    });
  }

  var LABELS = {
    ticker: '代號', name: '名稱', price: '現價', eps: 'EPS', myCagr1_5: '我估 1-5 年',
    implied: '市場隱含', gap: '落差', fairValue: '合理價', upside: '上漲空間',
    count: '筆數', status: '狀態', date: '更新', actions: ''
  };

  var COL_TONE = {
    price: 'c-fact', eps: 'c-fact', myCagr1_5: 'c-mine',
    fairValue: 'c-mine', upside: 'c-mine', implied: 'c-market', gap: 'c-signal', tvShare: 'c-warn'
  };

  function cell(col, inner, extraClass) {
    return '<td class="' + (COL_TONE[col] || '') + ' ' + (extraClass || '') + '" data-col="' + col
      + '" data-label="' + LABELS[col] + '">' + inner + '</td>';
  }

  function editCell(rec, field) {
    // 主表顯示的是該檔「最新一筆」，就地編輯動到的也只有那一筆——
    // 累積多筆之後很容易誤以為是在改整檔，所以把它寫在 title 上。
    var hint = '編輯的是最新一筆（' + rec.date + '）';
    return '<td class="num ' + (COL_TONE[field] || '') + '" data-col="' + field + '" data-label="' + LABELS[field] + '">'
      + '<input type="number" step="any" inputmode="decimal" title="' + esc(hint) + '" data-rec="' + rec.id
      + '" data-field="' + field + '" value="' + inputValue(rec[field]) + '"></td>';
  }

  function impliedHtml(c, rec) {
    return c.impliedStatus === 'ok'
      ? fmtPct(c.implied)
      : '<span class="signal-cell na">' + esc(statusMessage(c.impliedStatus, rec.eps, rec.price)) + '</span>';
  }

  function gapHtml(c) {
    return c.gap === null
      ? '<span class="signal-cell na">—</span>'
      : '<span class="signal-cell ' + gapState(c.gap) + '">' + fmtSigned(c.gap, 2, 'pp') + '</span>';
  }

  function tvHtml(c) {
    return c.tvShare === null ? '—'
      : '<span class="' + (c.tvShare > TV_HEAVY ? 'tv-heavy' : '') + '">' + fmtPct(c.tvShare, 0) + '</span>';
  }

  // 同一年只顯示月日（完整日期放 title），省下的寬度讓星號放得進代號欄。
  function shortDate(dateStr) {
    var y = String(dateStr).slice(0, 4);
    return y === String(new Date().getFullYear()) ? String(dateStr).slice(5) : dateStr;
  }

  function dateHtml(dateStr) {
    var age = daysSince(dateStr);
    var txt = esc(shortDate(dateStr));
    return age !== null && age > STALE_DAYS
      ? '<span class="badge stale" title="' + esc(dateStr) + '（' + age + ' 天沒更新）">' + txt + '</span>'
      : '<span title="' + esc(dateStr) + '">' + txt + '</span>';
  }

  function rowHtml(row) {
    var s = row.stock, r = row.rec, c = row.calc;
    var sel = s.id === selectedStockId ? ' class="selected"' : '';
    var html = '<tr data-stock="' + esc(s.id) + '"' + sel + '>';

    html += cell('ticker', starHtml('stock', s) + '<strong>' + esc(s.ticker || '（無代號）') + '</strong>'
      + ' <span class="mkt">' + (s.market === 'US' ? 'US' : 'TW') + '</span>');
    html += cell('name', '<span class="ellip" title="' + esc(s.name) + '">' + esc(s.name) + '</span>');

    html += editCell(r, 'price');
    html += editCell(r, 'eps');
    html += editCell(r, 'myCagr1_5');

    html += cell('implied', impliedHtml(c, r), 'num');
    html += cell('gap', gapHtml(c), 'num');
    html += cell('fairValue', fmtNum(c.fairValue), 'num');
    html += cell('upside', c.upside === null ? '—' : fmtSigned(c.upside, 1, '%'), 'num');
    html += cell('count', '<span class="count-pill">' + row.count + '</span>', 'num');
    html += cell('status', '<span class="badge ' + s.status + '">' + (s.status === 'held' ? '持有' : '觀察中') + '</span>');
    html += cell('date', dateHtml(r.date));
    html += cell('actions', '<button type="button" class="del" data-del-stock="' + esc(s.id)
      + '" title="刪除這一檔（含所有紀錄）">✕</button>');

    return html + '</tr>';
  }

  // 就地編輯後只重畫該列的計算欄位，不整表重建
  // （重建會把焦點與手機卡片的展開狀態一起弄丟）。
  function refreshMainRow(tr, rec) {
    var c = computeRecord(rec, settings());
    var map = {
      implied: impliedHtml(c, rec),
      gap: gapHtml(c),
      fairValue: fmtNum(c.fairValue),
      upside: c.upside === null ? '—' : fmtSigned(c.upside, 1, '%'),
      date: dateHtml(rec.date)
    };
    Object.keys(map).forEach(function (col) {
      var td = tr.querySelector('td[data-col="' + col + '"]');
      if (td) td.innerHTML = map[col];
    });
  }

  function render() {
    var rows = visibleRows();
    var total = Store.getState().stocks.length;

    // 一筆壞資料不該讓整張表消失。
    $('stockBody').innerHTML = rows.map(function (row) {
      try { return rowHtml(row); }
      catch (err) {
        console.error('這一列畫不出來', row.stock, err);
        return '<tr class="row-error"><td colspan="13">這一筆資料有問題，畫不出來（'
          + esc(String((row.stock || {}).ticker || '未知')) + '）：' + esc(err.message) + '</td></tr>';
      }
    }).join('');

    $('emptyState').hidden = total !== 0;
    $('noMatch').hidden = !(total > 0 && rows.length === 0);
    document.querySelector('.table-wrap').hidden = rows.length === 0;

    var shownRecords = rows.reduce(function (n, r) {
      return n + (filters.starred
        ? Store.recordsOf(r.stock.id).filter(function (x) { return x.starred; }).length
        : r.count);
    }, 0);
    updateCountLine(total, rows.length, shownRecords);

    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.sort === sort.key);
      th.classList.toggle('asc', th.dataset.sort === sort.key && sort.dir === 'asc');
    });

    renderTagFilters();
    renderExportNudge();
    renderStorageWarning();
    renderDetail();
  }

  function filtersActive() {
    return !!(filters.text || filters.market || filters.status || filters.tags.length || filters.starred);
  }

  // 紀錄數也要反映篩選，否則會出現「畫面上 3 筆、上面寫 62 筆」這種誤導。
  function updateCountLine(total, shownStocks, shownRecords) {
    var allRecs = Store.getState().records.length;
    var base = '追蹤 ' + total + ' 檔・' + allRecs + ' 筆紀錄';
    if (total !== shownStocks || allRecs !== shownRecords) {
      base += '（目前顯示 ' + shownStocks + ' 檔・' + shownRecords + ' 筆）';
    }
    $('countLine').textContent = base;
    $('clearFilters').hidden = !filtersActive();
  }

  function renderStorageWarning() {
    var el = $('storageWarn');
    if (Store.canPersist()) { el.hidden = true; return; }
    el.textContent = '這個瀏覽器不讓網頁儲存資料（可能是無痕模式或封鎖了網站資料）。'
      + '你現在看到的內容只存在記憶體裡，重新整理就會消失——請先按右上角「匯出」備份。';
    el.hidden = false;
  }

  function renderTagFilters() {
    $('tagFilters').innerHTML = Store.allTags().map(function (t) {
      return '<button type="button" class="tag-chip' + (filters.tags.indexOf(t) !== -1 ? ' on' : '')
        + '" data-tag="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
  }

  function renderExportNudge() {
    var el = $('exportNudge');
    var days = Store.daysSinceExport();
    if (Store.getState().stocks.length === 0) { el.hidden = true; return; }
    el.hidden = false;
    if (days === null) {
      el.textContent = '還沒匯出過備份';
      el.classList.add('stale');
    } else {
      el.textContent = '上次匯出：' + (days === 0 ? '今天' : days + ' 天前');
      el.classList.toggle('stale', days > EXPORT_NUDGE_DAYS);
    }
  }

  function renderSettings() {
    $('setDiscountRate').value = settings().discountRate;
    $('setPerpetualGrowth').value = settings().perpetualGrowth;
  }

  // ---- 分頁表：該檔的所有紀錄 ----

  // 與前一筆（較舊）相比的變化。百分比用於價格類，pp 用於成長率類。
  function deltaHtml(cur, prev, kind) {
    if (prev === null || prev === undefined || cur === null || cur === undefined) return '';
    if (!isFinite(cur) || !isFinite(prev)) return '';
    var d, text;
    if (kind === 'pp') {
      d = cur - prev;
      if (Math.abs(d) < 0.005) return '<span class="delta flat">持平</span>';
      text = fmtSigned(d, 2, 'pp');
    } else {
      if (prev === 0) return '';
      d = (cur / prev - 1) * 100;
      if (Math.abs(d) < 0.05) return '<span class="delta flat">持平</span>';
      text = fmtSigned(d, 1, '%');
    }
    return '<span class="delta ' + (d > 0 ? 'up' : 'down') + '">' + text + '</span>';
  }

  function numWithDelta(value, prevValue, kind, formatted) {
    return '<div class="val">' + formatted + '</div>' + deltaHtml(value, prevValue, kind);
  }

  function recordRowHtml(rec, prev, prevCalc) {
    var st = settings();
    var c = computeRecord(rec, st);
    var html = '<tr data-rec-row="' + esc(rec.id) + '"' + (rec.starred ? ' class="starred"' : '') + '>';

    // 星號內嵌在時間欄，不另開欄位：手機版把第一格當成卡片標題，
    // 星號若自成一欄會把標題樣式搶走。
    var meta = starHtml('record', rec) + '<span class="t">' + esc(localTime(rec.createdAt)) + '</span>';
    if (rec.label) meta += '<span class="badge rec-label">' + esc(rec.label) + '</span>';
    if (rec.starred && rec.starNote) meta += '<span class="star-note">' + esc(rec.starNote) + '</span>';
    html += '<td data-label="時間" class="rec-time">' + meta + '</td>';

    html += '<td class="num c-fact" data-label="股價">'
      + numWithDelta(rec.price, prev && prev.price, 'pct', fmtNum(rec.price)) + '</td>';
    html += '<td class="num c-fact" data-label="EPS">'
      + numWithDelta(rec.eps, prev && prev.eps, 'pct', fmtNum(rec.eps)) + '</td>';
    html += '<td class="num c-mine" data-label="我估 1-5 年">'
      + numWithDelta(rec.myCagr1_5, prev && prev.myCagr1_5, 'pp',
        rec.myCagr1_5 === null ? '未估' : fmtPct(rec.myCagr1_5)) + '</td>';
    html += '<td class="num c-mine" data-label="6-10 年">' + fmtPct(rec.cagr6_10) + '</td>';
    html += '<td class="num c-market" data-label="市場隱含">'
      + numWithDelta(c.implied, prevCalc && prevCalc.implied, 'pp', impliedHtml(c, rec)) + '</td>';
    html += '<td class="num c-signal" data-label="落差">'
      + numWithDelta(c.gap, prevCalc && prevCalc.gap, 'pp', gapHtml(c)) + '</td>';
    html += '<td class="num c-mine" data-label="合理價">'
      + numWithDelta(c.fairValue, prevCalc && prevCalc.fairValue, 'pct', fmtNum(c.fairValue)) + '</td>';
    html += '<td class="num c-warn" data-label="永續佔比">' + tvHtml(c) + '</td>';
    html += '<td class="rec-note" data-label="備註">' + (rec.note ? esc(rec.note) : '—') + '</td>';
    html += '<td data-label="" class="rec-actions">'
      + '<button type="button" class="pill" data-edit-rec="' + esc(rec.id) + '" title="載回上方計算器修改">編輯</button>'
      + '<button type="button" class="del" data-del-rec="' + esc(rec.id) + '" title="刪除這一筆紀錄">✕</button>'
      + '</td>';

    return html + '</tr>';
  }

  // 取「好看」的刻度間隔
  function niceStep(range, target) {
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : (norm <= 2 ? 2 : (norm <= 5 ? 5 : 10));
    return step * mag;
  }

  // 依日期把紀錄分組（新 → 舊），組內也是新 → 舊
  function groupByDate(recs) {
    var order = [];
    var map = {};
    recs.forEach(function (r) {
      if (!map[r.date]) { map[r.date] = []; order.push(r.date); }
      map[r.date].push(r);
    });
    return order.map(function (d) { return { date: d, items: map[d] }; });
  }

  // 手寫 inline SVG。重點：
  //  - 不能用 preserveAspectRatio="none"，否則加上去的文字會被橫向扯變形
  //  - x 軸用「不重複日期」等距排，不是真實時間距離。實測真實時間軸下，
  //    一筆 2020 年的紀錄會把最近三筆擠成整張圖的 0.08% 寬，等於看不見。
  //  - 同一天的多筆畫在同一個 x 上（平行試算），折線只連每日代表筆。
  function trendSvg(recs) {
    var st = settings();
    var groups = groupByDate(recs).slice().reverse();   // 舊 → 新

    var pts = groups.map(function (g, i) {
      var items = g.items.map(function (r) {
        var c = computeRecord(r, st);
        return { implied: c.impliedStatus === 'ok' ? c.implied : null, mine: r.myCagr1_5,
                 starred: r.starred === true };
      });
      return { date: g.date, i: i, items: items, lead: items[0] };   // items[0] = 該日最新
    });

    var vals = [];
    pts.forEach(function (p) {
      p.items.forEach(function (it) {
        if (it.implied !== null && isFinite(it.implied)) vals.push(it.implied);
        if (it.mine !== null && isFinite(it.mine)) vals.push(it.mine);
      });
    });
    if (!vals.length) return '<p class="hint">這些紀錄還算不出可畫的成長率，所以畫不出走勢。</p>';

    var mineCount = 0, total = 0;
    recs.forEach(function (r) { total++; if (r.myCagr1_5 !== null && isFinite(r.myCagr1_5)) mineCount++; });

    var W = 620, H = 240, L = 54, Rt = 16, T = 18, B = 40;
    var plotW = W - L - Rt, plotH = H - T - B;

    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    var step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;

    var x = function (i) { return pts.length === 1 ? L + plotW / 2 : L + i * plotW / (pts.length - 1); };
    var y = function (v) { return T + plotH - (v - lo) / (hi - lo) * plotH; };

    var svg = '';

    // y 軸格線與刻度
    for (var v = lo; v <= hi + 1e-9; v += step) {
      var yy = y(v);
      var zero = Math.abs(v) < 1e-9;
      svg += '<line class="grid' + (zero ? ' zero' : '') + '" x1="' + L + '" y1="' + yy.toFixed(1)
        + '" x2="' + (W - Rt) + '" y2="' + yy.toFixed(1) + '"/>';
      svg += '<text class="tick-y" x="' + (L - 7) + '" y="' + (yy + 3.5).toFixed(1) + '">'
        + v.toFixed(Math.abs(step) < 1 ? 1 : 0) + '%</text>';
    }

    // x 軸日期（太擠就隔著標）
    var everyN = Math.ceil(pts.length / 8);
    pts.forEach(function (p, i) {
      if (i % everyN !== 0 && i !== pts.length - 1) return;
      svg += '<text class="tick-x" x="' + x(i).toFixed(1) + '" y="' + (H - B + 16) + '">'
        + esc(p.date.slice(5)) + '</text>';
    });

    // 折線只連每日代表筆；缺值就斷線
    function leadLine(key, cls) {
      var segs = [], cur = [];
      pts.forEach(function (p, i) {
        var v = p.lead[key];
        if (v === null || !isFinite(v)) { if (cur.length > 1) segs.push(cur); cur = []; return; }
        cur.push(x(i).toFixed(1) + ',' + y(v).toFixed(1));
      });
      if (cur.length > 1) segs.push(cur);
      return segs.map(function (sg) {
        return '<polyline class="' + cls + '" points="' + sg.join(' ') + '"/>';
      }).join('');
    }
    svg += leadLine('implied', 'line-market') + leadLine('mine', 'line-mine');

    // 資料點：同一天的多筆疊在同一個 x，非代表筆畫淡一點
    var labels = [];
    pts.forEach(function (p, i) {
      p.items.forEach(function (it, j) {
        [['implied', 'market'], ['mine', 'mine']].forEach(function (pair) {
          var v = it[pair[0]];
          if (v === null || !isFinite(v)) return;
          var cx = x(i), cy = y(v);
          if (it.starred) {
            // 被標記的點：外環＋實心大點，在一堆點裡要一眼認得出來
            svg += '<circle class="dot-star-ring" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="6.5"/>';
          }
          svg += '<circle class="dot-' + pair[1] + (j > 0 && !it.starred ? ' alt' : '') + '" cx="' + cx.toFixed(1)
            + '" cy="' + cy.toFixed(1) + '" r="' + (it.starred ? 4.2 : (j > 0 ? 2.2 : 3)) + '"/>';
          labels.push({ x: cx, y: cy, v: v, cls: pair[1], lead: j === 0, starred: it.starred });
        });
      });
    });

    // 數值標示：會碰撞就略過（47 筆時點距只有幾 px，不處理一定疊成一團）。
    // 左右兩端的點要改變錨點，否則會壓到 y 軸刻度、或被右邊界切掉。
    // 被標記的排最前面，而且不受碰撞略過限制——標了就一定要看得到數字。
    labels.sort(function (a, b) {
      return ((b.starred ? 2 : 0) + (b.lead ? 1 : 0)) - ((a.starred ? 2 : 0) + (a.lead ? 1 : 0));
    });
    var placed = [];
    labels.forEach(function (lb) {
      var anchor = 'middle', tx = lb.x, ty = lb.y - (lb.starred ? 11 : 8);
      if (lb.x <= L + 20) { anchor = 'start'; tx = lb.x + (lb.starred ? 10 : 7); }
      else if (lb.x >= W - Rt - 20) { anchor = 'end'; tx = lb.x - (lb.starred ? 10 : 7); }
      if (!lb.starred) {
        var collide = placed.some(function (q) { return Math.abs(q.x - tx) < 34 && Math.abs(q.y - ty) < 12; });
        if (collide) return;
      }
      placed.push({ x: tx, y: ty });
      svg += '<text class="pt-label ' + lb.cls + (lb.starred ? ' starred' : '')
        + '" style="text-anchor:' + anchor + '" x="' + tx.toFixed(1)
        + '" y="' + ty.toFixed(1) + '">' + lb.v.toFixed(1) + '%</text>';
    });

    var note = mineCount === 0
      ? '（沒有任何一筆填了「我估」，所以只有市場隱含這條線）'
      : (mineCount < total ? '（' + total + ' 筆中有 ' + mineCount + ' 筆填了「我估」）' : '');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img"'
      + ' aria-label="市場隱含與我估的成長率走勢">' + svg + '</svg>'
      + '<div class="trend-legend">'
      + '<span class="k c-market">市場隱含</span><span class="k c-mine">我估</span>'
      + (recs.some(function (r) { return r.starred; }) ? '<span class="k star-k">★ 已標記</span>' : '')
      + '<span class="note">' + note + '</span>'
      + '<span class="span">' + esc(pts[0].date) + ' → ' + esc(pts[pts.length - 1].date)
      + '・' + pts.length + ' 個日期</span>'
      + '</div>';
  }

  function renderDetail() {
    var panel = $('detailPanel');
    if (!selectedStockId) { panel.hidden = true; return; }

    var stock = Store.findStock(selectedStockId);
    if (!stock) { selectedStockId = null; panel.hidden = true; return; }

    var recs = Store.recordsOf(stock.id);   // 新 → 舊
    if (!recs.length) { selectedStockId = null; panel.hidden = true; return; }

    panel.hidden = false;

    // 篩選只作用在表格；趨勢圖一律吃全量，否則看不到被標記的點在走勢裡的位置。
    var shown = filters.starred ? recs.filter(function (r) { return r.starred; }) : recs;

    $('detailStar').innerHTML = starHtml('stock', stock);
    $('detailTitle').textContent = stock.ticker + ' ' + stock.name
      + '・' + (stock.market === 'US' ? '美股' : '台股')
      + '・共 ' + recs.length + ' 筆'
      + (filters.starred ? '（只看標記：' + shown.length + ' 筆）' : '')
      + (stock.tags.length ? '・' + stock.tags.join('、') : '');
    $('deleteStock').dataset.stock = stock.id;

    var sn = $('detailStarNote');
    sn.hidden = !stock.starred;
    sn.value = stock.starNote || '';
    sn.dataset.id = stock.id;

    $('trendChart').innerHTML = trendSvg(recs);

    var st = settings();
    var groups = groupByDate(shown);                       // 新 → 舊

    // 差值的比較對象是「前一個日期分組的代表筆」，不是相鄰列。
    // 同一天的幾筆是平行試算，互比會跑出 -100% / +231% 這種沒有意義的數字。
    var html = '';
    groups.forEach(function (g, gi) {
      var baseGroup = groups[gi + 1] || null;              // 下一組＝更舊的日期
      var base = baseGroup ? baseGroup.items[0] : null;    // 該日最新一筆為代表
      var baseCalc = base ? computeRecord(base, st) : null;

      html += '<tr class="group-row"><td colspan="11">'
        + '<span class="g-date">' + esc(g.date) + '</span>'
        + '<span class="g-count">' + g.items.length + ' 筆</span>'
        + (g.items.length > 1 ? '<span class="g-hint">同一天的平行試算，彼此不互相比較</span>' : '')
        + (base ? '<span class="g-base">差值基準：' + esc(base.date) + '</span>' : '<span class="g-base">最早一組，沒有可比的前一次</span>')
        + '</td></tr>';

      g.items.forEach(function (r) {
        try { html += recordRowHtml(r, base, baseCalc); }
        catch (err) {
          console.error('這筆紀錄畫不出來', r, err);
          html += '<tr class="row-error"><td colspan="11">這筆紀錄畫不出來：' + esc(err.message) + '</td></tr>';
        }
      });
    });
    if (!groups.length) {
      html = '<tr><td colspan="11" class="empty-rec">這一檔沒有被標記的紀錄。關掉「只看標記」就能看到全部 '
        + recs.length + ' 筆。</td></tr>';
    }
    $('recordBody').innerHTML = html;
  }

  // 標記後在該列就地展開輸入框，Enter 或失焦存檔，Esc 放棄。
  function openStarNoteInput(recId) {
    var tr = $('recordBody').querySelector('tr[data-rec-row="' + recId + '"]');
    if (!tr) return;
    var cellEl = tr.querySelector('.rec-time');
    if (!cellEl || cellEl.querySelector('.star-note-edit')) return;

    var rec = Store.findRecord(recId);
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'star-note-edit';
    inp.placeholder = '為什麼標記？可留空';
    inp.value = (rec && rec.starNote) || '';
    cellEl.appendChild(inp);
    inp.focus();

    var done = false;
    function save(commit) {
      if (done) return;
      done = true;
      if (commit) Store.setStarNote('record', recId, inp.value);
      render();
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(true); }
      else if (e.key === 'Escape') { e.preventDefault(); save(false); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', function () { save(true); });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function selectStock(id) {
    if (editingRecordId !== null) {
      var ed = Store.findRecord(editingRecordId);
      if (!ed || ed.stockId !== id) { exitEdit(); recalcCalculator(); }
    }
    selectedStockId = id;
    render();
    var panel = $('detailPanel');
    if (!panel.hidden) panel.scrollIntoView({ block: 'nearest' });
  }

  // ---- 編輯模式 ----

  function enterEdit(recId) {
    var rec = Store.findRecord(recId);
    if (!rec) return;
    var stock = Store.findStock(rec.stockId);
    if (!stock) return;

    editingRecordId = recId;

    // 股票層
    $('newTicker').value = stock.ticker;
    $('newName').value = stock.name;
    $('newMarket').value = stock.market;
    $('newStatus').value = stock.status;
    $('newTags').value = stock.tags.join(', ');
    // 紀錄層
    $('calcPrice').value = inputValue(rec.price);
    $('calcEps').value = inputValue(rec.eps);
    $('calcG15').value = rec.myCagr1_5 === null ? '' : rec.myCagr1_5;
    $('calcG610').value = inputValue(rec.cagr6_10);
    $('newDate').value = rec.date;
    $('newLabel').value = rec.label;
    $('newNote').value = rec.note;

    // 代號與市場決定這筆屬於哪一檔，編輯時鎖住：
    // 允許改會變成「把紀錄搬到另一檔」這種模稜兩可的操作，容易弄壞資料。
    $('newTicker').readOnly = true;
    $('newMarket').disabled = true;
    $('newTicker').title = $('newMarket').title = '編輯紀錄時不能換股票。要搬到別檔請刪掉重加。';

    $('addBtn').textContent = '更新這一筆';
    $('editBannerText').textContent = '正在編輯 ' + stock.ticker + ' 的 ' + rec.date + ' 這一筆'
      + (rec.label ? '（' + rec.label + '）' : '');
    $('editBanner').hidden = false;
    showAddMsg('');

    recalcCalculator();
    $('editBanner').scrollIntoView({ block: 'center' });
  }

  function exitEdit() {
    if (editingRecordId === null) return;
    editingRecordId = null;
    $('newTicker').readOnly = false;
    $('newMarket').disabled = false;
    $('newTicker').title = $('newMarket').title = '';
    $('addBtn').textContent = '加入追蹤（新增一筆紀錄）';
    $('editBanner').hidden = true;
    $('newLabel').value = '';
    $('newNote').value = '';
    $('newDate').value = Store.today();
  }

  // ---- 加入追蹤 ----

  function showAddMsg(text, isError) {
    var el = $('addMsg');
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = text;
    el.classList.toggle('bad', !!isError);
    el.hidden = false;
  }

  function addToTracking() {
    var v = readCalc();
    var ticker = $('newTicker').value.trim();

    if (!ticker) { showAddMsg('請先在上方「股票資料」填代號，才知道這筆要存成哪一檔。', true); $('newTicker').focus(); return; }
    // 股價留空以前會被偷偷存成 0，變成一筆永遠算不出東西的紀錄。
    if (v.price === null || v.price <= 0) {
      showAddMsg('請填股價（要大於 0），否則這筆紀錄算不出任何東西。', true);
      $('calcPrice').focus();
      return;
    }
    if (v.eps === null) { showAddMsg('請填 EPS，否則這筆紀錄算不出任何東西。', true); $('calcEps').focus(); return; }

    // 編輯模式：更新那一筆，不新增
    if (editingRecordId !== null) {
      var editing = Store.findRecord(editingRecordId);
      if (editing) {
        Store.updateStock(editing.stockId, {
          name: $('newName').value,
          status: $('newStatus').value,
          tags: $('newTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
        });
        Store.updateRecord(editing.id, {
          date: $('newDate').value || editing.date,
          label: $('newLabel').value,
          price: v.price,
          eps: v.eps,
          myCagr1_5: v.g15,
          cagr6_10: v.g610 === null ? 0 : v.g610,
          note: $('newNote').value
        });
        var sid = editing.stockId;
        exitEdit();
        selectedStockId = sid;
        render();
        showAddMsg('已更新這一筆。');
        return;
      }
      exitEdit();
    }

    var stock = Store.upsertStock({
      ticker: ticker,
      name: $('newName').value,
      market: $('newMarket').value,
      status: $('newStatus').value,
      tags: $('newTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
    });

    Store.addRecord(stock.id, {
      date: $('newDate').value || Store.today(),
      label: $('newLabel').value,
      price: v.price,
      eps: v.eps,
      myCagr1_5: v.g15,                      // 留空就是 null＝未估，不是 0%
      cagr6_10: v.g610 === null ? 0 : v.g610,
      note: $('newNote').value
    });

    $('newLabel').value = '';
    $('newNote').value = '';
    $('newDate').value = Store.today();

    selectedStockId = stock.id;
    render();

    var count = Store.countOf(stock.id);
    showAddMsg('已為 ' + stock.ticker + ' 新增第 ' + count + ' 筆紀錄，共追蹤 '
      + Store.getState().stocks.length + ' 檔。');

    var tr = $('stockBody').querySelector('tr[data-stock="' + stock.id + '"]');
    if (tr) {
      tr.classList.add('flash');
      setTimeout(function () { tr.classList.remove('flash'); }, 1600);
      scrollRowIntoView(tr);
    }
  }

  // 捲動後用座標確認元素真的在視窗內，而不是「呼叫過就當成功」。
  // behavior: 'smooth' 在某些環境完全不作用，所以這裡一律用即時捲動。
  function scrollRowIntoView(tr) {
    tr.scrollIntoView({ block: 'center' });
    var b = tr.getBoundingClientRect();
    var topbar = document.querySelector('.topbar').getBoundingClientRect().bottom;
    if (b.top < topbar || b.bottom > window.innerHeight) {
      document.querySelector('.table-wrap').scrollIntoView({ block: 'center' });
    }
  }

  // ---- 事件 ----

  function applyEdit(inp) {
    var field = inp.dataset.field;
    var rec = Store.findRecord(inp.dataset.rec);
    if (!rec) return null;

    var patch = {};
    if (field === 'myCagr1_5') {
      patch[field] = numOrNull(inp.value);                 // 清空＝改回「未估」
    } else {
      var v = numOrNull(inp.value);
      // 股價與 EPS 必須是正數，否則那一列的計算全部失效卻沒有任何解釋。
      if (v === null || ((field === 'price' || field === 'eps') && v <= 0)) {
        inp.value = inputValue(rec[field]);
        inp.classList.add('rejected');
        inp.title = field === 'price' ? '股價必須大於 0' : (field === 'eps' ? 'EPS 必須大於 0' : '請輸入數字');
        setTimeout(function () { inp.classList.remove('rejected'); }, 1200);
        return null;
      }
      inp.title = '';
      patch[field] = v;
    }
    Store.updateRecord(rec.id, patch);
    return Store.findRecord(rec.id);
  }

  function bind() {
    ['calcPrice', 'calcEps', 'calcG15', 'calcG610'].forEach(function (id) {
      $(id).addEventListener('input', recalcCalculator);
    });

    $('calcG610').addEventListener('change', function () {
      var v = numOrNull(this.value);
      if (v !== null) Store.updateSettings({ defaultCagr6_10: v });
    });

    ['setDiscountRate', 'setPerpetualGrowth'].forEach(function (id) {
      $(id).addEventListener('input', recalcCalculator);
      $(id).addEventListener('change', function () {
        var res = Store.updateSettings({
          discountRate: parseFloat($('setDiscountRate').value),
          perpetualGrowth: parseFloat($('setPerpetualGrowth').value),
          defaultCagr6_10: settings().defaultCagr6_10
        });
        showCalcError(res.ok ? '' : res.error);
        if (!res.ok) renderSettings();
        recalcCalculator();
        render();
      });
    });

    $('calcBtn').addEventListener('click', function () {
      recalcCalculator();
      $('calcResult').scrollIntoView({ block: 'nearest' });
    });

    $('applyImplied').addEventListener('click', function () {
      var v = parseFloat(this.dataset.value);
      if (!isFinite(v)) return;
      $('calcG15').value = Math.round(v * 100) / 100;
      recalcCalculator();
    });

    $('helperBtn').addEventListener('click', function () {
      helperTarget = { kind: 'calc' };
      $('helperPicker').hidden = false;
    });

    $('addBtn').addEventListener('click', addToTracking);
    $('newTicker').addEventListener('input', function () { showAddMsg(''); });

    // 主表：就地編輯最新一筆
    $('stockBody').addEventListener('change', function (e) {
      var inp = e.target;
      if (!inp.dataset || !inp.dataset.field) return;
      var rec = applyEdit(inp);
      if (!rec) return;
      refreshMainRow(inp.closest('tr'), rec);
      renderDetail();
      renderStorageWarning();
    });

    $('stockBody').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del-stock]');
      if (del) {
        e.stopPropagation();
        var s = Store.findStock(del.dataset.delStock);
        if (!s) return;
        var n = Store.countOf(s.id);
        if (confirm('刪除 ' + (s.ticker || '這一檔') + '？連同它的 ' + n + ' 筆紀錄都會一起刪掉。')) {
          exitEdit();
          Store.removeStock(s.id);
          if (selectedStockId === s.id) selectedStockId = null;
          render();
        }
        return;
      }
      var st = e.target.closest('[data-star]');
      if (st) {
        e.stopPropagation();
        Store.toggleStar(st.dataset.star, st.dataset.starId);
        render();
        return;
      }
      if (e.target.closest('input, button')) return;
      var tr = e.target.closest('tr[data-stock]');
      if (tr) selectStock(tr.dataset.stock);
    });

    $('cancelEdit').addEventListener('click', function () { exitEdit(); recalcCalculator(); });

    // 分頁表：編輯與逐筆刪除
    $('recordBody').addEventListener('click', function (e) {
      var stBtn = e.target.closest('[data-star]');
      if (stBtn) {
        var item = Store.toggleStar(stBtn.dataset.star, stBtn.dataset.starId);
        render();
        // 剛標記起來 → 就地開一個小輸入框問原因，不想寫直接跳開即可
        if (item && item.starred && stBtn.dataset.star === 'record') {
          openStarNoteInput(stBtn.dataset.starId);
        }
        return;
      }

      var ed = e.target.closest('[data-edit-rec]');
      if (ed) { enterEdit(ed.dataset.editRec); return; }

      var del = e.target.closest('[data-del-rec]');
      if (!del) return;
      var rec = Store.findRecord(del.dataset.delRec);
      if (!rec) return;
      var left = Store.recordsOf(rec.stockId).length;
      var msg = left <= 1
        ? '這是這檔股票最後一筆紀錄，刪掉之後整檔也會從清單消失。要刪嗎？'
        : '刪除 ' + rec.date + ' 這一筆紀錄？';
      if (!confirm(msg)) return;
      if (editingRecordId === rec.id) exitEdit();
      var r = Store.removeRecord(rec.id);
      if (r.removedStock) selectedStockId = null;
      render();
    });

    $('detailClose').addEventListener('click', function () {
      exitEdit(); recalcCalculator(); selectedStockId = null; render();
    });

    $('deleteStock').addEventListener('click', function () {
      var s = Store.findStock(this.dataset.stock);
      if (!s) return;
      var n = Store.countOf(s.id);
      if (!confirm('刪除 ' + s.ticker + '？連同它的 ' + n + ' 筆紀錄都會一起刪掉。')) return;
      exitEdit();
      Store.removeStock(s.id);
      selectedStockId = null;
      render();
    });

    document.querySelectorAll('#stockTable thead th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (sort.key === key) { sort.dir = sort.dir === 'asc' ? 'desc' : 'asc'; }
        else { sort.key = key; sort.dir = 'asc'; }
        render();
      });
    });

    $('filterText').addEventListener('input', function () { filters.text = this.value; render(); });
    $('filterMarket').addEventListener('change', function () { filters.market = this.value; render(); });
    $('filterStatus').addEventListener('change', function () { filters.status = this.value; render(); });

    $('clearFilters').addEventListener('click', function () {
      filters = defaultFilters();
      $('filterText').value = '';
      $('filterMarket').value = '';
      $('filterStatus').value = '';
      $('filterStar').classList.remove('on');
      render();
    });

    $('filterStar').addEventListener('click', function () {
      filters.starred = !filters.starred;
      this.classList.toggle('on', filters.starred);
      render();
    });

    $('detailStarNote').addEventListener('change', function () {
      if (this.dataset.id) Store.setStarNote('stock', this.dataset.id, this.value);
    });

    $('tagFilters').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-tag]');
      if (!chip) return;
      var i = filters.tags.indexOf(chip.dataset.tag);
      if (i === -1) { filters.tags.push(chip.dataset.tag); } else { filters.tags.splice(i, 1); }
      render();
    });

    $('pickRates').addEventListener('click', function () {
      $('helperPicker').hidden = true;
      buildRateInputs();
      $('ratesModal').hidden = false;
    });

    $('pickEndpoints').addEventListener('click', function () {
      $('helperPicker').hidden = true;
      recalcEndpoints();
      $('endpointsModal').hidden = false;
    });

    $('rateYears').addEventListener('input', buildRateInputs);
    $('rateInputs').addEventListener('input', recalcRates);
    $('ratesApply').addEventListener('click', function () { applyCagr(parseFloat(this.dataset.value)); });

    ['epYears', 'epStart', 'epEnd'].forEach(function (id) {
      $(id).addEventListener('input', recalcEndpoints);
    });
    $('endpointsApply').addEventListener('click', function () { applyCagr(parseFloat(this.dataset.value)); });

    document.querySelectorAll('[data-close-modal]').forEach(function (btn) {
      btn.addEventListener('click', closeAllModals);
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeAllModals(); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAllModals(); });

    $('exportBtn').addEventListener('click', function () {
      Store.exportJson();
      renderExportNudge();
    });
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });

    $('importFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(reader.result); }
        catch (err) { alert('這個檔案不是有效的 JSON'); return; }

        var p = Store.previewImport(data);
        if (!p.ok) { alert('無法匯入：' + p.error); return; }

        var msg = '將新增 ' + p.newStocks + ' 檔股票、合併 ' + p.mergedStocks + ' 檔，共 ' + p.records + ' 筆紀錄';
        if (p.skipped) msg += '，略過 ' + p.skipped + ' 筆沒有代號的紀錄';
        if (!confirm(msg + '。要繼續嗎？')) return;

        Store.applyImport(data);
        renderSettings();
        recalcCalculator();
        render();
      };
      reader.readAsText(file);
      this.value = '';
    });
  }

  // ---- 輔助計算機 ----

  function closeAllModals() {
    ['ratesModal', 'endpointsModal', 'helperPicker'].forEach(function (id) { $(id).hidden = true; });
  }

  function applyCagr(value) {
    if (!helperTarget) return;
    $('calcG15').value = Math.round(value * 100) / 100;
    recalcCalculator();
    closeAllModals();
  }

  function buildRateInputs() {
    var n = parseInt($('rateYears').value, 10);
    if (!isFinite(n) || n < 1) n = 1;
    if (n > 10) n = 10;
    var html = '';
    for (var i = 1; i <= n; i++) {
      html += '<label>第 ' + i + ' 年<span class="field">'
        + '<input type="number" step="any" inputmode="decimal" class="rate-input" data-i="' + i + '"><i>%</i>'
        + '</span></label>';
    }
    $('rateInputs').innerHTML = html;
    recalcRates();
  }

  function recalcRates() {
    var rates = [];
    var missing = false;
    document.querySelectorAll('.rate-input').forEach(function (inp) {
      var v = numOrNull(inp.value);
      if (v === null) { missing = true; return; }
      rates.push(v / 100);
    });
    if (missing || !rates.length) {
      $('ratesOut').textContent = '把每一年的成長率都填上';
      $('ratesApply').disabled = true;
      return;
    }
    var cagr = Valuation.cagrFromRates(rates);
    if (cagr === null) {
      $('ratesOut').textContent = '這組成長率算不出 CAGR（累積值為負）';
      $('ratesApply').disabled = true;
      return;
    }
    var pct = cagr * 100;
    $('ratesOut').textContent = rates.length + ' 年複合年均成長率：' + pct.toFixed(2) + '%';
    $('ratesApply').disabled = false;
    $('ratesApply').dataset.value = pct;
  }

  function recalcEndpoints() {
    var cagr = Valuation.cagrFromEndpoints(
      numOrNull($('epStart').value), numOrNull($('epEnd').value), numOrNull($('epYears').value));
    if (cagr === null) {
      $('endpointsOut').textContent = '年數、期初、期末都要填，且期初與期末須大於 0';
      $('endpointsApply').disabled = true;
      return;
    }
    var pct = cagr * 100;
    $('endpointsOut').textContent = $('epYears').value + ' 年複合年均成長率：' + pct.toFixed(2) + '%';
    $('endpointsApply').disabled = false;
    $('endpointsApply').dataset.value = pct;
  }

  // ---- 啟動與自救 ----

  function showFatal(err) {
    var b = $('fatalBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'fatalBanner';
      b.className = 'fatal';
      b.setAttribute('style',
        'position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;gap:12px;' +
        'align-items:center;flex-wrap:wrap;padding:14px 16px;font:14px/1.5 -apple-system,sans-serif;' +
        'background:#fdeceb;color:#b3261e;border-bottom:2px solid #b3261e;');
      b.innerHTML = '<strong>網頁沒能正常啟動。</strong><span id="fatalDetail"></span>';
      var btn = document.createElement('button');
      btn.id = 'fatalReset';
      btn.type = 'button';
      btn.textContent = '清除快取並重新載入';
      btn.setAttribute('style',
        'background:#b3261e;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit;');
      b.appendChild(btn);
      document.body.insertBefore(b, document.body.firstChild);
    }
    var detail = $('fatalDetail');
    if (detail) detail.textContent = err && err.message ? err.message : String(err);
    var reset = $('fatalReset');
    if (reset && !reset.dataset.bound) {
      reset.dataset.bound = '1';
      reset.addEventListener('click', hardReset);
    }
    b.hidden = false;
  }

  function hardReset() {
    var jobs = [];
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations()
        .then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })
        .catch(function () {}));
    }
    if (window.caches) {
      jobs.push(caches.keys()
        .then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
        .catch(function () {}));
    }
    Promise.all(jobs).then(function () { location.reload(); });
  }

  function versionMatches() {
    var meta = document.querySelector('meta[name="app-build"]');
    var htmlBuild = meta ? parseInt(meta.content, 10) : NaN;
    if (htmlBuild === BUILD) { sessionStorage.removeItem('iv-reloaded'); return true; }
    if (!sessionStorage.getItem('iv-reloaded')) {
      sessionStorage.setItem('iv-reloaded', '1');
      hardReset();
      return false;
    }
    showFatal(new Error('版本不一致：HTML 是 ' + htmlBuild + '，程式是 ' + BUILD + '。請按下方按鈕清除快取。'));
    return false;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function (err) {
      console.warn('Service worker 註冊失敗', err);
    });
  }

  function init() {
    var resetBtn = $('fatalReset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.addEventListener('click', hardReset);
    }
    if (!versionMatches()) return;

    Store.load();
    Store.requestPersistence();
    renderSettings();
    $('calcG610').value = settings().defaultCagr6_10;   // 只在載入時種一次
    $('newDate').value = Store.today();
    bind();
    recalcCalculator();
    render();
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', function () {
    try { init(); }
    catch (err) { console.error(err); showFatal(err); }
  });
})();
