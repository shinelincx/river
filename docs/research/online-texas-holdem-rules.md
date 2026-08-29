# 线上无限注德州扑克规则研究

> 调研日期：2026-08-29  
> 用途：为私人牌局的需求设计提供可追溯的标准规则基线。本文只归纳游戏机制，不构成任何司法辖区的博彩合规、牌照或支付建议。

## 结论与建议范围

私人房局可将首版规则明确为：**标准 52 张牌、2–10 人、无限注德州扑克（No-Limit Hold'em, NLH）、table stakes（仅限本手开局已在桌面的筹码）**。这与大型线上扑克运营商公布的常规 Hold'em 规则一致。[PokerStars：Texas Hold'em Rules](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/?scroll=null)

以下各节均说明“标准规则是什么”；未由该规则直接决定的产品行为集中列于“待明确的产品策略”，不应被误认为是标准规则。

## 1. 基础牌局模型与人数

- 每桌为 2–10 名玩家，使用一副标准 52 张牌。每名玩家持有两张仅自己可见的底牌；牌面最多发出五张所有玩家可用的公共牌。[PokerStars：Texas Hold'em Rules](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/?scroll=null)
- 玩家从“2 张底牌 + 5 张公共牌”的七张可用牌中，任选零、一或两张底牌，组成自己的最佳五张牌。因此必须支持“公共牌本身即为最佳五张”的情形，不能强制使用底牌。[PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/)
- 玩家可通过两种方式赢得可争取的底池：其余玩家都弃牌，或在摊牌时以最佳五张牌获胜。前者不需要亮牌。[PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/)

## 2. 牌型、比较与平局

标准高牌玩法的牌型从强到弱依次为：皇家同花顺、同花顺、四条、葫芦、同花、顺子、三条、两对、一对、高牌。[PokerStars：Poker Hand Rankings](https://www.pokerstars.com/poker/games/rules/hand-rankings/)

- 先比较牌型类别；同类别再比较其构成牌的点数。例如顺子/同花顺比较最高牌，四条/三条比较成组牌点数，葫芦先比较三条再比较对子，两对先比较高对再比较低对，必要时按 kicker（踢脚牌）从高到低逐张比较。[PokerStars：Poker Hand Rankings](https://www.pokerstars.com/poker/games/rules/hand-rankings/)
- 花色不分大小；花色只用于构成同花或同花顺，不能在同等五张牌之间打破平局。[PokerStars：Poker Hand Rankings](https://www.pokerstars.com/poker/games/rules/hand-rankings/)
- 若所有比较的五张牌完全相同（包括 kicker），该底池由并列赢家平分。此规则同样适用于公共牌形成的完全相同牌面。[PokerStars：Poker Hand Rankings](https://www.pokerstars.com/poker/games/rules/hand-rankings/)

**实现含义：** 结算器的输入应是每位仍有资格玩家的七张可用牌，输出为可比较的“五张最佳牌”值；不能只比较两张底牌，也不能以花色作为比较键。

## 3. 庄家按钮、盲注与行动顺序

- 每手由 dealer button 标记名义庄家；button 左一为小盲（SB），再左一为大盲（BB），BB 通常是 SB 的两倍。每手结束后 button 顺时针移动一席。[PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/)
- 翻牌前（pre-flop）由 BB 左侧的玩家（UTG）先行动；翻牌、转牌、河牌（统称翻后）均由 button 左侧第一名仍在手牌中的玩家先行动，之后顺时针进行。[PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/)
- 单挑（heads-up）是座位与顺序的例外：button 玩家同时下 SB，另一位下 BB；button 玩家翻前先行动、翻后后行动。[PokerStars：Poker terms and rules explained](https://www.pokerstars.com/help/articles/poker-rules-master/)

**实现含义：** 每手应从“本手有效座位”计算 button、SB、BB 和首个行动者，不能仅按固定座位编号推导。两人局必须走专门分支。

## 4. 发牌街与合法动作

牌局从盲注与两张底牌开始，按以下顺序推进；每次公共牌发放前必须结束当前下注轮：

| 阶段 | 发牌 | 首个行动者 | 允许动作的规则 |
| --- | --- | --- | --- |
| Pre-flop | 每人两张私有底牌 | BB 左侧（UTG） | 面对 BB 可 fold、call 或 raise；若无人加注，BB 可 check。 |
| Flop | 三张公共牌 | button 左侧首名在手玩家 | 无未跟注下注时可 check 或 bet；已有下注时可 fold、call 或 raise。 |
| Turn | 第四张公共牌 | 同翻牌 | 与 flop 相同。 |
| River | 第五张公共牌 | 同翻牌 | 与 flop 相同；若仍有至少两人，之后进入摊牌。 |

上述动作语义及各街顺序以 [PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/) 为准。`fold` 后玩家不能再行动且失去已投入筹码；`call` 是补至当前最高下注额；`raise` 是先跟平再提高当前下注额。无人下注时才可 `check`，否则只能 fold/call/raise。[PokerStars：Poker Rules](https://www.pokerstars.com/poker/games/rules/)

除全下造成的合法不等额外，一轮下注在所有未弃牌玩家均已弃牌或已投入到该轮当前最高额时结束；之后才可发下一街。若只剩一名未弃牌玩家，立即将其有资格赢取的底池结算给该玩家，不再发后续牌或摊牌。[PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/)

## 5. 无限注下注、加注与短码全下

- 在 NLH 中，最小开注（bet）为 BB；任何玩家可下注或加注至其当前桌面筹码总额，即可 all-in，不存在加注次数上限。[PokerStars：How to Play Texas Hold'em](https://www.pokerstars.com/poker/games/texas-holdem/)
- 最小**加注增量**必须不小于本轮此前一次 bet 或 raise 的增量。例：有人 bet 100，下一人 raise 到 200（加注增量 100），后续玩家最少 raise 到 300。[PokerStars：Poker terms and rules explained](https://www.pokerstars.com/help/articles/poker-rules-master/)
- 若玩家筹码不足以跟注，则以其所有剩余桌面筹码 all-in；标准 table-stakes 规则不能要求其为继续本手追加桌外筹码，也不能因此被迫弃牌。[PokerStars：Poker Rules](https://www.pokerstars.com/poker/games/rules/)
- 未达到最小加注增量的短码 all-in 可被跟注，但不会重新开放给此前已行动玩家再次加注的权利；达到最小增量则按完整加注处理。[PokerStars：Poker terms and rules explained](https://www.pokerstars.com/help/articles/poker-rules-master/)

**实现含义：** 服务端在每次行动时至少校验：轮到该玩家、玩家尚未弃牌/全下、`callAmount`、剩余筹码、最小开注、最小加注增量，以及此次全下是否构成完整加注。客户端只负责引导，不能成为规则唯一校验点。

## 6. 主池、边池与可赢资格

- all-in 玩家仅能争取截至其最后投入额所覆盖的部分；其他仍可继续下注的玩家所增加的筹码形成该 all-in 玩家无资格赢取的边池。[PokerStars：Poker Rules](https://www.pokerstars.com/poker/games/rules/)
- 当至少一人 all-in 且其他玩家继续投注时产生边池；仅实际对该边池有投入的玩家可以赢得该边池。多名玩家 all-in 时可出现多个边池。[PokerStars：Poker terms and rules explained](https://www.pokerstars.com/help/articles/poker-rules-master/)

**实现含义：** 应按每名玩家的“本手累计投入额”分层建立主池与一个或多个边池；每个池保留独立的金额和有资格赢家集合，并分别以最佳五张牌结算。不得把所有投入合为一个池后仅排除短码玩家，否则会错误分配多个 all-in 情形。

## 7. 摊牌、分池与展示顺序

- river 下注轮后仍有两名或以上未弃牌玩家时摊牌；线上牌局可以自动展示所有剩余玩家底牌，并以最佳五张牌判定赢家。[PokerStars：Texas Hold'em Rules](https://www.pokerstars.com/poker/learn/lesson/texas-holdem-rules/?scroll=null)
- 若 river 无下注，button 左侧第一名仍在手牌的玩家先展示；若 river 有 bet/raise，则最后激进下注或加注者先展示。赢家的牌必须展示。线上自动亮牌时，该顺序主要影响行动记录与回放展示，而非结算结果。[PokerStars：Poker terms and rules explained](https://www.pokerstars.com/help/articles/poker-rules-master/)
- 一个池的多名赢家具有完全相同的最佳五张牌时，该池均分；边池与主池必须作为独立池，分别确定赢家并分配。[PokerStars：Poker Hand Rankings](https://www.pokerstars.com/poker/games/rules/hand-rankings/)；[PokerStars：Poker Rules](https://www.pokerstars.com/poker/games/rules/)

## 8. 待明确的产品策略（非本规则默认值）

以下问题不是上述标准规则可唯一推出的结论，私人房局需求需明确选择：

1. **房间规模：** 是否开放标准的 2–10 人，或因产品与 UI 限制收窄到 2–9 人。
2. **盲注与 ante：** 固定 SB/BB 还是允许房主配置；是否完全不支持 ante；是否允许盲注随时间增长。
3. **筹码生命周期：** 初始带入、手间补码、离桌、坐回、淘汰后能否重买，以及它们生效的手次边界。
4. **超时与掉线：** 默认自动 check（无下注可跟）/fold（需跟注）是否适用；恢复连接是否只对下一手生效。
5. **无法整除的筹码：** 平分底池的余数（odd chip）给谁；需以明确、可复现的座位顺序定义，不能静默丢弃或凭客户端决定。
6. **提前全下：** 所有仍在手牌者 all-in 后，是否自动依次发完剩余公共牌并直接结算；若支持“run it twice”，须另行定义每条牌面与每个池的拆分规则。
7. **反作弊与审计：** 随机发牌的可验证性、底牌可见性、行动超时记录、手牌历史和断线重连的授权边界。

## 来源说明

研究优先采用 PokerStars（大型线上扑克运营商）的官方规则与帮助中心页面，因其直接定义线上牌局的软件行为。各结论均在对应段落链接到来源；未采用博客、论坛或策略文章作为规则依据。
