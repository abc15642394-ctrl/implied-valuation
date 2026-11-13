// UI 層：估值計算器（即時雙向）、追蹤主表（一檔一列）、分頁表（該檔所有紀錄＋走勢圖）。
(function () {
  'use strict';

  var BUILD = 21;           // 必須與 index.html 的 <meta name="app-build"> 一致
  var GAP_GOOD = -5;        // 落差 ≤ -5pp 視為市場低估
  var GAP_BAD = 5;          // 落差 ≥ +5pp 視為市場比我樂觀
  var TV_HEAVY = 60;        // 永續價值佔比 > 60% 要提醒
  var STALE_DAYS = 30;      // 超過 30 天沒更新就標記
  var BACKUP_NUDGE_DAYS = 7;    // 備份提示變色
  var BACKUP_BLOCK_DAYS = 14;   // 擋住畫面要求備份
  var HUGE = 1e12;          // 超過這個量級就不要印出一長串數字

  var sort = { key: 'gap', dir: 'asc' };
  // 單一來源。先前這個物件在初始化與 clearFilters 各寫一次，
  // 加新欄位只改一處就會在「清除篩選」時把 key 弄丟。
  function defaultFilters() { return { text: '', market: '', status: '', tags: [], starred: false }; }
  var filters = defaultFilters();
  var helperTarget = null;  // { kind: 'calc' } 或 { kind: 'record', id: ... }
  var selectedStockId = null;
  var activeTab = 'list';
  var sumSort = { key: 'implied', dir: 'asc' };   // 預設最便宜的排最上面
  var aiSort = { key: 'gap', dir: 'asc' };        // 跟主表一樣，訊號欄是落差
  var aiExpanded = {};                            // AI 試算頁展開中的列
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

  // priceOverride：主表與隱含總表傳股票的「現價」（今天的價），
  // 分頁表與趨勢圖不傳，用該筆自己的「當時股價」——那是歷史快照，
  // 被今天的價覆寫的話，整條走勢線就不是當時真的發生過的事了。
  function computeRecord(rec, st, priceOverride) {
    var dr = st.discountRate / 100;
    var pg = st.perpetualGrowth / 100;
    var g610 = (rec.cagr6_10 || 0) / 100;
    var price = priceOverride === undefined ? rec.price : priceOverride;

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
        if (price > 0) out.upside = (parts.total / price - 1) * 100;
      }
    }

    var res = Valuation.impliedCagr1_5(price, rec.eps, g610, dr, pg);
    out.impliedStatus = res.status;
    if (res.status === 'ok') {
      out.implied = res.cagr * 100;
      if (hasMy) out.gap = out.implied - rec.myCagr1_5;
    }

    return out;
  }

  // 本益比＝現價 ÷ EPS。刻意不塞進 computeRecord——那支是 DCF，
  // 本益比跟折現、成長假設一點關係都沒有。
  // 一律收原始值，不收 stock / rec：沙盒頁用的是另一組數字，
  // 函式認物件的話那一頁就得另寫一份，兩份遲早會講不一樣的話。
  function peOf(price, eps) {
    if (!(price > 0) || !(eps > 0)) return null;
    return price / eps;
  }

  // 算不出本益比只有兩種原因，而且要自己講。借用 statusMessage() 的話，
  // 它回的是二分搜尋的狀態（超出上限／低於下限），貼到本益比那格就是一句假話。
  // 合理價是 EPS ＋「我估 1-5 年」的產物，兩個缺哪一個要講清楚哪一個。
  // 先前這裡一律寫「未估 1-5 年」，EPS ≤ 0 的那檔明明估了卻被說成沒估。
  function fairReason(eps, myCagr) {
    if (eps === null || eps === undefined) return '未填 EPS';
    if (!(eps > 0)) return 'EPS ≤ 0，不適用';
    if (myCagr === null || !isFinite(myCagr)) return '未估 1-5 年';
    return '—';
  }

  // 上漲空間＝合理價 ÷ 現價 − 1，所以先看合理價算不算得出來，再看有沒有現價。
  function upsideReason(price, eps, myCagr) {
    var f = fairReason(eps, myCagr);
    if (f !== '—') return f;
    if (!(price > 0)) return '未填現價';
    return '—';
  }

  function peReason(price, eps) {
    if (eps === null || eps === undefined) return '未填 EPS';
    if (!(eps > 0)) return 'EPS ≤ 0，不適用';
    if (!(price > 0)) return '未填現價';
    return '—';
  }

  // priceLabel：這一格的隱含是用哪一個價算的。主表與兩張總表用「現價」，
  // 分頁表每一列用那一筆自己的「當時股價」，計算器用輸入框的「股價」。
  // 不帶這個參數就會出現同一列裡本益比說「未填現價」、隱含說「未填股價」
  // 這種自相矛盾的畫面。
  function statusMessage(status, eps, price, priceLabel) {
    var pl = priceLabel || '股價';
    if (status === 'invalid') {
      // EPS 被清空（沙盒頁才可能）跟 EPS ≤ 0 是兩回事，別講同一句話
      if (eps === null || eps === undefined) return '未填 EPS';
      if (!(eps > 0)) return 'EPS ≤ 0，不適用';
      // 沒填價不是錯誤，只是這一筆沒有要反推市場隱含值。
      if (price === null || price === undefined) return '未填' + pl;
      if (!(price > 0)) return pl + '須 > 0';
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

  // 市場隱含的五級分帶。四條界線存在設定裡，使用者可以自己改。
  // 低＝市場要求不高（相對便宜）→ 綠；高＝市場要求極高 → 紅。
  // 每一帶都是「左閉右開」：b2 是 [界線1, 界線2)，最後一帶是 [界線4, ∞)。
  function bandOf(v, bands) {
    if (v === null || !isFinite(v)) return '';
    // 用「顯示出來的那個數字」分帶，不是原始值。二分搜尋會回傳 9.999389…，
    // 畫面四捨五入成 10.00% 卻被分到 0–10% 那一帶，顏色跟數字對不起來。
    var shown = Math.round(v * 100) / 100;
    for (var i = 0; i < bands.length; i++) {
      if (shown < bands[i]) return 'b' + (i + 1);
    }
    return 'b' + (bands.length + 1);
  }

  // 檔案不同步時（快取只更新了一半，app.js 是新的、store.js 還是舊的）
  // settings().bands 會是 undefined，讀 .length 就整頁炸掉。分帶只是顏色，
  // 不值得讓整張表畫不出來——退回預設界線，表照畫。
  var BAND_FALLBACK = [0, 10, 20, 30];
  function bandBounds() {
    var b = settings().bands;
    if (Array.isArray(b) && b.length === BAND_FALLBACK.length) return b;
    return (Store.DEFAULT_BANDS || BAND_FALLBACK).slice();
  }

  // 界線能不能編輯，取決於資料層有沒有這個功能（同樣是為了檔案不同步的情況）
  function bandsEditable() { return typeof Store.bandsError === 'function'; }

  function impliedBand(v) { return bandOf(v, bandBounds()); }

  // 界線顯示成最短的樣子：10 就寫 10，12.5 就寫 12.5，不要 10.00。
  function fmtBound(n) {
    if (!isFinite(n)) return '?';
    return String(Math.round(n * 100) / 100);
  }

  // 五個分帶的文字，從四條界線長出來。符號要跟 bandOf 的比較方式一致：
  // 寫「> 30%」但程式把剛好 30.00% 放進最後一帶，看的人會對不起來。
  function bandLabels(bands) {
    var out = ['< ' + fmtBound(bands[0]) + '%'];
    for (var i = 1; i < bands.length; i++) {
      out.push(fmtBound(bands[i - 1]) + '–' + fmtBound(bands[i]) + '%');
    }
    out.push('≥ ' + fmtBound(bands[bands.length - 1]) + '%');
    return out;
  }

  function bandChipsHtml(bands, counts) {
    return bandLabels(bands).map(function (label, i) {
      var n = counts ? counts[i] : null;
      return '<span class="band b' + (i + 1) + '">' + esc(label)
        + (n === null ? '' : ' <b class="band-n">' + n + '</b>') + '</span>';
    }).join('');
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

  // 三個分頁共用同一組篩選。先前主表與總表各寫了一份一模一樣的，
  // 再抄第三份，遲早會有一頁的篩選條件跟別人不一樣。
  function filteredStocks() {
    var text = filters.text.trim().toLowerCase();
    return Store.getState().stocks.filter(function (s) {
      if (filters.market && s.market !== filters.market) return false;
      if (filters.status && s.status !== filters.status) return false;
      if (text && (s.ticker + ' ' + s.name).toLowerCase().indexOf(text) === -1) return false;
      if (filters.tags.length && !filters.tags.every(function (t) { return s.tags.indexOf(t) !== -1; })) return false;
      if (filters.starred && !Store.stockHasStar(s.id)) return false;
      return true;
    });
  }

  function visibleRows() {
    var st = settings();

    var rows = filteredStocks().map(function (s) {
      var rec = Store.latestRecord(s.id);
      return {
        stock: s,
        rec: rec,
        calc: rec ? computeRecord(rec, st, s.currentPrice) : null,
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
      case 'price': return s.currentPrice;       // 主表的「現價」是股票層級的
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

  // upside 拿掉 c-mine：它改用訊號色（綠/紅/灰），再掛「我估紫」會兩套打架。
  var COL_TONE = {
    price: 'c-fact', eps: 'c-fact', myCagr1_5: 'c-mine',
    fairValue: 'c-mine', implied: 'c-market', gap: 'c-signal', tvShare: 'c-warn'
  };

  function cell(col, inner, extraClass) {
    return '<td class="' + (COL_TONE[col] || '') + ' ' + (extraClass || '') + '" data-col="' + col
      + '" data-label="' + LABELS[col] + '">' + inner + '</td>';
  }

  function numInput(attrs, value, hint, placeholder) {
    return '<input type="number" step="any" inputmode="decimal" title="' + esc(hint) + '" '
      + (placeholder ? 'placeholder="' + esc(placeholder) + '" ' : '')
      + attrs + ' value="' + inputValue(value) + '">';
  }

  function editCell(rec, field) {
    // 主表顯示的是該檔「最新一筆」，就地編輯動到的也只有那一筆——
    // 累積多筆之後很容易誤以為是在改整檔，所以把它寫在 title 上。
    var hint = '編輯的是最新一筆（' + rec.date + '）';
    return '<td class="num ' + (COL_TONE[field] || '') + '" data-col="' + field + '" data-label="' + LABELS[field] + '">'
      + numInput('data-rec="' + rec.id + '" data-field="' + field + '"', rec[field], hint) + '</td>';
  }

  // 現價存在股票上，不屬於任何一筆紀錄。它跟紀錄裡的「當時股價」是兩個數字：
  // 改現價只會重算市場隱含與上漲空間，不會改寫你任何一次估值的歷史。
  var PRICE_HINT = '現價＝今天的價。改它會重算市場隱含與上漲空間，不會動到任何一筆估值紀錄。留空＝只算得出合理價。';

  function priceCell(stock, col, label, tone, placeholder) {
    return '<td class="num ' + (tone || '') + '" data-col="' + col + '" data-label="' + label + '">'
      + numInput('data-stock-id="' + esc(stock.id) + '" data-stock-field="currentPrice"',
          stock.currentPrice, PRICE_HINT, placeholder)
      // 只有隱含總表那兩張給帶入鍵。priceCell 有三個呼叫點，追蹤清單也是其中之一
      // （它傳的 col 是 'price'），但主表的欄寬是另外調過的，不在這一包的範圍裡。
      + (col === 'currentPrice' ? closeBtn(stock) : '') + '</td>';
  }

  // 昨收帶入鍵。只有一顆小圖示，不是文字鍵——實測隱含總表在 831px 下只剩 105px
  // 餘裕（而且那是用短名稱的測試資料量的，真實資料更少），放文字鍵會把表撐爆。
  // 日期與數值放 title，不逐列顯示。
  function pendingClose(stock) {
    if (!Store.canPush()) return null;          // 手機是唯讀副本，帶了也會被下次拉覆蓋
    var c = Store.closeOf(stock.ticker);
    if (!c) return null;
    if (stock.currentPrice !== null && stock.currentPrice !== undefined
        && Math.abs(stock.currentPrice - c.price) < 0.005) return null;   // 一樣就不用帶
    return c;
  }

  function closeBtn(stock) {
    var c = pendingClose(stock);
    if (!c) return '';
    return '<button type="button" class="close-apply" data-close-apply="' + esc(stock.id) + '"'
      + ' title="' + esc(c.date + ' 收盤 ' + fmtNum(c.price) + '，點一下帶入現價') + '"'
      + ' aria-label="帶入昨收 ' + esc(fmtNum(c.price)) + '">↓</button>';
  }

  function impliedHtml(c, eps, price, priceLabel) {
    return c.impliedStatus === 'ok'
      ? fmtPct(c.implied)
      : '<span class="signal-cell na">' + esc(statusMessage(c.impliedStatus, eps, price, priceLabel)) + '</span>';
  }

  // 上漲空間跟落差一樣是方向性數字：正＝合理價高於現價，負＝現價已經超過。
  // 用同一套訊號色，一眼看得出賺賠。先前它跟合理價同一個紫，正負完全分不出來。
  // 門檻用 0，不用落差那組 ±5pp——那是成長率的「差不多」區間，套在價格上沒有意義。
  function upsideHtml(c, naText) {
    if (c.upside === null) {
      return '<span class="signal-cell na">' + esc(naText || '—') + '</span>';
    }
    var state = c.upside > 0 ? 'good' : (c.upside < 0 ? 'bad' : '');
    return '<span class="signal-cell ' + state + '">' + fmtSigned(c.upside, 1, '%') + '</span>';
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

    html += priceCell(s, 'price', LABELS.price, COL_TONE.price);
    html += editCell(r, 'eps');
    html += editCell(r, 'myCagr1_5');

    html += cell('implied', impliedHtml(c, r.eps, s.currentPrice, '現價'), 'num');
    html += cell('gap', gapHtml(c), 'num');
    html += cell('fairValue', fmtNum(c.fairValue), 'num');
    html += cell('upside', upsideHtml(c), 'num');
    html += cell('count', '<span class="count-pill">' + row.count + '</span>', 'num');
    html += cell('status', '<span class="badge ' + s.status + '">' + (s.status === 'held' ? '持有' : '觀察中') + '</span>');
    html += cell('date', dateHtml(r.date));
    html += cell('actions', '<button type="button" class="del" data-del-stock="' + esc(s.id)
      + '" title="刪除這一檔（含所有紀錄）">✕</button>');

    return html + '</tr>';
  }

  // 就地編輯後只重畫該列的計算欄位，不整表重建
  // （重建會把焦點與手機卡片的展開狀態一起弄丟）。
  function refreshMainRow(tr, rec, stock) {
    var c = computeRecord(rec, settings(), stock.currentPrice);
    var map = {
      implied: impliedHtml(c, rec.eps, stock.currentPrice, '現價'),
      gap: gapHtml(c),
      fairValue: fmtNum(c.fairValue),
      upside: upsideHtml(c),
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
    $('mainTableWrap').hidden = rows.length === 0;

    var shownRecords = rows.reduce(function (n, r) {
      return n + (filters.starred
        ? Store.recordsOf(r.stock.id).filter(function (x) { return x.starred; }).length
        : r.count);
    }, 0);
    updateCountLine(total, rows.length, shownRecords);

    // 一定要限定 #stockTable：不限定的話會連別張表的標題一起標上排序狀態。
    document.querySelectorAll('#stockTable thead th[data-sort]').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.sort === sort.key);
      th.classList.toggle('asc', th.dataset.sort === sort.key && sort.dir === 'asc');
    });

    renderTagFilters();
    renderExportNudge();
    renderStorageWarning();
    renderDetail();
    renderSummary();
    renderAi();
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

  // 備份提醒分三種裝置，不是兩種：
  //   能推（電腦）      → 看「幾天沒推」
  //   只能拉（手機副本）→ 不提醒。資料是從 gist 拉下來的，本來就有備份；
  //                      催它備份是噪音，而且擋版上沒有它能按的有效動作。
  //   都沒設定          → 維持舊行為，看「幾天沒匯出」。少了這條，在他貼 token
  //                      之前就完全沒有提醒，比現在還糟。
  function backupState() {
    if (Store.canPush()) {
      return { kind: 'push', days: Store.daysSincePush(),
               none: '還沒推上 gist', label: '上次推送' };
    }
    if (Store.canPull()) return { kind: 'replica' };   // 副本，不催
    return { kind: 'export', days: Store.daysSinceExport(),
             none: '還沒匯出過備份', label: '上次匯出' };
  }

  function renderExportNudge() {
    var el = $('exportNudge');
    var b = backupState();
    if (Store.getState().stocks.length === 0 || b.kind === 'replica') {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (b.days === null) {
      el.textContent = b.none;
      el.classList.add('stale');
    } else {
      el.textContent = b.label + '：' + (b.days === 0 ? '今天' : b.days + ' 天前');
      el.classList.toggle('stale', b.days > BACKUP_NUDGE_DAYS);
    }
  }

  // 這台裝置的資料有多舊。只在「拉得到但推不了」的裝置上顯示——也就是手機。
  // 單向同步最大的失敗模式是手機靜默過期：他在 LINE 查到一個看起來正常、
  // 其實是兩週前的估值。這一格就是防這件事的，所以它必須在 topbar，不能要他滑。
  function renderFreshTag() {
    var el = $('freshTag');
    if (!el) return;
    if (Store.canPush() || !Store.canPull() || Store.getState().stocks.length === 0) {
      el.hidden = true;
      return;
    }
    var days = Store.daysSincePush();
    el.hidden = false;
    if (days === null) {
      el.textContent = '來源時間不明';
      el.classList.add('stale');
    } else {
      el.textContent = '電腦 ' + (days === 0 ? '今天' : days + ' 天前');
      el.classList.toggle('stale', days > BACKUP_NUDGE_DAYS);
    }
  }

  // 太久沒備份就擋住畫面。這一層刻意不是 .modal——closeAllModals() 會掃所有
  // .modal，Esc 跟點背景都會呼叫它，那就擋不住了。
  var blockerSnoozed = false;

  function renderBackupBlocker() {
    var el = $('backupBlocker');
    if (!el) return;
    var st = Store.getState();
    if (blockerSnoozed || st.stocks.length === 0) { el.hidden = true; return; }
    var b = backupState();
    // 副本不擋：它的資料就是從 gist 來的，而且它也推不回去。
    if (b.kind === 'replica') { el.hidden = true; return; }
    if (!(b.days === null || b.days > BACKUP_BLOCK_DAYS)) { el.hidden = true; return; }
    $('blockerMsg').textContent = b.days === null
      ? '你的 ' + st.stocks.length + ' 檔 ' + st.records.length + ' 筆紀錄還沒有任何一份離機備份。'
        + '瀏覽器的儲存區是會被清掉的——清掉就真的沒了。'
      : '已經 ' + b.days + ' 天沒備份了（' + st.stocks.length + ' 檔 '
        + st.records.length + ' 筆紀錄）。瀏覽器的儲存區是會被清掉的。';
    $('blockerPush').hidden = !Store.canPush();
    el.hidden = false;
  }

  // iOS 的 Safari、加到主畫面的 app、LINE 內建瀏覽器各有一份互不相通的 localStorage，
  // 而且這是 Apple 刻意的設計（WebKit Bug 181849）。同一個網址在三個地方打開會看到
  // 三份不同的資料——不標出來的話，換一個地方開就會以為「資料不見了」。
  function runtimeLabel() {
    if (navigator.standalone === true) return '主畫面 app';   // iOS 專用，非標準
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
        return '主畫面 app';
      }
    } catch (e) { /* 舊瀏覽器沒有 matchMedia，往下走一般分頁 */ }
    if (/\bLine\//i.test(navigator.userAgent || '')) return 'LINE 瀏覽器';
    return '瀏覽器分頁';
  }

  // 只在啟動時判一次：這三種環境不會在同一次瀏覽中互相切換。
  function renderEnvTag() {
    var el = $('envTag');
    if (!el) return;
    el.textContent = runtimeLabel();
    el.title = '這份資料存在「' + el.textContent + '」裡。Safari、主畫面 app、'
      + 'LINE 內建瀏覽器各存一份，彼此看不到對方——換個地方打開筆數不一樣是正常的，不是資料不見了。';
    el.hidden = false;
  }


  // ---- 同步 ----

  function afterDataSwap() {
    renderSettings();
    recalcCalculator();
    render();
    renderExportNudge();
    renderFreshTag();
    renderBackupBlocker();
    $('syncUndo').hidden = !Store.hasUndo();
  }

  function syncMsg(text, bad) {
    var el = $('syncMsg');
    el.textContent = text;
    el.classList.toggle('error-text', !!bad);
  }

  function openSync() {
    var c = Store.deviceConfig();
    $('syncGistId').value = c.gistId;
    $('syncToken').value = c.token;
    $('syncUndo').hidden = !Store.hasUndo();
    syncMsg('');
    $('syncModal').hidden = false;
  }

  function saveSyncConfig() {
    Store.setDeviceConfig({ gistId: $('syncGistId').value, token: $('syncToken').value });
    renderExportNudge();
    renderFreshTag();
    renderBackupBlocker();
  }

  function doPush(onDone) {
    saveSyncConfig();
    if (!Store.canPush()) { syncMsg('要推的話 gist id 與 token 兩個都得填。', true); return; }
    syncMsg('推送中…');
    Store.pushToGist().then(function (r) {
      if (!r.ok) { syncMsg('推送失敗：' + r.error, true); return; }
      syncMsg('已推上去（' + Store.getState().stocks.length + ' 檔 '
        + Store.getState().records.length + ' 筆）。');
      renderExportNudge();
      renderFreshTag();
      blockerSnoozed = false;
      renderBackupBlocker();
      if (onDone) onDone();
    });
  }

  // 拉＝整個取代。所以先抓、先驗、先讓他看清楚會變成什麼，全部過了才換。
  // 抓失敗、驗不過、或「來源是空的而本機不是」都絕不動到本機資料。
  function doPull() {
    saveSyncConfig();
    if (!Store.canPull()) { syncMsg('要先填 gist id。', true); return; }
    syncMsg('抓取中…');
    Store.fetchFromGist().then(function (r) {
      if (!r.ok) { syncMsg('抓取失敗：' + r.error + '（本機資料沒有被動到）', true); return; }
      var pv = Store.replacePreview(r.data);
      if (!pv.ok) { syncMsg('抓回來的內容有問題：' + pv.error + '（本機資料沒有被動到）', true); return; }

      var msg = '這會把這台的資料整個換掉：'
        + pv.fromStocks + ' 檔 ' + pv.fromRecords + ' 筆 → '
        + pv.toStocks + ' 檔 ' + pv.toRecords + ' 筆。'
        + '正在試算的沙盒草稿也會換成來源那邊的。';
      if (pv.emptyingNonEmpty) {
        msg = '⚠️ 來源是空的（0 檔）。繼續的話，這台的 '
          + pv.fromStocks + ' 檔 ' + pv.fromRecords + ' 筆會被清空。\n\n'
          + '如果你還沒從電腦推過資料上去，現在按下去就會把這台清光——應該先去電腦推一次。\n\n'
          + '真的要繼續嗎？';
      } else if (pv.shrinkingALot) {
        msg = '⚠️ 來源比這台少很多（' + pv.fromStocks + ' 檔 → ' + pv.toStocks + ' 檔）。\n\n'
          + msg + '\n\n真的要繼續嗎？';
      } else {
        msg += '\n\n要繼續嗎？';
      }
      if (!confirm(msg)) { syncMsg('已取消，本機資料沒有被動到。'); return; }

      var res = Store.replaceAll(r.data);
      if (!res.ok) { syncMsg('取代失敗：' + res.error + '（本機資料沒有被動到）', true); return; }
      afterDataSwap();
      syncMsg('已更新成 ' + res.stocks + ' 檔 ' + res.records + ' 筆。按「還原上一次取代」可以救回來。');
    });
  }

  // ---- 匯入：合併還是取代 ----

  var pendingImport = null;

  function askImportMode(data) {
    var p = Store.previewImport(data);
    if (!p.ok) { alert('無法匯入：' + p.error); return; }
    var pv = Store.replacePreview(data);
    pendingImport = data;
    $('importModeSummary').textContent =
      '檔案裡有 ' + pv.toStocks + ' 檔 ' + pv.toRecords + ' 筆；這台目前是 '
      + pv.fromStocks + ' 檔 ' + pv.fromRecords + ' 筆。'
      + '合併只會增加（改過與刪掉的不會跟上）；取代會讓這台變成跟檔案一模一樣。';
    $('importModeModal').hidden = false;
  }

  function runImportMerge() {
    if (!pendingImport) return;
    Store.applyImport(pendingImport);
    pendingImport = null;
    closeAllModals();
    afterDataSwap();
  }

  function runImportReplace() {
    if (!pendingImport) return;
    var pv = Store.replacePreview(pendingImport);
    var warn = '';
    if (pv.emptyingNonEmpty) {
      warn = '⚠️ 這個檔案是空的（0 檔），繼續會把這台的 ' + pv.fromStocks + ' 檔清空。\n\n';
    } else if (pv.shrinkingALot) {
      warn = '⚠️ 這個檔案比這台少很多（' + pv.fromStocks + ' → ' + pv.toStocks + ' 檔）。\n\n';
    }
    if (!confirm(warn + '取代後：' + pv.fromStocks + ' 檔 ' + pv.fromRecords + ' 筆 → '
        + pv.toStocks + ' 檔 ' + pv.toRecords + ' 筆。正在試算的沙盒草稿也會換成檔案裡的。\n\n要繼續嗎？')) {
      return;
    }
    var res = Store.replaceAll(pendingImport);
    pendingImport = null;
    closeAllModals();
    if (!res.ok) { alert('取代失敗：' + res.error + '（本機資料沒有被動到）'); return; }
    afterDataSwap();
    alert('已取代成 ' + res.stocks + ' 檔 ' + res.records + ' 筆。到「同步」可以還原上一次取代。');
  }

  // ---- 昨收橫幅 ----
  //
  // 日期放這裡講一次就好：實測兩個來源各自只有一個日期（TWSE 全部同一天、
  // TPEx 全部同一天），所以不需要逐列顯示——那會吃掉本來就不夠的表格寬度。
  function renderCloseBanner() {
    var el = $('closeBanner');
    if (!el) return;
    if (!Store.hasCloses() || Store.getState().stocks.length === 0) { el.hidden = true; return; }

    var dates = Store.closeDates();
    var pending = Store.getState().stocks.filter(function (s) { return !!pendingClose(s); });

    // 連一檔都帶不動（手機、或全部都已經是最新）時，仍然顯示日期——
    // 他要知道手上這些昨收是哪一天的，TWSE 本來就可能落後一個交易日。
    var stale = dates.length && daysBetween(dates[0], Store.today()) > 5;
    var txt = '收盤資料：' + dates.join('、');
    if (pending.length) txt += '　' + pending.length + ' 檔可帶入';

    el.innerHTML = esc(txt)
      + (pending.length ? ' <button type="button" id="closeApplyAll" class="pill">全部帶入</button>' : '');
    el.classList.toggle('stale', !!stale);
    el.hidden = false;
  }

  function daysBetween(isoDate, today) {
    var a = new Date(isoDate + 'T00:00:00').getTime();
    var b = new Date(today + 'T00:00:00').getTime();
    if (!isFinite(a) || !isFinite(b)) return 0;
    return Math.round((b - a) / 86400000);
  }

  // 帶入只寫 stock.currentPrice。紀錄裡的「當時股價」是歷史快照，動了會讓
  // 過去的估值失真，絕對不碰。
  function applyClose(stockId) {
    var stock = Store.findStock(stockId);
    if (!stock) return false;
    var c = Store.closeOf(stock.ticker);
    if (!c) return false;
    Store.updateStock(stock.id, { currentPrice: c.price });
    return true;
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

    html += '<td class="num c-fact" data-label="當時股價">'
      + numWithDelta(rec.price, prev && prev.price, 'pct', fmtNum(rec.price)) + '</td>';
    html += '<td class="num c-fact" data-label="EPS">'
      + numWithDelta(rec.eps, prev && prev.eps, 'pct', fmtNum(rec.eps)) + '</td>';
    html += '<td class="num c-mine" data-label="我估 1-5 年">'
      + numWithDelta(rec.myCagr1_5, prev && prev.myCagr1_5, 'pp',
        rec.myCagr1_5 === null ? '未估' : fmtPct(rec.myCagr1_5)) + '</td>';
    html += '<td class="num c-mine" data-label="6-10 年">' + fmtPct(rec.cagr6_10) + '</td>';
    html += '<td class="num c-market" data-label="市場隱含">'
      + numWithDelta(c.implied, prevCalc && prevCalc.implied, 'pp', impliedHtml(c, rec.eps, rec.price, '當時股價')) + '</td>';
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

  // ---- 隱含總表 ----

  function summaryRows() {
    var st = settings();
    return filteredStocks().map(function (s) {
      var rec = Store.latestRecord(s.id);
      // 數字（EPS、我估、6-10 年、估值日期）來自最新一筆紀錄，
      // 價格來自股票層級的現價——所以「這次只算合理價」的紀錄不會讓整檔消失。
      return { stock: s, rec: rec, calc: rec ? computeRecord(rec, st, s.currentPrice) : null };
    }).filter(function (r) { return !!r.rec; });
  }

  // 分上下半部的唯一判準：有沒有現價。有現價才反推得出市場隱含，
  // 下半部的標題「未填現價」也才永遠是真的。
  function hasPrice(row) { return row.stock.currentPrice > 0; }

  function sumValue(row, key) {
    var s = row.stock, r = row.rec, c = row.calc;
    switch (key) {
      case 'ticker': return s.ticker;
      case 'name': return s.name;
      case 'date': return r.date;
      case 'price': return r.price;              // 當時股價＝那一筆紀錄的
      case 'currentPrice': return s.currentPrice; // 現價＝股票層級的
      case 'eps': return r.eps;
      case 'myCagr1_5': return r.myCagr1_5;
      case 'implied': return c.implied;
      case 'gap': return c.gap;
      case 'fairValue': return c.fairValue;
      case 'upside': return c.upside;
      default: return null;
    }
  }

  // 排序只有一份。先前主表與總表各寫一次，再加第三張表就會是第三份，
  // 任何一處的空值處理改了另外兩處不會跟上。
  function sortBy(rows, state, valueFn) {
    var dir = state.dir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var va = valueFn(a, state.key), vb = valueFn(b, state.key);
      var na = va === null || va === undefined || (typeof va === 'number' && !isFinite(va));
      var nb = vb === null || vb === undefined || (typeof vb === 'number' && !isFinite(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string') return va.localeCompare(vb, 'zh-Hant') * dir;
      return (va - vb) * dir;
    });
  }

  function sortSummary(rows) { sortBy(rows, sumSort, sumValue); }

  // 總表是唯讀顯示：要改就按「編輯」載回計算器。
  // 這裡不渲染 <input>——就地編輯的 change 處理器只綁在 #stockBody，
  // 在這裡放輸入框只會做出一個改了不會存的欄位。
  function cellWith(labels, col, inner, cls) {
    return '<td class="' + (cls || '') + '" data-col="' + col + '" data-label="' + (labels[col] || '') + '">'
      + inner + '</td>';
  }

  function sumCell(col, inner, cls) { return cellWith(SUM_LABELS, col, inner, cls); }
  function aiCell(col, inner, cls) { return cellWith(AI_LABELS, col, inner, cls); }

  var SUM_LABELS = {
    ticker: '代號', name: '名稱', date: '估值日期', price: '當時股價', currentPrice: '現價',
    eps: 'EPS', myCagr1_5: '我估 1-5 年', implied: '市場隱含', gap: '落差', fairValue: '合理價',
    upside: '上漲空間', cagr6_10: '6-10 年', tvShare: '永續佔比', actions: ''
  };

  // AI insight 的標籤。手機卡片的欄位名稱是從這裡來的，必須跟那張表的
  // 表頭一字不差——表頭寫「我估的合理價」、卡片寫「合理價」，看的人會以為是兩個東西。
  var AI_LABELS = (function () {
    var m = {};
    Object.keys(SUM_LABELS).forEach(function (k) { m[k] = SUM_LABELS[k]; });
    m.fairValue = '我估的合理價';
    m.pe = '本益比';
    m.range = '合理區間';
    m.note = '備註';
    m.actions = '';
    return m;
  })();

  function sumActions(rec) {
    return '<button type="button" class="pill" data-edit-rec="' + esc(rec.id) + '" title="載回上方計算器修改">編輯</button>'
      + '<button type="button" class="del" data-del-rec="' + esc(rec.id) + '" title="刪除這一筆紀錄">✕</button>';
  }

  function sumIdCell(s) {
    return sumCell('ticker', starHtml('stock', s) + '<strong>' + esc(s.ticker || '（無代號）') + '</strong>'
      + ' <span class="mkt">' + (s.market === 'US' ? 'US' : 'TW') + '</span>');
  }

  function summaryRowHtml(row) {
    var s = row.stock, r = row.rec, c = row.calc;
    var band = c.impliedStatus === 'ok' ? impliedBand(c.implied) : '';
    var html = '<tr data-sum-stock="' + esc(s.id) + '">';
    html += sumIdCell(s);
    html += sumCell('name', '<span class="ellip" title="' + esc(s.name) + '">' + esc(s.name) + '</span>');
    html += sumCell('date', '<span title="' + esc(r.date) + '">' + esc(shortDate(r.date)) + '</span>');
    html += sumCell('price', fmtNum(r.price), 'num c-fact');
    html += priceCell(s, 'currentPrice', SUM_LABELS.currentPrice, 'c-fact');
    html += sumCell('eps', fmtNum(r.eps), 'num c-fact');
    html += sumCell('myCagr1_5', r.myCagr1_5 === null ? '<span class="na">未估</span>' : fmtPct(r.myCagr1_5), 'num c-mine');
    // 算得出數值才上色。超出可反推範圍的那兩種有填現價、但沒有可比的數值，
    // 硬塞一個顏色的話，圖例的分帶計數就會跟表上的色塊對不起來。
    html += sumCell('implied', c.impliedStatus === 'ok'
      ? '<span class="band-val">' + fmtPct(c.implied) + '</span>'
      : impliedHtml(c, r.eps, s.currentPrice, '現價'),
      'num ' + (band ? 'band ' + band : 'c-market'));
    html += sumCell('gap', gapHtml(c), 'num');
    html += sumCell('fairValue', fmtNum(c.fairValue), 'num c-mine');
    html += sumCell('upside', upsideHtml(c), 'num');
    html += sumCell('actions', sumActions(r), 'sum-actions');
    return html + '</tr>';
  }

  function fairOnlyRowHtml(row) {
    var s = row.stock, r = row.rec, c = row.calc;
    var html = '<tr data-sum-stock="' + esc(s.id) + '">';
    html += sumIdCell(s);
    html += sumCell('name', '<span class="ellip" title="' + esc(s.name) + '">' + esc(s.name) + '</span>');
    html += sumCell('date', '<span title="' + esc(r.date) + '">' + esc(shortDate(r.date)) + '</span>');
    // 這一格就是出路：填上現價，這一列立刻移到上半部，有自己的市場隱含。
    // 這裡的輸入框要看得出來是「請填這裡」，不能跟其他唯讀儲存格長一樣。
    html += priceCell(s, 'currentPrice', SUM_LABELS.currentPrice, 'c-fact', '填現價'); 
    html += sumCell('eps', fmtNum(r.eps), 'num c-fact');
    html += sumCell('myCagr1_5', r.myCagr1_5 === null ? '<span class="na">未估</span>' : fmtPct(r.myCagr1_5), 'num c-mine');
    html += sumCell('cagr6_10', fmtPct(r.cagr6_10), 'num c-mine');
    html += sumCell('fairValue', fmtNum(c.fairValue), 'num c-mine');
    html += sumCell('tvShare', tvHtml(c), 'num c-warn');
    html += sumCell('actions', sumActions(r), 'sum-actions');
    return html + '</tr>';
  }

  function renderSummary() {
    renderCloseBanner();
    var all = summaryRows();
    var withPrice = all.filter(hasPrice);
    var noPrice = all.filter(function (r) { return !hasPrice(r); });

    sortSummary(withPrice);

    $('summaryBody').innerHTML = withPrice.map(function (row) {
      try { return summaryRowHtml(row); }
      catch (err) {
        console.error('總表這一列畫不出來', row.stock, err);
        return '<tr class="row-error"><td colspan="12">這一列畫不出來：' + esc(err.message) + '</td></tr>';
      }
    }).join('');
    $('summaryWrap').hidden = withPrice.length === 0;

    $('fairOnlyBody').innerHTML = noPrice.map(function (row) {
      try { return fairOnlyRowHtml(row); }
      catch (err) {
        console.error('只算合理價這一列畫不出來', row.stock, err);
        return '<tr class="row-error"><td colspan="10">這一列畫不出來：' + esc(err.message) + '</td></tr>';
      }
    }).join('');
    $('fairOnlySection').hidden = noPrice.length === 0;

    // 總表有自己的空狀態，不共用主表的 emptyState / noMatch
    var msg = '';
    if (Store.getState().stocks.length === 0) msg = '還沒有追蹤任何股票。上面算完後按「加入追蹤」。';
    else if (all.length === 0) msg = '沒有符合目前篩選條件的股票。';
    // 第三種：有股票、也通過篩選，但一檔都反推不出隱含。上半部整張表會消失，
    // 不講一句話的話畫面就是「圖例＋一片空白＋下半部」，看起來像壞掉。
    else if (withPrice.length === 0) msg = '這些股票都還沒填現價，反推不出市場隱含。'
      + '在下方表格的「現價」欄填一個價格，那一檔就會跳上來。';
    $('summaryEmpty').textContent = msg;
    $('summaryEmpty').hidden = !msg;

    // 上半部沒東西時，色階圖例沒有對應的表可看，一併收起來。
    $('bandLegend').hidden = withPrice.length === 0;
    renderBandLegend(withPrice);

    document.querySelectorAll('#summaryTable thead th[data-sum-sort]').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.sumSort === sumSort.key);
      th.classList.toggle('asc', th.dataset.sumSort === sumSort.key && sumSort.dir === 'asc');
    });
  }

  // ---- AI insight：獨立的試算沙盒 ----
  //
  // 這一頁跟另外兩頁只有單向關係：真實資料流進來當預設值，這一頁改的東西
  // 絕不流出去。做法是一層 override（Store 的 aiDraft）——只記「你動過的欄位」，
  // 沒動過的照樣跟著追蹤清單走，所以它不會慢慢變成一份越來越舊的副本。
  //
  // 這一頁的輸入框一律用 data-ai-stock / data-ai-field。千萬不要重用
  // priceCell() 或 noteCell()：那兩支發的是 data-stock-field / data-field，
  // 會直接寫進真實股票與真實紀錄——畫面看起來有做，其實整個功能等於沒做。

  var AI_FIELDS = {
    date: '估值日期', currentPrice: '現價', eps: 'EPS', myCagr1_5: '我估 1-5 年',
    cagr6_10: '6-10 年', discountRate: '折現率', perpetualGrowth: '永續成長率', note: '備註'
  };
  var AI_TEXT_FIELD = { date: 'date', note: 'text' };

  function aiRealValue(stock, rec, key) {
    var st = settings();
    switch (key) {
      case 'date': return rec.date;
      case 'currentPrice': return stock.currentPrice;
      case 'eps': return rec.eps;
      case 'myCagr1_5': return rec.myCagr1_5;
      case 'cagr6_10': return rec.cagr6_10;
      case 'discountRate': return st.discountRate;
      case 'perpetualGrowth': return st.perpetualGrowth;
      case 'note': return rec.note || '';
      default: return null;
    }
  }

  function aiShow(key, v) {
    if (v === null || v === undefined || v === '') return '空白';
    if (key === 'date' || key === 'note') return String(v);
    if (key === 'currentPrice' || key === 'eps') return fmtNum(v);
    return fmtPct(v);
  }

  // 疊出這一列實際要用的數字。overridden 記下哪些是你改過的——畫面要標出來，
  // 否則你會分不清眼前這個數字是真的，還是自己剛剛試算填的。
  function aiEffective(stock) {
    var rec = Store.latestRecord(stock.id);
    if (!rec) return null;
    var d = Store.aiDraftOf(stock.id) || {};
    var eff = { stock: stock, rec: rec, overridden: {} };

    Object.keys(AI_FIELDS).forEach(function (k) {
      if (k in d) { eff[k] = d[k]; eff.overridden[k] = true; }
      else { eff[k] = aiRealValue(stock, rec, k); }
    });
    ['rangeLo', 'rangeHi'].forEach(function (k) {
      if (k in d) { eff[k] = d[k]; eff.overridden[k] = true; } else { eff[k] = null; }
    });

    // computeRecord 只讀 eps / myCagr1_5 / cagr6_10 / price，餵一個純物件就行，
    // 那支函式不用為了沙盒改動。
    eff.calc = computeRecord(
      { eps: eff.eps, myCagr1_5: eff.myCagr1_5, cagr6_10: eff.cagr6_10, price: eff.currentPrice },
      { discountRate: eff.discountRate, perpetualGrowth: eff.perpetualGrowth },
      eff.currentPrice);
    eff.pe = peOf(eff.currentPrice, eff.eps);
    return eff;
  }

  // 排序讀的必須是同一份有效值。fallback 回真實值的話，會變成
  // 「畫面顯示沙盒數字、順序依真實數字」——看起來只是排序怪怪的，極難查。
  function aiValue(eff, key) {
    switch (key) {
      case 'ticker': return eff.stock.ticker;
      case 'name': return eff.stock.name;
      case 'date': return eff.date;
      case 'currentPrice': return eff.currentPrice;
      case 'eps': return eff.eps;
      case 'pe': return eff.pe;
      case 'fairValue': return eff.calc.fairValue;
      case 'implied': return eff.calc.implied;
      case 'gap': return eff.calc.gap;
      case 'upside': return eff.calc.upside;
      case 'note': return eff.note || '';
      default: return null;
    }
  }

  function naCell(text) { return '<span class="na">' + esc(text) + '</span>'; }

  function aiInput(eff, field, opts) {
    opts = opts || {};
    var type = AI_TEXT_FIELD[field] || 'number';
    var on = !!eff.overridden[field];
    var hint;
    if (field === 'rangeLo' || field === 'rangeHi') {
      hint = '合理區間是這一頁專屬的，追蹤清單沒有這個欄位。';
    } else {
      hint = on
        ? '已改過。追蹤清單的值是「' + aiShow(field, aiRealValue(eff.stock, eff.rec, field)) + '」，改這裡不會動到它。'
        : '可以直接改，只影響這一頁，不會動到追蹤清單與隱含總表。';
    }
    var v = eff[field];
    var common = ' class="ai-in' + (on ? ' edited' : '') + (opts.cls ? ' ' + opts.cls : '') + '"'
      + ' title="' + esc(hint) + '"'
      + ' data-ai-stock="' + esc(eff.stock.id) + '" data-ai-field="' + field + '"'
      + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '');

    // 備註用 textarea：<input> 永遠不換行，再寬都會有更長的備註把文字推出框外，
    // 所以「不要一直左右移」真正的解是讓它換行，不是加寬。
    //
    // 值的前面一定要多墊一個 '\n'。HTML 解析會丟掉緊接在 <textarea> 起始標籤後
    // 的第一個換行字元，所以「以換行開頭的備註」會掉掉那個換行——實測確認過。
    // 多墊的這個換行就是被丟掉的那一個，值本身因此一字不差。
    if (type === 'text') {
      return '<textarea rows="2"' + common + '>\n'
        + esc(v === null || v === undefined ? '' : v) + '</textarea>';
    }

    return '<input type="' + type + '"'
      + (type === 'number' ? ' step="any" inputmode="decimal"' : '')
      + common
      + ' value="' + (type === 'number' ? inputValue(v) : esc(v === null || v === undefined ? '' : v)) + '">';
  }

  // 唯讀顯示的格子若是覆寫值，也要標出來（例如估值日期，它的輸入框在展開區）
  function aiMark(eff, field, inner) {
    return eff.overridden[field]
      ? '<span class="edited-val" title="' + esc('已改過。追蹤清單的值是「'
          + aiShow(field, aiRealValue(eff.stock, eff.rec, field)) + '」。') + '">' + inner + '</span>'
      : inner;
  }

  // 星號在這一頁是唯讀的：它寫的是真實股票的標記，跟「這一頁改的不外流」衝突。
  function aiStarHtml(stock) {
    var on = stock.starred === true;
    return '<span class="star static' + (on ? ' on' : '') + '" title="'
      + esc(on ? (stock.starNote ? '已標記：' + stock.starNote : '已標記') : '未標記。要標記請到追蹤清單或隱含總表')
      + '">' + (on ? '★' : '☆') + '</span>';
  }

  function aiRangeCell(eff) {
    var lo = eff.rangeLo, hi = eff.rangeHi, p = eff.currentPrice;
    var state = '', why = '填你自己認為合理的價格區間（這一頁專屬）';
    if (lo !== null && hi !== null && p > 0) {
      if (p < lo) { state = 'good'; why = '現價 ' + fmtNum(p) + ' 低於你的區間下限'; }
      else if (p > hi) { state = 'bad'; why = '現價 ' + fmtNum(p) + ' 高於你的區間上限'; }
      else { why = '現價 ' + fmtNum(p) + ' 落在你的區間內'; }
    }
    return '<span class="range-box ' + state + '" title="' + esc(why) + '">'
      + aiInput(eff, 'rangeLo', { placeholder: '下限', cls: 'r' })
      + '<i>–</i>'
      + aiInput(eff, 'rangeHi', { placeholder: '上限', cls: 'r' })
      + '</span>';
  }

  function aiResetBtn(stock) {
    var on = Store.hasAiDraft(stock.id);
    return '<button type="button" class="pill ghost" data-ai-reset="' + esc(stock.id) + '"'
      + (on ? '' : ' disabled')
      + ' title="把這一列的試算值清掉，回到追蹤清單的數字">還原</button>';
  }

  function aiExpandHtml(eff) {
    function field(key, unit) {
      return '<label class="ai-f"><span class="k">' + esc(AI_FIELDS[key]) + '</span>'
        + '<span class="field">' + aiInput(eff, key) + (unit ? '<i>' + unit + '</i>' : '') + '</span>'
        + '<span class="real">追蹤清單：' + esc(aiShow(key, aiRealValue(eff.stock, eff.rec, key))) + '</span>'
        + '</label>';
    }
    // 這一列不帶 data-sum-stock：帶了的話，點展開區裡的空白處會把它自己收起來。
    return '<tr class="ai-expand" data-ai-expand="' + esc(eff.stock.id) + '"><td colspan="13">'
      + '<div class="ai-expand-grid">'
      + field('date') + field('myCagr1_5', '%') + field('cagr6_10', '%')
      + field('discountRate', '%') + field('perpetualGrowth', '%')
      + '</div>'
      + '<p class="hint">這些只影響這一頁的試算。折現率與永續成長率在別頁是所有股票共用的，'
      + '在這裡可以單獨替這一檔換掉，看看換個假設合理價會長怎樣。</p>'
      + '</td></tr>';
  }

  function aiRowHtml(eff) {
    var s = eff.stock, c = eff.calc;
    var band = c.impliedStatus === 'ok' ? impliedBand(c.implied) : '';
    var open = !!aiExpanded[s.id];

    // data-sum-stock 而不是 data-stock：帶 data-stock 的列會被主表的
    // 「點一列＝選取該檔」抓到。
    // 展開區裡改過的欄位，收起來之後主列是看不出來的——合理價跟追蹤清單不一樣
    // 卻沒有任何記號，等於一張會誤導人的表。所以把記號打在那個小箭頭上。
    var hidden = ['date', 'myCagr1_5', 'cagr6_10', 'discountRate', 'perpetualGrowth']
      .filter(function (k) { return eff.overridden[k]; })
      .map(function (k) { return AI_FIELDS[k]; });

    var html = '<tr data-sum-stock="' + esc(s.id) + '"' + (open ? ' class="expanded"' : '') + '>';
    html += aiCell('ticker', aiStarHtml(s) + '<strong>' + esc(s.ticker || '（無代號）') + '</strong>'
      + ' <span class="mkt">' + (s.market === 'US' ? 'US' : 'TW') + '</span>'
      + '<span class="caret' + (hidden.length ? ' edited-val' : '') + '" title="'
      + esc(hidden.length ? '展開區裡改過：' + hidden.join('、') : '點一下展開試算區')
      + '">' + (open ? '▴' : '▾') + '</span>');
    html += aiCell('name', '<span class="ellip" title="' + esc(s.name) + '">' + esc(s.name) + '</span>');
    html += aiCell('date', aiMark(eff, 'date',
      '<span title="' + esc(eff.date || '') + '">' + esc(eff.date ? shortDate(eff.date) : '—') + '</span>'));
    html += aiCell('currentPrice', aiInput(eff, 'currentPrice', { placeholder: '填現價' }), 'num c-fact');
    html += aiCell('eps', aiInput(eff, 'eps', { placeholder: '填 EPS' }), 'num c-fact');
    html += aiCell('pe', eff.pe === null
      ? naCell(peReason(eff.currentPrice, eff.eps)) : fmtNum(eff.pe), 'num c-fact');
    html += aiCell('range', aiRangeCell(eff), 'num c-mine');
    html += aiCell('fairValue', c.fairValue === null
      ? naCell(fairReason(eff.eps, eff.myCagr1_5)) : fmtNum(c.fairValue), 'num c-mine');
    html += aiCell('implied', c.impliedStatus === 'ok'
      ? '<span class="band-val">' + fmtPct(c.implied) + '</span>'
      : naCell(statusMessage(c.impliedStatus, eff.eps, eff.currentPrice, '現價')),
      'num ' + (band ? 'band ' + band : 'c-market'));
    html += aiCell('gap', gapHtml(c), 'num');
    html += aiCell('upside',
      upsideHtml(c, upsideReason(eff.currentPrice, eff.eps, eff.myCagr1_5)), 'num');
    html += aiCell('note', aiInput(eff, 'note', { placeholder: '只存在這一頁' }));
    html += aiCell('actions', aiResetBtn(s), 'sum-actions');
    html += '</tr>';

    if (open) html += aiExpandHtml(eff);
    return html;
  }

  function aiRows() {
    var rows = filteredStocks().map(aiEffective).filter(function (r) { return !!r; });
    sortBy(rows, aiSort, aiValue);
    return rows;
  }

  function renderAi() {
    var rows = aiRows();

    // 展開狀態只保留還在畫面上的，不然刪掉或篩掉的股票會一直累積在這裡
    var alive = {};
    rows.forEach(function (r) { alive[r.stock.id] = true; });
    Object.keys(aiExpanded).forEach(function (id) { if (!alive[id]) delete aiExpanded[id]; });

    $('aiBody').innerHTML = rows.map(function (eff) {
      try { return aiRowHtml(eff); }
      catch (err) {
        console.error('AI insight 這一列畫不出來', eff.stock, err);
        return '<tr class="row-error"><td colspan="13">這一列畫不出來：' + esc(err.message) + '</td></tr>';
      }
    }).join('');

    // 只有「真的一列都沒有」才收表——不是「有些欄位算不出來」就收。
    $('aiWrap').hidden = rows.length === 0;
    $('aiCopy').disabled = rows.length === 0;
    $('aiResetAll').disabled = Store.countAiDrafts() === 0;

    var msg = '';
    if (Store.getState().stocks.length === 0) msg = '還沒有追蹤任何股票。上面算完後按「加入追蹤」。';
    else if (rows.length === 0) msg = '沒有符合目前篩選條件的股票。';
    $('aiEmpty').textContent = msg;
    $('aiEmpty').hidden = !msg;

    document.querySelectorAll('#aiTable thead th[data-ai-sort]').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.aiSort === aiSort.key);
      th.classList.toggle('asc', th.dataset.aiSort === aiSort.key && aiSort.dir === 'asc');
    });
  }

  // ---- 沙盒的寫入 ----

  function applyAiEdit(inp) {
    var id = inp.dataset.aiStock;
    var field = inp.dataset.aiField;
    var eff = null;
    var stock = Store.findStock(id);
    if (!stock) return false;
    eff = aiEffective(stock);
    if (!eff) return false;

    var isText = !!AI_TEXT_FIELD[field];
    var v = isText ? String(inp.value) : numOrNull(inp.value);

    if (!isText && v !== null) {
      if ((field === 'currentPrice' || field === 'eps' || field === 'rangeLo' || field === 'rangeHi') && v <= 0) {
        rejectEdit(inp, eff[field], (AI_FIELDS[field] || '這個數字') + '要大於 0；不想填就清空。');
        return false;
      }
      // 折現率必須大於永續成長率，否則永續價值公式會算出無限大或負數。
      var dr = field === 'discountRate' ? v : eff.discountRate;
      var pg = field === 'perpetualGrowth' ? v : eff.perpetualGrowth;
      if ((field === 'discountRate' || field === 'perpetualGrowth') && !(dr > pg)) {
        rejectEdit(inp, eff[field], '折現率（' + dr + '%）必須大於永續成長率（' + pg + '%）。');
        return false;
      }
      var lo = field === 'rangeLo' ? v : eff.rangeLo;
      var hi = field === 'rangeHi' ? v : eff.rangeHi;
      if ((field === 'rangeLo' || field === 'rangeHi') && lo !== null && hi !== null && !(lo < hi)) {
        rejectEdit(inp, eff[field], '區間下限（' + lo + '）要小於上限（' + hi + '）。');
        return false;
      }
    }

    // 只寫沙盒。這裡絕對不能出現 updateStock / updateRecord。
    Store.setAiDraftField(id, field, isText && v === '' ? null : v);
    return true;
  }

  function toggleAiExpand(stockId) {
    if (aiExpanded[stockId]) { delete aiExpanded[stockId]; } else { aiExpanded[stockId] = true; }
    renderAi();
  }

  // ---- 複製給 AI ----

  // Markdown 表格的欄位分隔是 |，備註裡出現 | 會把整列切歪。
  // 備註改成 textarea 之後可以含換行，換行會把 Markdown 表格切成兩列，一併折成空白。
  function mdCell(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/\s*\r?\n\s*/g, ' ')
      .replace(/\|/g, '\\|');
  }

  var AI_COPY_HEAD = ['代號', '名稱', '估值日期', '現價', 'EPS', '本益比', '我的合理區間',
    '我估的合理價', '市場隱含', '落差', '上漲空間', '我估 1-5 年', '6-10 年',
    '折現率', '永續成長率', '備註'];

  function aiCopyValues(eff) {
    var c = eff.calc;
    var range = (eff.rangeLo === null && eff.rangeHi === null) ? '未填'
      : (eff.rangeLo === null ? '？' : fmtNum(eff.rangeLo)) + '–'
        + (eff.rangeHi === null ? '？' : fmtNum(eff.rangeHi));
    return [
      eff.stock.ticker || '（無代號）',
      eff.stock.name || '',
      eff.date || '未填',
      eff.currentPrice > 0 ? fmtNum(eff.currentPrice) : '未填現價',
      eff.eps === null ? '未填 EPS' : fmtNum(eff.eps),
      eff.pe === null ? peReason(eff.currentPrice, eff.eps) : fmtNum(eff.pe),
      range,
      c.fairValue === null ? fairReason(eff.eps, eff.myCagr1_5) : fmtNum(c.fairValue),
      c.impliedStatus === 'ok' ? fmtPct(c.implied)
        : statusMessage(c.impliedStatus, eff.eps, eff.currentPrice, '現價'),
      c.gap === null ? '算不出來' : fmtSigned(c.gap, 2, 'pp'),
      c.upside === null ? upsideReason(eff.currentPrice, eff.eps, eff.myCagr1_5)
        : fmtSigned(c.upside, 1, '%'),
      eff.myCagr1_5 === null ? '未估' : fmtPct(eff.myCagr1_5),
      fmtPct(eff.cagr6_10),
      fmtPct(eff.discountRate),
      fmtPct(eff.perpetualGrowth),
      eff.note || ''
    ];
  }

  // 多帶「我估 1-5 年／6-10 年」與逐列的折現率、永續成長率：少了它們，
  // AI 看到一個「合理價」根本無從判斷它是怎麼算出來的。折現率與永續成長率
  // 現在可以單檔覆寫，所以必須逐列列出，不能再寫一句「共用假設」。
  function aiClipboardText(rows) {
    var edited = rows.filter(function (r) { return Store.hasAiDraft(r.stock.id); }).length;
    var out = [];
    out.push('# 我的股票估值表（' + Store.today() + '）');
    out.push('');
    if (edited) {
      out.push('> 注意：以下有 ' + edited + ' 檔的數字是我在試算頁調整過的，不等於我追蹤清單裡的原始紀錄。');
      out.push('');
    }
    out.push('估值模型：EPS 兩段式折現。第 1-5 年用「我估 1-5 年」的成長率，第 6-10 年用「6-10 年」的成長率，'
      + '第 10 年之後以永續成長率延續，全部折現回現值。每一檔實際用的折現率與永續成長率列在表內。');
    out.push('市場隱含＝用現價反推出「市場正在假設的 1-5 年成長率」。落差＝市場隱含 − 我估 1-5 年，負值代表市場的要求比我低。');
    out.push('本益比＝現價 ÷ EPS，EPS 是我自己填的，可能是預估值。「我的合理區間」是我自己判斷的價格區間，不是算出來的。');
    out.push('欄位若寫著「未填現價」「未估 1-5 年」等字樣，代表那個數字算不出來，不要當成 0。');
    out.push('');
    out.push('| ' + AI_COPY_HEAD.join(' | ') + ' |');
    out.push('|' + AI_COPY_HEAD.map(function () { return '---'; }).join('|') + '|');
    rows.forEach(function (eff) {
      out.push('| ' + aiCopyValues(eff).map(mdCell).join(' | ') + ' |');
    });
    out.push('');
    out.push('以上 ' + rows.length + ' 檔'
      + (filtersActive() ? '（已套用我目前的篩選，不是全部持股）' : '') + '。');
    return out.join('\n');
  }

  function flashCopyMsg(text) {
    var el = $('aiCopyMsg');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(el.dataset.t);
    el.dataset.t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function showCopyFallback(text) {
    $('aiCopyText').value = text;
    $('aiCopyModal').hidden = false;
    $('aiCopyText').focus();
    $('aiCopyText').select();
  }

  function copyForAi() {
    var rows = aiRows();
    if (!rows.length) return;
    var text = aiClipboardText(rows);
    var ok = function () { flashCopyMsg('已複製 ' + rows.length + ' 檔，貼到 AI 對話就能直接問'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { showCopyFallback(text); });
    } else {
      showCopyFallback(text);
    }
  }

  // 圖例的文字一定要從設定長出來，不能寫死在 HTML——界線改了圖例沒跟著改，
  // 就會變成一張說謊的對照表。
  function renderBandLegend(rows) {
    var bands = bandBounds();
    $('editBands').hidden = !bandsEditable();
    $('bandChips').innerHTML = bandChipsHtml(bands, countByBand(rows, bands));
  }

  // 目前畫面上這些股票各落在哪一帶。跟著篩選走，因為使用者問的是
  // 「這組界線套在我現在看的這幾檔上長怎樣」。
  function countByBand(rows, bands) {
    var counts = [];
    for (var i = 0; i <= bands.length; i++) counts.push(0);
    rows.forEach(function (row) {
      var b = bandOf(row.calc.implied, bands);
      if (!b) return;
      counts[parseInt(b.slice(1), 10) - 1]++;
    });
    return counts;
  }

  // ---- 分帶界線編輯器 ----

  function readBandInputs() {
    return [1, 2, 3, 4].map(function (i) { return numOrNull($('bound' + i).value); });
  }

  function fillBandInputs(bands) {
    bands.forEach(function (v, i) { $('bound' + (i + 1)).value = v; });
  }

  function openBandsModal() {
    fillBandInputs(bandBounds());
    recalcBands();
    $('bandsModal').hidden = false;
    $('bound1').focus();
  }

  // 預覽用現在輸入框裡的值，不是已存的值——不然改到一半看到的是舊的分佈，
  // 等於沒有預覽。
  function recalcBands() {
    var raw = readBandInputs();
    var err = Store.bandsError(raw);
    $('bandsError').textContent = err || '';
    $('bandsError').hidden = !err;
    $('bandsApply').disabled = !!err;

    var bands = err ? bandBounds() : raw;
    var rows = summaryRows().filter(function (r) { return r.calc.impliedStatus === 'ok'; });
    $('bandsPreview').innerHTML = bandChipsHtml(bands, countByBand(rows, bands));
    $('bandsPreviewNote').textContent = err
      ? '先把上面修好，這裡才會顯示新界線的分佈。'
      : '括號裡是目前畫面上這 ' + rows.length + ' 檔各自落在哪一帶'
        + (filtersActive() ? '（已套用你現在的篩選）' : '') + '。';
  }

  function applyBands() {
    var res = Store.updateSettings({ bands: readBandInputs() });
    if (!res.ok) {
      $('bandsError').textContent = res.error;
      $('bandsError').hidden = false;
      return;
    }
    closeAllModals();
    render();
  }

  // 分頁清單從 DOM 長出來（.tabs 裡的 data-tab 與 data-view），不寫死在程式裡：
  // 寫死就要記得同時改 setTab 與方向鍵那兩份清單，漏一邊就是切不過去。
  function tabButtons() {
    return [].slice.call(document.querySelectorAll('.tabs .tab[data-tab]'));
  }

  function setTab(name) {
    var btns = tabButtons();
    var target = null;
    btns.forEach(function (b) { if (b.dataset.tab === name) target = b; });
    // 認不得就回第一個分頁。localStorage 的 iv-tab 可能留著舊版或壞掉的值，
    // 查不到對應的 view 卻照樣把每一個都藏起來，畫面就是全白——
    // 這個專案已經為白畫面付出過代價，一般化不能把這道保險拆掉。
    if (!target) target = btns[0];
    if (!target) return;

    activeTab = target.dataset.tab;
    btns.forEach(function (b) {
      var on = b === target;
      var view = $(b.dataset.view);
      if (view) view.hidden = !on;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    try { localStorage.setItem('iv-tab', activeTab); } catch (e) {}
    render();
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
    // 一筆紀錄只要算得出「市場隱含」或「合理價」其中之一就有價值：
    //   市場隱含 需要 股價 > 0 且 EPS > 0
    //   合理價   需要 EPS > 0 且 填了我估的 1-5 年成長率
    // 所以股價是可以留空的——那就是「只用自己的假設算合理價」。
    // 要擋的只有「打了一個不合理的股價」與「兩邊都算不出來」。
    if (v.eps === null || v.eps <= 0) {
      showAddMsg('請填 EPS（要大於 0），這是所有計算的起點。', true);
      $('calcEps').focus();
      return;
    }
    if (v.price !== null && v.price <= 0) {
      showAddMsg('股價要大於 0。如果你只是要算合理價，把股價留空即可。', true);
      $('calcPrice').focus();
      return;
    }
    if (v.price === null && v.g15 === null) {
      showAddMsg('股價和 1-5 年成長率至少要填一個：填股價會反推市場隱含值，填成長率會算出合理價。', true);
      $('calcPrice').focus();
      return;
    }

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
          price: v.price,      // 可為 null
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
      tags: $('newTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      // 這次估值填的股價就是你剛查到的現價；留空則不動原本的現價。
      currentPrice: v.price
    });

    Store.addRecord(stock.id, {
      date: $('newDate').value || Store.today(),
      label: $('newLabel').value,
      price: v.price,          // 可為 null＝這一筆沒有記股價
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

    // 不在「追蹤清單」分頁時，那一列在隱藏容器裡，getBoundingClientRect() 全是 0，
    // scrollRowIntoView() 會去捲一個同樣隱藏的 #mainTableWrap——畫面莫名其妙跳一下，
    // 使用者還以為按壞了。
    var tr = activeTab === 'list'
      ? $('stockBody').querySelector('tr[data-stock="' + stock.id + '"]')
      : null;
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
      $('mainTableWrap').scrollIntoView({ block: 'center' });
    }
  }

  // ---- 事件 ----

  // 還原成原值並把原因寫在 title 上。原本的提示要還回去——
  // 不還的話那一格的說明就被錯誤訊息永久蓋掉了。
  function rejectEdit(inp, value, why) {
    var prev = inp.title;
    inp.value = inputValue(value);
    inp.classList.add('rejected');
    inp.title = why;
    setTimeout(function () { inp.classList.remove('rejected'); inp.title = prev; }, 1600);
  }

  // 現價改的是股票，不是紀錄——任何一張表上的現價格都走這裡。
  function applyStockEdit(inp) {
    var stock = Store.findStock(inp.dataset.stockId);
    if (!stock) return null;
    var nv = numOrNull(inp.value);
    if (nv !== null && nv <= 0) {
      rejectEdit(inp, stock.currentPrice, '現價要大於 0；沒有價可填就清空，那一檔只會算得出合理價');
      return null;
    }
    Store.updateStock(stock.id, { currentPrice: nv });
    return Store.findStock(stock.id);
  }

  function applyEdit(inp) {
    var field = inp.dataset.field;
    var rec = Store.findRecord(inp.dataset.rec);
    if (!rec) return null;

    var patch = {};
    // 這兩個欄位清空是有意義的：我估＝未估、股價＝這一筆沒記股價（只算合理價）。
    if (field === 'myCagr1_5' || field === 'price') {
      var nv = numOrNull(inp.value);
      if (nv !== null && field === 'price' && nv <= 0) {
        rejectEdit(inp, rec[field], '股價要大於 0；只算合理價的話把它清空即可');
        return null;
      }
      patch[field] = nv;
    } else {
      var v = numOrNull(inp.value);
      if (v === null || (field === 'eps' && v <= 0)) {
        rejectEdit(inp, rec[field], field === 'eps' ? 'EPS 必須大於 0' : '請輸入數字');
        return null;
      }
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

    // 所有列層級的互動都委派在 .shell 上——星號、編輯、刪除紀錄、刪除整檔、
    // 點列選取。先前這些散在 #stockBody 與 #recordBody 兩個容器，而且星號的
    // 邏輯是兩份重複的；新增一張表就會得到一堆「按了沒反應」的按鈕。
    document.querySelector('.shell').addEventListener('click', function (e) {
      var star = e.target.closest('[data-star]');
      if (star) {
        e.stopPropagation();
        var item = Store.toggleStar(star.dataset.star, star.dataset.starId);
        render();
        // 剛標起來的紀錄，就地問一句原因（股票層的原因在分頁表標頭編輯）
        if (item && item.starred && star.dataset.star === 'record'
            && $('recordBody').querySelector('tr[data-rec-row="' + star.dataset.starId + '"]')) {
          openStarNoteInput(star.dataset.starId);
        }
        return;
      }

      var ed = e.target.closest('[data-edit-rec]');
      if (ed) { e.stopPropagation(); enterEdit(ed.dataset.editRec); return; }

      var delRec = e.target.closest('[data-del-rec]');
      if (delRec) {
        e.stopPropagation();
        var rec = Store.findRecord(delRec.dataset.delRec);
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
        return;
      }

      var delStock = e.target.closest('[data-del-stock]');
      if (delStock) {
        e.stopPropagation();
        var st2 = Store.findStock(delStock.dataset.delStock);
        if (!st2) return;
        var n = Store.countOf(st2.id);
        if (!confirm('刪除 ' + (st2.ticker || '這一檔') + '？連同它的 ' + n + ' 筆紀錄都會一起刪掉。')) return;
        exitEdit();
        Store.removeStock(st2.id);
        if (selectedStockId === st2.id) selectedStockId = null;
        render();
        return;
      }

      var aiReset = e.target.closest('[data-ai-reset]');
      if (aiReset) {
        e.stopPropagation();
        Store.clearAiDraft(aiReset.dataset.aiReset);
        renderAi();
        return;
      }

      // AI 試算頁：點一列展開／收合試算區。要排在下面那句提早 return 之前，
      // 否則點在儲存格上也會被它攔掉。展開列不帶 data-sum-stock，所以
      // 點展開區裡的空白處不會把它自己收起來。
      if (!e.target.closest('input, textarea, button, label, a')) {
        var aiTr = e.target.closest('#aiBody tr[data-sum-stock]');
        if (aiTr) { toggleAiExpand(aiTr.dataset.sumStock); return; }
      }

      // 昨收帶入。要整表重繪：帶了現價之後，那一列會從下半部「只算得出合理價」
      // 跳到上半部的隱含總表，只刷一格會讓它留在錯的表裡。既有的 currentPrice
      // 編輯分支也是這樣處理的。
      var applyOne = e.target.closest('[data-close-apply]');
      if (applyOne) {
        if (applyClose(applyOne.dataset.closeApply)) render();
        return;
      }
      if (e.target.id === 'closeApplyAll') {
        var n = 0;
        Store.getState().stocks.forEach(function (st) { if (applyClose(st.id)) n++; });
        if (n) render();
        return;
      }

      // 點主表的列＝選取該檔（總表的列不帶 data-stock，所以不會誤觸）
      if (e.target.closest('input, textarea, button')) return;
      var tr = e.target.closest('#stockBody tr[data-stock]');
      if (tr) selectStock(tr.dataset.stock);
    });

    // 就地編輯。跟上面的 click 一樣委派在 .shell：綁在 #stockBody 的話，
    // 總表裡的輸入框會變成「改了不會存」的死欄位。
    document.querySelector('.shell').addEventListener('change', function (e) {
      var inp = e.target;
      if (!inp.dataset) return;

      // AI 試算頁。必須排在另外兩條之前，而且那一頁的輸入框絕對不帶
      // data-stock-field / data-field——帶了就會掉進寫真實資料的分支。
      if (inp.dataset.aiField) {
        if (applyAiEdit(inp)) renderAi();
        renderStorageWarning();
        return;
      }

      var inMain = !!inp.closest('#stockBody');

      if (inp.dataset.stockField === 'currentPrice') {
        var stock = applyStockEdit(inp);
        if (!stock) return;
        if (inMain) {
          // 主表只刷那一列：整表重建會把焦點與手機卡片的展開狀態弄丟。
          var mrec = Store.latestRecord(stock.id);
          if (mrec) refreshMainRow(inp.closest('tr'), mrec, stock);
          renderSummary();
          renderAi();
        } else {
          // 總表：填了現價那一列會從下半部移到上半部，只刷一格不夠。
          render();
        }
        renderStorageWarning();
        return;
      }

      if (!inp.dataset.field) return;
      var rec = applyEdit(inp);
      if (!rec) return;
      if (inMain) refreshMainRow(inp.closest('tr'), rec, Store.findStock(rec.stockId));
      renderDetail();
      renderSummary();        // 改 EPS 會連帶改總表，先前漏了這一句
      renderAi();
      renderStorageWarning();
    });

    $('cancelEdit').addEventListener('click', function () { exitEdit(); recalcCalculator(); });

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

    var tabBtns = tabButtons();
    tabBtns.forEach(function (btn, i) {
      btn.addEventListener('click', function () { setTab(btn.dataset.tab); });
      btn.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        var next = tabBtns[(i + (e.key === 'ArrowRight' ? 1 : tabBtns.length - 1)) % tabBtns.length];
        setTab(next.dataset.tab);
        next.focus();
      });
    });

    document.querySelectorAll('#summaryTable thead th[data-sum-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sumSort;
        if (sumSort.key === key) { sumSort.dir = sumSort.dir === 'asc' ? 'desc' : 'asc'; }
        else { sumSort.key = key; sumSort.dir = 'asc'; }
        renderSummary();
      });
    });

    document.querySelectorAll('#aiTable thead th[data-ai-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.aiSort;
        if (aiSort.key === key) { aiSort.dir = aiSort.dir === 'asc' ? 'desc' : 'asc'; }
        else { aiSort.key = key; aiSort.dir = 'asc'; }
        renderAi();
      });
    });

    $('aiCopy').addEventListener('click', copyForAi);

    $('aiResetAll').addEventListener('click', function () {
      var n = Store.countAiDrafts();
      if (!n) return;
      if (!confirm('把 ' + n + ' 檔的試算值全部清掉，回到追蹤清單的數字？這不會動到你的真實資料。')) return;
      Store.clearAllAiDrafts();
      renderAi();
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

    $('editBands').addEventListener('click', openBandsModal);
    $('bandsReset').addEventListener('click', function () {
      fillBandInputs(Store.DEFAULT_BANDS || BAND_FALLBACK);
      recalcBands();
    });
    ['bound1', 'bound2', 'bound3', 'bound4'].forEach(function (id) {
      $(id).addEventListener('input', recalcBands);
    });
    $('bandsApply').addEventListener('click', applyBands);

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
      blockerSnoozed = false;
      renderBackupBlocker();
    });

    $('syncBtn').addEventListener('click', openSync);
    $('syncPush').addEventListener('click', function () { doPush(); });
    $('syncPull').addEventListener('click', doPull);
    $('syncGistId').addEventListener('change', saveSyncConfig);
    $('syncToken').addEventListener('change', saveSyncConfig);
    $('syncUndo').addEventListener('click', function () {
      if (!confirm('把資料還原成上一次「取代」之前的狀態？這一步沒有再上一層的還原。')) return;
      if (Store.undoReplace()) { afterDataSwap(); syncMsg('已還原。'); }
      else { syncMsg('沒有可還原的快照。', true); }
    });

    $('importMerge').addEventListener('click', runImportMerge);
    $('importReplace').addEventListener('click', runImportReplace);

    // 擋版的三顆鈕。它不是 .modal，所以 Esc 與點背景都關不掉它——這是刻意的。
    $('blockerPush').addEventListener('click', function () {
      $('backupBlocker').hidden = true;
      openSync();
      doPush();
    });
    // 這顆可能跑在手機上，所以走 shareJson（系統分享面板，不支援才退到下載）。
    // iOS 主畫面 app 裡的 <a download> 常常沒反應——擋版叫人備份卻按了沒事發生，
    // 是這個功能最糟的失敗方式。
    $('blockerExport').addEventListener('click', function () {
      Store.shareJson().then(function (r) {
        renderExportNudge();
        if (r && r.cancelled) return;        // 他自己取消，擋版留著
        blockerSnoozed = true;
        renderBackupBlocker();
      });
    });
    $('blockerLater').addEventListener('click', function () {
      blockerSnoozed = true;      // 只壓到這次重新載入為止，不寫進儲存
      renderBackupBlocker();
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

        askImportMode(data);
      };
      reader.readAsText(file);
      this.value = '';
    });
  }

  // ---- 輔助計算機 ----

  // 掃 .modal 而不是列 id：先前是一份寫死的清單，新增一個模態忘了加進去，
  // Esc 與點背景就關不掉它。
  function closeAllModals() {
    document.querySelectorAll('.modal').forEach(function (m) { m.hidden = true; });
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
        'background:#351a19;color:#ff8d84;border-bottom:2px solid #ff8d84;');
      b.innerHTML = '<strong>網頁沒能正常啟動。</strong><span id="fatalDetail"></span>';
      var btn = document.createElement('button');
      btn.id = 'fatalReset';
      btn.type = 'button';
      btn.textContent = '清除快取並重新載入';
      btn.setAttribute('style',
        'background:#ff8d84;color:#1a0f0e;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit;');
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
    renderEnvTag();
    renderFreshTag();
    $('calcG610').value = settings().defaultCagr6_10;   // 只在載入時種一次
    $('newDate').value = Store.today();
    bind();
    recalcCalculator();
    var saved = 'list';
    try { saved = localStorage.getItem('iv-tab') || 'list'; } catch (e) {}
    setTab(saved);                 // setTab 內部會呼叫 render()
    renderBackupBlocker();         // 要在資料載入與 render 之後才算得準
    // 昨收是加分項不是相依項：載入失敗（離線、檔案還沒產生、404）就當沒有這個功能，
    // 不跳錯也不影響任何既有畫面。所以放最後而且不擋啟動。
    Store.loadCloses().then(function () { render(); });
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', function () {
    try { init(); }
    catch (err) { console.error(err); showFatal(err); }
  });
})();
