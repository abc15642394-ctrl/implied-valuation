#!/usr/bin/env python3
"""把證交所（上市）與櫃買（上櫃）的每日收盤合併成 docs/prices.json。

為什麼要在這裡抓而不是讓網頁抓：兩個官方 API 都沒有 Access-Control-Allow-Origin，
瀏覽器直接 fetch 一律是 TypeError: Failed to fetch（實測過）。

輸出格式刻意壓到最小：{"代號": ["名稱", 收盤價, "西元日期"]}
"""
import datetime, json, urllib.request

SOURCES = [
    # (名稱, 網址, 代號欄, 名稱欄, 收盤欄)
    ("TWSE", "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
     "Code", "Name", "ClosingPrice"),
    ("TPEx", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes",
     "SecuritiesCompanyCode", "CompanyName", "Close"),
]

# 每個來源的下限。**不要用一個共用的鬆數字。**
# 先前兩邊共用 MIN_ROWS = 500，而實測 TWSE 約 1389 筆、TPEx 約 1020 筆——
# 500 只有 TWSE 的 36%，所以某一邊只回 600 筆（少了 57%）照樣過關、照樣寫檔，
# 而那正是這支腳本的 docstring 說要防的「安靜地少掉半個市場」。
# 取各來源實測值的七成左右。
MIN_ROWS = {"TWSE": 950, "TPEx": 700}
DEFAULT_MIN_ROWS = 500          # 將來多一個來源時的保守預設

# 合併後跟上一版比：少於這個比例就視為異常。
# 絕對下限擋得住「幾乎什麼都沒回來」，擋不住「少了三成」——而後者一樣是安靜的。
SHRINK_TOLERANCE = 0.8

# 最新的收盤日期距今超過這麼多天，就視為資料源凍結。
#
# 為什麼需要這一條：如果 TWSE 哪天一直回同一天的舊資料，build() 會成功、
# 「內容沒變就不 commit」會跳過、Actions 全綠——**沒有 commit、沒有通知、
# 沒有錯誤信**。唯一的線索是 app 橫幅五天後變色。而對一個設計成「只在有事時
# 才響」的系統來說，資料源凍結跟市場平靜長得一模一樣。
# 10 天足以涵蓋連假，又遠短於他自己會察覺的時間。
MAX_STALE_DAYS = 10

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


def date_or_none(v):
    """日期解不出來就回 None，**不要讓整天的收盤價因為一列壞資料而消失**。

    先前這裡是直接 raise：1389 列裡有一列的 Date 怪怪的，整個 job 就失敗、
    收到一封錯誤信、而且 prices.json 一整天不更新。而同一支腳本對「壞掉的收盤價」
    是跳過那一列並計數（見 price_or_none）——同一類問題（來源給了一列壞資料）
    兩種待遇，而嚴格的那一種代價大得多。

    這不會弱化「不寫出半個市場」的保證：如果是整個格式變了（所有列都解不出來），
    全部跳過之後筆數會撞上來源的下限而中止，來源層的硬失敗一條都沒動。
    """
    try:
        return roc_to_ad(v)
    except (TypeError, ValueError):
        return None


def price_or_none(v):
    """收盤價可能是空字串（TWSE）或 '----'（TPEx，當天沒成交）。
    這兩種每天的筆數都不一樣，所以不靠固定筆數判斷，一律 parse 不出正數就跳過。"""
    try:
        f = float(str(v).strip().replace(",", ""))
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def build(sources, prev_count=None, today=None):
    """sources 是 [(名稱, rows, code_k, name_k, close_k)]。純轉換，不碰網路，方便測。

    prev_count：上一版 prices.json 的檔數，用來擋「突然少了一大批」。None＝沒有上一版。
    today：datetime.date，用來擋「資料源凍結」。None＝不檢查（測試方便指定）。
    """
    out, dates, skipped = {}, {}, 0
    for name, rows, code_k, name_k, close_k in sources:
        floor = MIN_ROWS.get(name, DEFAULT_MIN_ROWS)
        if not isinstance(rows, list) or len(rows) < floor:
            raise SystemExit("%s 只回了 %s 筆，低於下限 %d，視為異常，中止不寫檔"
                             % (name, len(rows) if isinstance(rows, list) else "非陣列", floor))
        kept = 0
        for r in rows:
            code = str(r.get(code_k, "")).strip()
            px = price_or_none(r.get(close_k))
            day = date_or_none(r.get("Date"))
            if not code or px is None or day is None:
                skipped += 1
                continue
            out[code] = [str(r.get(name_k, "")).strip(), round(px, 2), day]
            dates.setdefault(name, set()).add(day)
            kept += 1
        print("%s: %d 筆可用、%d 筆跳過，日期 %s"
              % (name, kept, len(rows) - kept, sorted(dates.get(name, []))))

    if len(out) < sum(MIN_ROWS.get(n, DEFAULT_MIN_ROWS) for n, _, _, _, _ in sources):
        raise SystemExit("合併後只有 %d 檔，低於各來源下限的總和，視為異常，中止不寫檔" % len(out))

    # 跟上一版比。絕對下限擋不住「少了三成」，而那一樣是安靜的資料損失。
    if prev_count and len(out) < prev_count * SHRINK_TOLERANCE:
        raise SystemExit("合併後 %d 檔，上一版是 %d 檔（只剩 %.0f%%），視為異常，中止不寫檔"
                         % (len(out), prev_count, 100.0 * len(out) / prev_count))

    # 資料源凍結：成功、內容沒變、不 commit、全綠——沒有任何人會發現。
    all_days = sorted({d for ds in dates.values() for d in ds})
    if today is not None and all_days:
        newest = datetime.date.fromisoformat(all_days[-1])
        age = (today - newest).days
        if age > MAX_STALE_DAYS:
            raise SystemExit("最新的收盤日期是 %s，距今 %d 天（超過 %d 天），"
                             "資料源可能凍結了，中止不寫檔" % (all_days[-1], age, MAX_STALE_DAYS))

    return out, skipped


def previous_count(path):
    """寫檔之前先讀舊的那一份，拿它的檔數當比較基準。

    workflow 的順序是先跑這支、再 `git show HEAD` 撈舊檔給通知用，所以這個時候
    docs/prices.json 還是上一版，直接讀就好，不必動 workflow。
    讀不到（第一次跑、檔案壞掉）就回 None，那就只靠絕對下限。
    """
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return len(d) if isinstance(d, dict) and d else None
    except Exception:
        return None


def main():
    # 關鍵：全部抓完、全部驗過才寫檔。只要有一邊失敗就整個中止——
    # 不然寫出去的檔案會少掉半個市場的條目，而那是安靜地不見，
    # 隔天又自己回來，事後幾乎查不出來。
    prev = previous_count(OUT)
    fetched = [(name, fetch(url), c, n, p) for name, url, c, n, p in SOURCES]
    out, skipped = build(fetched, prev_count=prev, today=datetime.date.today())

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("寫出 %s：%d 檔、共跳過 %d 筆無效收盤價" % (OUT, len(out), skipped))


if __name__ == "__main__":
    main()
