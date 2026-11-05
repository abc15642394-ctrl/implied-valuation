// 純計算層：不碰 DOM。所有成長率、折現率以小數傳入（0.15 = 15%）。
// 數學沿用原 Chrome 擴充套件 popup.js 的兩段式 EPS 折現模型。
(function (global) {
  'use strict';

  var PHASE1_END = 5;    // 1-5 年用 cagr1_5
  var PHASE2_END = 10;   // 6-10 年用 cagr6_10，第 10 年末接永續
  var CAGR_MIN = -0.9;   // 反推下界（原版 -0.5 會擋到便宜股，見計畫稽核第 2 點）
  var CAGR_MAX = 3.0;    // 反推上界
  var BISECT_ITERATIONS = 50;
  var PRICE_TOLERANCE = 0.01;

  // 把估值拆成「前 10 年現值」與「永續價值現值」，好讓 UI 顯示永續佔比。
  function dcfParts(eps, cagr1_5, cagr6_10, dr, pg) {
    var explicit = 0;
    var e = eps;
    var i;

    for (i = 1; i <= PHASE1_END; i++) {
      e *= (1 + cagr1_5);
      explicit += e / Math.pow(1 + dr, i);
    }
    for (i = PHASE1_END + 1; i <= PHASE2_END; i++) {
      e *= (1 + cagr6_10);
      explicit += e / Math.pow(1 + dr, i);
    }

    var terminal = ((e * (1 + pg)) / (dr - pg)) / Math.pow(1 + dr, PHASE2_END);
    return { explicit: explicit, terminal: terminal, total: explicit + terminal };
  }

  function dcfPrice(eps, cagr1_5, cagr6_10, dr, pg) {
    return dcfParts(eps, cagr1_5, cagr6_10, dr, pg).total;
  }

  // 反推市場隱含的 1-5 年成長率。
  // 回傳 { cagr, status }，status 為 'ok' | 'above' | 'below' | 'invalid'。
  // EPS <= 0 時股價對成長率是遞減的，二分搜尋的方向假設會反過來並靜默算出
  // 看似正常的假數字，所以直接擋掉（計畫稽核第 3 點）。
  function impliedCagr1_5(price, eps, cagr6_10, dr, pg) {
    if (!isFinite(price) || !isFinite(eps) || price <= 0 || eps <= 0) {
      return { cagr: null, status: 'invalid' };
    }
    if (!(dr > pg)) {
      return { cagr: null, status: 'invalid' };
    }

    var floorPrice = dcfPrice(eps, CAGR_MIN, cagr6_10, dr, pg);
    var ceilPrice = dcfPrice(eps, CAGR_MAX, cagr6_10, dr, pg);

    if (price < floorPrice) return { cagr: CAGR_MIN, status: 'below' };
    if (price > ceilPrice) return { cagr: CAGR_MAX, status: 'above' };

    var lo = CAGR_MIN;
    var hi = CAGR_MAX;
    var mid = 0;

    for (var n = 0; n < BISECT_ITERATIONS; n++) {
      mid = (lo + hi) / 2;
      var p = dcfPrice(eps, mid, cagr6_10, dr, pg);
      if (Math.abs(p - price) < PRICE_TOLERANCE) {
        return { cagr: mid, status: 'ok' };
      }
      if (p < price) { lo = mid; } else { hi = mid; }
    }

    // 已確認 50 次迭代在可達區間內必收斂；走到這裡只可能是極端量級，
    // 仍回傳收斂值而非報錯。
    return { cagr: (lo + hi) / 2, status: 'ok' };
  }

  // 逐年成長率 → 平均 CAGR。rates 為小數陣列。
  function cagrFromRates(rates) {
    if (!rates.length) return null;
    var product = 1;
    for (var i = 0; i < rates.length; i++) {
      if (!isFinite(rates[i])) return null;
      product *= (1 + rates[i]);
    }
    if (product <= 0) return null;
    return Math.pow(product, 1 / rates.length) - 1;
  }

  // 期初期末 → CAGR。
  function cagrFromEndpoints(startValue, endValue, years) {
    if (!isFinite(startValue) || !isFinite(endValue) || !isFinite(years)) return null;
    if (startValue <= 0 || endValue <= 0 || years <= 0) return null;
    return Math.pow(endValue / startValue, 1 / years) - 1;
  }

  global.Valuation = {
    CAGR_MIN: CAGR_MIN,
    CAGR_MAX: CAGR_MAX,
    dcfParts: dcfParts,
    dcfPrice: dcfPrice,
    impliedCagr1_5: impliedCagr1_5,
    cagrFromRates: cagrFromRates,
    cagrFromEndpoints: cagrFromEndpoints
  };
})(window);
