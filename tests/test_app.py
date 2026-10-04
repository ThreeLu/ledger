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
        self.prompt = ""  # 下一次 prompt() 弹窗填什么

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
            if t.get("account") == acc:
                b += {"income": 1, "repay": 1, "adjust": 1, "expense": -1, "transfer": -1, "advance": -1, "payback": -1}.get(t["type"], 0) * t["amount"]
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
            p.get_by_role("button", name=cat, exact=True).first.click()  # 「最近用过」里可能也有
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
    for name, v in [("存钱卡余额", "10000"), ("生活费卡余额", "500"), ("微信余额", "1000"), ("校园卡余额", "100")]:
        p.get_by_label(name).fill(v)
    p.get_by_role("button", name="开始记账").click()
    expect(p.locator(".summary-title")).to_be_visible()
    d = c.data()
    assert {a["id"]: a["opening"] for a in d["accounts"]}["a-save"] == 10000, d["accounts"]
    assert d["openingDate"] == TODAY
    # 个人设置在私有仓库里改（这里用编的数字模拟）：美元账户、固定扣费、收入计划、预算
    d["accounts"].append({"id": "a-usd", "name": "Apple ID", "currency": "USD", "opening": 150, "note": ""})
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
    c.add(15, cat="午餐", acc="校园卡", note="食堂午饭", quick=True)
    expect(p.locator(".tx", has_text="午餐").first).to_be_visible()
    d = c.data()
    t = d["tx"][-1]
    assert (t["type"], t["amount"], t["category"], t["account"], t["note"]) == ("expense", 15, "c-lunch", "a-campus", "食堂午饭"), t
    assert d["quick"][0]["name"] == "食堂午饭"
    c.go("#/add")
    p.get_by_role("button", name="食堂午饭 ¥15").click()
    c.wait_saved(2)
    assert c.balance("a-campus") == 70
    # 下次默认账户是上次用的
    c.go("#/add")
    expect(p.get_by_role("group", name="账户").get_by_role("button", name="校园卡")).to_have_attribute("aria-pressed", "true")


@step("记收入：生活费 4000 到存钱卡")
def _(c):
    c.add(4000, kind="收入", cat="生活费", acc="存钱卡")
    assert c.balance("a-save") == 14000


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
    assert c.balance("a-campus") == 270 and c.balance("a-live") == 299, (c.balance("a-campus"), c.balance("a-live"))
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
    assert c.balance("a-usd") == 169.5, c.balance("a-usd")
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
    assert c.balance("a-save") == 14100
    n = len(c.tx())
    p.locator(".tx", has_text="软件订阅").click()
    p.get_by_role("button", name="删除").click()
    c.wait_saved(n - 1)
    # 只看一个账户
    p.locator(".chip-scroll").get_by_role("link", name="校园卡").click()
    expect(p.locator(".tx", has_text="存钱卡")).to_have_count(0)
    expect(p.locator(".tx", has_text="午餐").first).to_be_visible()


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
    # 生活费卡：500 − 充校园卡 200 − 手续费 1 − 充 Apple ID 140 = 159，实际 480 → 差额 +321
    assert t["type"] == "adjust" and t["amount"] == 321 and c.balance("a-live") == 480, t
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

def person(c, name):
    return next(p for p in c.data()["people"] if p["name"] == name)


def net(c, pid):
    """和这个人之间：正数他欠我，负数我欠他（和网页 personStatus 一样算）"""
    n = 0
    for t in c.tx():
        if t.get("person") != pid:
            continue
        v = t.get("cny", t["amount"])
        if t["type"] in ("advance", "payback"):
            n += v
        elif t["type"] == "repay" or (t["type"] == "expense" and not t.get("account")):
            n -= v
    return round(n, 2)


