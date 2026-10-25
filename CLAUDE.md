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
  settings: { periodStartDay, expectedIncome, emergencyFloor, floorAccount, usdRate, summerMonths: [月], sideIncomeSave, payNote, medTarget },
  accounts: [{ id, name, currency: 'CNY'|'USD', opening, note }],
  categories: [{ id, name, kind: 'expense'|'income', group: 'food'|'daily'|'free'|'look'|'sub'|'none' }],
  budget: { food, daily, free, look, sub }, notes: { 组: 说明 }, incomePlan: [{ name, amount, when, use }],
  presets: [{ name, from, to }], recurring: [{ id, name, amount, account, category, day, since, lastPosted } | { yearly: 'MM-DD', remindOnly }],
  claims: [{ id, name, payer, createdAt, status: 'open'|'settled', settledAt, docs: [{ file, name, kind: 'pdf'|'image', submitted }] }],
  people: [{ id, name, archived? }], favors: [{ id, person, dir: 'owe'|'owed', text, date, createdAt, status: 'open'|'done', doneAt, doneTx?, doneNote?, skip?, plan? }], reconciled: { 预算月开始日: 对账日 },
  wishes: [{ id, name, price, want: 'bit'|'nice'|'want'|'very'|'most', kind: ''|'need'|'grow'|'joy'|'feel'|'gift', reason, link, targetDate, createdAt, status: 'open'|'bought'|'dropped', boughtAt, boughtPrice, saveStart? }],
  wishTrail: [{ id, price, saveStart, droppedAt }],
  wishAdvice: { at, summary, order: [id], items: { id: { when, need, comment } } }, wishCart: [{ id: 心愿id, price? }], categoryVersion,
  decisions: [{ id, at, item, price, verdict, choice: 'buy'|'wish'|'skip', review?: 'worth'|'meh'|'regret' }],
  taxYears: { 年: { done, refund } }, subReview: { last, notes: { 订阅id: 'keep'|'downgrade'|'stop' } }, goals: [{ id, name, target, by, note, createdAt, status?: 'done'|'cancelled', doneAt? }], family: { sealed, log: [{ date, amount }] },
  tx: [{ id, type, date, account, amount, cny?, category?, what?, to?, toAmount?, claim?, person?, group?, favor?, special?, who?, note, auto?, receipt?, from?, bill?, billParty?, createdAt }] }
