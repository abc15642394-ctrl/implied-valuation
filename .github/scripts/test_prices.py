#!/usr/bin/env python3
"""收盤價管線的測試。用 python3 直接跑，不裝任何東西、不碰網路：

    python3 .github/scripts/test_prices.py

## 為什麼這一支到 build 26 才出現

`build_prices.py` 的 docstring 從第一天就寫著「純轉換，不碰網路，方便測」，
但它**從來沒有測試檔**。而逐字讀回去之後，那支腳本裡有三件事是錯的：

  1. 一列壞掉的 `Date` 會 `raise` → 整個 job 失敗 → **一整天沒有收盤價**，
     而同一支腳本對壞掉的收盤價是跳過那一列並計數。同一類問題兩種待遇。
  2. `MIN_ROWS = 500` 兩邊共用，而實測 TWSE 約 1389、TPEx 約 1020
     ——某一邊只回 600 筆（少 57%）照樣寫檔，正是 docstring 說要防的那件事。
  3. 資料源凍結（一直回同一天的舊資料）會成功、不 commit、全綠，
     **沒有人會發現**。對一個「只在有事時才響」的系統，凍結跟市場平靜長得一樣。

所以這一支鎖的是「資料安靜地壞掉」那三條路。
"""
import datetime
import importlib.util
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location(
    "build_prices", os.path.join(ROOT, ".github/scripts/build_prices.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)

passed = 0
failures = []


def ok(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        return True
    failures.append(name + ("\n       " + detail if detail else ""))
    return False


def eq(name, got, want):
    return ok(name, got == want, "得到 %r\n       應為 %r" % (got, want))


def rows(n, start=1000, date="1151120", price="100.5", name_prefix="測試"):
    """產生 n 列合法的 TWSE 形狀資料。"""
    return [{"Code": str(start + i), "Name": "%s%d" % (name_prefix, i),
             "ClosingPrice": price, "Date": date} for i in range(n)]


def tpex(n, start=6000, date="1151120", price="50.25"):
    return [{"SecuritiesCompanyCode": str(start + i), "CompanyName": "櫃%d" % i,
             "Close": price, "Date": date} for i in range(n)]


def sources(twse_rows, tpex_rows):
    return [("TWSE", twse_rows, "Code", "Name", "ClosingPrice"),
            ("TPEx", tpex_rows, "SecuritiesCompanyCode", "CompanyName", "Close")]


TODAY = datetime.date(2026, 11, 20)      # 跟 1151120 同一天


class quiet:
    """build() 會 print 每個來源的筆數，測試跑 20 次會把輸出洗掉。"""

    def __enter__(self):
        self._old = sys.stdout
        sys.stdout = io.StringIO()
        return self

    def __exit__(self, *a):
        sys.stdout = self._old
        return False


def build(*args, **kw):
    with quiet():
        return bp.build(*args, **kw)


def build_ok(name, *args, **kw):
    """預期 build() 會成功。它要是中止或丟錯，報成一條斷言失敗，不要讓整支測試
    噴 traceback——那樣 workflow 雖然也會紅，但紀錄上看不出是哪一條斷言在講話。"""
    try:
        return build(*args, **kw)
    except BaseException as e:            # SystemExit 也要接
        ok(name, False, "預期會成功，卻中止／丟錯了：%r" % (e,))
        return {}, None


def expect_exit(name, fn, must_contain=None):
    """回傳中止訊息，讓呼叫端可以再對它下斷言。

    **不要寫 ok("訊息裡會寫出那個日期", True) 這種恆真斷言**——我第一版就這樣寫了，
    而這個專案已經為「斷言因為巧合（或因為恆真）而通過」付出過四次代價。
    """
    try:
        with quiet():
            fn()
    except SystemExit as e:
        msg = str(e)
        if must_contain and must_contain not in msg:
            ok(name, False, "訊息是「%s」，裡面沒有「%s」" % (msg, must_contain))
            return msg
        ok(name, True)
        return msg
    except BaseException as e:
        # 中止了，但不是 SystemExit——例如 roc_to_ad 直接 raise ValueError。
        # 那也是壞的（訊息不是我們寫的、workflow 的紀錄裡只會看到 traceback），
        # 所以報成失敗而不是讓它炸掉整支測試。
        ok(name, False, "中止了，但丟的不是 SystemExit 而是 %r" % (e,))
        return ""
    ok(name, False, "居然沒有中止")
    return ""


# ---- 1. 民國年轉西元 ----

def test_roc():
    eq("1151112 → 2026-11-12", bp.roc_to_ad("1151112"), "2026-11-12")
    eq("1150101 → 2026-01-01", bp.roc_to_ad("1150101"), "2026-01-01")
    eq("前後空白照樣解得出來", bp.roc_to_ad(" 1151120 "), "2026-11-20")
    for bad in ["", "115112", "11511123", "11511a2", None, 1151112.0]:
        eq("看不懂的日期 %r 回 None（不丟錯）" % (bad,), bp.date_or_none(bad), None)
    eq("合法的日期 date_or_none 照樣解得出來", bp.date_or_none("1151120"), "2026-11-20")


# ---- 2. 收盤價的過濾（原本就有的行為，鎖住別改壞）----

def test_price():
    eq("正常價", bp.price_or_none("100.5"), 100.5)
    eq("帶千分位", bp.price_or_none("1,085.00"), 1085.0)
    for bad in ["", "----", None, "0", "-3", "abc"]:
        eq("無效收盤價 %r 回 None" % (bad,), bp.price_or_none(bad), None)


# ---- 3. 一列壞掉的 Date 不可以殺掉整天的收盤價 ----
#
# 這是 build 26 修的第一件。先前 `roc_to_ad(r.get("Date"))` 直接 raise，
# 1389 列裡有一列怪怪的就整個 job 失敗、一整天沒有收盤價。

def test_one_bad_date_is_skipped():
    tw = rows(1000)
    tw[500]["Date"] = "壞掉的日期"
    out, skipped = build_ok("壞掉那一列被跳過，不是整個中止（不可以 raise）",
                            sources(tw, tpex(800)), today=TODAY)
    eq("壞掉那一列被跳過，剩下的都寫出來了", len(out), 1799)
    eq("而且被算進 skipped", skipped, 1)
    ok("其餘的列都還在", "1000" in out and "1999" in out)

    # 跟「壞掉的收盤價」待遇一致——這一條就是當初不一致的地方
    tw2 = rows(1000)
    tw2[500]["ClosingPrice"] = "----"
    out2, skipped2 = build_ok("壞價格那一列也是跳過", sources(tw2, tpex(800)), today=TODAY)
    eq("壞價格與壞日期的待遇一樣（都是跳過並計數）", (len(out2), skipped2), (1799, 1))

    # 但整個來源的 Date 都壞掉＝格式變了，必須中止（全部跳過 → 撞下限）
    tw3 = rows(1000)
    for r in tw3:
        r["Date"] = "x"
    expect_exit("整個來源的日期都壞掉 → 中止（不會寫出半個市場）",
                lambda: bp.build(sources(tw3, tpex(800)), today=TODAY),
                "低於各來源下限的總和")


# ---- 4. 每個來源各自的下限 ----
#
# 先前兩邊共用 MIN_ROWS = 500，而 TWSE 實測約 1389 筆——500 只有它的 36%。

def test_per_source_floor():
    ok("TWSE 的下限明顯高於 TPEx", bp.MIN_ROWS["TWSE"] > bp.MIN_ROWS["TPEx"])
    ok("TWSE 的下限不是 500 那種鬆數字", bp.MIN_ROWS["TWSE"] >= 900,
       "現在是 %s" % bp.MIN_ROWS["TWSE"])
    expect_exit("TWSE 只回 600 筆（少 57%）→ 中止",
                lambda: bp.build(sources(rows(600), tpex(1000)), today=TODAY),
                "低於下限")
    expect_exit("TPEx 只回 400 筆 → 中止",
                lambda: bp.build(sources(rows(1300), tpex(400)), today=TODAY),
                "低於下限")
    expect_exit("來源回的不是陣列 → 中止",
                lambda: bp.build(sources({"oops": 1}, tpex(1000)), today=TODAY),
                "非陣列")
    out, _ = build(sources(rows(1300), tpex(1000)), today=TODAY)
    eq("正常筆數會過", len(out), 2300)


# ---- 5. 跟上一版比：少了一大批也要擋 ----

def test_shrink_vs_previous():
    full = sources(rows(1300), tpex(1000))          # 2300 檔
    out, _ = build(full, prev_count=2386, today=TODAY)
    eq("2300 vs 上一版 2386（96%）→ 過", len(out), 2300)

    expect_exit("只剩上一版的 70% → 中止",
                lambda: bp.build(sources(rows(1000), tpex(700)), prev_count=2386, today=TODAY),
                "視為異常")
    # 沒有上一版（第一次跑）就只靠絕對下限
    out2, _ = build(sources(rows(1000), tpex(700)), prev_count=None, today=TODAY)
    eq("沒有上一版時不比較", len(out2), 1700)
    eq("容許比例是 0.8", bp.SHRINK_TOLERANCE, 0.8)


# ---- 6. 資料源凍結 ----
#
# 一直回同一天的舊資料 → build 成功 → 內容沒變 → 不 commit → 全綠 → 沒人發現。

def test_frozen_source():
    old = rows(1300, date="1151101")                # 2026-11-01
    msg = expect_exit("最新日期是 19 天前 → 中止並說出原因",
                      lambda: bp.build(sources(old, tpex(1000, date="1151101")), today=TODAY),
                      "資料源可能凍結")
    ok("訊息裡寫出了那個日期與天數", "2026-11-01" in msg and "19 天" in msg, msg)

    # 剛好在容許範圍內
    recent = rows(1300, date="1151110")             # 2026-11-10，距今 10 天
    out, _ = build(sources(recent, tpex(1000, date="1151110")), today=TODAY)
    eq("剛好 10 天 → 過（連假要撐得過去）", len(out), 2300)
    eq("門檻是 10 天", bp.MAX_STALE_DAYS, 10)

    # 不給 today 就不檢查（本機拿舊資料測的時候不該被擋）
    out2, _ = build(sources(old, tpex(1000, date="1151101")), today=None)
    eq("today 是 None 時不檢查新鮮度", len(out2), 2300)


# ---- 7. 兩個交易所的日期可以不一樣，也可以一樣 ----
#
# TWSE 落後一個交易日**不是結構性的，是「幾點抓」決定的**：2026-11-21 台北 02:06
# 那次是 TWSE 11-19 ＋ TPEx 11-20（兩個日期），09:27 那次就只有 11-20 一個。
# 所以兩種都得支援，不能寫死「一定有兩個日期」。

def test_two_dates_or_one():
    out, _ = build(sources(rows(1300, date="1151119"), tpex(1000, date="1151120")),
                      today=TODAY)
    days = sorted({v[2] for v in out.values()})
    eq("兩個交易所不同日期時，各自保留自己的", days, ["2026-11-19", "2026-11-20"])

    out2, _ = build(sources(rows(1300, date="1151120"), tpex(1000, date="1151120")),
                       today=TODAY)
    eq("對齊時只有一個日期", sorted({v[2] for v in out2.values()}), ["2026-11-20"])


# ---- 8. 輸出格式 ----

def test_shape():
    out, _ = build(sources(rows(1300), tpex(1000)), today=TODAY)
    for code, row in list(out.items())[:5]:
        ok("每一筆都是 [名稱, 收盤價, 日期]",
           isinstance(row, list) and len(row) == 3
           and isinstance(row[0], str) and isinstance(row[1], float)
           and isinstance(row[2], str), repr(row))
    ok("收盤價四捨五入到小數兩位", out["1000"][1] == 100.5)
    # 兩邊代號零重疊是實測結論；萬一重疊，後面的來源會蓋掉前面的
    eq("上市與上櫃的代號在這份假資料裡不重疊",
       len(out), 2300)


# ---- 9. previous_count ----

def test_previous_count():
    import json
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "prices.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"2330": ["台積電", 1000.0, "2026-11-20"]}, f)
        eq("讀得到上一版的檔數", bp.previous_count(p), 1)
        with open(p, "w", encoding="utf-8") as f:
            f.write("{{{壞掉")
        eq("壞掉的檔案回 None（不要讓它擋住今天的更新）", bp.previous_count(p), None)
        eq("不存在的檔案回 None", bp.previous_count(os.path.join(d, "nope.json")), None)
        with open(p, "w", encoding="utf-8") as f:
            f.write("{}")
        eq("空物件回 None（當成沒有上一版）", bp.previous_count(p), None)


def run():
    test_roc()
    test_price()
    test_one_bad_date_is_skipped()
    test_per_source_floor()
    test_shrink_vs_previous()
    test_frozen_source()
    test_two_dates_or_one()
    test_shape()
    test_previous_count()

    print("通過 %d 項" % passed)
    if failures:
        print("\n失敗 %d 項：" % len(failures))
        for f in failures:
            print("  ❌ " + f)
        sys.exit(1)
    print("全部通過")


if __name__ == "__main__":
    run()
