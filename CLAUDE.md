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
  categories: [{ id, name, kind: 'expense'|'income', group: 'food'|'daily'|'free'|'look'|'sub'|'none' }],
  budget: { food, daily, free, look, sub }, notes: { 组: 说明 }, incomePlan: [{ name, amount, when, use }],
  presets: [{ name, from, to }], recurring: [{ id, name, amount, account, category, day, since, lastPosted } | { yearly: 'MM-DD', remindOnly }],
  quick: [{ id, name, amount, category, account }],
  claims: [{ id, name, payer, createdAt, status: 'open'|'settled', settledAt, docs: [{ file, name, kind: 'pdf'|'image', submitted }] }],
  people: [{ id, name }], reconciled: { 预算月开始日: 对账日 },
  wishes: [{ id, name, price, want: 'bit'|'nice'|'want'|'very'|'most', kind: ''|'need'|'grow'|'joy'|'feel'|'gift', reason, link, targetDate, createdAt, status: 'open'|'bought'|'dropped', boughtAt, boughtPrice }],
  wishAdvice: { at, summary, order: [id], items: { id: { when, need, comment } } }, categoryVersion,
  decisions: [{ id, at, item, price, verdict, choice: 'buy'|'wish'|'skip', review?: 'worth'|'meh'|'regret' }],
  taxYears: { 年: { done, refund } }, subReview: { last, notes: { 订阅id: 'keep'|'downgrade'|'stop' } }, goals: [{ id, name, target, by, note }],
  tx: [{ id, type, date, account, amount, cny?, category?, what?, to?, toAmount?, claim?, person?, group?, note, auto?, receipt?, from?, bill?, billParty?, createdAt }] }
