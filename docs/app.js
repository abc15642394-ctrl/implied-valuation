// UI 層：表格渲染、就地編輯、篩選排序、輔助計算機帶入。
(function () {
  'use strict';

  var GAP_GOOD = -5;        // 落差 ≤ -5pp 視為市場低估
  var GAP_BAD = 5;          // 落差 ≥ +5pp 視為市場比我樂觀
  var TV_HEAVY = 60;        // 永續價值佔比 > 60% 要提醒
  var STALE_DAYS = 30;      // 超過 30 天沒更新就標記
  var EXPORT_NUDGE_DAYS = 14;

  var sort = { key: 'gap', dir: 'asc' };
  var filters = { text: '', market: '', status: '', tags: [] };
  var helperTarget = null;  // { kind: 'form' } 或 { kind: 'stock', id: ... }

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

  function daysSince(iso) {
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  // ---- 計算：每次渲染即時算，不存進 localStorage ----

  function computeRow(stock, settings) {
    var dr = settings.discountRate / 100;
    var pg = settings.perpetualGrowth / 100;
    var g610 = stock.cagr6_10 / 100;
    var myG = stock.myCagr1_5 / 100;

    var out = {
      implied: null, impliedStatus: 'invalid',
      gap: null, fairValue: null, upside: null, tvShare: null
    };

    if (stock.eps > 0) {
      var parts = Valuation.dcfParts(stock.eps, myG, g610, dr, pg);
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
      out.gap = out.implied - stock.myCagr1_5;
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

  // ---- 渲染 ----

  function visibleRows() {
    var settings = Store.getState().settings;
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
      return { stock: s, calc: computeRow(s, settings) };
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

      // 算不出數字的（EPS ≤ 0、超出上下界）一律排到最後，不參與比大小。
      var na = va === null || va === undefined || (typeof va === 'number' && !isFinite(va));
      var nb = vb === null || vb === undefined || (typeof vb === 'number' && !isFinite(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;

      if (typeof va === 'string') return va.localeCompare(vb, 'zh-Hant') * dir;
      return (va - vb) * dir;
    });
  }

  function editCell(stock, field, value, digits) {
    return '<td class="num" data-col="' + field + '" data-label="' + colLabel(field) + '">'
      + '<input type="number" step="0.01" data-id="' + stock.id + '" data-field="' + field
      + '" value="' + fmtNum(value, digits) + '"></td>';
  }

  var LABELS = {
    ticker: '代號', name: '名稱', market: '市場', price: '現價', eps: 'EPS',
    myCagr1_5: '我估 1-5 年', cagr6_10: '6-10 年', implied: '市場隱含', gap: '落差',
    fairValue: '合理價', upside: '上漲空間', tvShare: '永續佔比', tags: '標籤',
    status: '狀態', updatedAt: '更新', note: '備註', actions: ''
  };

  function colLabel(key) { return LABELS[key] || ''; }

  function rowHtml(row) {
    var s = row.stock;
    var c = row.calc;
    var html = '<tr data-id="' + s.id + '">';

    html += '<td data-col="ticker" data-label="代號"><strong>' + esc(s.ticker) + '</strong></td>';

    var nameCell = esc(s.name);
    if (s.note) nameCell += ' <span class="badge" title="' + esc(s.note) + '">備註</span>';
    html += '<td data-col="name" data-label="名稱">' + nameCell + '</td>';

    html += '<td data-col="market" data-label="市場">' + (s.market === 'US' ? '美股' : '台股') + '</td>';

    html += editCell(s, 'price', s.price, 2);
    html += editCell(s, 'eps', s.eps, 2);
    html += editCell(s, 'myCagr1_5', s.myCagr1_5, 2);
    html += editCell(s, 'cagr6_10', s.cagr6_10, 2);

    // 市場隱含
    html += '<td class="num" data-col="implied" data-label="市場隱含">';
    html += c.impliedStatus === 'ok'
      ? fmtPct(c.implied)
      : '<span class="signal-cell na">' + esc(statusMessage(c.impliedStatus, s.eps)) + '</span>';
    html += '</td>';

    // 落差（訊號欄）
    html += '<td class="num" data-col="gap" data-label="落差">';
    if (c.gap === null) {
      html += '<span class="signal-cell na">—</span>';
    } else {
      var cls = 'signal-cell';
      if (c.gap <= GAP_GOOD) cls += ' good';
      else if (c.gap >= GAP_BAD) cls += ' bad';
      html += '<span class="' + cls + '">' + fmtSigned(c.gap, 2, 'pp') + '</span>';
    }
    html += '</td>';

    html += '<td class="num" data-col="fairValue" data-label="合理價">' + fmtNum(c.fairValue) + '</td>';
    html += '<td class="num" data-col="upside" data-label="上漲空間">'
      + (c.upside === null ? '—' : fmtSigned(c.upside, 1, '%')) + '</td>';

    html += '<td class="num" data-col="tvShare" data-label="永續佔比">';
    if (c.tvShare === null) {
      html += '—';
    } else {
      html += '<span class="' + (c.tvShare > TV_HEAVY ? 'tv-heavy' : '') + '">'
        + fmtPct(c.tvShare, 0) + '</span>';
    }
    html += '</td>';

    html += '<td class="row-tags" data-col="tags" data-label="標籤">'
      + s.tags.map(function (t) { return '<span class="badge">' + esc(t) + '</span>'; }).join('')
      + '</td>';

    html += '<td data-col="status" data-label="狀態"><span class="badge ' + s.status + '">'
      + (s.status === 'held' ? '持有' : '觀察中') + '</span></td>';

    var age = daysSince(s.updatedAt);
    var dateText = s.updatedAt.slice(0, 10);
    html += '<td data-col="updatedAt" data-label="更新">';
    html += age !== null && age > STALE_DAYS
      ? '<span class="badge stale" title="' + age + ' 天沒更新">' + dateText + '</span>'
      : dateText;
    html += '</td>';

    html += '<td data-col="note" data-label="備註">' + esc(s.note || '—') + '</td>';

    html += '<td data-col="actions" data-label="">'
      + '<button type="button" class="pill" data-helper-for="' + s.id + '">算 CAGR</button> '
      + '<button type="button" class="del" data-del="' + s.id + '" title="刪除">✕</button></td>';

    html += '</tr>';
    return html;
  }

  function render() {
    var rows = visibleRows();
    var total = Store.getState().stocks.length;

    $('stockBody').innerHTML = rows.map(rowHtml).join('');
    $('emptyState').hidden = total !== 0;
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

  function renderSettings() {
    var s = Store.getState().settings;
    $('setDiscountRate').value = s.discountRate;
    $('setPerpetualGrowth').value = s.perpetualGrowth;
    $('setDefaultCagr6_10').value = s.defaultCagr6_10;
    $('newCagr610').value = s.defaultCagr6_10;
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
    if (helperTarget.kind === 'form') {
      $('newMyCagr').value = rounded;
    } else {
      Store.updateStock(helperTarget.id, { myCagr1_5: rounded });
      render();
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
        + '<input type="number" step="0.01" class="rate-input" data-i="' + i + '"><i>%</i>'
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
      var v = parseFloat(inp.value);
      if (!isFinite(v)) { missing = true; return; }
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
    var years = parseFloat($('epYears').value);
    var start = parseFloat($('epStart').value);
    var end = parseFloat($('epEnd').value);

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

  // ---- 事件 ----

  function bind() {
    $('settingsToggle').addEventListener('click', function () {
      $('settingsPanel').hidden = !$('settingsPanel').hidden;
    });

    ['setDiscountRate', 'setPerpetualGrowth', 'setDefaultCagr6_10'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var patch = {
          discountRate: parseFloat($('setDiscountRate').value),
          perpetualGrowth: parseFloat($('setPerpetualGrowth').value),
          defaultCagr6_10: parseFloat($('setDefaultCagr6_10').value)
        };
        var res = Store.updateSettings(patch);
        var errEl = $('settingsError');
        if (!res.ok) {
          errEl.textContent = res.error;
          errEl.hidden = false;
          renderSettings();   // 退回上一個合法值
          return;
        }
        errEl.hidden = true;
        renderSettings();
        render();
      });
    });

    $('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var tags = $('newTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      Store.addStock({
        ticker: $('newTicker').value,
        name: $('newName').value,
        market: $('newMarket').value,
        price: parseFloat($('newPrice').value),
        eps: parseFloat($('newEps').value),
        myCagr1_5: parseFloat($('newMyCagr').value),
        cagr6_10: parseFloat($('newCagr610').value),
        status: $('newStatus').value,
        tags: tags,
        note: $('newNote').value
      });
      this.reset();
      renderSettings();
      render();
    });

    // 就地編輯
    $('stockBody').addEventListener('change', function (e) {
      var inp = e.target;
      if (!inp.dataset || !inp.dataset.field) return;
      var v = parseFloat(inp.value);
      if (!isFinite(v)) { render(); return; }
      var patch = {};
      patch[inp.dataset.field] = v;
      Store.updateStock(inp.dataset.id, patch);
      render();
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

      // 手機上點卡片展開；桌機點格子不應觸發
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

    // 輔助計算機
    document.querySelectorAll('[data-open-helper]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        helperTarget = { kind: 'form' };
        openModal('helperPicker');
      });
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

    // 匯出 / 匯入
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
        render();
      };
      reader.readAsText(file);
      this.value = '';
    });
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
    bind();
    render();
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