```

- tx.type：`expense` 支出、`income` 收入、`transfer` 转账、`adjust` 对账差额，以及「钱动了但不算收支」的：`advance` 垫付 / 借给别人 / AA 里别人那份（钱出去，别人欠我）、`repay` 报销到账 / 别人还我、`payback` 我还别人；`expense` 没有 account、有 person = 别人替我付（算花销，账户不动，我欠他）；`writeoff` 垫付结清时报不回的部分（算花销，类别「出差自付」group none，没有 account）。
- 卡和欠款分开：欠款按 claim / person 算（`claimStatus`、`personStatus`，先进先出算「拖了多久」），还到哪张卡都行。AA 的几笔共用 `group`，删花销时一起删。
- 类别：`EXPENSE_CATEGORIES`（大组 group 管预算，小组 sub 只为好找，日常先点小组再点类别）。改类别时提高 `CATEGORY_VERSION`，`migrate()` 会给老账本改名、补新的、按默认顺序排；不用的老类别 `hidden`（老账照样显示名字）。`c-wish`、`c-trip` 只由心愿单、垫付自动记。选「其他」（`FREEFORM`）必须写 `what`（具体是什么），流水里显示它。
- **钱怎么分（2026-10-08 用户定的方案）**：钱不挪账户，全是现算的。七类：生活费、心愿基金（在生活费卡）、应急底线、医疗备用金、专项存款、自由存款、家庭存款（后五类在存钱卡）。`node tests/test_money.mjs` 把每条规则测了一遍，改规则先改它。
  - 心愿基金（`wishFunds`，按时间顺序一件件算）：每个结束的预算月生活费结余 + 兼职三成进来；每次进账 **1/3**（`WISH_SHARE`）给正在攒的大额心愿、2/3 进「能随便用」（`small`）。超支（生活费、专项超了、医疗超了、报不回的垫付 writeoff）先扣能随便用，**扣到只剩 100**（`WISH_KEEP`），扣不动的记 `spill`（由存款补）；大额心愿攒着的（`env`）不扣。`parts` 是合计 `total` 的来源（生活费省下、兼职收入、超支扣回、帮专项和看病补、买了心愿），加起来等于 total。
  - 大额心愿（`wishBigFrom` 300 以上）：放进来只在单子上；点「开始攒」记 `saveStart`，从能随便用拿 100（`WISH_SEED`，不到 100 不能开始）；**一次只攒一个**，其他按点的先后排队（「不排了」删 saveStart），轮到时再拿 100；**攒够才能买**（存款不动），比攒的便宜多的退回；不想要了攒的全退回。`bigWishPlan` 给状态 idle / waiting / saving / ready 和大约几个月（最近 3 个月平均结余 × 1/3）。没有 ↑↓ 了，排序「默认」就是列表顺序。`wishMonthlyCap`（400）不再用。
  - 记账时「用心愿基金的钱」（2026-10-14）：支出（没有 AA / 别人帮付、不是专项）可以打开，tx 带 `wishFund: true`，类别照常；`txGroup` 算 `none`（不占预算）、`isFromSaved`、`wishFunds` 当小额心愿从能随便用里扣。超过能随便用的不让记。流水里标「心愿基金」。推送脚本 `group_of` 同样排除。
  - 心愿单大字是**能随便用的**（`small`，用户 2026-10-14：307 里 100 给大额心愿就显示 207），来源各行最后一行「攒给大额心愿 −env」，加起来等于大字；钱都在哪的心愿基金也显示能用的。`cardCheck` 仍用 total（卡里实际的钱）。放弃的心愿不再算「省下多少」（用户说有时只是选择而已）。
  - **能随便用的上限 `WISH_CAP` 1 万**（2026-10-14 用户定）：满了再进来的（结余、兼职、大额心愿退回的）不进心愿基金，算存款（`parts.toFree`，钱留在生活费卡上，对账页数额计算会让转回存钱卡、进自由存款）；给大额心愿的 1/3 照常。从开始记账就按这个算。
  - 放弃的心愿（2026-10-15 用户定的）：只留到这个预算月结束。心愿单最下面「这个月放下的 · N 个」（折起来）每个有「放回来」；新的预算月打开网站时 `checkDrops` 把之前放弃的整个删掉（`expiredDrops` / `forgetDrops`），不留记录，年总结、月度小信也不再提放弃。大额心愿攒过钱的，删掉或放回来前把攒钱经过（不带名字）记进 `wishTrail`，`wishFunds` 照样算它，心愿基金的数才不变；放回来（`restoreWish`）的大额心愿去掉 `saveStart`，要重新点「开始攒」。「实现了 N 个」是开始记账以来的总数，点开列出买了什么。
  - 小额心愿用能随便用买，超出的记 `c-like`（自由钱）。买了记 `c-wish`（不占预算）。冷静 `coolDays` 天。分类 `kind`（选填，`WISH_KIND`）：生活必需品、提升自己、提升幸福感、情怀、送人（送人时日期框改成「哪天前送出去」），卡片上显示，也发给 AI。想要程度 5 档（`WANT`，从低到高：有点想、有了更好、想要、很想要、非常想要；老数据只有 very / nice，键名没变）。
  - 存款（`savingsMap`）：存钱卡余额 + 别人欠我的（垫付先当作还在）− 我欠别人的，按顺序分：家庭存款（已封存的）→ 应急底线 → 医疗备用金 → 专项（按日子，近的先，同一天先加的先）→ 自由存款；钱不够时反过来，所以缺口总落在自由存款、最远的专项上。专项 `sealed` = 留够了（封存）；`short` = 按 预计收入 − 预算 每月能存的，到那天会差多少（琥珀色提醒）。
  - 医疗备用金：`settings.medTarget`（1000）。看病、买药是「医疗」组（`med`，`CATEGORY_VERSION` 4），不占生活预算；水位 `wishFunds().med`：花了往下降（超了按超支扣），存钱卡的收入和「医保报销」（`i-med`）补回去。低于 300 首页「要做的事」提一句（`medLowCard`）；记满一年后看病买药超过目标，钱都在哪里建议调高。
  - 专项存款（`specialList`，页面 `#/goals`）：暑假生活费（`summerGoal`：平时是下个暑假那几个月的预算；暑假里还没从存钱卡转出来的那几个月继续留着；花起来按生活费算，结余进心愿基金）、300 以上的人情（自动，还的那笔 `favor` 指向它 → 不占预算）、自己加的 `goals`（记账时「算在哪个专项里」→ `tx.special`，不占预算；`target` 是还要留的 = 预算 − 已花）。「办完了」`status: 'done'`：结余自动回自由存款，超了的部分在花的时候就按超支扣了；「不用了」`cancelled`。`txGroup` 把专项和大额人情的花销算进 `none` 组（periodStats、summary 都用它）。
  - 每年一次的专项（2026-10-16，用户要的：学费、住宿费）：`data.yearly = [{ id, name, amount, category, month, day, skip: [年份], note }]`（只在 finance.json，代码里不写金额）。`yearlyDue` 算出要新加的 `goals`（id `y-<id>-<年>`，带 `yearly`/`yearlyYear`，名字「2027 年学费」），每一项同一时间只有一个，办完了 / 不用了就生成下一年；`skip` 里的年份不生成；也可写 `lunar: { m, d }` 按农历算日子（`nextLunar`，取这一公历年里的那天）；日子已经过了的不新生成。`goalsPaid`：任何专项花够了（记账选这个专项）自动办完。专项页「办完了」不再直接办完，而是跳到 `#/add?special=&amount=还剩的&note=&account=floorAccount&category=`（`category` 来自 yearly 配置，生成时带进 goal），点「记好了」才扣；还剩 0 的（超了）才直接办完。`checkYearly` 打开网站时跑，之后就是普通专项（按日子留钱、不占预算、可改金额）。用户的：学费 1 万每年 9 月、住宿费 1600 每年 10 月，都从存钱卡直接交，2026 年学费不用交（skip）；导师补助 / 奖学金不和它们挂钩。另有医保 300（每年 10 月）、春节回家车票 440（小年回家 + 正月初八返校，济南东 ↔ 邯郸东单程 220，按农历小年留钱）。不要的：校园网、体检、保险、查重 / 版面费 / 会议费（报销）、雅思等考试（没定）。
  - **年费也是每年一次的专项**（2026-10-24 用户选的，原来年费那个月会把订阅预算撑爆）：`recurring` 里每年扣的（`yearly: 'MM-DD'`、没有 `day`）由 `yearlySubs` 变成和 `data.yearly` 一样的条目进 `yearlyDue`（goal id `y-<订阅id>-<年>`，美元按 `settings.usdRate` 折人民币）。订阅预算、`budgetAdvice` 的订阅建议、`subMonthCard` 的「还要扣」只算每月扣的；扣了年费记账选这个专项（不占预算），花够了自己办完、生成下一年。订阅页改年费金额 / 日子 → `syncYearlyGoal` 改还没办完的专项；停掉 / 改成每月 → 专项 `cancelled`。订阅超了不扣心愿基金（订阅不在 `LIVING`），只是那个月存下的少。
  - 自由存款留 2000（`FREE_KEEP`）；超过的部分每凑够 10000（`FAMILY_STEP`）打开网站时自动封存（`checkFamily` 写 `data.family`），一万一万地封；判断够不够时不算别人还欠我的（只封真在卡里的）。首页「应急钱」那格用 `savingsMap().emergency.have`（家庭存款先保着、欠别人的先扣）。暑假「这个月生活费转过没有」只认从存钱卡转到生活费卡这边（`isLivingAccount`）的。
  - 钱都在哪（`#/money`，更多、账户、专项页有入口；总结页右上角「钱都在哪」整页翻过来看同一页 `moneyView(true)`，`summaryFlipped` 只在内存，离开总结页就回到总结，翻转动画 `#view.flip-in`）：总共 + 分段条，存钱卡和生活费卡两组小圆圈（`moneyRing`，封存深紫、来不及琥珀），点开看说明或跳到对应页面。
  - 2026-10-14 第二次重做（用户逐项定的）：存钱罐（`jarSvg`，圆罐顶上投币口、里面水位，封存的盖盖子，没满 / 会差的水是琥珀色），按能不能动分三组：存着不动（家庭、应急、医疗、每个专项一个罐子、正在攒的大额心愿）/ 能自由用（自由存款、心愿基金能随便用的）/ 这个月（生活费还剩）。罐子下只写名字和金额（1 万以上缩写 `jarMoney`），人情专项只写「人情·某某」。水位：应急 / 医疗 / 专项 = 有 ÷ 目标，家庭封存了就满，自由存款不到 2000 按兜底线、之后按凑下一个一万，心愿基金按 `WISH_CAP` 1 万，大额心愿 = 攒的 ÷ 价格，生活费 = 还剩 ÷ 预算。点罐子在那组下面展开最多两句（`moneyOpen`，只在内存）。最上面「一共」精确到分（`cents`，用户要的）。之后又改（用户选的）：水面最高停在罐子九成、带一道浅色水面线，投币口一直露着；罐子少的一行居中；「能自由用」和「这个月」并在一张卡里（`jarCard` 传两组，中间细线）；颜色一组一个色调：存着不动紫色深浅 `--jar-k1..k5`，能自由用暖色 `--jar-w1/w2`，生活费灰 `--jar-g`；没满 / 会差的水和罐子边都是琥珀色。数额计算不在这一页，只在对账页。
  - 不占预算的花销按来源写（2026-10-22，用户发现心愿基金被写成「手续费、出差自付等」）：`noneParts` 分成心愿基金（`wishFund` / `c-wish`）、专项、人情、出差自付，其余按类别名；`noneLine` 是那句话。首页「这个月的钱」条上分开画（心愿基金暖色 `--jar-w2`），预算卡最下面、周总结大字下面都用 `noneLine`。
  - 首页「这个月还能花」下面那根条（2026-10-22 改成和周总结一样）：紫色是生活预算用了多少（超了琥珀色），竖线是日子到哪了。
  - 花钱节奏一条规矩（2026-10-22 用户要的）：首页那根条、健康指标「花钱节奏」、月总结都用 `plannedSoFar`（从开始记账那天数起，到今天该花多少）+ `onPace`（不超过它的 `PACE_SLACK` 1.1 倍算正常，预算月头 3 天不算快）；周总结同样 1.1 倍。以前首页按 15 号数、没有余量，健康指标 1.15 倍。
  - 月总结「心愿基金」卡（2026-10-22，用户选的三样）：`wishFunds().flow` 记下能随便用的每一次变化（saved / jobs / back / over / cover / wish / toBig / toFree，加起来 = small），`summary.js` 的 `wishMonth` 按预算月分：月初 → 月底（没过完写「现在」）、每一类进出（`WISH_FLOW`）、省下率（生活费省下 ÷ 生活预算，过完才有，和上个月比；没过完写现在还剩多少）、最近 6 个月每月多了少了（柱）和月底多少（线）。
  - 买不买：能自由用的钱 = 自由存款 + 心愿基金能随便用的 + 这个月生活费还剩的；超过就一定「不建议」。
  - 花销口径（`spendOf`，periodStats / summary / 推送脚本都用它）：支出、writeoff；**对账差额在生活费卡这边、而且是少了的，算成漏记的日常花销**（`daily` 组，「花在哪了」里叫「对账差额（漏记的）」，`ADJUST_CAT`），照常进结余 / 先扣心愿基金；存钱卡、美元账户的差额只改余额。预算月头 7 天对的账，差额记到上个预算月最后一天。
  - 存钱达标（`saveStreak`、首页「本月存钱」、年总结和计划比）用 `planSaved` = 真实存下 + 用以前留好的钱花的（`isFromSaved`：专项、大额人情、心愿）；首页「本月存钱」还不拿看病来催（照算在存下的钱里）。月、年总结大字还是真实存下的，下面一行小字写「其中 ¥X 是用以前留好的钱花的」。（2026-10-08 用户选的）
  - 数据仓库里的推送脚本（`.github/ledger_push.py`）自己算「这周生活花了多少」，`group_of` 和 `txGroup` 一样排除看病买药（按类别 id）、专项、大额人情；改规则时两边一起改。