```

- tx.type：`expense` 支出、`income` 收入、`transfer` 转账、`adjust` 对账差额，以及「钱动了但不算收支」的：`advance` 垫付 / 借给别人 / AA 里别人那份（钱出去，别人欠我）、`repay` 报销到账 / 别人还我、`payback` 我还别人；`expense` 没有 account、有 person = 别人替我付（算花销，账户不动，我欠他）；`writeoff` 垫付结清时报不回的部分（算花销，类别「出差自付」group none，没有 account）。
- 卡和欠款分开：欠款按 claim / person 算（`claimStatus`、`personStatus`，先进先出算「拖了多久」），还到哪张卡都行。AA 的几笔共用 `group`，删花销时一起删。
- 类别：`EXPENSE_CATEGORIES`（大组 group 管预算，小组 sub 只为好找，日常先点小组再点类别）。改类别时提高 `CATEGORY_VERSION`，`migrate()` 会给老账本改名、补新的、按默认顺序排；不用的老类别 `hidden`（老账照样显示名字）。`c-wish`、`c-trip` 只由心愿单、垫付自动记。选「其他」（`FREEFORM`）必须写 `what`（具体是什么），流水里显示它。
- 心愿单：`settings.wishBigFrom`（300）以内是小额，用「心愿基金」= 每个结束的预算月生活预算的结余（超支扣回，最低 0）减去小额心愿花的；以上是大额，每个结束的预算月按心愿单顺序攒，合计不超过 `wishMonthlyCap`（400）。都是现算的（`wishFunds`、`bigWishPlan`），钱不挪账户。买了记 `c-wish`（不占预算）；小额超出基金的部分记 `c-like`（自由钱）。冷静 `coolDays` 天。分类 `kind`（选填，`WISH_KIND`）：生活必需品、提升自己、提升幸福感、情怀、送人（送人时日期框改成「哪天前送出去」），卡片上显示，也发给 DeepSeek。想要程度 5 档（`WANT`，从低到高：有点想、有了更好、想要、很想要、非常想要；老数据只有 very / nice，键名没变）。排序（`WISH_SORTS`：攒钱顺序、冷静期、价格（再点一下高低切换）、想要程度、加入时间、DeepSeek 建议）只改显示，存 localStorage `ledger-wish-sort`；只有「攒钱顺序」时显示 ↑↓。
- DeepSeek：密钥先读账本仓库 `config/ai.json`，没有就读物品档案仓库的（同一个令牌）。只发心愿单和汇总数字，不发流水明细；建议存 `wishAdvice`，密钥不进 finance.json。
- 买不买（`#/ask`）：话里有价格时网站先算 `priceFacts`（几天饭钱、几个月自由钱、存钱目标晚几天、大额要攒几个月）和硬规则（价格 > 总资产 − 应急底线 − 本月还要花的生活费 → 一定「不建议」，前端强制；大额建议先冷静），连同 `moneyContext`（只有汇总数字，不发流水明细和备注）给 DeepSeek。聊天只在内存，决定存 `decisions`，买了的 30 天后回访。理财小课堂（`lessons()`）是写死的大白话 + 他自己的数字，不推荐具体产品。
- 个税退税：兼职收入（`i-job`）可填 `tax`（被预扣的个税），`taxYear()` 按年汇总；每年 3/1–6/30（`taxSeason`）上一年有预扣且没办（`taxYears[年].done`）就首页提醒、推送（3/1、3/15、4/15、5/15、6/15、6/25）；办好后记一笔 `i-tax` 收入。
- 订阅体检：`subReview.last` 起满 90 天提醒（首页 + 推送：当天、之后每 14 天），`#/subs` 可改金额、加每月 / 每年的订阅、停掉（只停自动记账，订阅本身要去 App Store 取消）。
- 暑假生活费：`summerGoal()` 自动生成（预算 × 没收入的月数，第一个没收入的预算月开始前一天存够），排在存款目标最前面；暑假预算月头 5 天首页提醒转生活费，推送在那几个月的发钱日。
- 兼职收入的 `1 − sideIncomeSave`（三成）自动进心愿基金（`wishFunds` 里算）。
- 预算调整建议 `budgetAdvice()`：最近 3 个完整、非暑假的预算月（至少 2 个）；一直 ≤ 85% 建议调低到 max(平均 × 1.1, 最多那个月)（自由钱不低于 200），≥ 2 个月超 5% 建议调高到平均；订阅按登记的实际金额。采用记 `budgetHistory`，「这个月先不改」记 `budgetAdviceDismissed[组] = 预算月开始日`。
- 发钱日一条龙 `payday()`：收入计划（`incomePlan`，按名字或 `category` 对应收入类别）这个预算月没到的，首页卡片问「到了吗」（到了 → 金额预填、账户默认存钱卡；还没 → 当天不再问，记在 `data.payday[预算月].later`）；有收入到了（或暑假）且这个月还没从存钱卡转出过，就提供按 `presets` 一步转生活费（默认生活预算），「这个月不用」记 `noTransfer`。开始记账那个不完整的预算月不问。
- 流水搜索：有字时搜全部时间（标题、备注、what、类别、账户、人、垫付、金额、日期，空格 = 同时满足），类别可选单个或整组；显示合计。筛选条件存在内存 `listFilter`。
- 记账时的价格提示：选了支出类别后，在「记好了」上面显示上次同类（有备注就按同样的备注、「其他」按 what）花了多少、最近 5 次平均；有 3 次以上记录时，明显贵（> 平均 1.3 倍）或便宜会说。
- 里程碑 `newMilestones()`：总资产第一次超过 2 万、3 万、5 万……（开始记账时就超过的不算），连续 1/3/6/12/24 个完整非暑假预算月存钱达标；打开时检查，记 `milestones.reached`，首页祝贺 7 天或点「好」（`seen`）。年度总结里列出当年的。
- 月度小信：结束了、有记录的预算月，打开月总结时（最近结束的那个自动，更早的点按钮）DeepSeek 用汇总数字写 120～220 字，存 `letters[预算月]`。
- 年度总结 `yearSummary()`（自然年），总结页「年」；1 月 1 日推送、1 月头一周首页提醒。
- 令牌到期：读物品档案设置里的 `tokenExpires`，14 天内首页提示。
- 存款目标 `goals`（比如毕业过渡金）：不另外挪钱，存钱卡余额 − 应急底线 − 大额心愿已攒的，按顺序算进度和每月要留多少（`goalStatus`）。
- 推送：`js/push.js`（账本自己的 VAPID 公钥，和物品档案不是一对）+ `sw.js`，订阅存账本仓库 `config/push.json`；账本仓库 `.github/workflows/push.yml` 每天 13:00 UTC（北京 21 点）跑 `.github/ledger_push.py`：没记账提醒、周日加周总结、预算月最后一天加月总结，合成一条。私钥只在账本仓库 secret `VAPID_PRIVATE_KEY`。
- 发票存私有仓库 `claims/<claimId>/<随机>.pdf|jpg`（照片压缩），删除时一起删文件。

