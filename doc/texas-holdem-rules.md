# River 无限注德州扑克规则与实现基线

> 调研日期：2026-08-28  
> 范围：标准高牌制（high only）No-Limit Texas Hold'em，私人桌/锦标赛式积分，不含 straddle、run it twice、保险、抽水与现金桌补盲。  
> 说明：文中“规则”来自 Poker TDA、WSOP、PokerStars 的一手资料；“实现结论 / UI 推论”是为 River 服务端状态机与客户端交互给出的确定性落地方案，不冒充正式规则。

## 1. 权威来源与采用顺序

1. [Poker TDA 2024 Rules、Recommended Procedures 与 Illustration Addendum](https://www.pokertda.com/view-poker-tda-rules/)：当前公开的 TDA 规则页，主要用于下注、加注、short all-in、重新开放行动、摊牌、边池与余数筹码。
2. [2026 WSOP Official Tournament Rules（PDF）](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf)：用于与 TDA 交叉验证；重点为 Rules 73–74、80、87、95–96、108，以及 Section VIII / glossary。
3. PokerStars 官方在线规则与产品行为：
   - [The Rules of Online Poker](https://www.pokerstars.com/poker/games/rules/)
   - [Texas Hold'em Rules](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/)
   - [Poker terms and rules explained（side pot、heads-up、small all-in）](https://www.pokerstars.com/help/articles/poker-rules-master/)
   - [Money in the pot](https://www.pokerstars.com/help/articles/money-in-pot/)
   - [Moving button system](https://www.pokerstars.com/help/articles/fwd-moving-button/)
   - [Table appearance / Preferred Seat](https://www.pokerstars.com/help/articles/table-appearance-feature/232136/)

若这些来源在现场程序性细节上有差异，本项目应把所选方案写成 house rule，并在同一房间中始终一致。核心下注数学在上述来源中没有实质冲突。

## 2. 按钮、盲注与行动顺序

### 2.1 多人桌（3 人及以上）

- 按钮（BTN）标记庄位；小盲（SB）是按钮顺时针方向下一位有资格参赛者，大盲（BB）是再下一位。每手牌结束后按钮按所采用的按钮制度移动。
- 翻牌前由大盲顺时针方向下一位仍在手牌中的玩家（UTG）首先行动，然后顺时针继续。
- 翻牌、转牌、河牌均由按钮顺时针方向下一位仍在手牌、且尚能行动的玩家首先行动。
- 已弃牌与已全下玩家不再获得行动；寻找下一行动者时必须跳过他们。
- 若此前所有人只跟到大盲，大盲仍拥有 `check` 或合法 `raise` 的完整选择，不能直接结束翻牌前下注轮。

PokerStars 的 [Texas Hold'em Rules：Pre-Flop / Flop](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/) 明确写明翻牌前由大盲左侧开始、翻牌后由按钮左侧首位活跃玩家开始，并说明无人加注时大盲可 check；WSOP 2026 glossary 将盲注定义为发牌前的 live bet，并规定按钮每手顺时针移动，规则含义一致。

### 2.2 单挑（heads-up）

- 按钮兼小盲，另一位玩家为大盲。
- 按钮/小盲翻牌前先行动，翻牌后最后行动；因此大盲翻牌后先行动。
- 从多人局切到单挑时可以校正按钮，以避免同一玩家连续两次支付大盲。

这是 [Poker TDA Rule 34-B](https://www.pokertda.com/view-poker-tda-rules/) 与 [WSOP 2026 Rule 87](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf) 的直接规则；PokerStars 的 [heads-up 说明](https://www.pokerstars.com/help/articles/poker-rules-master/) 也给出相同行动顺序。

### 2.3 River 应采用的按钮制度（house rule）

TDA 锦标赛采用 dead button（Rule 32），而 PokerStars 官方说明在线动态桌使用 [forward-moving button](https://www.pokerstars.com/help/articles/fwd-moving-button/)，以保证每手都有 SB 与 BB。River 是线上私人桌，建议采用：

- 下一手按钮移动到顺时针下一位 `stack > 0` 且已入座的玩家；
- 再从该按钮依次寻找 SB、BB；
- 进入 heads-up 时应用上节的特殊规则；
- 服务端保存真实物理座号，客户端不得因“主视角旋转”改变按钮或行动顺序。

这是产品 house rule，不是所有扑克室唯一允许的按钮制度。

### 2.4 盲注不足时

- SB/BB 实际扣除 `min(stack, blindAmount)`；筹码用尽即 `allIn = true`。
- **实现结论：** 即使大盲玩家只能投入不足额筹码，翻牌前其他有足够筹码的玩家进入底池仍应面对牌局规定的名义大盲，因此 `currentBet` 初始化为名义 BB，而不是该玩家实际投入额；实际投入差异在主池/边池中解决。
- ante 若以后加入，只增加 `handContribution` 与底池，不增加玩家的 `streetContribution`、`currentBet` 或 `toCall`。

WSOP 2026 Section VIII 规定无限注最小下注等于 BB，其 glossary 将盲注定义为结构指定的强制 live bet；同一 glossary 对 all-in 的限制是玩家只能赢取自己已贡献并获他人跟注的部分。这共同导出上述服务端处理。

## 3. 合法动作

设：

```text
toCall = max(0, currentBet - streetContribution[player])
allInTarget = streetContribution[player] + stack[player]
```

PokerStars [The Rules of Online Poker](https://www.pokerstars.com/poker/games/rules/) 对动作的官方定义是：当前轮尚无下注才可 check/bet；面对下注时通过 fold/call/raise 响应；No-Limit 的上限为玩家全部筹码。TDA Rules 40–52 规定动作必须按顺序且声明具有约束力。

| 场景 | 合法动作 | River UI / API 约束 |
|---|---|---|
| `toCall = 0` 且本街尚无下注 | `check`、`bet`；筹码不足最小下注时可 short all-in | 普通 `fold` 不应作为主按钮；可另做预操作“遇下注则弃牌” |
| `toCall = 0` 且存在 live blind / 玩家已跟平（典型为 BB option） | `check`、`raise` | 文案显示“过牌 / 加注到”而不是“下注” |
| `toCall > 0` | `fold`、`call`、在加注权开放时 `raise` | `call` 实扣 `min(toCall, stack)` |
| `stack <= toCall` | `fold` 或 `call all-in` | 不足额跟注合法，不能强迫补足筹码 |
| `allInTarget > currentBet` 且加注权开放 | `all-in raise` 合法 | 即使达不到最小完整加注仍可 short all-in |
| `allInTarget > currentBet` 但加注权未重新开放 | 不得用 all-in 绕过关闭的加注权 | 只能 fold/call；“全下”按钮应隐藏或按 call 处理而不投入多余筹码 |

弃牌意味着立即失去手牌及本手已投入筹码的获奖资格；call 是补齐当前需跟金额（筹码不足则全下）；raise 是先跟平再增加当前下注层级。PokerStars [Texas Hold'em Rules](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/) 与 TDA Rules 47、50–51 支持这些约束。

## 4. 最小下注、最小加注与 short all-in

### 4.1 最小下注

- 翻牌后尚无人下注时，完整 opening bet 至少为一个名义 BB。
- 玩家筹码少于一个 BB 时，允许把全部剩余筹码作为不足额 opening all-in。
- No-Limit 最大下注/加注目标为玩家当前可用的全部筹码。

参见 PokerStars [No-Limit Hold'em 规则](https://www.pokerstars.com/poker/games/texas-holdem/) 与 WSOP 2026 Section VIII（minimum bet = Big Blind）。

### 4.2 最小完整加注

关键不是“当前总下注翻倍”，而是**至少增加本街上一笔最大的完整下注/完整加注增量**。TDA Rule 43 与其 Illustration Addendum 给出：下注 600、加注 1000 到总额 1600 后，下一位最少再增加 1000，即加到 2600；不是加到 3200。[TDA Rules 43、47 及示例](https://www.pokertda.com/view-poker-tda-rules/) 与 [WSOP 2026 Rules 95–96](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf) 一致。

服务端应维护：

```text
lastFullRaiseSize

preflop 初始化：bigBlind
postflop 初始化：bigBlind（尚无下注时用于最小 opening bet）

若已有下注：
minRaiseTo = currentBet + lastFullRaiseSize
maxRaiseTo = streetContribution[player] + stack[player]
```

例子：

| 本街过程 | `lastFullRaiseSize` | 下一完整加注最小目标 |
|---|---:|---:|
| 盲注 50/100，翻牌前尚无加注 | 100 | 加到 200 |
| 翻牌下注 100 | 100 | 加到 200 |
| 下注 100，加到 350（增量 250） | 250 | 加到 600 |
| 下注 300，short all-in 到 500 | 300（不变） | 尚未行动者可加到 800 |

如果翻牌后第一笔动作是小于 BB 的 all-in，例如 BB=100、A 全下 20，则未行动且有加注权的 B 可 call 20，或至少**增加一个完整最小下注**而加到 120；不能把普通最小下注误写成只补到 100。已经 check 过且只新面对 20 的玩家没有被重新开放加注。

### 4.3 short all-in 是否重新开放行动

不足一个完整下注/加注增量的 all-in：

- 本身合法并提高 `currentBet`；后续玩家仍需补跟差额；
- 不更新 `lastFullRaiseSize`；
- 尚未在该下注轮行动的玩家仍保有完整 raise 权；
- 已经行动的玩家，只有当行动回到自己时，**相对自己上次行动所面对的下注层级，累计增加已达到至少一个 `lastFullRaiseSize`**，才重新获得 raise 权；否则只能 fold/call；
- 多个 short all-in 的累计增量可以重新开放行动，但重新开放后的最小加注增量仍是最后一次完整有效下注/加注。

这是 [Poker TDA Rule 47 与 Illustration Addendum](https://www.pokertda.com/view-poker-tda-rules/) 的直接规则；[WSOP 2026 Rule 96(a)](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf) 给出 `500 bet → 1000 raise → 1300 all-in → 1700 all-in` 的例子：累计达到上一完整加注 500 后重新开放，最小可加到 2200。

### 4.4 River 筹码粒度与快捷码量（house rule）

标准规则规定最小下注与最小完整加注，但不规定线上娱乐积分必须采用何种面额。River 采用小盲额作为常规下注/加注的最小单位：10/20 桌的常规目标必须是 10 的整数倍；全下保留精确的剩余积分，即使带有余数也合法。

快捷码量必须先按以下顺序生成，再只显示唯一且可直接提交的目标：

1. 翻牌后无人下注：`1/3 池`、`1/2 池`、`2/3 池`、`满池`。
2. 翻牌前仅有盲注：`2.5 BB`、`3 BB`、`4 BB`、`全下`。
3. 面对下注或加注：`最小加注`、`2.5 倍当前下注`、`底池加注`、`全下`；底池加注目标为 `currentBet + potTotal + toCall`。

对每个非全下候选目标执行 `ceil(max(candidate, minRaiseTo) / smallBlind) * smallBlind`。目标超过可全下额时不替换成误导性的比例按钮；只保留“全下”。重复目标合并；因此短码时快捷项可以少于四个，但任何显示的快捷项都能执行，不能置灰。服务端同样校验粒度，客户端只负责引导。

建议每位玩家保存：

```text
hasActedThisStreet[player]
betLevelAtLastAction[player]

raiseIsOpen(player) =
  !hasActedThisStreet[player]
  || currentBet - betLevelAtLastAction[player] >= lastFullRaiseSize
```

官方示例中的细节非常重要：玩家 C 在 125 时已经 call，随后仅面对 200（多 75），其 raise 不开放；若另一玩家把总额加到 300，C 相对 125 新面对 175，达到完整增量 100，raise 才重新开放。

### 4.4 本街何时结束

一轮下注只有在下列条件满足时结束：

- 每位仍可行动（未 fold、未 all-in）的玩家都完成了所需动作；
- 他们的 `streetContribution` 均已跟到 `currentBet`；或在无人下注时所有人都 check；
- 大盲的翻牌前 option 也已完成。

PokerStars [The Rules of Online Poker](https://www.pokerstars.com/poker/games/rules/) 明确规定：所有玩家跟平或弃牌，或者无人下注且所有人 check，当前 betting round 才结束。

实现上建议维护 `pendingActionPlayerIds`：

- 新街：加入所有可行动玩家；
- check/call/fold：移除当前玩家；
- 完整 bet/raise：重建为除进攻者外的所有可行动玩家；
- short all-in：保留尚未行动者，并把所有尚未跟到新 `currentBet` 的可行动玩家重新加入；是否能 raise 再由上一节公式判断；
- pending 为空后才进入下一街。

## 5. 每轮下注与整手总贡献必须分开

扑克规则描述的是 pre-flop、flop、turn、river 四个独立 betting rounds；每轮都要重新从 check/bet 开始，但已投入的筹码继续属于整手底池。参见 PokerStars [The Rules of Online Poker](https://www.pokerstars.com/poker/games/rules/) 和 [Texas Hold'em Rules](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/)。

因此服务端至少需要两个不同字段：

```text
streetContribution[player]  // 本街投入；用于 toCall、currentBet、加注
handContribution[player]    // 本手净投入；用于总底池、主池、边池
```

每次投入 `delta`：

```text
stack -= delta
streetContribution += delta
handContribution += delta
```

进入 flop / turn / river 时：

```text
streetContribution[*] = 0
currentBet = 0
lastFullRaiseSize = bigBlind
hasActedThisStreet[*] = false
betLevelAtLastAction[*] = 0
```

但 `handContribution` 直到整手分池与派奖完成前绝不能清零。盲注计入 pre-flop 的两个 contribution；弃牌玩家的 `handContribution` 仍留在底池，只是失去获奖资格。

## 6. 未跟注筹码、底池显示、主池与边池

### 6.1 未跟注筹码必须先退回

下注轮结束时，某玩家独有且没有任何对手匹配的最高投入部分不是底池，必须退回。Poker TDA Rules 15-B、65-A 明确要求未被 call 的 bet/raise 退回；[WSOP 2026 Rule 108](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf) 同样规定 uncalled bet or raise 返回玩家。

**实现结论：** 在每街结束、分池或因所有对手弃牌而派奖前，对本街投入做一次 reconciliation：

```text
top = 本街唯一最高 streetContribution
second = 本街第二高 streetContribution（包含随后弃牌者已投入的筹码）
refund = max(0, top.amount - second.amount)

top.stack += refund
top.streetContribution -= refund
top.handContribution -= refund
```

若最高投入有两位或以上并列，就没有未跟注额。不能先把未跟注额算进底池再“由赢家赢回”，因为这会使底池数字、边池资格和派奖日志都错误。

### 6.2 底池显示

PokerStars 官方 [Money in the pot](https://www.pokerstars.com/help/articles/money-in-pot/) 明确说明：桌面顶部显示完整底池，**包括当前仍摆在玩家面前的本街下注**；每轮结束时下注移动到桌面中央，但总额不因此改变。

River 应采用：

```text
displayedTotalPot = sum(handContribution[player])
```

- 每个座位旁另显 `streetContribution[player]`，不要把它与中心底池重复相加；
- 每街“收筹码”只是动画和 `streetContribution` 清零，不改变 `displayedTotalPot`；
- uncalled refund 发生时同步降低底池显示并显示“退回 X”；
- 出现全下分层后，中心可显示 `总底池 X`，展开为 `主池 A · 边池1 B · 边池2 C`；
- 不能用 `sum(player.bet)` 作为整手底池，因为该字段若在换街时清零会丢失前街贡献。

### 6.3 主池 / 边池构造

PokerStars [Table stakes and All-in](https://www.pokerstars.com/poker/games/rules/) 规定：全下玩家只能赢取截至其最终投入额度的部分，此后其他玩家的行动进入其无资格赢取的 side pot；[PokerStars side-pot 帮助](https://www.pokerstars.com/help/articles/poker-rules-master/) 也明确“只有对边池有贡献者可赢该边池”。TDA Rule 21 与 WSOP 2026 Rule 74 要求每个边池独立分配。

完成 uncalled refund 后，用所有玩家的**整手净贡献**分层；弃牌者要参与金额计算，但不得出现在赢家候选集合中：

```text
levels = sort(unique(handContribution > 0), ascending)
previous = 0

for level in levels:
  contributors = players where handContribution >= level  // 包括 folded
  amount = (level - previous) * contributors.length
  eligible = contributors where !folded                    // 且手牌仍有效
  createPot(amount, eligible)
  previous = level
```

- 第一层是主池，后续层依次为边池 1、边池 2……；
- 某一层即使只剩一位 `eligible`，金额仍来自所有该层 contributors，该玩家直接获得该层；
- 每层单独比较牌力、单独平分、单独处理余数；绝不能把主池和边池合并后找一个总赢家；
- 多个全下玩家可以分别只参与他们达到的层级。

例：三人整手投入分别为 100 / 300 / 500。最高玩家的 200 没有匹配，应先退回，净贡献变为 100 / 300 / 300；随后形成主池 `100 × 3 = 300`，边池 `200 × 2 = 400`。若其中一名投入 300 的玩家已经弃牌，其筹码仍在两个池中，但他不在任何赢家候选中。

### 6.4 必须长期成立的筹码守恒

```text
sum(all awarded pots) + sum(refunds)
  == sum(original handContribution before settlement)

牌局进行中：sum(current stacks) + sum(handContribution)
  == 本手开始时全部参赛筹码

派奖后：sum(current stacks)
  == 本手开始时全部参赛筹码
```

本项目范围不含 rake；若未来加入抽水，必须把 rake 作为显式第三项记录，不能让筹码凭空消失。

## 7. 摊牌、分池与余数

### 7.1 不到摊牌即获胜

若只剩一位未弃牌玩家，该玩家直接获得所有已被跟注的主池/边池，不必展示底牌；其未被跟注的下注先按上一节退回。PokerStars [The Rules of Online Poker](https://www.pokerstars.com/poker/games/rules/) 将“最后一笔无人跟注下注使其他人弃牌”列为无需 showdown 的获胜方式；TDA Rule 17-B 也允许唯一 live hand 不亮牌获胜。

### 7.2 摊牌顺序与全下亮牌

- 有全下且所有其他下注行动已经结束时，所有仍有主池或边池资格的手牌立即亮出，然后发完公共牌；不能只亮边池玩家而暂时隐藏主池全下玩家。
- 普通摊牌中，河牌最后一位 bet/raise 的进攻者先亮；若河牌无人下注，由按钮左侧第一位仍在手牌的玩家先亮，之后顺时针。
- 在线产品可以自动亮出需要参与比较的牌。PokerStars 官方说明在线牌局会自动展示摊牌手牌。

依据为 [Poker TDA Rules 16–17 及 Illustration Addendum](https://www.pokertda.com/view-poker-tda-rules/)、WSOP 2026 showdown rules，以及 PokerStars [Texas Hold'em Rules：Showdown](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/)。

### 7.3 每个池独立判定与平分

- 每名 eligible 玩家从 2 张底牌与 5 张公共牌中组成最佳 5 张牌，可以用 0、1 或 2 张底牌。
- 同一池有多个完全并列赢家时，先整除平分该池。
- TDA Rules 20–21 与 [WSOP 2026 Rules 73–74](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf) 规定：每个主池/边池分别处理；德州扑克余下的最小单位筹码给按钮左侧顺时针方向第一位并列赢家。
- **实现补充：** 若一个池的余数多于 1 个最小单位，则从按钮左侧第一位并列赢家开始，按顺时针向并列赢家每人发 1 单位，直到该池余数用完；这是一种将官方“first seat left of the button”确定性扩展到多个余数单位的实现约定。

建议先计算、记录所有 pot awards，再一次性修改 stack；UI 可按“最外层边池 → … → 主池”播放派奖动画，但动画顺序不得改变资格与金额。TDA Illustration Addendum 的 all-in 示例也采用先边池、后主池的派奖叙述。

## 8. 本地玩家底部主视角：UI 惯例，不是扑克规则

正式规则只关心真实座号、按钮和相对行动顺序，不要求本地玩家必须显示在底部。PokerStars 官方 [Table Appearance](https://www.pokerstars.com/help/articles/table-appearance-feature/232136/) 提供“按桌型选择 Preferred Seat”，证明客户端旋转显示是常见在线产品能力；但“River 固定把自己放在最底部中央”是本项目的 UX 决策与行业惯例推论，不是 TDA/WSOP 规则。

### 8.1 映射原则

- 服务端 `physicalSeat` 永远不变，行动、按钮、盲注、余数筹码都按真实座号计算。
- 客户端只计算 `visualOffset`，把 hero 旋转到视觉槽 0（底部中央）。
- 必须按房间 `maxSeats` 保留空位；不能按“当前玩家数组下标”压缩座位，否则有人离桌/淘汰时所有对手会跳位。
- BTN / SB / BB、当前行动倒计时、下注额等标记跟随玩家从真实座位映射到视觉槽，但其业务含义不变。

假定真实座号沿顺时针递增：

```text
visualOffset(player) = mod(
  physicalSeat(player) - physicalSeat(hero),
  maxSeats
)
```

`visualOffset = 0` 固定为底部中央；`+1` 是 hero 顺时针下一席，在屏幕上位于左下方向，之后沿桌缘顺时针排列。

### 8.2 6 人桌推荐锚点

| visualOffset | 相对 hero | 视觉位置 |
|---:|---|---|
| 0 | hero | 底部中央 |
| 1 | 顺时针第 1 席 | 左下 |
| 2 | 顺时针第 2 席 | 左上 |
| 3 | 对家 | 顶部中央 |
| 4 | 顺时针第 4 席 | 右上 |
| 5 | 顺时针第 5 席 | 右下 |

9 人桌不应复用“前 6 个 9 人桌 CSS 槽位”；应生成完整 9 个等距椭圆锚点。通用方案：

```text
theta = 90° + visualOffset * 360° / maxSeats
x = centerX + radiusX * cos(theta)
y = centerY + radiusY * sin(theta)
```

在屏幕坐标系（y 向下）中，`theta = 90°` 是底部中央，角度增加沿桌面顺时针走向左侧。实际应为玩家卡片尺寸、刘海区和操作栏对 `radiusX/radiusY` 做响应式微调。

### 8.3 当前行动倒计时

倒计时应渲染在 `currentPlayerId` 映射后的座位组件内部，例如头像外圈进度环或头像旁数字；不能固定放在中心或 hero 区。WSOP 2026 Rule 80 对 player shot-clock 的描述也是把每次决策时间依次交给当前 Participant；这支持“计时状态属于当前行动者”的交互语义，但具体视觉位置仍是 UI 设计。

## 9. 推荐的服务端状态与派生值

```text
HandState
  dealerSeat
  smallBlindSeat
  bigBlindSeat
  street: preflop | flop | turn | river | showdown | settled
  currentPlayerId
  currentBet
  lastFullRaiseSize
  pendingActionPlayerIds
  pots[]

PlayerHandState
  folded
  allIn
  streetContribution
  handContribution
  hasActedThisStreet
  betLevelAtLastAction
```

API 不应让客户端自己猜合法动作。每次快照为本地玩家返回：

```text
legalActions
  canCheck
  canFold
  callAmount
  canBet
  canRaise
  minRaiseTo
  maxRaiseTo
  canAllIn
```

所有按钮文案用总目标表达，例如“加注到 600”，而不是含混的“加注 300”。服务端仍需重新校验每个动作，客户端禁用不是安全边界。

## 10. 最低回归测试矩阵

1. **顺序**：6 人桌 pre-flop 从 BB 下一位开始；flop 从 BTN 下一位 live player 开始；跳过 folded/all-in。
2. **BB option**：所有人 limp 到 BB，BB 仍可 check 或 raise。
3. **heads-up**：BTN=SB，BTN pre-flop first，BB post-flop first。
4. **最小下注**：BB=100，post-flop 普通 opening bet 最少 100；stack=60 可全下 60。
5. **完整加注**：下注 600、加到 1600，下一次最小加到 2600。
6. **pre-flop short raise**：盲注 50/100，UTG 全下到 150，尚未行动者最小可加到 250。
7. **short opening all-in**：BB=100，post-flop A 全下 20；未行动 B 可 call 20 或最小加到 120；已经 check 且只面对新增 20 的玩家不可 raise。
8. **不重新开放**：BB=4000，A call，C 全下到 7500；BB 尚未行动可 raise 到至少 11500；BB 若只 call，已行动 A 只能 fold/call 3500。
9. **累计重新开放**：500 bet、raise 到 1000、short all-in 到 1300、再 short all-in 到 1700；先前已行动者重新可 raise，最小到 2200。
10. **每街清零**：进入 flop 后所有 `streetContribution=0`，但 `handContribution` 与总底池保留 pre-flop 全部净投入。
11. **未跟注退回**：三人 100/300/500，先退 200，再形成主池 300、边池 400。
12. **弃牌死钱**：100/300/300，其中一个 300 玩家 folded；其投入计入金额但无获奖资格。
13. **多全下分层**：100/300/500/500，形成 400 主池、600 边池 1、400 边池 2；逐池独立比较。
14. **平分余数**：每个池分别平分；余数从 BTN 左侧第一位并列赢家开始分配。
15. **守恒**：随机动作序列中始终满足 stack + contribution 守恒；settlement 后所有 contribution/pot 清零且总 stack 不变。
16. **相对座位**：hero 分别在真实 1–6 / 1–9 号座时，视觉上始终在底部；所有其他玩家、BTN/SB/BB、下注额、行动倒计时保持正确相对偏移；空位不会使其他人跳位。

## 11. 实现时最容易出现的错误

- 把 `minRaiseTo` 写成 `currentBet * 2`；上一笔加注不是翻倍时立即错误。
- short all-in 后更新 `lastFullRaiseSize`，导致后续最小加注过小。
- 只用布尔 `acted` 判断重新开放，遗漏多个 short all-in 累计达到完整加注的情况。
- 所有人 limp 后直接发 flop，漏掉 BB option。
- 换街清空唯一的 `bet` 字段，导致底池只剩当前街金额。
- 只按未弃牌玩家贡献构造 pot，把弃牌者的 dead money 弄丢。
- 未先退回 uncalled excess，制造只有一个 contributor 的假边池。
- 合并主池与边池后只找一个总赢家。
- 用当前玩家数量压缩视觉座位，使玩家离桌后按钮与对手在屏幕上跳位。
- 为了把 hero 放底部而修改服务端真实 seat，进而破坏盲注、行动顺序与 odd-chip 归属。