- **和卡无关（2026-10-14 用户定的）**：分钱不看钱在哪张卡上。`savingsMap(data, today, rate)`：所有账户加起来（美元按汇率，`all`）+ 别人欠我 − 我欠别人，先留出心愿基金（total）和这个月生活费还剩的（`livingLeft`，≥0），剩下的按 家庭 → 应急 → 医疗 → 专项 → 自由 分；所以「钱都在哪」的一共 = 总资产 + 别人欠我 − 我欠别人。`cardCheck` / 数额计算删掉了。任何收入（医保报销除外，它走 medBack）都先补医疗备用金。暑假生活费按日子：暑假里到了哪个月，那个月就是生活费，后面的月份继续留着（不看转账）；`summerTransfer` 和健康指标「暑假生活费」删了。发钱日「挪生活费」只是提醒，不影响算账。`settings.floorAccount` 只剩默认账户、发钱日提醒的意思。
- **对账（2026-10-14 重做）**：随时对，`data.lastReconciled`，超过 `RECONCILE_DAYS`（14）天首页提醒。页面最上面「网站上一共」，填了实际余额实时显示「实际一共」和差额怎么算。差额看所有账户加起来：一次对账的几笔 adjust 带同一个 `rec`；加起来是 0 = 账户之间挪了没记，只改余额；少了 → 记在最负的那笔的 `spend` 上，算漏记的日常花销（`spendOf` 先看 `spend`，有 `rec` 没 `spend` 的不算；没 `rec` 的老差额还按老规矩）；多了不算收入，直接进存款。推送脚本同样改了。
- **一次性的钱**：收入类别带 `lump: true`（`isLump`；用户的「导师补助」，类别只在 finance.json 里），不算每个月的收入和存钱（periodStats / rangeStats 的 income 不含，rangeStats 另给 `lump`），不分给心愿基金，直接进存款；年总结单独一行「一次性的钱」。记收入选到它时表单写一句说明。
- 预下单（2026-10-08）：「挑几个算一算」进打勾模式（`wishPicking`，只在内存），选的存 `data.wishCart`（手机电脑同步），卡片标「准备买」。价格可以改（`price`，只用来算账，「都买了」按它记；小额 / 大额仍按心愿本身的价格分）。`cartMath`：小额合计从心愿基金出，超出的算这个月自由钱（自由钱会超时琥珀色提醒，不拦）；大额只有攒够了（按改过的价格）才能勾、才能买；冷静期的能选，只提一句。「都买了」（`buyCart`）整单一个账户，没买成的取消勾选、留在预下单里；记账和单个「买了」规则一样。单个「买了」、「不想要了」也会从预下单里拿掉。
- 界面上一律叫「AI」，不写 DeepSeek（用户 2026-10-08 要求）；只有「余额不足去 DeepSeek 官网充值」和手机丢了「去 DeepSeek 后台换密钥」这种要去那个网站操作的地方留名字。
- DeepSeek：密钥先读账本仓库 `config/ai.json`，没有就读物品档案仓库的（同一个令牌）。只发心愿单和汇总数字，不发流水明细；建议存 `wishAdvice`，密钥不进 finance.json。
- 「我的故事」的简介（2026-10-06）：`js/profile.js`（物品档案、账本、生活三边同一份）读 `story-data/profile.json`（一天一次，缓存 localStorage `story-profile`，读不到就不带），`js/ai.js` 的 `askJson` 每次都把它加在 system 后面（`withProfile`）。令牌要授权 story-data。
- 买不买（`#/ask`）：话里有价格时网站先算 `priceFacts`（几天饭钱、几个月自由钱、存钱目标晚几天、大额要攒几个月）和硬规则（价格 > 总资产 − 应急底线 − 本月还要花的生活费 → 一定「不建议」，前端强制；大额建议先冷静），连同 `moneyContext`（只有汇总数字，不发流水明细和备注）给 DeepSeek。聊天只在内存，决定存 `decisions`，买了的 30 天后回访。理财小课堂（`lessons()`）是写死的大白话 + 他自己的数字，不推荐具体产品。
- 个税退税：兼职收入（`i-job`）可填 `tax`（被预扣的个税），`taxYear()` 按年汇总；每年 3/1–6/30（`taxSeason`）上一年有预扣且没办（`taxYears[年].done`）就首页提醒、推送（3/1、3/15、4/15、5/15、6/15、6/25）；办好后记一笔 `i-tax` 收入。
- 订阅体检：`subReview.last` 起满 90 天提醒（首页 + 推送：当天、之后每 14 天），`#/subs` 可改金额、加每月 / 每年的订阅、停掉（只停自动记账，订阅本身要去 App Store 取消）。
- 暑假生活费：`summerGoal()` 自动生成（见上面「钱怎么分」）；暑假预算月头 5 天首页提醒转生活费，推送在那几个月的发钱日。
- 兼职收入的 `1 − sideIncomeSave`（三成）自动进心愿基金（`wishFunds` 里算），钱在生活费卡。
- 预算调整建议 `budgetAdvice()`：最近 3 个完整、非暑假的预算月（至少 2 个）；一直 ≤ 85% 建议调低到 max(平均 × 1.1, 最多那个月)（自由钱不低于 200），≥ 2 个月超 5% 建议调高到平均；订阅按登记的实际金额。采用记 `budgetHistory`，「这个月先不改」记 `budgetAdviceDismissed[组] = 预算月开始日`。
- 发钱日一条龙 `payday()`：收入计划（`incomePlan`，按名字或 `category` 对应收入类别）这个预算月没到的，首页卡片问「到了吗」（到了 → 金额预填、账户默认存钱卡；还没 → 当天不再问，记在 `data.payday[预算月].later`）；有收入到了（或暑假）且这个月还没从存钱卡转出过，就提供按 `presets` 一步转生活费（默认生活预算），「这个月不用」记 `noTransfer`。开始记账那个不完整的预算月不问。
- 流水（2026-10-24 起没有单独的页，底栏让给新功能）：首页最下面「最近记的」平时列最近 8 笔；右边小放大镜点开搜全部时间（标题、备注、what、类别、账户、人、垫付、金额、日期，空格 = 同时满足），显示合计。搜的字存在内存 `recentSearch`，改完一笔回首页还是搜索结果。按账户看在账户页。没有翻月、类别筛选。
- 记账时的价格提示：选了支出类别后，在「记好了」上面显示上次同类（有备注就按同样的备注、「其他」按 what）花了多少、最近 5 次平均；有 3 次以上记录时，明显贵（> 平均 1.3 倍）或便宜会说。
- 里程碑 `newMilestones()`：总资产第一次超过 2 万、3 万、5 万……（开始记账时就超过的不算），连续 1/3/6/12/24 个完整非暑假预算月存钱达标；打开时检查，记 `milestones.reached`，首页祝贺 7 天或点「好」（`seen`）。年度总结里列出当年的。
- 月度小信：结束了、有记录的预算月，打开月总结时（最近结束的那个自动，更早的点按钮）DeepSeek 用汇总数字写 120～220 字，存 `letters[预算月]`。
- 年度总结 `yearSummary()`（自然年），总结页「年」；1 月 1 日推送、1 月头一周首页提醒。
- 令牌到期：读物品档案设置里的 `tokenExpires`，14 天内首页提示。
- 推送：`js/push.js`（账本自己的 VAPID 公钥，和物品档案不是一对）+ `sw.js`，订阅存账本仓库 `config/push.json`；账本仓库 `.github/workflows/push.yml` 每天 13:00 UTC（北京 21 点）跑 `.github/ledger_push.py`：没记账提醒、周日加周总结、预算月最后一天加月总结，合成一条。私钥只在账本仓库 secret `VAPID_PRIVATE_KEY`。（2026-10-07 起**只在时间段里发**：GitHub 定时实测晚 6 小时、凌晨两三点才跑，曾在凌晨发出并占掉当天。`once(key, now, earliest, latest)` 不在北京时间段里就跳过、不记成发过；定时和外部触发都按这个规则，只有测试推送不受限。记账 20:30–23、洗衣 19:30–22:30、购物周日 8:30–12。pywebpush 固定 2.5.0。脚本只在数据仓库 `.github/` 里，改的时候直接改那边。）
- 发票存私有仓库 `claims/<claimId>/<随机>.pdf|jpg`（照片压缩），删除时一起删文件。