@step("AA：先付 200，选两个新同学，我那份算花销、其他记成欠我；别人帮我付；人情账还钱")
def _(c):
    p = c.page
    c.go("#/add")
    p.get_by_label("金额", exact=True).fill("200")
    p.get_by_role("button", name="出去吃", exact=True).first.click()
    p.get_by_role("group", name="账户").get_by_role("button", name="微信", exact=True).click()
    p.get_by_role("group", name="和别人有关").get_by_role("button", name="AA / 帮人付").click()
    for name in ("小甲", "小乙"):
        c.prompt = name
        p.get_by_role("button", name="+ 新的人").click()
    expect(p.get_by_label("我那份")).to_have_value("66.67")
    p.get_by_label("我那份").fill("50")
    expect(p.locator(".split-hint")).to_contain_text("其他 2 人各约 ¥75")
    n = len(c.tx())
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 3)
    new = c.tx()[n:]
    assert sorted((t["type"], t["amount"]) for t in new) == [("advance", 75), ("advance", 75), ("expense", 50)], new
    assert len({t["group"] for t in new}) == 1
    a, b = person(c, "小甲"), person(c, "小乙")
    assert net(c, a["id"]) == 75 and net(c, b["id"]) == 75
    # 小乙帮我付了 30：算我的花销，账户不动
    wechat = c.balance("a-wechat")
    c.go("#/add")
    p.get_by_label("金额", exact=True).fill("30")
    p.get_by_role("button", name="午餐", exact=True).first.click()
    p.get_by_role("group", name="和别人有关").get_by_role("button", name="别人帮我付的").click()
    expect(p.get_by_role("group", name="账户")).to_have_count(0)
    p.get_by_role("group", name="谁帮我付的").get_by_role("button", name="小乙").click()
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 4)
    t = c.tx()[-1]
    assert t["account"] is None and t["person"] == b["id"] and c.balance("a-wechat") == wechat, t
    assert net(c, b["id"]) == 45
    # 人情账：小甲还我 75 到生活费卡（当初是微信付的，没关系）
    c.go("#/more")
    p.get_by_role("link", name="人情账").click()
    expect(p.locator(".cell", has_text="小乙")).to_contain_text("¥45")
    p.locator(".cell", has_text="小甲").click()
    expect(p.locator(".big-num")).to_have_text("¥75")
    p.get_by_role("button", name="他还我钱").click()
    expect(p.locator(".sheet").get_by_label("金额")).to_have_value("75")
    p.locator(".sheet").get_by_role("group", name="钱到了哪个账户").get_by_role("button", name="生活费卡").click()
    live = c.balance("a-live")
    p.locator(".sheet").get_by_role("button", name="记好了").click()
    c.wait_saved(n + 5)
    assert net(c, a["id"]) == 0 and c.balance("a-live") == round(live + 75, 2)
    expect(p.locator(".big-num")).to_have_text("¥0")
    # 首页：待收回
    c.go("#/")
    expect(p.locator(".cell.indicator", has_text="待收回")).to_contain_text("¥45")
    # 删 AA 的那笔花销，连同记给别人的一起删
    c.go("#/list")
    p.locator(".tx").filter(has_text=re.compile(r"^出去吃")).click()
    p.get_by_role("button", name="删除").click()
    c.wait_saved(n + 2)
    assert not any(t.get("group") == new[0]["group"] for t in c.tx())


