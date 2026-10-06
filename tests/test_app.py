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
from urllib.parse import quote
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
LAST_AI = []  # 最近一次发给 DeepSeek 的请求（检查有没有发不该发的东西）


def step(name):
    def wrap(fn):
        STEPS.append((name, fn))
        return fn
    return wrap


class Ctx:
    def __init__(self, page, repo, inventory=None):
        self.page, self.repo, self.inventory = page, repo, inventory
        self.prompt = ""  # 下一次 prompt() 弹窗填什么

    def data(self):
        # 修改是先存手机、后台上传的：等待上传队列清空再读仓库
        self.page.wait_for_function(
            "() => { try { const q = JSON.parse(localStorage.getItem('ledger-queue')); return !q || !q.items.length; } catch { return true; } }",
            timeout=15000)
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
    # 形象预算：单独一组，算进生活预算
    c.go("#/budget")
    p.get_by_label("形象").fill("150")
    p.get_by_role("button", name="保存").click()
    p.wait_for_function("location.hash === '#/'")
    assert c.data()["budget"]["look"] == 150
    c.add(66, cat="护肤", acc="生活费卡", note="编的洗面奶")
    assert c.tx()[-1]["category"] == "c-skin"
    c.go("#/rules")
    expect(p.get_by_text("买护肤品、化妆品、香水这些")).to_be_visible()
    c.go("#/budget")
    p.get_by_label("形象").fill("0")
    p.get_by_role("button", name="保存").click()
    p.wait_for_function("location.hash === '#/'")


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
        if name == "降噪耳机":
            sheet.get_by_role("button", name="提升幸福感").click()
        sheet.get_by_role("button", name="加进心愿单").click()
        expect(p.locator(".wish", has_text=name)).to_be_visible()
    expect(p.locator(".wish", has_text="一本闲书")).to_contain_text("冷静中，还剩 3 天")
    expect(p.locator(".wish", has_text="降噪耳机").locator(".wish-tags")).to_contain_text("提升幸福感")
    assert next(w for w in c.data()["wishes"] if w["name"] == "降噪耳机")["kind"] == "joy"
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
    expect(p.locator(".rule", has_text="心愿单：有闲钱再买")).to_contain_text("每月合计最多 ¥400")