- 余额 = `opening` + 每笔的进出（`money.js` 的 `delta`）。**转账不算收支**；美元账户金额按美元，花销另存 `cny`（记账当时的汇率，Frankfurter 接口每天查一次，存在 localStorage）。`adjust` 是「校准」产生的对账差额，不算预算。
- 预算月从 `periodStartDay` 号到下个月前一天（`periodOf`）。开始记账那天在预算月中间时，这个月预算按天数折算、收入不估（`partial`）。`summerMonths` 开始的预算月没有收入。
- 健康指标（`health()`）：安全垫（总资产 ÷ 月预算）、应急钱底线、花钱节奏（只看 food/daily/free）、本月存钱、即将扣款（美元账户够不够付接下来 35 天的订阅）、待收回（垫付超过 30 天、人情超过 14 天提醒）、对账（完整预算月还没对）、年费提醒。每项 level good/warn/bad + 大白话 text + 该做什么 action；`headline()` 是首页最上面那句。解释文字在 `main.js` 的 `EXPLAIN`。
- 固定扣费到日子自动记（`duePostings`，`lastPosted` 防重复；在 `store.save` 的修改函数里重新算，两台设备同时打开也不会重复）。
- `migrate()` 给旧数据补字段，加功能时在这里补。
- 生活网站（`../life`）的「想做到的事」可以往 `wishes` 直接加心愿（`reason` 是「为了：目标名」，`want: 'want'`），见 life/CLAUDE.md。
- 人情（不是钱的，2026-10-06）：`favors`，「我欠他一个人情」`owe` / 「他欠我」`owed`，不写钱、不分轻重。还人情：记聚餐请客、礼物、红包（`FAVOR_CATEGORIES`）时可以选「还的是哪个人情」→ tx 带 `favor`，那个人情 `status: done`、`doneTx`；改掉 / 删掉那笔，人情回到没还。没花钱的在人情页点「还了」写一句（`doneNote`）。**只在法定节假日提醒**（`holidayFavors`，`js/cal.js` 的 `holidayAround`：放假前一天到假期最后一天，周末不算），首页 `favorHolidayCard` 一个个问「这次还 / 这次不还」：还 → `plan = 假期 key`，出「记一笔」（`#/add?favor=id` 预选聚餐请客和这个人情）；不还 → `skip = 假期 key`，下个假期再问。生活网站「今天」里也问同样的，也能记人情（直接提交 finance.json）。
- 要准备的人情钱（2026-10-06，用户选的方案）：欠的人情可填 `cost`（他为我花了多少）、`estimate`（预计要准备多少，「估一个」= DeepSeek，`js/renqing.js` 的 `estimatePrompt`，和 life 同一份，带上和这个人以前来回的钱）。`socialPlan`：有 `due` 的按那天，没有的按下一个假期（`nextHoliday`），过期的算今天。**`FAVOR_BIG` 300 以上**自动变成专项存款（`specialList` 里 `auto-favor-*`，按日子排，还上就没了；还的那笔不占预算）；以下从日常里出，首页（45 天内）和人情账页按月列「要准备的钱」（`socialCard`）。买不买：`moneyContext` 带上这些和存款各部分。有 `due` 的人情（生活网站「重要的日子」勾了随礼来的，`kind: 'date'`、id `fd-日子id`）节假日不问。
- 礼尚往来：礼物 / 红包 / 聚餐请客的支出选「给谁的」、收入「收到的红包礼金」（`i-gift`，`GIFT_IN`）选「谁给的」→ tx `who`（不影响欠款，`person` 才是欠款）；选了还的人情会自动带上那个人。人情账的人页面有「礼尚往来」，生活网站「身边的人」也读它。
- 选人（AA、别人帮我付、给谁的 / 谁给的、记一个人情）都用 `js/picker.js`（和 life 同一份）：输入一个字出补全（名字和 `hint`，比如「本科 · 舍友」，hint 由生活网站同步过来），空着出最近 5 个，没有就「＋ 新加」。用户不要一大排人名按钮。
- 人的名单由生活网站「身边的人」管（同一个 id）：那边加人、改名、归档会写进 `people`（`archived` 的不出现在选人里）；账本里新加的人那边打开时会搬过去。账本里不改名字。人情账页只列有来往（钱或人情）的人。
- `js/cal.js`（和 life 同一份，改了两边一起改）：法定节假日（`OFFICIAL` 按年补国务院公布的安排，没有的年份按节日估算）、农历（浏览器 `Intl` 中国历法，北京时间；`LUNAR_FIX` 修正朔月贴着半夜的年份）、生日。
- 物品档案那边「买回来了」、新建物品填了价格时也会直接往 `tx` 加支出（带 `from: 'inventory'`），见 inventory/CLAUDE.md。
- **删掉的功能（2026-10-25 用户说不需要了）**：导入小票、Siri 和快捷指令、快捷记账整个删了（`js/receipt.js` 没了，按商品名猜类别的 `guessCategory` 挪进 `bills.js`；`migrate()` 删掉老数据的 `quick`）。「更多」里不再放「钱都在哪」（总结页翻过来就是它）。**心愿单从「更多」挪到首页右上角 ? 旁边的小礼物按钮**（`.wish-btn`，返回回首页）。
- **花钱方式（2026-10-25，「我们的花钱方式」和「预算」合成一页 `#/rules`，用户定的）**：最上面有建议时放 `adviceCard`；然后每月预算表（`budgetTable`），右上「改」就地变成五个输入框（`budgetForm`，`budgetEditing` 只在内存），保存后留在这页；下面「规矩」每条一个 `details.rule-item` 折起来，点开看怎么做和为什么；每月正常收入在收入那条、应急钱底线在应急钱那条里改（`setRow` → 弹出框）；最后「一年下来」。`#/budget` 老链接也打开这页。「更多」里只剩一项「花钱方式」。
- **心愿单页（2026-10-25 重做，用户说原来不协调）**：上面心愿基金只一个数（`.wish-fund`，「来源 ›」弹出 `.fund-rows` 和攒给大额心愿的）；心愿合成**一张清单**（`.wish-list`，不分小额 / 大额两段、没有排序按钮），一行名字 · 价格 + 一句状态（`status()`：可以买了 / 冷静中 / 心愿基金还差 / 正在攒 + 细条 / 排队第 N 个 / 还没开始攒），按「能买的 → 正在攒 → 其他」排；点一行弹出详情（`wishSheet`：想要程度、分类、理由、链接、AI 看法，按钮只放当下该按的 + 改 / 不想要了 / 不排了）。清单下面两个小链接「挑几个算一算」「AI 看看」（`wishAiSheet`：总建议 + 先后顺序 + 问问 AI）。最下面一行「实现了 N 个 · 放下 N 个」（`.wish-history`）点开两段。`openSheet` 的 `confirmText: null` = 只有一个「关上」。
- **储蓄率（2026-10-25 用户要「直观明显」）**：月度、年度报表四个数下面一块 `savingMeter`：大字百分比 + 「每 100 块收入，存下 N 块」+ 0～100% 的条，条上竖线是计划（月 = `monthPlanRate`：(正常收入 − 预算) ÷ 正常收入，暑假月不算；年 = `yearPlan().rate`）和常见建议 20%（离计划太近就不画）。到计划绿、20% 以上紫、以下或多花了琥珀（不用红）。右上「比上月 / 比去年 ±N 个点」。没收入写一句不算；没过完的月提醒会往下走。
- 账单查漏记（`#/bills`，「更多」和对账页有入口）：`js/sheet.js` 读 CSV（UTF-8 / GBK 自动认）和 xlsx（自己解 zip，`DecompressionStream`）；`js/bills.js` 的 `parseBill` 按「交易时间 / 金额」那一行找表头，按列名取（微信、支付宝列名不同），`matchBills`：只看「支出」，退款 / 关闭 / 不计收支不算，开始记账前的不算，`bill` 单号相同直接认，否则账本里有账户的支出、垫付、转出、还钱（AA 按 group 合计）金额相同、日期差 ≤2 天的配上（每笔只用一次）。没配上的一笔笔确认：类别 `guessBillCategory`（同一 `billParty` 上次的类别 → 商家表 `MERCHANTS` → 商品名关键词），账户 `guessAccount`（`settings.payMethods` 记住的「来源:付款方式」→ 微信零钱找名字带「微信」的 → 上次用的），转账 / 红包 `isPersonal` 默认不记。补记的 tx 带 `bill`、`billParty`。
- 买不买、心愿单建议会带上物品档案里已有的东西（`inventoryContext()`：名称、类别、数量、部位颜色季节、穿了几次、价格；不发照片序列号备注；缓存 5 分钟），规则 `INVENTORY_RULE`：有类似的就点出来，买不买他自己定（用户 2026-10-04 要求）。
- 推送脚本（数据仓库 `.github/ledger_push.py`）：一晚上错开整点排三次 cron，`once()` 用 `config/push-sent.json` 保证一天只发一次、23 点后不发（GitHub 定时整点常被跳过）。
- 手机丢了（`#/lost`）：删令牌、换令牌的步骤 + 两个仓库最近的修改按设备统计（提交说明末尾「 · 设备」，`github.js` 的 `DEVICE` / `recentCommits`）。
- 提示（toast）一次只出一条，新的换掉旧的；底部有「撤销」时普通提示放在它上面（`.toast.raised`）。四个网站一样。
- 撤销代替确认：`saveUndoable(message, fn, doneText)` 先做，底部 `undoToast`「…  撤销」6 秒，撤销 = 把 `diff(改后, 改前)` 套回去。用在删一笔、放弃心愿、停订阅、删存款目标；删垫付（连发票文件）、退出仍然 `confirm`。