@step("垫付报销：建一件事、垫两笔、传 PDF 和照片、勾已提交、分两次报销、结清（报不回的算出差自付）")
def _(c):
    p = c.page
    c.go("#/claims")
    p.get_by_role("button", name="新的垫付").click()
    p.get_by_label("这件事").fill("测试开会")
    p.locator(".sheet").get_by_role("button", name="建好").click()
    p.wait_for_function("location.hash.startsWith('#/claim/')")
    cid = c.data()["claims"][-1]["id"]
    save_before, n = c.balance("a-save"), len(c.tx())
    for amount in ("600", "400"):
        p.get_by_role("button", name="垫一笔").click()
        p.locator(".sheet").get_by_label("金额").fill(amount)
        p.locator(".sheet").get_by_role("group", name="从哪个账户付的").get_by_role("button", name="存钱卡").click()
        p.locator(".sheet").get_by_role("button", name="记好了").click()
        expect(p.locator(".sheet")).to_have_count(0)
    c.wait_saved(n + 2)
    assert c.balance("a-save") == round(save_before - 1000, 2)
    expect(p.locator(".big-num")).to_have_text("¥1,000")
    # 不算花销：这个预算月的「不占预算」里没有它
    # 发票
    pdf = ART / "invoice.pdf"
    pdf.write_bytes(b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
    img = ART / "ticket.png"
    import struct, zlib
    raw = b"".join(b"\x00" + b"\x80\x80\x80" * 8 for _ in range(8))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))  # noqa: E731
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    p.get_by_label("上传发票").set_input_files([str(pdf), str(img)])
    expect(p.get_by_text("已提交 0 / 2")).to_be_visible()
    docs = next(x for x in c.data()["claims"] if x["id"] == cid)["docs"]
    assert [x["kind"] for x in docs] == ["pdf", "image"] and c.repo.read(docs[0]["file"]).startswith(b"%PDF"), docs
    p.get_by_label("invoice.pdf 已提交").check()
    expect(p.get_by_text("已提交 1 / 2")).to_be_visible()
    # 报销分两次到账
    for amount, acc in (("500", "生活费卡"), ("300", "微信")):
        p.get_by_role("button", name="报销到账").click()
        p.locator(".sheet").get_by_label("金额").fill(amount)
        p.locator(".sheet").get_by_role("group", name="打到哪个账户").get_by_role("button", name=acc).click()
        p.locator(".sheet").get_by_role("button", name="记好了").click()
        expect(p.locator(".sheet")).to_have_count(0)
    c.wait_saved(n + 4)
    expect(p.locator(".big-num")).to_have_text("¥200")
    p.get_by_role("button", name="结清").click()
    expect(p.locator(".sheet")).to_contain_text("还差 ¥200 报不回来")
    p.locator(".sheet").get_by_role("button", name="结清").click()
    c.wait_saved(n + 5)
    w = c.tx()[-1]
    assert (w["type"], w["amount"], w["category"], w.get("account")) == ("writeoff", 200, "c-trip", None), w
    assert next(x for x in c.data()["claims"] if x["id"] == cid)["status"] == "settled"
    c.go("#/")
    expect(p.get_by_text("出差自付").first).to_be_visible()
    # 删一张发票
    c.go(f"#/claim/{cid}")
    p.locator(".manage-row", has_text="ticket.png").get_by_role("button", name="删除").click()
    expect(p.get_by_text("已提交 1 / 1")).to_be_visible()
    assert c.repo.read(docs[1]["file"]) is None


@step("对账：新的预算月提醒对账，对得上的不填，对不上的补差额")
def _(c):
    p = c.page
    d = c.data()
    d["openingDate"] = "2020-01-01"  # 假装早就开始记账，这个预算月是完整的
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/")
    p.reload()
    expect(p.locator(".cell.indicator", has_text="对账")).to_be_visible()
    c.go("#/reconcile")
    live = c.balance("a-live")
    p.get_by_label("生活费卡实际余额").fill(str(round(live - 12.5, 2)))
    n = len(c.tx())
    p.get_by_role("button", name="对完了").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    assert t["type"] == "adjust" and t["amount"] == -12.5 and c.data()["reconciled"], t
    p.wait_for_function("location.hash === '#/'")
    expect(p.locator(".cell.indicator", has_text="对账")).to_have_count(0)


@step("总结：周（每天柱状图、环形图、和上周比、最大几笔）、月（曲线、每月存下、总资产、建议）")
def _(c):
    p = c.page
    c.go("#/summary")
    expect(p.get_by_role("img", name="每天的生活花销")).to_be_visible()
    expect(p.locator(".summary-head")).to_contain_text("这周")
    if c.tx():
        expect(p.get_by_role("img", name="花在哪了")).to_be_visible()
    p.get_by_role("link", name="月", exact=True).click()
    expect(p.get_by_role("img", name="花钱曲线")).to_be_visible()
    expect(p.locator(".advice")).to_contain_text("下个月可以试试")
    expect(p.get_by_role("img", name="总资产")).to_be_visible()
    p.get_by_role("link", name="上一个").click()
    expect(p.locator(".period-nav")).to_be_visible()
    p.get_by_role("button", name="怎么用").click()
    expect(p.locator(".sheet")).to_contain_text("花钱曲线")


def period_start(day, start=15):
    """预算月开始那天（和网页 periodOf 一样，startDay=15）"""
    if day.day >= start:
        return day.replace(day=start)
    first = day.replace(day=1) - timedelta(days=1)
    return first.replace(day=start)