- 余额 = `opening` + 每笔的进出（`money.js` 的 `delta`）。**转账不算收支**；美元账户金额按美元，花销另存 `cny`（记账当时的汇率，Frankfurter 接口每天查一次，存在 localStorage）。`adjust` 是「校准」产生的对账差额，不算预算。
- 预算月从 `periodStartDay` 号到下个月前一天（`periodOf`）。开始记账那天在预算月中间时，这个月预算按天数折算、收入不估（`partial`）。`summerMonths` 开始的预算月没有收入。
- 健康指标（`health()`）：安全垫（总资产 ÷ 月预算）、应急钱底线、花钱节奏（只看 food/daily/free）、本月存钱、即将扣款（美元账户够不够付接下来 35 天的订阅）、待收回（垫付超过 30 天、人情超过 14 天提醒）、对账（完整预算月还没对）、年费提醒。每项 level good/warn/bad + 大白话 text + 该做什么 action；`headline()` 是首页最上面那句。解释文字在 `main.js` 的 `EXPLAIN`。
- 固定扣费到日子自动记（`duePostings`，`lastPosted` 防重复；在 `store.save` 的修改函数里重新算，两台设备同时打开也不会重复）。
- `migrate()` 给旧数据补字段，加功能时在这里补。
- 导入小票（`#/receipt`，`js/receipt.js` 纯计算 + `main.js` 页面）：用户把小票照片和「复制提示词」（`receiptPrompt`，类别名从数据里取）发给手机上的 AI，回答贴回来（或快捷指令带 `?text=`，用完从网址去掉）。`parseReceipt` 先找 JSON，不是就按行认「名称 数量 价格 / 合计」。一样一样确认：名称、数量、实付、类别（`guessCategory`：AI 给的类别名 → 以前同名的 → 关键词 `BY_WORD` → 宿舍小物件）、物品档案怎么处理（`matchInventory` 同名 / 包含，消耗品优先；默认 `defaultInventoryAction`：消耗品补货、耐用的不动、没有的吃喝不进档案其他进待建档）。可以「这样不记」「剩下的都按推荐」。**按类别合并成几笔**（用户选的），整单优惠并进最大那笔，备注「店名：名称×数量、…」，每笔带 `receipt` 指纹（日期 + 名称价格），同一张再导时提醒。记账走本地队列；物品档案（`js/bridge.js`，同一个令牌直接提交 inventory.json，`applyToInventory`）要联网，失败了可以「再试一次」，账不受影响。
- 生活网站（`../life`）的「想做到的事」可以往 `wishes` 直接加心愿（`reason` 是「为了：目标名」，`want: 'want'`），见 life/CLAUDE.md。
- 物品档案那边「买回来了」、新建物品填了价格时也会直接往 `tx` 加支出（带 `from: 'inventory'`），见 inventory/CLAUDE.md。
- Siri（`#/siri` 有做快捷指令的步骤）：快捷指令打开 `#/add?text=一句话`，`parseSpoken` 认金额（「18块5」= 18.5）、类别（快捷记账名 → 类别名 → 常说的叫法 `SPOKEN` → 以前的备注 → 关键词），预填后还是要点「记好了」；`#/receipt?text=` 打开导入小票。快捷指令打开的是 Safari（和主屏幕图标各存各的），没令牌时记下要去的页面（`ledger-after-login`），填好令牌再跳过去。
- 账单查漏记（`#/bills`，「更多」和对账页有入口）：`js/sheet.js` 读 CSV（UTF-8 / GBK 自动认）和 xlsx（自己解 zip，`DecompressionStream`）；`js/bills.js` 的 `parseBill` 按「交易时间 / 金额」那一行找表头，按列名取（微信、支付宝列名不同），`matchBills`：只看「支出」，退款 / 关闭 / 不计收支不算，开始记账前的不算，`bill` 单号相同直接认，否则账本里有账户的支出、垫付、转出、还钱（AA 按 group 合计）金额相同、日期差 ≤2 天的配上（每笔只用一次）。没配上的一笔笔确认：类别 `guessBillCategory`（同一 `billParty` 上次的类别 → 商家表 `MERCHANTS` → 商品名关键词），账户 `guessAccount`（`settings.payMethods` 记住的「来源:付款方式」→ 微信零钱找名字带「微信」的 → 上次用的），转账 / 红包 `isPersonal` 默认不记。补记的 tx 带 `bill`、`billParty`。
- 买不买、心愿单建议会带上物品档案里已有的东西（`inventoryContext()`：名称、类别、数量、部位颜色季节、穿了几次、价格；不发照片序列号备注；缓存 5 分钟），规则 `INVENTORY_RULE`：有类似的就点出来，买不买他自己定（用户 2026-10-04 要求）。
- 推送脚本（数据仓库 `.github/ledger_push.py`）：一晚上错开整点排三次 cron，`once()` 用 `config/push-sent.json` 保证一天只发一次、23 点后不发（GitHub 定时整点常被跳过）。
- 手机丢了（`#/lost`）：删令牌、换令牌的步骤 + 两个仓库最近的修改按设备统计（提交说明末尾「 · 设备」，`github.js` 的 `DEVICE` / `recentCommits`）。
- 撤销代替确认：`saveUndoable(message, fn, doneText)` 先做，底部 `undoToast`「…  撤销」6 秒，撤销 = 把 `diff(改后, 改前)` 套回去。用在删一笔、放弃心愿、停订阅、删存款目标；删垫付（连发票文件）、退出仍然 `confirm`。

