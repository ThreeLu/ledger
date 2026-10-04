"""端到端测试：真浏览器打开账本网页，连本地的假 GitHub（tests/fake_github.py），把主要功能走一遍。

    pip install playwright openpyxl && python -m playwright install chromium
    python tests/test_app.py            # 全部
    python tests/test_app.py 转账 校准    # 只跑名字里含这些字的步骤（前面的「开始记账」总会跑）

汇率接口用假数据（1 美元 = 7 元），不联网、不需要令牌。失败时截图在 tests/artifacts/。
"""

import json
import re
import sys
import threading
import traceback
from datetime import date, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from fake_github import FakeRepo, serve  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "tests" / "artifacts"
APP_PORT, API_PORT = 8775, 8776
URL = f"http://127.0.0.1:{APP_PORT}/"
API = f"http://127.0.0.1:{API_PORT}"
REPO = "test/finance-data"
TODAY = date.today().isoformat()

STEPS = []


def step(name):
    def wrap(fn):
        STEPS.append((name, fn))
        return fn
    return wrap


class Ctx:
    def __init__(self, page, repo):
        self.page, self.repo = page, repo

    def data(self):
        return json.loads(self.repo.read("finance.json"))

    def tx(self):
        return self.data()["tx"]

    def go(self, hash_):
        same = self.page.url == URL + hash_
        self.page.goto(URL + hash_)
        if same:
            self.page.reload()

    def balance(self, acc):
        d = self.data()
        a = next(x for x in d["accounts"] if x["id"] == acc)
        b = a["opening"]
        for t in d["tx"]:
            if t["account"] == acc:
                b += {"income": t["amount"], "expense": -t["amount"], "transfer": -t["amount"], "adjust": t["amount"]}[t["type"]]
            if t["type"] == "transfer" and t.get("to") == acc:
                b += t.get("toAmount", t["amount"])
        return round(b, 2)

    def wait_saved(self, n):
        """等仓库里的流水数变成 n（保存是异步的）"""
        for _ in range(60):
            if len(self.tx()) == n:
                return
            self.page.wait_for_timeout(200)
        raise AssertionError(f"流水数是 {len(self.tx())}，不是 {n}")

    def add(self, amount, *, kind="支出", cat=None, acc=None, to=None, note=None, quick=False):
        p = self.page
        self.go("#/add")
        p.locator(".segmented").get_by_role("button", name=kind, exact=True).click()
        p.get_by_label("金额", exact=True).fill(str(amount))
        if cat:
            p.get_by_role("button", name=cat, exact=True).click()
        if acc:
            group = {"支出": "账户", "收入": "账户", "转账": "转出账户"}[kind]
            p.get_by_role("group", name=group).get_by_role("button", name=acc, exact=True).click()
        if to:
            p.get_by_role("group", name="转入账户").get_by_role("button", name=to, exact=True).click()
        if note:
            p.get_by_label("备注").fill(note)
        if quick:
            p.get_by_text("存成快捷").click()
        n = len(self.tx())
        p.get_by_role("button", name="记好了").click()
        self.wait_saved(n + 1)
        p.wait_for_function("location.hash === '#/'")


# ---------- 测试步骤 ----------

@step("开始记账：用物品档案的令牌连上，填期初余额，建好账本")
def _(c):
    p = c.page
    p.goto(URL)
    p.evaluate(f"""() => {{
        localStorage.clear();
        localStorage.setItem('ledger-api-base', '{API}');
        localStorage.setItem('inventory-settings', JSON.stringify({{ repo: 'x/inventory-data', token: 'test-token' }}));
        localStorage.setItem('ledger-settings', JSON.stringify({{ repo: '{REPO}' }}));
    }}""")
    p.goto(URL)
    expect(p.get_by_role("heading", name="开始记账")).to_be_visible()
    for name, v in [("存钱卡余额", "13087.39"), ("生活费卡余额", "689.88"), ("微信余额", "1985.83"), ("校园卡余额", "162.58")]:
        p.get_by_label(name).fill(v)
    p.get_by_role("button", name="开始记账").click()
    expect(p.locator(".summary-title")).to_be_visible()
    d = c.data()
    assert {a["id"]: a["opening"] for a in d["accounts"]}["a-save"] == 13087.39, d["accounts"]
    assert d["openingDate"] == TODAY
    # 个人设置在私有仓库里改（这里用编的数字模拟）：美元账户、固定扣费、收入计划、预算
    d["accounts"].append({"id": "a-usd", "name": "Apple ID", "currency": "USD", "opening": 126.35, "note": ""})
    d["presets"].append({"name": "充值 Apple ID", "from": "a-live", "to": "a-usd"})
    d["recurring"] = [{"id": "r-claude", "name": "订阅甲", "amount": 20, "account": "a-usd", "category": "c-ai", "day": 6, "since": TODAY},
                      {"id": "r-gpt", "name": "订阅乙", "amount": 100, "account": "a-usd", "category": "c-ai", "day": 29, "since": TODAY}]
    d["incomePlan"] = [{"name": "收入甲", "amount": 4000, "when": "每月 15 号", "use": "过这个月"}, {"name": "收入乙", "amount": 4000, "use": "全部存下"}]
    d["settings"].update(periodStartDay=15, expectedIncome=8000, emergencyFloor=8000, summerMonths=[7, 8], sideIncomeSave=0.7, payNote="测试：支付宝记在生活费卡")
    d["budget"] = {"food": 1900, "daily": 700, "free": 300, "sub": 900}
    expect(p.locator(".cell.indicator", has_text="安全垫")).to_be_visible()
    # 固定扣费先推到很远以后，免得今天刚好是扣费日、打乱后面的笔数（扣费单独测）
    for r in d["recurring"]:
        r["since"] = "2999-01-01"
    d["tx"] = []
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    p.reload()
    expect(p.locator(".summary-title")).to_be_visible()


