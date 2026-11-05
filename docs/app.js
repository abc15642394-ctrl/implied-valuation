// UI 層：估值計算器（即時雙向）、追蹤表格、就地編輯、篩選排序、輔助計算機帶入。
(function () {
  'use strict';

  var GAP_GOOD = -5;        // 落差 ≤ -5pp 視為市場低估
  var GAP_BAD = 5;          // 落差 ≥ +5pp 視為市場比我樂觀
  var TV_HEAVY = 60;        // 永續價值佔比 > 60% 要提醒
  var STALE_DAYS = 30;      // 超過 30 天沒更新就標記
  var EXPORT_NUDGE_DAYS = 14;

  var sort = { key: 'gap', dir: 'asc' };
  var filters = { text: '', market: '', status: '', tags: [] };
  var helperTarget = null;  // { kind: 'calc' } 或 { kind: 'stock', id: ... }

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtNum(n, digits) {
    if (n === null || !isFinite(n)) return '—';
    return n.toFixed(digits === undefined ? 2 : digits);
  }

  function fmtPct(n, digits) {
    if (n === null || !isFinite(n)) return '—';
    return n.toFixed(digits === undefined ? 2 : digits) + '%';
  }

  function fmtSigned(n, digits, unit) {
    if (n === null || !isFinite(n)) return '—';
    var sign = n > 0 ? '+' : '';
    return sign + n.toFixed(digits) + unit;
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

  function daysSince(iso) {
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function settings() { return Store.getState().settings; }

  // ---- 計算：每次渲染即時算，不存進 localStorage ----

  function computeRow(stock, st) {
    var dr = st.discountRate / 100;
    var pg = st.perpetualGrowth / 100;
    var g610 = (stock.cagr6_10 || 0) / 100;

    var out = {
      implied: null, impliedStatus: 'invalid',
      gap: null, fairValue: null, upside: null, tvShare: null
    };

    // 「我估的」沒填就不該有合理價、落差、上漲空間——那是估計值的產物，不是 0%。
    var hasMy = stock.myCagr1_5 !== null && isFinite(stock.myCagr1_5);

    if (stock.eps > 0 && hasMy && dr > pg) {
      var parts = Valuation.dcfParts(stock.eps, stock.myCagr1_5 / 100, g610, dr, pg);
      if (isFinite(parts.total) && parts.total > 0) {
        out.fairValue = parts.total;
        out.tvShare = (parts.terminal / parts.total) * 100;
        if (stock.price > 0) out.upside = (parts.total / stock.price - 1) * 100;
      }
    }

    var res = Valuation.impliedCagr1_5(stock.price, stock.eps, g610, dr, pg);
    out.impliedStatus = res.status;
    if (res.status === 'ok') {
      out.implied = res.cagr * 100;
      if (hasMy) out.gap = out.implied - stock.myCagr1_5;
    }

    return out;
  }

  function statusMessage(status, eps) {
    if (status === 'invalid') {
      if (!(eps > 0)) return 'EPS ≤ 0，此模型不適用';
      return '輸入不完整';
    }
    if (status === 'above') return '高於可求解上限（' + (Valuation.CAGR_MAX * 100) + '%）';
    if (status === 'below') return '低於可求解下限（' + (Valuation.CAGR_MIN * 100) + '%）';
    return '—';
  }

  function gapClass(gap) {
    var cls = 'signal-cell';
    if (gap <= GAP_GOOD) cls += ' good';
    else if (gap >= GAP_BAD) cls += ' bad';
    return cls;
  }

  // ---- 估值計算器（頂部面板，即時雙向） ----

  function readCalc() {
    var st = settings();
    return {
      price: numOrNull($('calcPrice').value),
      eps: numOrNull($('calcEps').value),
      g15: numOrNull($('calcG15').value),
      g610: numOrNull($('calcG610').value),
      dr: st.discountRate,
      pg: st.perpetualGrowth
    };
  }

  function showCalcError(text) {
    var el = $('calcError');
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = text;
    el.hidden = false;
  }

  function setRes(id, text, cls) {
    var el = $(id);
    el.textContent = text;
    el.className = cls || '';
  }

  function recalcCalculator() {
    var v = readCalc();
    var g610 = v.g610 === null ? 0 : v.g610;

    setRes('resImplied', '—');
    setRes('resFair', '—');
    setRes('resGap', '—');
    setRes('resUpside', '—');
    setRes('resTv', '—');
    $('applyImplied').hidden = true;
    $('applyImplied').dataset.value = '';

    var msg = $('calcMsg');

    if (!(v.dr > v.pg)) {
      msg.textContent = '折現率必須大於永續成長率，否則永續價值公式會算出無限大或負數。';
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

    var implied = null;

    // 方向一：股價 → 市場隱含成長率
    if (v.price !== null && v.price > 0) {
      var res = Valuation.impliedCagr1_5(v.price, v.eps, g610 / 100, v.dr / 100, v.pg / 100);
      if (res.status === 'ok') {
        implied = res.cagr * 100;
        setRes('resImplied', fmtPct(implied));
        $('applyImplied').hidden = false;
        $('applyImplied').dataset.value = implied;
      } else {
        setRes('resImplied', statusMessage(res.status, v.eps), 'na');
      }
    }

    // 方向二：我估的成長率 → 合理價
    if (v.g15 !== null) {
      var parts = Valuation.dcfParts(v.eps, v.g15 / 100, g610 / 100, v.dr / 100, v.pg / 100);
      if (isFinite(parts.total) && parts.total > 0) {
        setRes('resFair', fmtNum(parts.total) + ' 元');
        setRes('resTv', fmtPct(parts.terminal / parts.total * 100, 0),
          (parts.terminal / parts.total * 100) > TV_HEAVY ? 'tv-heavy' : '');
        if (v.price !== null && v.price > 0) {
          setRes('resUpside', fmtSigned((parts.total / v.price - 1) * 100, 1, '%'));
        }
      }
    }

    // 兩個方向都有 → 落差
    if (implied !== null && v.g15 !== null) {
      var gap = implied - v.g15;
      setRes('resGap', fmtSigned(gap, 2, 'pp'), gapClass(gap));
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

  // ---- 表格渲染 ----

  function visibleRows() {
    var st = settings();
    var text = filters.text.trim().toLowerCase();

    var rows = Store.getState().stocks.filter(function (s) {
      if (filters.market && s.market !== filters.market) return false;
      if (filters.status && s.status !== filters.status) return false;
      if (text) {
        var hay = (s.ticker + ' ' + s.name).toLowerCase();
        if (hay.indexOf(text) === -1) return false;
      }
      if (filters.tags.length) {
        var hit = filters.tags.every(function (t) { return s.tags.indexOf(t) !== -1; });
        if (!hit) return false;
      }
      return true;
    }).map(function (s) {
      return { stock: s, calc: computeRow(s, st) };
    });

    sortRows(rows);
    return rows;
  }

  function sortValue(row, key) {
    var s = row.stock;
    var c = row.calc;
    switch (key) {
      case 'ticker': return s.ticker;
      case 'name': return s.name;
      case 'market': return s.market;
      case 'status': return s.status;
      case 'tags': return s.tags.join(',');
      case 'updatedAt': return s.updatedAt;
      case 'price': return s.price;
      case 'eps': return s.eps;
      case 'myCagr1_5': return s.myCagr1_5;
      case 'cagr6_10': return s.cagr6_10;
      case 'implied': return c.implied;
      case 'gap': return c.gap;
      case 'fairValue': return c.fairValue;
      case 'upside': return c.upside;
      case 'tvShare': return c.tvShare;
      default: return null;
    }
  }

  function sortRows(rows) {
    var dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var va = sortValue(a, sort.key);
      var vb = sortValue(b, sort.key);

      // 算不出數字的（未估、EPS ≤ 0、超出上下界）一律排到最後，不參與比大小。
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
    ticker: '代號', name: '名稱', market: '市場', price: '現價', eps: 'EPS',
    myCagr1_5: '我估 1-5 年', cagr6_10: '6-10 年', implied: '市場隱含', gap: '落差',
    fairValue: '合理價', upside: '上漲空間', tvShare: '永續佔比', tags: '標籤',
    status: '狀態', updatedAt: '更新', note: '備註', actions: ''
  };

  function editCell(stock, field) {
    return '<td class="num" data-col="' + field + '" data-label="' + LABELS[field] + '">'
      + '<input type="number" step="any" inputmode="decimal" data-id="' + stock.id
      + '" data-field="' + field + '" value="' + inputValue(stock[field]) + '"></td>';
  }

  // 計算出來的那幾格，就地編輯時只重畫這些，不重建整張表
  // （重建會把焦點與手機卡片的展開狀態一起弄丟）。
  function computedHtml(col, s, c) {
    switch (col) {
      case 'implied':
        return c.impliedStatus === 'ok'
          ? fmtPct(c.implied)
          : '<span class="signal-cell na">' + esc(statusMessage(c.impliedStatus, s.eps)) + '</span>';
      case 'gap':
        return c.gap === null
          ? '<span class="signal-cell na">—</span>'
          : '<span class="' + gapClass(c.gap) + '">' + fmtSigned(c.gap, 2, 'pp') + '</span>';
      case 'fairValue':
        return fmtNum(c.fairValue);
      case 'upside':
        return c.upside === null ? '—' : fmtSigned(c.upside, 1, '%');
      case 'tvShare':
        return c.tvShare === null
          ? '—'
          : '<span class="' + (c.tvShare > TV_HEAVY ? 'tv-heavy' : '') + '">' + fmtPct(c.tvShare, 0) + '</span>';
      case 'updatedAt':
        var age = daysSince(s.updatedAt);
        var dateText = s.updatedAt.slice(0, 10);
        return age !== null && age > STALE_DAYS
          ? '<span class="badge stale" title="' + age + ' 天沒更新">' + dateText + '</span>'
          : dateText;
      default:
        return '—';
    }
  }

  var COMPUTED_COLS = ['implied', 'gap', 'fairValue', 'upside', 'tvShare', 'updatedAt'];

  function rowHtml(row) {
    var s = row.stock;
    var c = row.calc;
    var html = '<tr data-id="' + s.id + '">';

    html += '<td data-col="ticker" data-label="代號"><strong>' + esc(s.ticker) + '</strong></td>';

    var nameCell = esc(s.name);
    if (s.note) nameCell += ' <span class="badge" title="' + esc(s.note) + '">備註</span>';
    html += '<td data-col="name" data-label="名稱">' + nameCell + '</td>';

    html += '<td data-col="market" data-label="市場">' + (s.market === 'US' ? '美股' : '台股') + '</td>';

    html += editCell(s, 'price');
    html += editCell(s, 'eps');
    html += editCell(s, 'myCagr1_5');
    html += editCell(s, 'cagr6_10');

    COMPUTED_COLS.slice(0, 5).forEach(function (col) {
      html += '<td class="num" data-col="' + col + '" data-label="' + LABELS[col] + '">'
        + computedHtml(col, s, c) + '</td>';
    });

    html += '<td class="row-tags" data-col="tags" data-label="標籤">'
      + s.tags.map(function (t) { return '<span class="badge">' + esc(t) + '</span>'; }).join('')
      + '</td>';

    html += '<td data-col="status" data-label="狀態"><span class="badge ' + s.status + '">'
      + (s.status === 'held' ? '持有' : '觀察中') + '</span></td>';

    html += '<td data-col="updatedAt" data-label="更新">' + computedHtml('updatedAt', s, c) + '</td>';

    html += '<td data-col="note" data-label="備註">' + esc(s.note || '—') + '</td>';

    html += '<td data-col="actions" data-label="">'
      + '<button type="button" class="pill" data-helper-for="' + s.id + '">換算</button> '
      + '<button type="button" class="del" data-del="' + s.id + '" title="刪除">✕</button></td>';

    html += '</tr>';
    return html;
  }

  function refreshRow(tr, stock) {
    var c = computeRow(stock, settings());
    COMPUTED_COLS.forEach(function (col) {
      var td = tr.querySelector('td[data-col="' + col + '"]');
      if (td) td.innerHTML = computedHtml(col, stock, c);
    });
  }

  function render() {
    var rows = visibleRows();
    var total = Store.getState().stocks.length;

    $('stockBody').innerHTML = rows.map(rowHtml).join('');

    // 一檔都沒有、跟「有股票但全被篩掉」是兩件事，訊息要分開講，
    // 否則篩選沒中時畫面會是一片沒有任何說明的空白。
    $('emptyState').hidden = total !== 0;
    $('noMatch').hidden = !(total > 0 && rows.length === 0);
    document.querySelector('.table-wrap').hidden = rows.length === 0;

    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.sort === sort.key);
      th.classList.toggle('asc', th.dataset.sort === sort.key && sort.dir === 'asc');
    });

    renderTagFilters();
    renderExportNudge();
  }

  function renderTagFilters() {
    var tags = Store.allTags();
    $('tagFilters').innerHTML = tags.map(function (t) {
      var on = filters.tags.indexOf(t) !== -1;
      return '<button type="button" class="tag-chip' + (on ? ' on' : '')
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

  // 只負責把設定值寫回那兩個欄位；絕不碰 calcG610，
  // 否則使用者手動改的 6-10 年會在每次動設定時被蓋回預設值。
  function renderSettings() {
    $('setDiscountRate').value = settings().discountRate;
    $('setPerpetualGrowth').value = settings().perpetualGrowth;
  }

  // ---- 輔助計算機 ----

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function closeAllModals() {
    ['ratesModal', 'endpointsModal', 'helperPicker'].forEach(closeModal);
  }

  function applyCagr(value) {
    if (!helperTarget) return;
    var rounded = Math.round(value * 100) / 100;
    if (helperTarget.kind === 'calc') {
      $('calcG15').value = rounded;
      recalcCalculator();
    } else {
      Store.updateStock(helperTarget.id, { myCagr1_5: rounded });
      var tr = $('stockBody').querySelector('tr[data-id="' + helperTarget.id + '"]');
      var stock = Store.findStock(helperTarget.id);
      if (tr && stock) {
        var inp = tr.querySelector('input[data-field="myCagr1_5"]');
        if (inp) inp.value = inputValue(stock.myCagr1_5);
        refreshRow(tr, stock);
      }
    }
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
    var inputs = document.querySelectorAll('.rate-input');
    var rates = [];
    var missing = false;

    inputs.forEach(function (inp) {
      var v = numOrNull(inp.value);
      if (v === null) { missing = true; return; }
      rates.push(v / 100);
    });

    if (missing || !rates.length) {
      $('ratesOut').textContent = '把每一年的成長率都填上';
      $('ratesApply').disabled = true;
      $('ratesApply').dataset.value = '';
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
    var years = numOrNull($('epYears').value);
    var start = numOrNull($('epStart').value);
    var end = numOrNull($('epEnd').value);

    var cagr = Valuation.cagrFromEndpoints(start, end, years);
    if (cagr === null) {
      $('endpointsOut').textContent = '年數、期初、期末都要填，且期初與期末須大於 0';
      $('endpointsApply').disabled = true;
      return;
    }

    var pct = cagr * 100;
    $('endpointsOut').textContent = years + ' 年複合年均成長率：' + pct.toFixed(2) + '%';
    $('endpointsApply').disabled = false;
    $('endpointsApply').dataset.value = pct;
  }

  // ---- 加入追蹤 ----

  function showAddMsg(text) {
    var el = $('addMsg');
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = text;
    el.hidden = false;
  }

  function addToTracking() {
    var v = readCalc();
    var ticker = $('newTicker').value.trim();

    // 不靠瀏覽器那顆很小的驗證泡泡——使用者已經漏看過一次。
    if (!ticker) { showAddMsg('請先填代號，才知道這筆要存成哪一檔。'); $('newTicker').focus(); return; }
    if (v.price === null && v.eps === null) { showAddMsg('至少要有股價或 EPS 才有東西可以存。'); return; }

    var market = $('newMarket').value;
    var payload = {
      ticker: ticker,
      name: $('newName').value,
      market: market,
      price: v.price === null ? 0 : v.price,
      eps: v.eps === null ? 0 : v.eps,
      myCagr1_5: v.g15,                    // 留空就是 null＝未估，不是 0%
      cagr6_10: v.g610 === null ? 0 : v.g610,
      status: $('newStatus').value,
      tags: $('newTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      note: $('newNote').value
    };

    var existing = Store.findByTicker(market, ticker);
    if (existing) {
      if (!confirm(ticker + ' 已經在追蹤清單裡了，要用現在計算器上的數字覆蓋嗎？')) return;
      Store.updateStock(existing.id, payload);
    } else {
      Store.addStock(payload);
    }

    showAddMsg('');
    $('newTicker').value = '';
    $('newName').value = '';
    $('newTags').value = '';
    $('newNote').value = '';
    render();
  }

  // ---- 事件 ----

  var CALC_INPUTS = ['calcPrice', 'calcEps', 'calcG15', 'calcG610'];

  function bind() {
    CALC_INPUTS.forEach(function (id) {
      $(id).addEventListener('input', recalcCalculator);
    });

    // 6-10 年改了就記成往後新增股票的預設值
    $('calcG610').addEventListener('change', function () {
      var v = numOrNull(this.value);
      if (v !== null) Store.updateSettings({ defaultCagr6_10: v });
    });

    // 折現率、永續成長率是全局設定：驗證通過才寫入，失敗就退回上一個合法值
    ['setDiscountRate', 'setPerpetualGrowth'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var res = Store.updateSettings({
          discountRate: parseFloat($('setDiscountRate').value),
          perpetualGrowth: parseFloat($('setPerpetualGrowth').value),
          defaultCagr6_10: settings().defaultCagr6_10
        });
        if (!res.ok) {
          // 必須寫在專屬的 calcError，recalcCalculator() 每次都會重寫 calcMsg，
          // 寫在那裡會被立刻蓋掉，使用者就永遠看不到被退回的原因。
          showCalcError(res.error);
          renderSettings();
        } else {
          showCalcError('');
        }
        recalcCalculator();
        render();
      });
    });

    $('calcBtn').addEventListener('click', function () {
      recalcCalculator();
      $('calcResult').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    $('applyImplied').addEventListener('click', function () {
      var v = parseFloat(this.dataset.value);
      if (!isFinite(v)) return;
      $('calcG15').value = Math.round(v * 100) / 100;
      recalcCalculator();
    });

    $('helperBtn').addEventListener('click', function () {
      helperTarget = { kind: 'calc' };
      openModal('helperPicker');
    });

    $('addBtn').addEventListener('click', addToTracking);
    $('newTicker').addEventListener('input', function () { showAddMsg(''); });

    // 就地編輯：只更新該列的計算欄位，不重建整張表
    $('stockBody').addEventListener('change', function (e) {
      var inp = e.target;
      if (!inp.dataset || !inp.dataset.field) return;

      var field = inp.dataset.field;
      var stock = Store.findStock(inp.dataset.id);
      if (!stock) return;

      var patch = {};
      if (field === 'myCagr1_5') {
        patch[field] = numOrNull(inp.value);   // 清空＝改回「未估」
      } else {
        var v = numOrNull(inp.value);
        if (v === null) { inp.value = inputValue(stock[field]); return; }
        patch[field] = v;
      }

      Store.updateStock(stock.id, patch);
      refreshRow(inp.closest('tr'), Store.findStock(stock.id));
    });

    $('stockBody').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        var s = Store.findStock(del.dataset.del);
        if (s && confirm('刪除 ' + s.ticker + '？')) { Store.removeStock(s.id); render(); }
        return;
      }

      var helper = e.target.closest('[data-helper-for]');
      if (helper) {
        helperTarget = { kind: 'stock', id: helper.dataset.helperFor };
        openModal('helperPicker');
        return;
      }

      if (e.target.closest('input, button')) return;
      if (window.matchMedia('(max-width: 768px)').matches) {
        var tr = e.target.closest('tr');
        if (tr) tr.classList.toggle('expanded');
      }
    });

    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (sort.key === key) {
          sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sort.key = key;
          sort.dir = 'asc';
        }
        render();
      });
    });

    $('filterText').addEventListener('input', function () { filters.text = this.value; render(); });
    $('filterMarket').addEventListener('change', function () { filters.market = this.value; render(); });
    $('filterStatus').addEventListener('change', function () { filters.status = this.value; render(); });

    $('tagFilters').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-tag]');
      if (!chip) return;
      var tag = chip.dataset.tag;
      var i = filters.tags.indexOf(tag);
      if (i === -1) { filters.tags.push(tag); } else { filters.tags.splice(i, 1); }
      render();
    });

    $('pickRates').addEventListener('click', function () {
      closeModal('helperPicker');
      buildRateInputs();
      openModal('ratesModal');
    });

    $('pickEndpoints').addEventListener('click', function () {
      closeModal('helperPicker');
      recalcEndpoints();
      openModal('endpointsModal');
    });

    $('rateYears').addEventListener('input', buildRateInputs);
    $('rateInputs').addEventListener('input', recalcRates);
    $('ratesApply').addEventListener('click', function () {
      applyCagr(parseFloat(this.dataset.value));
    });

    ['epYears', 'epStart', 'epEnd'].forEach(function (id) {
      $(id).addEventListener('input', recalcEndpoints);
    });
    $('endpointsApply').addEventListener('click', function () {
      applyCagr(parseFloat(this.dataset.value));
    });

    document.querySelectorAll('[data-close-modal]').forEach(function (btn) {
      btn.addEventListener('click', closeAllModals);
    });

    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeAllModals(); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllModals();
    });

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
        try {
          data = JSON.parse(reader.result);
        } catch (err) {
          alert('這個檔案不是有效的 JSON');
          return;
        }
        var preview = Store.previewImport(data);
        if (!preview.ok) { alert('無法匯入：' + preview.error); return; }

        var msg = '將新增 ' + preview.added + ' 筆、覆蓋 ' + preview.overwritten + ' 筆。要繼續嗎？';
        if (!confirm(msg)) return;

        Store.applyImport(data);
        renderSettings();
        recalcCalculator();
        render();
      };
      reader.readAsText(file);
      this.value = '';
    });

    window.addEventListener('resize', syncTopbarHeight);
  }

  // 表頭 sticky 的偏移量必須等於 topbar 實際高度，寫死會在換行時露餡。
  function syncTopbarHeight() {
    var h = document.querySelector('.topbar').getBoundingClientRect().height;
    document.documentElement.style.setProperty('--topbar-h', Math.round(h) + 'px');
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('Service worker 註冊失敗', err);
    });
  }

  function init() {
    Store.load();
    Store.requestPersistence();
    renderSettings();
    $('calcG610').value = settings().defaultCagr6_10;   // 只在載入時種一次
    bind();
    recalcCalculator();
    render();
    syncTopbarHeight();
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