- **返回（2026-10-25）**：添加到主屏幕的网页没有浏览器返回键。除了底栏那几页（首页、模拟、＋、总结、更多），每个子页面左上角都有「‹ 上一页」，在 `render()` 里统一加（`PARENTS` 写直接打开时回到哪里；「改一笔」`#/add?edit=` 也算子页面）。每条浏览记录在 `history.state.nav` 编号（`navEnter`），号变小 = 返回，回到原来滚到的位置；上一页的名字：底栏的写名字（`TAB_NAMES`），别的取那页的大标题，超过 8 个字写「返回」。走过的页存 sessionStorage `ledger-nav`，刷新也认得。新加子页面记得加进 `PARENTS`。
- **月度财务报表（2026-10-25，总结页的「月」整个换成它）**：用户要「每个月的总结做成财务报表」，选了：直接替换月页、要能导出。**网页上只放四个关键数字和图，小字、表格都不要（用户 2026-10-25 改的）**：表格、明细放在 `.rep-detail` 里，网页上藏着（`@media screen`），存成 PDF 时才印出来；「存成 PDF」「导出给 ChatGPT」在页面最下面。计算在 `js/report.js`（`monthReport`，纯计算，`test_money.mjs` 测），页面是 `monthReportView`。按预算月；没过完时算到今天（`asOf`）。八部分：一 关键数字（四格 + 表）；二 收支表（`waterfall` 瀑布图，收入按类别、支出按组，和上月比）；三 资产表（月初 / 月底按用途的堆叠条 + 净资产折线；按账户、按用途两张表，两边合计都 = 净资产，自由存款可以是负的）；四 预算执行（子弹条 + 表 + 花钱曲线）；五 花销明细（环形 + 前 10 类 + 每天生活花销日历 + 最大几笔）；六 趋势（`barsLine` 收入支出柱 + 储蓄率线，开头没记账的月不放）；七 附注（有才写）；八 AI 点评（原来的月度小信 `letterCard`）。导出：「存成 PDF」= `window.print()` + `@media print`（只留报表、强制浅色）；「导出给 ChatGPT」= `chatgptSheet`（和模拟交易共用）+ `reportText` 的 Markdown。原来的 `monthHead`、`wishMonthCard` 删了（`monthSummary` 还给小信用）。
- **年度财务报表（2026-10-25，总结页的「年」，用户选的：自然年、要 AI 点评、要日历、要 Excel）**：计算 `yearReport`（`report.js`，开始记账那年从开始记账那天算，每月按自然月，所以和月度报表的预算月数字不完全一样）；页面 `yearReportView`，和月度一样网页上只有四个数和图：每月收支（`barsLine`）、存钱计划（累计存下 vs `planBetween` 计划累计，用以前留好的钱花的不算没存够）、家底（`purposeStacks` + 月底净资产）、预算格子（一行一块一列一月，超了红）、花在哪（环形 + `stackedBars`）、日历（`yearCalendar`，上下半年两排，五档按分位数）、AI 点评（`data.letters['2026']`，第二年打开去年的自动写一次）。三个导出在最下面：PDF、Excel（`makeWorkbook` 多工作表、数字按数字；年度 = 总览 + 分表 + 每个月一张明细，月度 = 总览、家底、预算、类别、每天、明细）、ChatGPT（`yearText`）。
- **模拟交易（2026-10-24，底栏「模拟」，`#/sim`）**：用户想等存款稳定后再投资，先用假钱练、留下记录让 AI 了解他的逻辑。**不是钱**：数据 `simGames / simTrades / simWatch / simReviews`（格式见 `migrate()` 注释），不进总资产、预算、买不买、任何统计。起始 1 万（`START_CASH`），可以「重开一局」（旧局 `end`、`endValue` 留着）。
  - 行情：`js/quotes.js`，腾讯免费接口（不要密钥）：实时价 `qt.gtimg.cn`（GBK，允许跨域）、每天的价格 `web.ifzq.gtimg.cn` fqkline（看走势用前复权 `qfq`，算每天一共值多少用不复权）、搜索 `smartbox.gtimg.cn`（不允许跨域 → `<script>` 读全局 `v_hint`，8 秒超时）。只要 A 股（股票、ETF、LOF）和美股，不要港股。美股实时价用 `usAAPL`，走势要带后缀 `usAAPL.OQ`（存在 `k`）。行情只在内存 `simQ`，15 秒算旧；开盘时每 15 秒重画一次。
  - 规则按真的来（用户选的），`js/sim.js` 纯计算，`node tests/test_sim.mjs` 测：开盘时间（A 股北京 9:30–11:30 / 13:00–15:00，美股按纽约 9:30–16:00，`Intl` 算夏令时；工作日行情日期不是今天 = 节假日休市）；买按卖一、卖按买一；卖一没量 = 涨停买不到，买一没量 = 跌停卖不出；A 股 100 股一手（科创板 688 最少 200、1 股 1 股加），不全卖要整百；T+1（跨境 QDII、黄金、债券、货币 ETF 和美股 T+0，`tPlus0` 按搜索给的类型和名字认）；手续费 `fees`（A 股佣金万 2.5 最低 5、股票过户费十万分之一、卖出印花税万 5；美股佣金 + 平台费约 2 美元、卖出证监会费）；美股的钱按当天汇率从那 1 万里换（用户选的 a）。只有市价单，没有挂单。
  - 买卖（`orderSheet`）：① 数量 + 为什么（必填）+ 打算拿多久（买入必选，`HOLD`）+ 有几成把握（1～5 必点，存 `sure`，2026-10-25 加）→ ② DeepSeek 问 1～2 句（`simAsk`，只问不评价不建议；连不上就跳过）可答可不答 → ③ 重新拉一次行情按那一刻成交。不能删、不能改（真的也撤不回）。
  - 回头看（`lookbackDue`）：卖出 7 天后、买入 30 天后问「当时想对了吗」（想对了 / 想错了 / 说不清 + 一句），一次一笔，可跳过（`look.skip`）。
  - 复盘（用户选 c）：月初打开模拟页时上个月有买卖就自动写（`reviewDue`，失败了这次打开不再试）；「现在复盘」写上次复盘以来的。`simRecordText` 是复盘和导出共用的文字。
  - 对照线（2026-10-25，用户选的）：「一共」的图里蓝线 = 开局前一天收盘把钱全买成沪深 300 ETF（`BENCH` sh510300，前复权）一直不动，每天值多少（`benchSeries`，不算手续费和一手）；下面一行写「你比它多 / 少多少」。复盘和导出也带上这句。
  - 股票页走势图上的买卖点（2026-10-25）：红点买、绿点卖（`tradeMarks` 落到那天或下一个交易日，`lineChart` 的 `marks`）。
  - 导出给 ChatGPT：可改的问题（`SIM_ASK`）+ 全部记录（含以前的复盘）一起复制，打开 chatgpt.com；或下载 .md。
  - 网站不教知识（用户说学习那一面不需要），「我的认识」小本子用户不要。颜色红涨绿跌（`--up` / `--down`，和国内炒股软件一样）。