@step("记支出：金额、类别、账户；存成快捷，再点快捷记一笔")
def _(c):
    p = c.page
    c.go("#/add")
    expect(p.get_by_text("测试：支付宝记在生活费卡")).to_be_visible()
    c.add(15, cat="三餐", acc="校园卡", note="食堂午饭", quick=True)
    expect(p.locator(".tx", has_text="三餐").first).to_be_visible()
    d = c.data()
    t = d["tx"][-1]
    assert (t["type"], t["amount"], t["category"], t["account"], t["note"]) == ("expense", 15, "c-meal", "a-campus", "食堂午饭"), t
    assert d["quick"][0]["name"] == "食堂午饭"
    c.go("#/add")
    p.get_by_role("button", name="食堂午饭 ¥15").click()
    c.wait_saved(2)
    assert c.balance("a-campus") == 132.58
    # 下次默认账户是上次用的
    c.go("#/add")
    expect(p.get_by_role("group", name="账户").get_by_role("button", name="校园卡")).to_have_attribute("aria-pressed", "true")


@step("记收入：生活费 4000 到存钱卡")
def _(c):
    c.add(4000, kind="收入", cat="生活费", acc="存钱卡")
    assert c.balance("a-save") == 17087.39


@step("转账：常用的「充值校园卡」带手续费；充值 Apple ID 人民币换美元")
def _(c):
    p = c.page
    c.go("#/add")
    p.locator(".segmented").get_by_role("button", name="转账").click()
    p.get_by_role("button", name="充值校园卡").click()
    p.get_by_label("金额", exact=True).fill("200")
    p.get_by_label("手续费").fill("1")
    n = len(c.tx())
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 2)
    assert c.balance("a-campus") == 332.58 and c.balance("a-live") == 488.88, (c.balance("a-campus"), c.balance("a-live"))
    fee = c.tx()[-1]
    assert fee["category"] == "c-fee" and fee["amount"] == 1
    p.wait_for_function("location.hash === '#/'")
    expect(p.get_by_text("另有不占预算的花销")).to_be_visible()
    # 充值 Apple ID：140 元按 1:7 估成 20 美元
    c.go("#/add")
    p.locator(".segmented").get_by_role("button", name="转账").click()
    p.get_by_role("button", name="充值 Apple ID").click()
    p.get_by_label("金额", exact=True).fill("140")
    expect(p.get_by_label("到账金额")).to_have_value("20")
    p.get_by_label("到账金额").fill("19.5")
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 3)
    assert c.balance("a-usd") == 145.85, c.balance("a-usd")
    # 美元账户的花销按汇率折成人民币
    c.add(2, cat="软件订阅", acc="Apple ID")
    assert c.tx()[-1]["cny"] == 14


@step("流水：按预算月列出；改一笔、删一笔")
def _(c):
    p = c.page
    c.go("#/list")
    expect(p.locator(".period-nav")).to_contain_text("支出")
    p.locator(".tx").filter(has_text=re.compile(r"^生活费\d")).click()
    expect(p.get_by_role("heading", name="改一笔")).to_be_visible()
    p.get_by_label("金额", exact=True).fill("4100")
    p.get_by_role("button", name="保存").click()
    p.wait_for_function("location.hash.startsWith('#/list')")
    assert c.balance("a-save") == 17187.39
    n = len(c.tx())
    p.locator(".tx", has_text="软件订阅").click()
    p.get_by_role("button", name="删除").click()
    c.wait_saved(n - 1)
    # 只看一个账户
    p.locator(".chip-scroll").get_by_role("link", name="校园卡").click()
    expect(p.locator(".tx", has_text="存钱卡")).to_have_count(0)
    expect(p.locator(".tx", has_text="三餐").first).to_be_visible()


@step("账户：总资产、校准（差额记对账差额）")
def _(c):
    p = c.page
    c.go("#/accounts")
    expect(p.locator(".big-num")).to_be_visible()
    p.locator(".cell", has_text="生活费卡").click()
    p.get_by_role("button", name="校准").click()
    p.get_by_label("实际余额").fill("480")
    n = len(c.tx())
    p.locator(".sheet").get_by_role("button", name="校准").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    # 生活费卡：689.88 − 充校园卡 200 − 手续费 1 − 充 Apple ID 140 = 348.88，实际 480 → 差额 +131.12
    assert t["type"] == "adjust" and t["amount"] == 131.12 and c.balance("a-live") == 480, t
    expect(p.locator(".tx", has_text="对账差额")).to_be_visible()


