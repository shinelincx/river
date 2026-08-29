# River Table 私人牌局测试设计与追踪矩阵

> 状态：已确认  
> 日期：2026-08-29  
> 需求来源：[私人牌局需求设计](./private-table-requirements-design.md)

## 1. 测试策略

测试以需求设计第 11 节的验收标准为入口，并使用以下分层。每项已实现的行为必须以可运行、全绿的测试保护；尚未实现的目标需求在 Vitest 中以 `todo` 登记、在 Playwright 中以带 `TODO` 原因的跳过用例登记，直到相应功能交付后转换为可运行测试。它们不得被误当作已验收功能。

| 层级 | 工具与位置 | 目标 |
| --- | --- | --- |
| 规则单元 | Vitest；`apps/api/src/game-engine.test.ts` | 下注数学、牌力、底池、结算和筹码守恒。 |
| 房间/API 单元与集成 | Vitest + `Fastify.inject()`；`store.test.ts`、`index.test.ts` | 身份、邀请码、权限、账本和错误协议。 |
| Socket 集成 | Vitest + `socket.io-client`；`socket.test.ts` | Cookie 握手、入桌、ack、广播和玩家视角脱敏。 |
| PostgreSQL 集成 | Vitest + `@testcontainers/postgresql` | 真实迁移、事务事件/快照、重启恢复、过期清理。 |
| 浏览器 E2E | Playwright；`tests/e2e/` | Chromium 桌面/移动的深链、Cookie、多玩家隐私、座位布局。 |

根命令：

```bash
npm test                 # 所有非 todo 的单元/API/Socket/Web/E2E 测试
npm run test:coverage    # Vitest 覆盖率报告
npx playwright install chromium  # 首次运行实际 E2E 前安装浏览器
```

PostgreSQL 集成测试使用 Testcontainers，每次运行启动隔离数据库并执行真实迁移；本机和 CI 必须提供 Docker。Playwright 的实际浏览器用例加入后，应为 API 与 Web 配置受控的 `webServer` 启动命令，测试不得连接生产环境。

## 2. 需求追踪矩阵

| 需求验收标准 | 测试用例 | 层级 | 当前状态 |
| --- | --- | --- | --- |
| AC-01：受邀成员零初始积分且不能参赛 | TC-API-01、TC-SOCKET-01 | API、Socket | `todo` |
| AC-02：手中补分不影响权益 | TC-STORE-02、TC-PG-02 | 状态机、PostgreSQL | `todo`；当前实现反向行为必须替换 |
| AC-03：中途加入等待到结算边界 | TC-SOCKET-03、TC-E2E-03 | Socket、E2E | `todo` |
| AC-04：20 秒自动动作与 60 秒暂离 | TC-SCHED-04、TC-SOCKET-04 | Scheduler、Socket | 前半部分已有覆盖；暂离为 `todo` |
| AC-05：重启精确恢复且不重复结算 | TC-PG-05 | PostgreSQL | `todo` |
| AC-06：actionId、版本与并发恰好一次 | TC-API-06、TC-PG-06 | API、PostgreSQL | `todo` |
| AC-07：10 天内可复算发牌与分池 | TC-RNG-07、TC-PG-07 | 单元、PostgreSQL | `todo` |
| AC-08：回放/审计的底牌授权 | TC-SOCKET-08、TC-E2E-08 | Socket、E2E | 活跃快照脱敏已覆盖；其余 `todo` |
| AC-09：扑克规则回归矩阵 | TC-ENGINE-09-* | 规则单元 | 部分已覆盖；见第 3 节 |
| AC-10：暂停/移除/解散的手牌边界 | TC-STORE-10、TC-SOCKET-10 | 状态机、Socket | 解散部分覆盖；其余 `todo` |
| AC-11：邀请轮换与深链 | TC-API-11、TC-E2E-11 | API、E2E | 邀请关闭部分覆盖；其余 `todo` |

## 3. 已运行的回归用例

| 编号 | 用例 | 文件 |
| --- | --- | --- |
| TC-ENGINE-01 | 发牌仅向本地玩家显示自己的底牌，并在 matched action 后进入 flop。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-02 | 单挑时 BTN=SB，BTN 翻牌前先行动、BB 翻牌后先行动。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-03 | 最小完整加注基于上一完整加注增量，而不是简单翻倍。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-04 | short all-in 不重新开放加注；多个 short all-in 的累计增量可以重新开放。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-05 | 大盲 short stack 仍保留名义 BB；未跟注返还；主池/边池与筹码守恒。 | `apps/api/src/game-engine.test.ts` |
| TC-STORE-01 | 只有房主可补分，账本幂等，房间解散关闭邀请。 | `apps/api/src/store.test.ts` |
| TC-API-01 | Cookie 游客、建房、邀请码加入及非房主补分拒绝。 | `apps/api/src/index.test.ts` |
| TC-SOCKET-01 | Cookie Socket 握手、入桌、开局后的私牌脱敏快照。 | `apps/api/src/socket.test.ts` |
| TC-SCHED-01 | 20 秒自动 check/fold、结算后续局和不足两位正积分玩家等待。 | `apps/api/src/table-scheduler.test.ts` |

后续规则单元必须补足需求规则基线中的 6 人顺序/跳过 folded-all-in、翻后 short opening all-in、完整加注示例、精确多层边池、弃牌 dead money、odd chip 和随机动作筹码守恒。

## 4. 待办用例转正条件

1. 功能实现和运行时 schema 完成后，先将对应 `it.todo` 改为失败的最小验收测试，再实现至通过。
2. PostgreSQL 用例必须通过真实迁移与 Testcontainers 运行，不得仅 mock repository。
3. Socket 用例必须建立两个以上独立 Cookie 会话，验证 ack、重连/断线和每个接收者的 payload。
4. E2E 用例在 Chromium desktop 和 mobile 项目均运行；涉及深链的用例必须使用真实路由和独立浏览器上下文。
5. 每个实现 PR 都要更新本矩阵状态，并保持 `npm test` 与 `npm run typecheck` 全绿。

## 5. 安全与并发固定场景

- 未认证 Socket 连接被拒绝；成员不能读取其他房间或未参与手牌的完整审计材料。
- 非房主不能补分、暂停、移除成员、轮换邀请码或解散房间。
- 旧状态版本、未知动作、重复 `actionId` 和双击并发动作不会写入重复事件、重复扣积分或重复结算。
- 邀请码错误请求受限速；邀请码关闭或轮换后，旧值不能重新激活。
- 正在进行的手牌和未结算的完整牌堆永不广播给无权接收者。
