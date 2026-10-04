# 账本 — 给 Claude Code 的说明

用户的个人记账网站。用中文交流。用户对理财不太熟、容易焦虑：界面先说结论、用大白话解释，每页角落有「?」怎么用（`helpButton`），不制造焦虑（小超支只黄色提示）。

## 结构

- **本仓库 `ThreeLu/ledger`（公开）**：纯静态网页，GitHub Pages 发布在 https://threelu.github.io/ledger/ 。推送到 main 自动上线。
- **数据仓库 `ThreeLu/finance-data`（私有）**：`finance.json`。网页用 fine-grained 令牌（和物品档案同一个，额外授权这个仓库）通过 GitHub API 读写，每次修改一次提交。
- **代码是公开的：绝不能写进任何个人信息**——银行卡名、收入来源和金额、订阅、饮食习惯、余额都只放在私有的 `finance.json`。`defaultData()` 只放通用默认值；「我们的花钱方式」页面、记账提示（`settings.payNote`）、转账常用路线（`presets`）都从数据生成。测试里也只用编的名字和数字。
- 和物品档案（`threelu.github.io/inventory`）同源：没有账本令牌时直接用 `localStorage['inventory-settings']` 的令牌。
- 用户不想在本地留数据：不要把数据仓库 clone 到本地长期保存。

## 数据格式（finance.json）

```
{ version, openingDate,
  settings: { periodStartDay, expectedIncome, emergencyFloor, floorAccount, usdRate, summerMonths: [月], sideIncomeSave, payNote },
  accounts: [{ id, name, currency: 'CNY'|'USD', opening, note }],
  categories: [{ id, name, kind: 'expense'|'income', group: 'food'|'daily'|'free'|'sub'|'none' }],
  budget: { food, daily, free, sub }, notes: { 组: 说明 }, incomePlan: [{ name, amount, when, use }],
  presets: [{ name, from, to }], recurring: [{ id, name, amount, account, category, day, since, lastPosted } | { yearly: 'MM-DD', remindOnly }],
  quick: [{ id, name, amount, category, account }],
  claims: [{ id, name, payer, createdAt, status: 'open'|'settled', settledAt, docs: [{ file, name, kind: 'pdf'|'image', submitted }] }],
  people: [{ id, name }], reconciled: { 预算月开始日: 对账日 },
  tx: [{ id, type, date, account, amount, cny?, category?, to?, toAmount?, claim?, person?, group?, note, auto?, createdAt }] }
```

- tx.type：`expense` 支出、`income` 收入、`transfer` 转账、`adjust` 对账差额，以及「钱动了但不算收支」的：`advance` 垫付 / 借给别人 / AA 里别人那份（钱出去，别人欠我）、`repay` 报销到账 / 别人还我、`payback` 我还别人；`expense` 没有 account、有 person = 别人替我付（算花销，账户不动，我欠他）；`writeoff` 垫付结清时报不回的部分（算花销，类别「出差自付」group none，没有 account）。
- 卡和欠款分开：欠款按 claim / person 算（`claimStatus`、`personStatus`，先进先出算「拖了多久」），还到哪张卡都行。AA 的几笔共用 `group`，删花销时一起删。
- 发票存私有仓库 `claims/<claimId>/<随机>.pdf|jpg`（照片压缩），删除时一起删文件。

- 余额 = `opening` + 每笔的进出（`money.js` 的 `delta`）。**转账不算收支**；美元账户金额按美元，花销另存 `cny`（记账当时的汇率，Frankfurter 接口每天查一次，存在 localStorage）。`adjust` 是「校准」产生的对账差额，不算预算。
- 预算月从 `periodStartDay` 号到下个月前一天（`periodOf`）。开始记账那天在预算月中间时，这个月预算按天数折算、收入不估（`partial`）。`summerMonths` 开始的预算月没有收入。
- 健康指标（`health()`）：安全垫（总资产 ÷ 月预算）、应急钱底线、花钱节奏（只看 food/daily/free）、本月存钱、即将扣款（美元账户够不够付接下来 35 天的订阅）、待收回（垫付超过 30 天、人情超过 14 天提醒）、对账（完整预算月还没对）、年费提醒。每项 level good/warn/bad + 大白话 text + 该做什么 action；`headline()` 是首页最上面那句。解释文字在 `main.js` 的 `EXPLAIN`。
- 固定扣费到日子自动记（`duePostings`，`lastPosted` 防重复；在 `store.save` 的修改函数里重新算，两台设备同时打开也不会重复）。
- `migrate()` 给旧数据补字段，加功能时在这里补。

## 代码

- `js/money.js` 纯计算（可以用 node 直接测）；`js/summary.js` 周 / 月总结的数（一周从周一开始，月总结按预算月，`advice()` 只给一条建议）；`js/charts.js` SVG 图表（柱状、环形、折线，颜色用 CSS 变量）；`js/store.js` 读写（422 冲突重试）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不用 innerHTML 拼数据，令牌在 localStorage）；`js/main.js` 路由和页面。没有构建步骤。
- 外观和物品档案一致：无印良品底色 + 苹果风，主色藤紫，颜色在 `css/app.css` 的 `:root`。

## 测试

- `python3 tests/test_app.py`：真浏览器 + 本地假 GitHub（`tests/fake_github.py`），汇率用假数据。推送后 GitHub Actions 自动跑。**改了功能就加对应步骤。**
- 网页通过 `localStorage['ledger-api-base']` 接到假 GitHub。
- **绝不拿真实数据仓库做写入测试。**

## 计划（分批做）

1. ✅ 记账、账户、转账、预算、首页总况和健康指标、「我们的花钱方式」。
2. ✅ 垫付报销（按「一件事」归组，发票 PDF/照片存私有仓库，报不回的部分结清时算「出差自付」，不占日常预算）、人情账（按人记谁欠谁，还到哪张卡都行）、每月对账、每周 / 每月总结图表。
3. 存钱计划（暑假备用金、出游、大件）、「买不买」聊天（DeepSeek，只发汇总数字；理财小课堂放在聊天页）、推送（每晚 9 点没记账提醒；周日、每月最后一天推总结）。