## 代码

- **先存手机、后台上传**（`js/store.js`）：`save()` 在本地数据上改、算 patch（带 id 的列表按 id 增改删和顺序，普通对象按字段，其他整个替换）进 localStorage 队列 `ledger-queue`，页面立刻更新；`sync()` 在 GitHub 最新数据上套 patch 提交，没网 20 秒后重试、`online` 事件马上重试。页面顶部的 `.sync-pill` 只在没网 / 失败 / 上传超过 1.5 秒时出现。上传发票、删文件、自动记固定扣费走 `online`（直接提交）。测试里 `Ctx.data()` 会先等队列清空。
- 「花在哪了」圆环（周、年总结，`spendDonut`）：点圆环的一段或右边一行 → 这一段加粗、其他变淡，那一行亮一下（`.glow`）并留着底色，圆环中间换成这一组的钱和占比，下面列出这一组里各类别花了多少、几笔（`rangeStats` 的 `byCat`）；再点一下或点中间收起。
- `js/money.js` 纯计算（可以用 node 直接测）；`js/summary.js` 周 / 月总结的数（一周从周一开始，月总结按预算月，`advice()` 只给一条建议）；`js/charts.js` SVG 图表（柱状、环形、折线，颜色用 CSS 变量）；`js/store.js` 读写（422 冲突重试）；`js/github.js` API；`js/util.js` DOM（只用 textContent，不用 innerHTML 拼数据，令牌在 localStorage）；`js/main.js` 路由和页面。没有构建步骤。语法检查用 `node --input-type=module --check < js/main.js`（直接 `node --check 文件` 漏过过括号错误）。
- 外观和物品档案、生活一致（2026-10）：无印良品底色 + 苹果风，主色藤紫，颜色在 `css/app.css` 的 `:root`；页面大标题、卡片小标题用宋体（`--serif`），正文苹方。首页开头 `homeHeader`：日期 → 宋体问候（`greeting`）→「N 月预算 · 第 N 天」「离发工资还有 N 天」两个小标签；紧接着就是「这个月还能花」（2026-10-07 调整顺序：不再让一串提醒卡叠在它上面）。一切正常时 `headline` 那句是这张卡最上面一行小字；有事要处理时放进下面的「要做的事」（`todoCard`，2026-10-14 重做：以前只露第一个指标）：每件一行 `.todo-item`，左边小圆点图标按 bad / warn / accent / calm 上色；每个要处理 / 留意的指标单独一行（`healthTodo`，点开解释），顺序 要处理的指标 → 令牌 → 节假日人情 → 发钱日 → 留意的指标 → 医疗 → 里程碑；右上「N 件」，先露 4 件，其余「还有 N 件」（`todoMore`，只在内存）。指标和令牌每行右边「做完了」（2026-10-24 用户要的，可撤销）：个税 → `taxYears[年].done`、订阅体检 → `subReview.last`、对账 → `lastReconciled` 记成今天；其他记 `data.todoDone[key] = '预算月开始日|轻重'`（`todoSig`），下个预算月或变得更要紧才再出现；令牌记 `todoDone.token = 到期日`。首页不再放「钱都在哪」入口（2026-10-24，总结页翻过来就是它）。即将扣款不再是健康指标格子，是单独一张卡（`upcomingCard` / `chargePlan`）：35 天内一笔一行（日子方块、名字、还有几天、金额 ≈ 人民币），美元账户最后一行余额够不够（`chargeFoot`）。订阅页最上面「这个预算月的订阅」（`subMonthCard`：已扣、还要扣、都扣完和预算比）+「美元订阅的钱怎么走」（充值 = 转账不算花，扣款那天按汇率算进订阅预算）。人情要准备的钱挪到预算卡下面。只有某一组超了、整体还在预算里时（`health().overGroups`），那句话是「整体还在计划里 · 日常超了 ¥N，别的组省下的能补上」，琥珀色，不说「一切正常」。健康指标窄格是单数时最后一格占一整行。「这个月还能花」（`spendLeftCard`，2026-10-06 重做）：左边大圆环是生活预算用了多少（用户喜欢这个圆弧，超了变红），右边**精确到分**（`cents`，不四舍五入），下面一条是预算月过了几天、竖线是钱用到哪了，最下面一行生活预算 / 已花（开始记账那个月写按几天折算）。健康指标是两列小卡（`healthTile`，即将扣款占一整行）：每格一个小圆环，按 good / warn / bad 上色，`gauge` 决定多满（安全垫 3 个月算满、应急钱按底线、花钱节奏 = 生活预算用了多少 + 小白点 `mark` 是按日子该到哪、本月存钱离目标多近，其他的满圈只看颜色），中间 `short` + 小字 `unit`，点开是原来的解释。**不盖章**（用户说的）。每页最下面角落一句（`js/words.js`，花钱观，安静的短句，每页每天一句；记账、设置这些页面不放）。点选标签轻轻弹一下（`.pop`）、换页淡入、浅色时底色随节气微变（`js/solar.js`，和 life 仓库同一份算法，改了三边一起改）。话要温柔、短，不说教。