@step("分类：老账本自动升级（三餐藏起来但老账照样显示）、日常先点小组再点类别、最近用过")
def _(c):
    p = c.page
    d = c.data()
    for x in d["categories"]:
        if x["id"] == "c-lunch":
            x.update(id="c-meal", name="三餐")  # 假装是老版本的账本
    d["categories"] = [x for x in d["categories"] if x["id"] not in ("c-breakfast", "c-dinner")]
    d.pop("categoryVersion", None)
    d["tx"].append({"id": "old1", "type": "expense", "date": TODAY, "account": "a-campus", "amount": 9, "category": "c-meal", "note": "老账", "createdAt": "2020-01-01T00:00:00Z"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/list")
    p.reload()
    expect(p.locator(".tx", has_text="老账")).to_contain_text("三餐")
    c.go("#/add")
    expect(p.get_by_role("button", name="早餐", exact=True)).to_be_visible()
    expect(p.get_by_role("button", name="三餐", exact=True)).to_have_count(0)
    expect(p.get_by_role("button", name="收纳整理")).to_have_count(0)
    p.get_by_role("group", name="日常小组").get_by_role("button", name="家居用品").click()
    p.get_by_role("button", name="收纳整理").click()
    p.get_by_label("金额", exact=True).fill("25")
    n = len(c.tx())
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 1)
    assert c.tx()[-1]["category"] == "c-storage"
    c.go("#/add")
    expect(p.get_by_role("group", name="最近用过的类别").get_by_role("button", name="收纳整理")).to_be_visible()
    # 「其他」：要写一下具体是什么，流水里显示写的名字
    p.get_by_role("group", name="日常小组").get_by_role("button", name="其他").click()
    p.get_by_role("group", name="其他类别").get_by_role("button", name="其他").click()
    expect(p.get_by_label("具体是什么")).to_be_focused()
    p.get_by_label("金额", exact=True).fill("680")
    n = len(c.tx())
    p.get_by_role("button", name="记好了").click()
    expect(p.locator(".toast.error")).to_contain_text("写一下具体是什么")
    p.get_by_label("具体是什么").fill("二手自行车")
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    assert (t["category"], t["what"]) == ("c-other", "二手自行车"), t
    c.go("#/list")
    expect(p.locator(".tx").filter(has_text=re.compile(r"^二手自行车"))).to_contain_text("其他")


@step("心愿单：小额用心愿基金（省下的预算）、大额按顺序每月最多 400 攒、冷静期、DeepSeek 建议、买了、放弃")
def _(c):
    p = c.page
    c.go("#/more")
    p.get_by_role("link", name="心愿单").click()
    for name, price, want in (("一本闲书", "80", "有了更好"), ("降噪耳机", "1200", "很想要"), ("机械键盘", "600", "有了更好")):
        p.get_by_role("button", name="加一个心愿").click()
        sheet = p.locator(".sheet")
        sheet.get_by_label("想要什么").fill(name)
        sheet.get_by_label("价格").fill(price)
        sheet.get_by_role("button", name=want).click()
        sheet.get_by_role("button", name="加进心愿单").click()
        expect(p.locator(".wish", has_text=name)).to_be_visible()
    expect(p.locator(".wish", has_text="一本闲书")).to_contain_text("冷静中，还剩 3 天")
    expect(p.locator(".section-title", has_text="小额心愿")).to_be_visible()
    # 上个预算月：生活预算 3000，花了 2800 → 省下 200 进心愿基金；耳机早就加进来了，攒了 400
    cur = period_start(date.today())
    prev = period_start(cur - timedelta(days=1))
    d = c.data()
    d["openingDate"] = prev.isoformat()
    d["tx"].append({"id": "lastmonth", "type": "expense", "date": prev.isoformat(), "account": "a-live", "amount": 2800, "category": "c-lunch", "note": "上个月", "createdAt": "2020-01-01T00:00:00Z"})
    for w in d["wishes"]:
        if w["name"] == "降噪耳机":
            w["createdAt"] = prev.isoformat()
    living_before = sum(t["amount"] for t in d["tx"] if prev.isoformat() <= t["date"] < cur.isoformat() and t["type"] == "expense"
                        and t["category"] not in ("c-ai", "c-soft", "c-member", "c-fee", "c-trip", "c-wish"))
    d["config_note"] = "test"
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.repo.external_write("config/ai.json", json.dumps({"deepseek": {"key": "sk-test", "model": "deepseek-flash"}}).encode())
    p.reload()
    fund = 3000 - living_before
    expect(p.locator(".big-num")).to_have_text(f"¥{fund:,}")
    expect(p.locator(".wish", has_text="降噪耳机")).to_contain_text("已攒 ¥400 / ¥1,200")
    expect(p.locator(".wish", has_text="降噪耳机")).to_contain_text("预计")
    # 调顺序：键盘往前排
    p.get_by_role("button", name="机械键盘 往前排").click()
    order = lambda: [w["name"] for w in c.data()["wishes"] if float(w["price"]) > 300 and w["status"] == "open"]  # noqa: E731
    for _ in range(50):
        if order()[0] == "机械键盘":
            break
        p.wait_for_timeout(200)
    big_order = order()
    assert big_order == ["机械键盘", "降噪耳机"], big_order
    # DeepSeek
    p.get_by_role("button", name="问问 DeepSeek").click()
    expect(p.locator(".ai-summary")).to_contain_text("先买闲书")
    expect(p.locator(".wish", has_text="一本闲书").locator(".wish-ai")).to_contain_text("想要")
    expect(p.locator(".wish", has_text="一本闲书").locator(".wish-rank")).to_have_text("1")
    assert "sk-test" not in json.dumps(c.data())  # 密钥不会写进账本
    # 买闲书：从心愿基金出
    n = len(c.tx())
    p.locator(".wish", has_text="一本闲书").get_by_role("button", name="买了").click()
    expect(p.locator(".sheet")).to_contain_text("还在冷静期")
    p.locator(".sheet").get_by_role("button", name="记好了").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    assert (t["category"], t["amount"], t["wishKind"]) == ("c-wish", 80, "small"), t
    expect(p.locator(".big-num")).to_have_text(f"¥{fund - 80:,}")
    # 再加一个 250 的小额心愿，基金不够：差的算自由钱
    p.get_by_role("button", name="加一个心愿").click()
    p.locator(".sheet").get_by_label("想要什么").fill("台灯")
    p.locator(".sheet").get_by_label("价格").fill("250")
    p.locator(".sheet").get_by_role("button", name="加进心愿单").click()
    p.locator(".wish", has_text="台灯").get_by_role("button", name="买了").click()
    expect(p.locator(".sheet")).to_contain_text("差的")
    p.locator(".sheet").get_by_role("button", name="记好了").click()
    c.wait_saved(n + 3)
    split = sorted((x["category"], x["amount"]) for x in c.tx()[-2:])
    assert split == sorted([("c-wish", fund - 80), ("c-like", 250 - (fund - 80))]), split
    expect(p.locator(".big-num")).to_have_text("¥0")
    # 放弃键盘
    p.locator(".wish", has_text="机械键盘").get_by_role("button", name="不想要了").click()
    expect(p.locator(".done-wishes")).to_contain_text("省下 ¥600")
    # 「我们的花钱方式」里有心愿单的规则
    c.go("#/rules")
    expect(p.locator(".rule", has_text="心愿单")).to_contain_text("每月合计最多 ¥400")

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

    def deepseek(route):
        body = json.loads(route.request.post_data)
        user = body["messages"][-1]["content"]
        ids = {line.split(" | ")[1]: line.split(" | ")[0] for line in user.splitlines() if line.count(" | ") >= 5}
        ans = {"summary": "先买闲书，耳机等攒够再说。", "order": [ids.get("一本闲书"), ids.get("机械键盘"), ids.get("降噪耳机")],
               "items": [{"id": ids.get("一本闲书"), "when": "心愿基金够了，冷静期过了就买", "need": "想要", "comment": "想想会不会真的读完？"}]}
        route.fulfill(json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(ans, ensure_ascii=False)}}]})
    page.route("https://api.deepseek.com/**", deepseek)


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
        page.on("dialog", lambda d: d.accept(c.prompt) if d.type == "prompt" else d.accept())
        c = Ctx(page, repo)
        fake_externals(page)
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
