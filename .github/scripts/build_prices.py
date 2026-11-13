#!/usr/bin/env python3
"""把證交所（上市）與櫃買（上櫃）的每日收盤合併成 docs/prices.json。

為什麼要在這裡抓而不是讓網頁抓：兩個官方 API 都沒有 Access-Control-Allow-Origin，
瀏覽器直接 fetch 一律是 TypeError: Failed to fetch（實測過）。

輸出格式刻意壓到最小：{"代號": ["名稱", 收盤價, "西元日期"]}
"""
import json, sys, urllib.request

SOURCES = [
    # (名稱, 網址, 代號欄, 名稱欄, 收盤欄)
    ("TWSE", "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
     "Code", "Name", "ClosingPrice"),
    ("TPEx", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes",
     "SecuritiesCompanyCode", "CompanyName", "Close"),
]

# 少於這個數就當成 API 回了殘缺資料。實測 TWSE 約 1389 筆、TPEx 約 1020 筆。
MIN_ROWS = 500
OUT = "docs/prices.json"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "implied-valuation-bot"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def roc_to_ad(d):
    """民國 1151112 → 2026-11-12。"""
    d = str(d).strip()
    if len(d) != 7 or not d.isdigit():
        raise ValueError("看不懂的日期格式: %r" % d)
    return "%04d-%s-%s" % (int(d[:3]) + 1911, d[3:5], d[5:7])


def price_or_none(v):
    """收盤價可能是空字串（TWSE）或 '----'（TPEx，當天沒成交）。
    這兩種每天的筆數都不一樣，所以不靠固定筆數判斷，一律 parse 不出正數就跳過。"""
    try:
        f = float(str(v).strip().replace(",", ""))
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def build(sources):
    """sources 是 [(名稱, rows, code_k, name_k, close_k)]。純轉換，不碰網路，方便測。"""
    out, dates, skipped = {}, {}, 0
    for name, rows, code_k, name_k, close_k in sources:
        if not isinstance(rows, list) or len(rows) < MIN_ROWS:
            raise SystemExit("%s 只回了 %s 筆，低於下限 %d，視為異常，中止不寫檔"
                             % (name, len(rows) if isinstance(rows, list) else "非陣列", MIN_ROWS))
        kept = 0
        for r in rows:
            code = str(r.get(code_k, "")).strip()
            px = price_or_none(r.get(close_k))
            if not code or px is None:
                skipped += 1
                continue
            day = roc_to_ad(r.get("Date"))
            out[code] = [str(r.get(name_k, "")).strip(), round(px, 2), day]
            dates.setdefault(name, set()).add(day)
            kept += 1
        print("%s: %d 筆可用、%d 筆跳過，日期 %s"
              % (name, kept, len(rows) - kept, sorted(dates.get(name, []))))

    if len(out) < MIN_ROWS * 2:
        raise SystemExit("合併後只有 %d 檔，視為異常，中止不寫檔" % len(out))
    return out, skipped


def main():
    # 關鍵：全部抓完、全部驗過才寫檔。只要有一邊失敗就整個中止——
    # 不然寫出去的檔案會少掉半個市場的條目，而那是安靜地不見，
    # 隔天又自己回來，事後幾乎查不出來。
    fetched = [(name, fetch(url), c, n, p) for name, url, c, n, p in SOURCES]
    out, skipped = build(fetched)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("寫出 %s：%d 檔、共跳過 %d 筆無效收盤價" % (OUT, len(out), skipped))


if __name__ == "__main__":
    main()