## 测试

- `node tests/test_money.mjs`：钱怎么分的每条规则（纯计算）。
- `node tests/test_sim.mjs`：模拟交易的规则（开盘时间、一手、T+1、手续费、涨跌停、对照线、买卖点）。
- `python3 tests/test_app.py`：真浏览器 + 本地假 GitHub（`tests/fake_github.py`，同时开账本和编的物品档案 `x/inventory-data` 两个仓库），汇率用假数据。推送后 GitHub Actions 自动跑。**改了功能就加对应步骤。**
- 网页通过 `localStorage['ledger-api-base']` 接到假 GitHub。
- **绝不拿真实数据仓库做写入测试。**

## 计划（分批做）

1. ✅ 记账、账户、转账、预算、首页总况和健康指标、「我们的花钱方式」。
2. ✅ 垫付报销（按「一件事」归组，发票 PDF/照片存私有仓库，报不回的部分结清时算「出差自付」，不占日常预算）、人情账（按人记谁欠谁，还到哪张卡都行）、每月对账、每周 / 每月总结图表。
2.5 ✅ 类别细分（三餐拆开、日常分小组）、心愿单（小额 / 大额、DeepSeek 建议）。
3. ✅ 存钱计划已并进大额心愿（暑假出游也建成大额心愿）；「买不买」聊天（DeepSeek，只发汇总数字；理财小课堂放在聊天页）、推送（每晚 9 点没记账提醒；周日、每月最后一天推总结）。