## 代码

- **先存手机、后台上传**（`js/store.js`）：`save()` 在本地数据上改、算 patch（带 id 的列表按 id 增改删和顺序，普通对象按字段，其他整个替换）进 localStorage 队列 `ledger-queue`，页面立刻更新；`sync()` 在 GitHub 最新数据上套 patch 提交，没网 20 秒后重试、`online` 事件马上重试。页面顶部的 `.sync-pill` 只在没网 / 失败 / 上传超过 1.5 秒时出现。上传发票、删文件、自动记固定扣费走 `online`（直接提交）。测试里 `Ctx.data()` 会先等队列清空。
- `js/money.js` 纯计算（可以用 node 直接测）；`js/summary.js` 周 / 月总结的数（一周从周一开始，月总结按预算月，`advice()` 只给一条建议）；`js/charts.js` SVG 图表（柱状、环形、折线，颜色用 CSS 变量）；`js/store.js` 读写（422 冲突重试）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不用 innerHTML 拼数据，令牌在 localStorage）；`js/main.js` 路由和页面。没有构建步骤。语法检查用 `node --input-type=module --check < js/main.js`（直接 `node --check 文件` 漏过过括号错误）。
- 外观和物品档案、生活一致（2026-10）：无印良品底色 + 苹果风，主色藤紫，颜色在 `css/app.css` 的 `:root`；页面大标题、卡片小标题用宋体（`--serif`），正文苹方。首页开头 `homeHeader`：日期 → 宋体问候（`greeting`）→「N 月预算 · 第 N 天」「离发工资还有 N 天」两个小标签；「这个月还能花」左边圆环是生活预算用了多少（超了变红）。**不盖章**（用户说的）。每页最下面角落一句（`js/words.js`，花钱观，安静的短句，每页每天一句；记账、小票、设置这些页面不放）。点选标签轻轻弹一下（`.pop`）、换页淡入、浅色时底色随节气微变（`js/solar.js`，和 life 仓库同一份算法，改了三边一起改）。话要温柔、短，不说教。

## 测试

- `python3 tests/test_app.py`：真浏览器 + 本地假 GitHub（`tests/fake_github.py`，同时开账本和编的物品档案 `x/inventory-data` 两个仓库），汇率用假数据。推送后 GitHub Actions 自动跑。**改了功能就加对应步骤。**
- 网页通过 `localStorage['ledger-api-base']` 接到假 GitHub。
- **绝不拿真实数据仓库做写入测试。**

## 计划（分批做）

1. ✅ 记账、账户、转账、预算、首页总况和健康指标、「我们的花钱方式」。
2. ✅ 垫付报销（按「一件事」归组，发票 PDF/照片存私有仓库，报不回的部分结清时算「出差自付」，不占日常预算）、人情账（按人记谁欠谁，还到哪张卡都行）、每月对账、每周 / 每月总结图表。
2.5 ✅ 类别细分（三餐拆开、日常分小组）、心愿单（小额 / 大额、DeepSeek 建议）。
3. ✅ 存钱计划已并进大额心愿（暑假出游也建成大额心愿）；「买不买」聊天（DeepSeek，只发汇总数字；理财小课堂放在聊天页）、推送（每晚 9 点没记账提醒；周日、每月最后一天推总结）。

- 形象（2026-10-05 加，`CATEGORY_VERSION` 3）：护肤 / 化妆 / 香水和打理单独一组 `look`，算进生活预算（`LIVING`）。用户从日常里分出 150 给它。护肤化妆品的关键词（`BY_WORD`，和物品档案 bridge.js 同一张表）先认成这一组。生活网站（`../life`）的形象路线图讲买什么。