@step("首页：健康指标能点开看解释；应急钱跌破底线变红并说该做什么")
def _(c):
    p = c.page
    c.go("#/")
    p.locator(".cell.indicator", has_text="安全垫").click()
    sheet = p.locator(".sheet")
    for t in ("这是什么", "为什么重要", "你现在"):
        expect(sheet).to_contain_text(t)
    sheet.get_by_role("button", name="知道了").click()
    p.get_by_role("button", name="怎么用").click()
    expect(p.locator(".sheet")).to_contain_text("健康指标")
    p.locator(".sheet").get_by_role("button", name="知道了").click()
    # 预算页把底线调到 99999 → 红
    c.go("#/budget")
    p.get_by_label("应急钱底线").fill("99999")
    p.get_by_role("button", name="保存").click()
    p.wait_for_function("location.hash === '#/'")
    expect(p.locator(".summary.bad")).to_contain_text("先别从里面转钱出来花")
    c.go("#/budget")
    p.get_by_label("应急钱底线").fill("8000")
    p.get_by_label("吃饭").fill("2000")
    p.get_by_role("button", name="保存").click()
    p.wait_for_function("location.hash === '#/'")
    expect(p.locator(".summary.bad")).to_have_count(0)
    assert c.data()["budget"]["food"] == 2000


@step("固定扣费：到日子自动记一笔（美元按汇率折算），不会重复记")
def _(c):
    p = c.page
    d = c.data()
    past = (date.today() - timedelta(days=40)).isoformat()
    for r in d["recurring"]:
        if r["id"] == "r-claude":
            r["since"] = past
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    n = len(d["tx"])
    # 从 40 天前到今天，每月 6 号扣一次：一般是 1～2 次
    days = [date.today() - timedelta(days=k) for k in range(41)]
    expected = sum(1 for x in days if x.day == 6)
    p.reload()
    c.wait_saved(n + expected)
    auto = [t for t in c.tx() if t.get("auto") == "r-claude"]
    assert auto and all(t["amount"] == 20 and t["cny"] == 140 for t in auto), auto
    p.reload()
    p.wait_for_timeout(1500)
    assert len([t for t in c.tx() if t.get("auto") == "r-claude"]) == len(auto), "重复记了"


@step("我们的花钱方式：规则和一年能存多少")
def _(c):
    p = c.page
    c.go("#/more")
    p.get_by_role("link", name="我们的花钱方式").click()
    expect(p.get_by_text("先存后花")).to_be_visible()
    expect(p.locator(".rule", has_text="2 笔收入")).to_contain_text("收入乙 ¥4,000：全部存下")
    expect(p.locator(".rule", has_text="7、8 月没有收入")).to_be_visible()
    expect(p.locator(".rule", has_text="兼职的钱")).to_contain_text("70% 存下")
    expect(p.locator(".rule", has_text="一年下来")).to_contain_text("能存约 ¥33,200，储蓄率 42%")  # 前面把吃饭预算改成了 2000


@step("导出全部账目 Excel")
def _(c):
    p = c.page
    c.go("#/more")
    with p.expect_download() as dl:
        p.get_by_role("button", name="导出全部账目（Excel）").click()
    path = ART / "ledger.xlsx"
    dl.value.save_as(path)
    import openpyxl
    rows = list(openpyxl.load_workbook(path).active.values)
    assert rows[0][0] == "日期" and len(rows) == len(c.tx()) + 1, rows[:2]


def fake_externals(page):
    page.route("https://api.frankfurter.dev/**", lambda r: r.fulfill(json={"base": "USD", "rates": {"CNY": 7.0}}))


def main():
    only = sys.argv[1:]
    ART.mkdir(exist_ok=True)
    repo = FakeRepo({"README.md": b"# finance-data\n"})
    serve(repo, API_PORT)
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a: None
    app = ThreadingHTTPServer(("127.0.0.1", APP_PORT), handler)
    threading.Thread(target=app.serve_forever, daemon=True).start()

    failed, errors, ran = [], [], 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, accept_downloads=True, locale="zh-CN")
        ctx.set_default_timeout(10000)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        fake_externals(page)
        c = Ctx(page, repo)
        for i, (name, fn) in enumerate(STEPS):
            if i and only and not any(k in name for k in only):
                continue
            ran += 1
            try:
                fn(c)
                print(f"  ✓ {name}")
            except Exception:
                failed.append(name)
                page.screenshot(path=ART / f"fail-{i:02d}.png", full_page=True)
                print(f"  ✗ {name}\n{traceback.format_exc()}")
                if i == 0:
                    break
        browser.close()
    if errors:
        print("页面报错：", *errors, sep="\n  ")
    print(f"\n{ran - len(failed)}/{ran} 通过" + ("" if ran == len(STEPS) else f"（共 {len(STEPS)} 项，没跑完）"))
    sys.exit(1 if failed or errors else 0)


if __name__ == "__main__":
    main()