- 形象（2026-10-05 加，`CATEGORY_VERSION` 3）：护肤 / 化妆 / 香水和打理单独一组 `look`，算进生活预算（`LIVING`）。用户从日常里分出 150 给它。护肤化妆品的关键词（`BY_WORD`，和物品档案 bridge.js 同一张表）先认成这一组。生活网站（`../life`）的形象路线图讲买什么。
- 颜色（2026-10-07）：花销分组用 `--g-food / --g-daily / --g-look / --g-sub / --g-none`（藤紫深浅 + 暖灰，`GROUPS`），不用彩虹色；红色只给超支。周总结「和上周比」用灰色小字，不用红绿箭头。周总结最上面（`weekHead`，2026-10-07）：大字这周生活花了多少 + 右上小标签（节奏正常 / 花得有点快 / 下周收一收）+ 进度条（用了这周计划的多少，超了变琥珀色；这周没过完时竖线是到今天该花到哪，左下写「还能花」，过完了写「比计划少 / 多」）+ 最下面一行上周多少。有不占预算的花销时大字下面一行小字（`noneLine`）。年总结最上面（`yearHead`，2026-10-08）也一样：大字这一年存下多少 + 收入 / 花了 / 储蓄率三格 + 进度条（存下了计划的多少，计划 = `yearPlanBetween`：有收入的月「预计收入 − 预算」、暑假的月「− 预算」，开始记账那个月按天数折算；这一年没过完时竖线是到今天该存到哪，落后用琥珀色）+ 最下面总资产变化和记了几天账。月总结最上面（`monthHead`）同样的样子：大字这个月存下多少（没收入时是花了多少）+ 收入 / 花了 / 其中生活三格 + 生活预算进度条 + 下个月可以试试。角落那句话只在首页。按下去的手感在 `app.css` 最后（四个网站同一段）。