@step("买不买：先问问题再给建议、价格换算、硬规则（动应急钱一定不建议）、放进心愿单、决定买去记账、只发汇总、小课堂、回访")
def _(c):
    p = c.page
    c.go("#/")
    p.get_by_role("link", name="想买个东西？问问买不买……").click()
    p.wait_for_function("location.hash === '#/ask'")
    # 小课堂
    p.get_by_role("button", name=re.compile("^储蓄率")).click()
    expect(p.locator(".sheet")).to_contain_text("储蓄率 = 存下的钱 ÷ 收入")
    p.locator(".sheet").get_by_role("button", name="问问 DeepSeek").click()
    expect(p.get_by_label("想问什么")).to_have_value("关于「储蓄率」，我想问：")
    p.get_by_label("想问什么").fill("")
    p.get_by_label("想问什么").dispatch_event("input")
    # 先问问题
    p.get_by_role("button", name="想买个 1200 的机械键盘").click()
    expect(p.locator(".msg.ai").last).to_contain_text("现在用的键盘坏了吗")
    sent = json.dumps(LAST_AI[0], ensure_ascii=False)
    assert "食堂午饭" not in sent and "老账" not in sent, "流水明细不该发给 DeepSeek"
    assert "相当于" in sent and "天的饭钱" in sent and "冷静" in sent, "网站算好的换算和规则要发过去"
    assert "抽纸 | 清洁用品 | ×0" in sent and "有没有类似的" in sent, "物品档案里已有的东西要发过去（买前查重）"
    p.get_by_label("想问什么").fill("坏了，每天都用")
    p.get_by_role("button", name="发送").click()
    last = p.locator(".msg.ai").last
    expect(last.locator(".verdict")).to_have_text("等等再说")
    expect(last.locator(".facts")).to_contain_text("天的饭钱")
    expect(last.locator(".facts")).to_contain_text("先冷静")
    n = len(c.data().get("wishes", []))
    last.get_by_role("button", name="放进心愿单").click()
    expect(last).to_contain_text("你的决定：放进心愿单")
    d = c.data()
    assert len(d["wishes"]) == n + 1 and d["wishes"][-1]["name"] == "机械键盘" and d["decisions"][-1]["choice"] == "wish"
    # 硬规则：动到应急钱的，就算 AI 说可以也显示不建议
    p.get_by_label("想问什么").fill("想买个 99999 的电脑")
    p.get_by_role("button", name="发送").click()
    last = p.locator(".msg.ai").last
    expect(last.locator(".verdict")).to_have_text("不建议")
    expect(last.locator(".facts")).to_contain_text("会动到应急钱")
    last.get_by_role("button", name="决定买").click()
    p.wait_for_function("location.hash.startsWith('#/add')")
    expect(p.get_by_label("金额", exact=True)).to_have_value("99999")
    expect(p.get_by_label("备注")).to_have_value("顶配电脑")
    # 回访：一个多月前决定买的东西
    d = c.data()
    d["decisions"].append({"id": "old", "at": (date.today() - timedelta(days=40)).isoformat(), "item": "台灯", "price": 120, "verdict": "buy", "choice": "buy"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/ask")
    p.reload()
    expect(p.locator(".review")).to_contain_text("「台灯」买了一个多月了")
    p.locator(".review").get_by_role("button", name="值").click()
    expect(p.locator(".review")).to_have_count(0)
    assert next(x for x in c.data()["decisions"] if x["id"] == "old")["review"] == "worth"
    # 设置里有手机提醒
    c.go("#/settings")
    expect(p.locator(".card", has_text="手机提醒")).to_contain_text("每晚 9 点")

@step("个税退税：兼职收入填被预扣的个税；按年汇总；去年的点「办好了」记退税收入")
def _(c):
    p = c.page
    c.go("#/add")
    p.locator(".segmented").get_by_role("button", name="收入").click()
    p.get_by_label("金额", exact=True).fill("1600")
    p.get_by_role("button", name="兼职", exact=True).click()
    p.get_by_label("被预扣的个税").fill("400")
    p.get_by_role("group", name="账户").get_by_role("button", name="生活费卡").click()
    n = len(c.tx())
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 1)
    assert c.tx()[-1]["tax"] == 400
    # 去年的兼职（被扣过税）
    y = date.today().year - 1
    d = c.data()
    d["tx"].append({"id": "lastyearjob", "type": "income", "date": f"{y}-11-02", "account": "a-live", "amount": 800, "category": "i-job", "tax": 200, "note": "", "createdAt": "2020-01-01T00:00:00Z"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/more")
    p.reload()
    p.get_by_role("link", name=re.compile("^个税退税")).click()
    this = p.locator(".card").filter(has=p.get_by_role("heading", name=f"{y + 1} 年", exact=True))
    expect(this).to_contain_text("¥400")
    expect(this).to_contain_text("明年 3 月 1 日到 6 月 30 日办")
    last = p.locator(".card").filter(has=p.get_by_role("heading", name=f"{y} 年", exact=True))
    expect(last).to_contain_text("¥200")
    last.get_by_role("button", name="办好了").click()
    p.locator(".sheet").get_by_label("退了多少").fill("200")
    n = len(c.tx())
    p.locator(".sheet").get_by_role("button", name="办好了").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    assert (t["category"], t["amount"]) == ("i-tax", 200) and c.data()["taxYears"][str(y)]["refund"] == 200, t
    expect(last).to_contain_text("退了 ¥200")


@step("订阅：一年花多少、改金额、加年费、停掉、体检；满 3 个月首页提醒")
def _(c):
    p = c.page
    d = c.data()
    d["subReview"] = {"last": (date.today() - timedelta(days=100)).isoformat()}
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/")
    p.reload()
    expect(p.locator(".cell.indicator", has_text="订阅体检")).to_be_visible()
    c.go("#/subs")
    expect(p.locator(".banner")).to_contain_text("该体检了")
    card = p.locator(".card.sub", has_text="订阅乙")
    expect(card).to_contain_text("¥8,400/年")  # 100 美元 × 12 × 7
    card.get_by_role("button", name="考虑降档").click()
    expect(card.get_by_role("button", name="考虑降档")).to_have_attribute("aria-pressed", "true")
    card.get_by_role("button", name="改").click()
    p.locator(".sheet").get_by_label("每次扣多少").fill("20")
    p.locator(".sheet").get_by_role("button", name="保存").click()
    expect(card).to_contain_text("¥1,680/年")
    # 加一个年费
    p.get_by_role("button", name="加一个订阅").click()
    sheet = p.locator(".sheet")
    sheet.get_by_label("名称").fill("笔记软件")
    sheet.get_by_label("每次扣多少").fill("68")
    sheet.get_by_role("button", name="每年").click()
    sheet.get_by_label("每年哪天续费").fill(f"{date.today().year}-05-25")
    sheet.get_by_role("group", name="从哪个账户扣").get_by_role("button", name="生活费卡").click()
    sheet.get_by_role("button", name="保存").click()
    expect(p.locator(".card.sub", has_text="笔记软件")).to_contain_text("每年 5月25日")
    r = next(x for x in c.data()["recurring"] if x["name"] == "笔记软件")
    assert r["yearly"] == "05-25" and r["remindOnly"] and "day" not in r, r
    p.locator(".card.sub", has_text="订阅甲").get_by_role("button", name="停掉", exact=True).click()
    expect(p.locator(".card.sub", has_text="订阅甲")).to_have_count(0)
    p.get_by_role("button", name="体检完了").click()
    expect(p.locator(".banner")).to_have_count(0)
    assert c.data()["subReview"]["last"] == TODAY
    c.go("#/")
    expect(p.locator(".cell.indicator", has_text="订阅体检")).to_have_count(0)


@step("存款目标：毕业过渡金的进度和每月要留多少")
def _(c):
    p = c.page
    c.go("#/goals")
    p.get_by_role("button", name="加一个存款目标").click()
    sheet = p.locator(".sheet")
    sheet.get_by_label("目标").fill("过渡金")
    sheet.get_by_label("要存多少").fill("20000")
    sheet.get_by_label("什么时候前存够").fill("2030-12-31")
    sheet.get_by_role("button", name="保存").click()
    card = p.locator(".card.goal", has_text="过渡金")
    expect(card).to_contain_text("平均每月留")
    g = c.data()["goals"][0]
    assert (g["target"], g["by"]) == (20000, "2030-12-31"), g

@step("没信号也能记：先存手机、立刻显示；离线刷新还在；有网后自动上传，和另一台设备的修改合并")
def _(c):
    p = c.page
    before = c.data()
    n = len(before["tx"])
    p.route(f"{API}/**", lambda r: r.abort())  # 断网
    c.go("#/add")
    p.get_by_label("金额", exact=True).fill("12")
    p.get_by_role("button", name="早餐", exact=True).first.click()
    p.get_by_label("备注").fill("离线记的")
    p.get_by_role("button", name="记好了").click()
    p.wait_for_function("location.hash === '#/'")
    expect(p.locator(".busy")).to_have_count(0)  # 不弹「正在保存」
    expect(p.locator(".tx", has_text="离线记的")).to_be_visible()
    expect(p.locator(".sync-pill")).to_contain_text("没网，1 项存在手机上")
    p.reload()
    expect(p.locator(".tx", has_text="离线记的")).to_be_visible()
    assert len(json.loads(c.repo.read("finance.json"))["tx"]) == n
    # 这期间另一台设备记了一笔
    d = json.loads(c.repo.read("finance.json"))
    d["tx"].append({"id": "otherdevice", "type": "expense", "date": TODAY, "account": "a-wechat", "amount": 7, "category": "c-drink", "note": "另一台设备", "createdAt": "2020-01-01T00:00:00Z"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    p.unroute(f"{API}/**")
    p.evaluate("window.dispatchEvent(new Event('online'))")
    d = c.data()
    notes = [t.get("note") for t in d["tx"]]
    assert "离线记的" in notes and "另一台设备" in notes and len(d["tx"]) == n + 2, notes[-3:]
    expect(p.locator(".sync-pill")).to_be_hidden()
    c.go("#/list")
    expect(p.locator(".tx", has_text="另一台设备")).to_be_visible()
    expect(p.locator(".tx", has_text="离线记的")).to_be_visible()

@step("暑假生活费自动目标、兼职三成进心愿基金、令牌到期提醒、预算调整建议（采用后改预算）、年度总结")
def _(c):
    p = c.page
    # 令牌还有 5 天过期
    exp = (date.today() + timedelta(days=5)).isoformat()
    p.evaluate(f"""() => {{ const s = JSON.parse(localStorage.getItem('inventory-settings')); s.tokenExpires = '{exp}'; localStorage.setItem('inventory-settings', JSON.stringify(s)); }}""")
    c.go("#/")
    p.reload()
    expect(p.locator(".token-banner")).to_contain_text("还有 5 天过期")
    # 暑假生活费
    c.go("#/goals")
    card = p.locator(".card.goal", has_text="暑假生活费")
    expect(card).to_contain_text("自动")
    expect(card.get_by_role("button", name="删掉")).to_have_count(0)
    # 兼职三成：前面记过 1600 + 去年 800 的兼职
    c.go("#/wishes")
    expect(p.get_by_text("其中兼职收入的三成进来了 ¥720")).to_be_visible()
    # 预算建议：挑最近 3 个完整、非暑假的预算月，日常每月只花 300
    d = c.data()
    cur = period_start(date.today())
    periods = []
    s0 = cur
    while len(periods) < 3:
        prev = period_start(s0 - timedelta(days=1))
        if prev.month not in (7, 8):
            periods.append((prev, s0))
        s0 = prev
    d["openingDate"] = period_start(s0 - timedelta(days=1)).isoformat()
    inside = lambda t: any(a.isoformat() <= t["date"] < b.isoformat() for a, b in periods)  # noqa: E731
    d["tx"] = [t for t in d["tx"] if not (inside(t) and t["type"] in ("expense", "writeoff"))]
    for a, _ in periods:
        d["tx"].append({"id": f"tissue{a}", "type": "expense", "date": a.isoformat(), "account": "a-live", "amount": 300, "category": "c-tissue", "note": "", "createdAt": "2020-01-01T00:00:00Z"})
        d["tx"].append({"id": f"lunch{a}", "type": "expense", "date": a.isoformat(), "account": "a-live", "amount": 1900, "category": "c-lunch", "note": "", "createdAt": "2020-01-01T00:00:00Z"})
        d["tx"].append({"id": f"fun{a}", "type": "expense", "date": a.isoformat(), "account": "a-live", "amount": 280, "category": "c-fun", "note": "", "createdAt": "2020-01-01T00:00:00Z"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/")
    p.reload()
    expect(p.locator(".cell", has_text="条调整建议")).to_be_visible()
    c.go("#/budget")
    adv = p.locator(".advice-card")
    daily = adv.locator(".advice-item", has_text="日常")
    expect(daily).to_contain_text("¥700 → ¥350")
    expect(daily).to_contain_text("纸巾清洁 月均 ¥300")
    expect(daily).to_contain_text("每月多存 ¥350")
    expect(adv.locator(".advice-item", has_text="订阅")).to_contain_text("¥900 → ¥150")
    expect(adv.locator(".advice-item", has_text="吃饭")).to_have_count(0)  # 吃饭花得和预算差不多，不用调
    adv.get_by_role("button", name=re.compile("^全部采用")).click()
    expect(adv).to_contain_text("不用调")
    b = c.data()["budget"]
    assert (b["daily"], b["sub"], b["food"]) == (350, 150, 2000), b
    assert len(c.data()["budgetHistory"]) == 2
    # 年度总结
    c.go("#/summary?mode=year")
    expect(p.locator(".summary-head")).to_contain_text(f"{date.today().year} 年收入")
    expect(p.get_by_role("img", name="每月存下")).to_be_visible()
    expect(p.get_by_text("花得最多的类别")).to_be_visible()

@step("流水搜索和筛选：全部时间里按名称、人名、金额搜，显示合计；按一整组类别筛选")
def _(c):
    p = c.page
    c.go("#/list")
    p.get_by_label("搜索流水").fill("二手")
    expect(p.locator(".tx")).to_have_count(1)
    expect(p.get_by_text("全部时间里找到 1 笔 · 支出 ¥680")).to_be_visible()
    expect(p.locator(".period-nav")).to_be_hidden()
    p.get_by_label("搜索流水").fill("小乙")
    expect(p.locator(".tx").first).to_contain_text("小乙")
    p.get_by_label("搜索流水").fill("")
    p.get_by_label("按类别筛选").select_option("g:food")
    expect(p.get_by_text(re.compile("^这个预算月找到"))).to_be_visible()
    for row in p.locator(".tx").all():
        assert "转账" not in row.inner_text()
    p.get_by_label("按类别筛选").select_option("")


@step("发钱日一条龙：收入到了点一下记上，「还没」今天不再问，再点一下从存钱卡转生活费")
def _(c):
    p = c.page
    cur = period_start(date.today())
    if cur.month in (7, 8):
        return  # 暑假那两个月没有收入，这一步只在平时测
    d = c.data()
    d["openingDate"] = "2020-01-01"
    d["categories"] += [{"id": "i-a", "name": "收入甲", "kind": "income"}, {"id": "i-b", "name": "收入乙", "kind": "income"}]
    d["tx"] = [t for t in d["tx"] if not (t["date"] >= cur.isoformat() and t["type"] == "transfer" and t["account"] == "a-save")]
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/")
    p.reload()
    card = p.locator(".payday")
    expect(card).to_contain_text("收入甲的 ¥4,000 到了吗？")
    card.locator(".payday-row", has_text="收入乙").get_by_role("button", name="还没").click()
    expect(card.locator(".payday-row", has_text="收入乙")).to_have_count(0)
    card.locator(".payday-row", has_text="收入甲").get_by_role("button", name="到了").click()
    sheet = p.locator(".sheet")
    expect(sheet.get_by_label("金额")).to_have_value("4000")
    expect(sheet.get_by_role("group", name="到了哪个账户").get_by_role("button", name="存钱卡")).to_have_attribute("aria-pressed", "true")
    n = len(c.tx())
    sheet.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    assert (t["type"], t["category"], t["amount"], t["account"]) == ("income", "i-a", 4000, "a-save"), t
    expect(card).to_contain_text("转这个月的生活费")
    card.get_by_role("button", name="转到生活费卡").click()
    b = c.data()["budget"]
    living = b["food"] + b["daily"] + b["free"]
    expect(p.locator(".sheet").get_by_label("转多少")).to_have_value(str(living))
    p.locator(".sheet").get_by_role("button", name="转好了").click()
    c.wait_saved(n + 2)
    t = c.tx()[-1]
    assert (t["type"], t["account"], t["to"], t["amount"]) == ("transfer", "a-save", "a-live", living), t
    expect(p.locator(".payday")).to_have_count(0)

@step("记账时提示上次的价格；里程碑祝贺；月度小信（DeepSeek 写，存下来）")
def _(c):
    p = c.page
    # 上次的价格（「比平时贵」要有 3 次以上的记录）
    d = c.data()
    d["tx"].append({"id": "lunch3", "type": "expense", "date": (date.today() - timedelta(days=1)).isoformat(), "account": "a-campus", "amount": 15, "category": "c-lunch", "note": "食堂午饭", "createdAt": "2020-01-01T00:00:00Z"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/list")
    p.reload()
    expect(p.locator(".tx", has_text="食堂午饭").nth(2)).to_be_visible()  # 新数据读到了
    c.go("#/add")
    p.get_by_role("button", name="午餐", exact=True).first.click()
    expect(p.locator(".price-memo")).to_contain_text("上次")
    p.get_by_label("备注").fill("食堂午饭")
    expect(p.locator(".price-memo")).to_contain_text("最近 3 次平均 ¥15")
    p.get_by_label("金额", exact=True).fill("40")
    expect(p.locator(".price-memo")).to_contain_text("这次比平时贵一些")
    # 里程碑：收到一大笔钱，总资产跨过好几个整数
    d = c.data()
    d["tx"].append({"id": "bigincome", "type": "income", "date": TODAY, "account": "a-save", "amount": 100000, "category": "i-other", "note": "测试", "createdAt": "2020-01-01T00:00:00Z"})
    c.repo.external_write("finance.json", json.dumps(d, ensure_ascii=False).encode())
    c.go("#/")
    p.reload()
    card = p.locator(".milestone")
    expect(card).to_contain_text("总资产第一次超过 ¥100,000")
    reached = c.data()["milestones"]["reached"]
    assert "a100000" in reached and reached["a100000"]["at"] == TODAY, reached
    card.get_by_role("button", name="好").click()
    expect(p.locator(".milestone")).to_have_count(0)
    p.reload()
    expect(p.locator(".milestone")).to_have_count(0)
    # 月度小信：上个预算月的总结
    prev_end = period_start(date.today()) - timedelta(days=1)
    c.go(f"#/summary?mode=month&day={prev_end.isoformat()}")
    expect(p.locator(".letter-text")).to_contain_text("这个月你把吃饭控制得很好")
    letters = c.data()["letters"]
    assert any("吃饭控制得很好" in x["text"] for x in letters.values()), letters
    p.reload()
    expect(p.locator(".letter-text")).to_contain_text("这个月你把吃饭控制得很好")

RECEIPT = {"shop": "测试超市", "date": TODAY, "total": 47.4, "items": [
    {"name": "可乐", "qty": 2, "price": 6, "category": "饮料奶茶"},
    {"name": "抽纸", "qty": 1, "price": 19.9, "category": "纸巾清洁"},
    {"name": "薯片", "qty": 1, "price": 8, "category": "零食"},
    {"name": "收纳盒", "qty": 1, "price": 15, "category": "收纳整理"},
    {"name": "优惠", "price": -1.5}]}


@step("导入小票：一样一样确认（类别、补货、建档），按类别合成几笔；物品档案补数量、划掉购物清单、进待建档；同一张再导提醒")
def _(c):
    p = c.page
    n = len(c.tx())
    c.go("#/add")
    p.get_by_role("link", name="有小票？一次导入一整张").click()
    expect(p.get_by_role("heading", name="导入小票")).to_be_visible()
    p.get_by_label("小票内容").fill("下面是整理好的：\n```json\n" + json.dumps(RECEIPT, ensure_ascii=False) + "\n```")
    p.get_by_role("button", name="下一步").click()
    expect(p.get_by_text("第 1 / 5 样")).to_be_visible()
    # 可乐：AI 给的类别；吃的喝的默认不进档案
    expect(p.get_by_label("类别")).to_have_value("c-drink")
    expect(p.get_by_role("group", name="物品档案").get_by_role("button", name="不进档案")).to_have_attribute("aria-pressed", "true")
    p.get_by_role("button", name="对，下一样").click()
    # 抽纸：档案里用完了的消耗品 → 补货；数量改成 2
    expect(p.get_by_text("第 2 / 5 样")).to_be_visible()
    expect(p.get_by_role("group", name="物品档案").get_by_role("button", name="补货：现在 ×0 → ×1")).to_have_attribute("aria-pressed", "true")
    p.get_by_label("数量").fill("2")
    p.get_by_label("数量").blur()
    expect(p.get_by_label("一共有几个")).to_have_value("2")
    p.get_by_role("button", name="对，下一样").click()
    # 薯片：购物清单上手动加的，会划掉
    expect(p.get_by_text("购物清单上的「薯片」会划掉")).to_be_visible()
    p.get_by_role("button", name="对，下一样").click()
    # 收纳盒：档案里没有 → 放进待建档
    expect(p.get_by_role("group", name="物品档案").get_by_role("button", name="放进「买回来还没建档」")).to_have_attribute("aria-pressed", "true")
    p.get_by_role("button", name="对，下一样").click()
    expect(p.get_by_text("优惠会并进金额最多的那一笔")).to_be_visible()
    p.get_by_role("button", name="对，看合计").click()
    expect(p.get_by_text("和小票实付对得上")).to_be_visible()
    expect(p.get_by_text("记账 4 笔")).to_be_visible()
    p.get_by_role("group", name="账户").get_by_role("button", name="生活费卡").click()
    p.get_by_role("button", name="全部保存").click()
    expect(p.get_by_text("记了 4 笔，共 ¥47.4")).to_be_visible()
    expect(p.get_by_text("补货 1 样，1 样等着建档，购物清单划掉 1 样")).to_be_visible()
    d = c.data()
    new = d["tx"][n:]
    assert sorted((t["category"], t["amount"]) for t in new) == [("c-drink", 6), ("c-snack", 8), ("c-storage", 15), ("c-tissue", 18.4)], new
    assert all(t["account"] == "a-live" and t["date"] == TODAY and t["receipt"] for t in new)
    assert next(t for t in new if t["category"] == "c-tissue")["note"] == "测试超市：抽纸×2、优惠 -1.5"
    inv = json.loads(c.inventory.read("inventory.json"))
    tissue = next(i for i in inv["items"] if i["name"] == "抽纸")
    assert tissue["quantity"] == 2 and "runningLow" not in tissue and "小票导入" in tissue["notes"], tissue
    sh = inv["shopping"]
    assert [e["name"] for e in sh["extra"]] == ["电池"], sh["extra"]
    assert [(e["name"], e["price"], e["paid"]) for e in sh["toFile"]] == [("收纳盒", 15, True)], sh["toFile"]
    assert sorted(x["name"] for x in sh["history"]) == ["抽纸", "收纳盒", "薯片"], sh["history"]
    # 同一张小票再导一次：提醒别记重了
    p.get_by_role("button", name="再导入一张").click()
    p.get_by_label("小票内容").fill(json.dumps(RECEIPT, ensure_ascii=False))
    p.get_by_role("button", name="下一步").click()
    expect(p.get_by_text("好像已经导入过了")).to_be_visible()


@step("小票没有 AI 也能贴（一行一样）；快捷指令带内容打开；剩下的按推荐；物品档案写不上可以再试")
def _(c):
    p = c.page
    n = len(c.tx())
    text = "楼下便利店\n矿泉水 2 4\n电池 ×4 12.5\n合计 16.5"
    c.go("#/receipt?text=" + quote(text))
    expect(p.get_by_text("第 1 / 2 样")).to_be_visible()
    assert p.evaluate("location.hash") == "#/receipt"  # 网址里的内容用完就去掉
    expect(p.get_by_label("类别")).to_have_value("c-drink")
    p.get_by_role("button", name="剩下的都按推荐，直接看合计").click()
    expect(p.get_by_text("和小票实付对得上")).to_be_visible()
    # 物品档案这时连不上：账照样记好，可以再试
    p.route(f"{API}/repos/x/inventory-data/**", lambda r: r.abort())
    p.get_by_role("button", name="全部保存").click()
    expect(p.get_by_text("物品档案没更新上")).to_be_visible()
    assert len(c.tx()) == n + 2
    p.unroute(f"{API}/repos/x/inventory-data/**")
    p.get_by_role("button", name="再试一次").click()
    expect(p.get_by_text("购物清单划掉 1 样")).to_be_visible()
    assert json.loads(c.inventory.read("inventory.json"))["shopping"]["extra"] == []


@step("Siri 一句话记账：打开填好的记一笔；删一笔直接删、可以撤销")
def _(c):
    p = c.page
    n = len(c.tx())
    c.go("#/add?text=" + quote("午饭 18块5"))
    expect(p.get_by_text("听到：「午饭 18块5」")).to_be_visible()
    expect(p.get_by_label("金额", exact=True)).to_have_value("18.5")
    expect(p.get_by_role("button", name="午餐", exact=True).first).to_have_attribute("aria-pressed", "true")
    p.get_by_role("button", name="记好了").click()
    c.wait_saved(n + 1)
    t = c.tx()[-1]
    assert (t["amount"], t["category"], t["note"]) == (18.5, "c-lunch", "午饭"), t
    c.go("#/siri")
    expect(p.locator("code", has_text="#/add?text=")).to_be_visible()
    # 删掉刚才那笔：不弹确认，底部可以撤销
    c.go(f"#/add?edit={t['id']}")
    p.get_by_role("button", name="删除").click()
    toast = p.locator(".toast.undo")
    expect(toast).to_contain_text("删掉了：午餐")
    c.wait_saved(n)
    toast.get_by_role("button", name="撤销").click()
    expect(p.get_by_text("已撤销")).to_be_visible()
    c.wait_saved(n + 1)
    assert c.tx()[-1]["id"] == t["id"]


@step("账单查漏记：微信 Excel + 支付宝 GBK CSV；记过的跳过、退款提现不算、转账默认不记；补记带单号，记住付款方式；再导一次都对上")
def _(c):
    p = c.page
    c.add(15.03, cat="早餐", acc="微信", note="食堂")
    n = len(c.tx())
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    for row in [["微信支付账单明细"], ["微信昵称：[测试]"], ["----------------------微信支付账单明细列表--------------------"],
                ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
                [f"{TODAY} 08:00:00", "商户消费", "食堂", "早餐", "支出", "¥15.03", "零钱", "支付成功", "wx1", "/", "/"],
                [f"{TODAY} 09:00:00", "商户消费", "瑞幸咖啡", "拿铁", "支出", "¥9.97", "零钱", "已全额退款", "wx2", "/", "/"],
                [f"{TODAY} 10:00:00", "零钱提现", "招商银行", "/", "/", "¥100.00", "零钱", "提现已到账", "wx3", "/", "/"],
                [f"{TODAY} 12:01:02", "商户消费", "美团外卖", "美团订单", "支出", "¥23.47", "零钱", "支付成功", "wx4", "/", "/"],
                [f"{TODAY} 18:00:00", "转账", "小王", "/", "支出", "¥50.01", "零钱", "对方已收钱", "wx5", "/", "/"]]:
        ws.append(row)
    wx = ART / "微信账单.xlsx"
    wb.save(wx)
    ali = ART / "支付宝账单.csv"
    ali.write_bytes(("支付宝交易明细\n交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n"
                     f"{TODAY} 20:00:00,交通出行,滴滴出行,x@x.com,打车,支出,18.61,中国银行储蓄卡(1234),交易成功,ali1\t,T1\t,,\n").encode("gbk"))
    c.go("#/more")
    p.get_by_role("link", name=re.compile("^账单查漏记")).click()
    p.get_by_label("选账单文件").set_input_files([str(wx), str(ali)])
    expect(p.get_by_text("没记的第 1 / 3 笔")).to_be_visible()
    expect(p.get_by_text("记过的 1 笔已经跳过")).to_be_visible()
    expect(p.get_by_text("美团外卖")).to_be_visible()
    expect(p.get_by_label("类别")).to_have_value("c-takeout")
    expect(p.get_by_role("group", name="账户").get_by_role("button", name="微信")).to_have_attribute("aria-pressed", "true")
    p.get_by_role("button", name="记上").click()
    expect(p.get_by_text("这是转给个人的钱")).to_be_visible()
    p.get_by_role("button", name="不记").click()
    expect(p.get_by_text("滴滴出行")).to_be_visible()
    expect(p.get_by_label("类别")).to_have_value("c-taxi")
    p.get_by_role("group", name="账户").get_by_role("button", name="生活费卡").click()
    p.get_by_role("button", name="记上").click()
    expect(p.get_by_text("补记 2 笔，共 ¥42.08")).to_be_visible()
    p.get_by_role("button", name="全部记上").click()
    expect(p.get_by_text("补记了 2 笔")).to_be_visible()
    d = c.data()
    new = d["tx"][n:]
    assert sorted((t["category"], t["amount"], t["account"], t["bill"]) for t in new) == [("c-takeout", 23.47, "a-wechat", "wx4"), ("c-taxi", 18.61, "a-live", "ali1")], new
    assert d["settings"]["payMethods"]["alipay:中国银行储蓄卡(1234)"] == "a-live"
    # 再导一次：都对上了
    p.get_by_role("button", name="再对一份").click()
    p.get_by_label("选账单文件").set_input_files([str(wx), str(ali)])
    expect(p.get_by_text("没有漏记的")).to_be_visible()


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


# 物品档案（导入小票写进去）：抽纸用完了、购物清单上手动加了薯片和电池
def inventory_seed():
    I = lambda i, name, tag, **kw: {"id": i, "name": name, "assetId": None, "location": "L1", "tags": [tag], "quantity": 1, "fields": {},  # noqa: E731,E741
                                    "photos": [], "receipts": [], "notes": "", "archived": False, "consumable": False, **kw}
    data = {"version": 1, "tags": ["清洁用品", "电子产品"], "locations": [{"id": "L1", "name": "储物间", "parent": None, "assetId": None}],
            "items": [I("i1", "抽纸", "清洁用品", quantity=0, consumable=True, runningLow="2026-10-01"), I("i2", "台灯", "电子产品")],
            "shopping": {"extra": [{"id": "e1", "name": "薯片"}, {"id": "e2", "name": "电池"}], "skip": {}, "history": [], "toFile": []}}
    return {"inventory.json": json.dumps(data, ensure_ascii=False).encode()}


def fake_externals(page):
    page.route("https://api.frankfurter.dev/**", lambda r: r.fulfill(json={"base": "USD", "rates": {"CNY": 7.0}}))

    def deepseek(route):
        body = json.loads(route.request.post_data)
        user = body["messages"][-1]["content"]
        system = body["messages"][0]["content"]
        LAST_AI.clear()
        LAST_AI.append(body)
        if "理财小伙伴" in system:
            ans = {"letter": "这个月你把吃饭控制得很好，比预算少花了一些。下个月试试每周日看一眼周总结。"}
            return route.fulfill(json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(ans, ensure_ascii=False)}}]})
        if "理财小助手" in system:
            if "99999" in user:
                ans = {"answer": "这个太贵了，不过你想买的话也行。", "verdict": "buy", "item": {"name": "顶配电脑", "price": 99999}}
            elif "键盘" in user:
                ans = {"answer": "现在用的键盘坏了吗？多久用一次？", "verdict": None, "item": {"name": "机械键盘", "price": 1200}}
            elif "坏了" in user:
                ans = {"answer": "每天都用、旧的坏了，值得买；不过 1200 不少，先冷静几天、等双十一看看。", "verdict": "wait", "item": {"name": "机械键盘", "price": 1200}}
            else:
                ans = {"answer": "这个月吃饭花得最多，整体在预算内。", "verdict": None, "item": None}
            return route.fulfill(json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(ans, ensure_ascii=False)}}]})
        ids = {line.split(" | ")[1]: line.split(" | ")[0] for line in user.splitlines() if line.count(" | ") >= 5}
        ans = {"summary": "先买闲书，耳机等攒够再说。", "order": [ids.get("一本闲书"), ids.get("机械键盘"), ids.get("降噪耳机")],
               "items": [{"id": ids.get("一本闲书"), "when": "心愿基金够了，冷静期过了就买", "need": "想要", "comment": "想想会不会真的读完？"}]}
        route.fulfill(json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(ans, ensure_ascii=False)}}]})
    page.route("https://api.deepseek.com/**", deepseek)


@step("外观和「生活」一致：问候、预算月和发工资小标签、还能花的圆环、角落一句；记账页不放")
def _(c):
    p = c.page
    c.go("#/")
    expect(p.locator(".today-head .greet")).to_have_text(re.compile("好|夜深"))
    expect(p.locator(".head-tags .tag").first).to_have_text(re.compile("月预算 · 第 \\d+ 天"))
    expect(p.locator(".spend-left .ring")).to_be_visible()
    expect(p.locator(".whisper")).to_have_count(1)
    p.wait_for_timeout(600)
    p.screenshot(path=ART / "look-home.png")
    c.go("#/add")
    expect(p.locator(".whisper")).to_have_count(0)


def main():
    only = sys.argv[1:]
    ART.mkdir(exist_ok=True)
    repo = FakeRepo({"README.md": b"# finance-data\n"})
    inventory = FakeRepo(inventory_seed())
    serve({REPO: repo, "x/inventory-data": inventory}, API_PORT)
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
        c = Ctx(page, repo, inventory)
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
