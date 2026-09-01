# River Table 私人牌局测试设计与追踪矩阵

> 状态：已确认  
> 日期：2026-08-29  
> 需求来源：[私人牌局需求设计](./private-table-requirements-design.md)

## 1. 测试策略

测试以需求设计第 11 节的验收标准为入口，并使用以下分层。每项行为均由可运行测试保护；当前需求矩阵中的 `todo`/跳过占位已全部转为真实测试，不能用占位用例冒充验收。

| 层级 | 工具与位置 | 目标 |
| --- | --- | --- |
| 规则单元 | Vitest；`apps/api/src/game-engine.test.ts` | 下注数学、牌力、底池、结算和筹码守恒。 |
| 房间/API 单元与集成 | Vitest + `Fastify.inject()`；`store.test.ts`、`index.test.ts` | 身份、邀请码、权限、账本和错误协议。 |
| Socket 集成 | Vitest + `socket.io-client`；`socket.test.ts` | Cookie 握手、入桌、ack、广播和玩家视角脱敏。 |
| PostgreSQL 集成 | Vitest + `@testcontainers/postgresql` | 真实迁移、事务事件/快照、重启恢复、过期清理和持久化专用覆盖率。 |
| 浏览器 E2E | Playwright；`tests/e2e/` | Chromium 桌面/移动的深链、Cookie、多玩家隐私、审计、断线和座位布局。 |
| 生产链路 E2E | Playwright + PostgreSQL 16 + 编译后 API | 浏览器牌局跨真实 API 进程重启保持同一牌堆、身份和可写状态。 |
| 持续门禁 | npm scripts + GitHub Actions | 构建、类型、覆盖率、真数据库和两套浏览器验收缺一即失败。 |

根命令：

```bash
npm test                       # 单元/API/Socket + 真 PostgreSQL + 两套浏览器 E2E
npm run verify                 # 构建、类型、覆盖率及全部验收门禁
npm run test:postgres          # WSL/Linux PostgreSQL 16 真容器 17 项
npm run test:postgres:coverage # persistence.ts 专用覆盖率门禁
npm run test:e2e:postgres      # 生产配置 API + PostgreSQL + 进程重启 E2E
npx playwright install chromium  # 首次运行实际 E2E 前安装浏览器
```

PostgreSQL 集成测试使用 Testcontainers，每次运行启动隔离数据库并执行真实迁移；本机和 CI 必须提供 Docker。强制命令在 Docker 不可用时直接失败，不能静默跳过。Playwright 使用受控的 `webServer`；普通桌面/移动验收运行开发态隔离服务，生产链路验收运行编译后 API、独立 PostgreSQL 容器和仅绑定本机的进程重启控制器，均不得连接生产环境。

本次在 WSL Debian + Docker + PostgreSQL 16 镜像中执行的真实环境命令：

```bash
POSTGRES_TEST_IMAGE=docker.m.daocloud.io/library/postgres:16-alpine npm run test:postgres
POSTGRES_TEST_IMAGE=docker.m.daocloud.io/library/postgres:16-alpine npm run test:postgres:coverage
POSTGRES_TEST_IMAGE=docker.m.daocloud.io/library/postgres:16-alpine npm run test:e2e:postgres
```

## 2. 需求追踪矩阵

| 需求验收标准 | 测试用例 | 层级 | 当前状态 |
| --- | --- | --- | --- |
| AC-01：受邀成员零初始积分且不能参赛 | TC-STORE-01、TC-API-01、TC-SOCKET-01 | 状态机、API、Socket | 通过 |
| AC-02：手中补分不影响权益 | TC-STORE-13、TC-SCHED-14 | 状态机、Scheduler | 通过 |
| AC-03：中途加入等待到结算边界 | TC-STORE-13、TC-E2E-24 | 状态机、E2E | 通过 |
| AC-04：20 秒自动动作与 60 秒暂离 | TC-SCHED-01、TC-SCHED-14、TC-E2E-38 | Scheduler、Socket、E2E | 通过 |
| AC-05：重启精确恢复且不重复结算 | TC-PG-01、TC-RESTART-23、TC-PG-E2E-39 | PostgreSQL、生产 E2E | 通过 |
| AC-06：actionId、版本与并发恰好一次 | TC-ACTION-41、TC-PG-15、TC-EVENT-22 | Socket、PostgreSQL | 通过 |
| AC-07：10 天内可复算发牌与分池 | TC-RNG-11、TC-AUDIT-12、TC-PG-15、TC-HISTORY-36 | 单元、PostgreSQL | 通过 |
| AC-08：回放/审计的底牌授权 | TC-AUDIT-12、TC-HISTORY-20、TC-E2E-38 | 单元、E2E | 通过 |
| AC-09：扑克规则回归矩阵 | TC-ENGINE-01～10 | 规则单元 | 通过 |
| AC-10：暂停/移除/解散的手牌边界 | TC-STORE-01、TC-AUTH-26、TC-E2E-29、TC-E2E-38 | 状态机、Socket、E2E | 通过 |
| AC-11：邀请轮换、深链与失效会话恢复 | TC-INVITE-21、TC-E2E-01、TC-SESSION-42 | API、E2E | 通过 |

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
| TC-ENGINE-06 | 6 人桌按物理座位行动，并跳过已弃牌和 all-in 玩家。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-07 | 翻牌后 short opening all-in 合法，但不改变完整加注增量。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-08 | 三层底池精确包含弃牌死钱，并为每层独立派奖。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-09 | 平分底池的 odd chip 按按钮左侧物理座位顺时针分配。 | `apps/api/src/game-engine.test.ts` |
| TC-ENGINE-10 | 25 组确定性随机合法动作序列始终保持积分守恒。 | `apps/api/src/game-engine.test.ts` |
| TC-PG-01 | PostgreSQL 16 真容器迁移、事件/快照事务、重启恢复和 10 天清理。 | `apps/api/src/postgres.integration.test.ts` |
| TC-E2E-01 | 深链身份创建、独立 Cookie 隐私、旧邀请码失效和 6/9 人布局。 | `tests/e2e/private-table.spec.ts` |
| TC-RNG-11 | 服务端先广播逐手承诺，再收集绑定 `handId` 的一次性玩家贡献；收齐前不发牌。 | `apps/api/src/game-engine.test.ts`、`apps/api/src/socket.test.ts` |
| TC-AUDIT-12 | 完整验证器可发现牌堆、底牌、公共牌、底池及派奖篡改；非参与等待者收不到 seed/审计字段。 | `apps/api/src/game-engine.test.ts`、`apps/api/src/socket.test.ts` |
| TC-STORE-13 | 成员数不受座位数限制；候补不占物理座位，空位只在手牌边界按队列分配；未入桌补分保持原子；活跃手牌补分排队到结算边界。 | `apps/api/src/store.test.ts`、`apps/api/src/game-engine.test.ts` |
| TC-SCHED-14 | action、下一手和逐玩家重连截止时间可恢复；重复动作、补分及生命周期命令不延长当前行动时钟。 | `apps/api/src/table-scheduler.test.ts`、`apps/api/src/socket.test.ts` |
| TC-PG-15 | 延迟的旧事务不能覆盖新版本；审计过期同时清理事件、快照秘密，后续保存不会复活材料。 | `apps/api/src/postgres.integration.test.ts` |
| TC-PERSIST-16 | 权威持久化失败时回滚已接受动作，并恢复原动作时钟和玩家视角快照。 | `apps/api/src/socket.test.ts` |
| TC-SCHED-17 | 结算边界先晋升有积分候补，再判断下一手自动开局条件。 | `apps/api/src/table-scheduler.test.ts` |
| TC-LEDGER-18 | 每手结算为每位参与者追加幂等积分变化流水，且本手净变化守恒。 | `apps/api/src/store.test.ts` |
| TC-API-19 | HTTP 玩家视角牌桌快照支持版本对账，并拒绝非成员访问。 | `apps/api/src/index.test.ts` |
| TC-HISTORY-20 | 最近 10 天手牌索引和普通回放包含参与者、盲注、公共牌、底池、时间线及积分变化，同时保持底牌授权。 | `apps/api/src/game-engine.test.ts`、`apps/web/src/requirements.test.ts`、`tests/e2e/private-table.spec.ts` |
| TC-INVITE-21 | 128 位邀请凭证以 AES-GCM 密文、哈希与版本分离持久化；关闭后重开签发新值；暂停仍可加入；成功请求不清空错误尝试计数。 | `apps/api/src/index.test.ts`、`apps/api/src/store.test.ts`、`apps/api/src/postgres.integration.test.ts` |
| TC-EVENT-22 | 一次转换产生的全部公开事件按连接序号顺序投递；逐手事件写入 `hand_events`；快照哈希异常时从受保护恢复检查点精确重建并标记异常。 | `apps/api/src/socket.test.ts`、`apps/api/src/postgres.integration.test.ts` |
| TC-RESTART-23 | 启动时以最终恢复表为准统一标记离线并建立重连宽限；排队中的旧超时不能删除新行动者时钟。 | `apps/api/src/postgres.integration.test.ts`、`apps/api/src/table-scheduler.test.ts` |
| TC-E2E-24 | 桌面/移动 Chromium 真实完成普通回放；中途入桌显示候补、当手无底牌，并在结算边界自动坐入下一手。 | `tests/e2e/private-table.spec.ts` |
| TC-SCHED-25 | 已排队的旧重连/下一手回调不能覆盖新截止时间，也不能绕过最新断线状态开局。 | `apps/api/src/table-scheduler.test.ts` |
| TC-AUTH-26 | 成员被移除后现有 Socket 立即退出房间且不能再同步；历史列表只包含本人参与过的手牌。 | `apps/api/src/socket.test.ts`、`apps/api/src/game-engine.test.ts` |
| TC-PG-27 | 全局及牌桌恢复均使用数据库单调 revision；状态与全部计时同包校验，可越过损坏检查点，并在系统时钟回拨时保持最新状态。 | `apps/api/src/postgres.integration.test.ts` |
| TC-PG-28 | 已持久化的洗牌准备取消后清除秘密恢复材料、保留 cancelled 生命周期，并可用同一显示手数重新准备。 | `apps/api/src/postgres.integration.test.ts` |
| TC-E2E-29 | 暂停的空闲牌局可由房主立即解散，客户端不再读取已关闭成员关系并返回房间列表。 | `tests/e2e/private-table.spec.ts` |
| TC-PG-30 | 牌桌持久化只追加新事件，拒绝事后到达的旧状态；恢复增量不重复嵌入完整事件历史，并通过周期检查点将恢复日志限制在固定规模；全局快照不复制积分历史且聚合恢复记录最多保留两份。 | `apps/api/src/postgres.integration.test.ts` |
| TC-AUDIT-31 | 审计材料中的洗牌承诺、开局承诺、结算承诺和牌局身份必须一致；服务端验证还必须匹配 `hands.commitment_hash` 独立记录。 | `apps/api/src/game-engine.test.ts`、`apps/api/src/postgres.integration.test.ts` |
| TC-PG-32 | 结算快照始终使用无秘密恢复基线；服务停机跨过第 10 天且活动快照损坏时，仍能恢复牌桌且不复活底牌或服务端 seed。 | `apps/api/src/postgres.integration.test.ts` |
| TC-PG-33 | 结算后下一手准备中的恢复记录绑定新 `handId`；准备取消后清除该手秘密恢复材料。 | `apps/api/src/postgres.integration.test.ts` |
| TC-PG-34 | 全局快照、累计账本哈希和牌桌 revision 同包校验；启动迁移不重签离线损坏数据，回退会清除未来房间/准备手秘密并可修复快照、追加新积分、再次重启；基线明文邀请只在应用密钥加密及 v2 快照提交后清除。 | `apps/api/src/postgres.integration.test.ts` |
| TC-CONFIG-35 | `NODE_ENV` 未设置或为非标准值时，缺少 PostgreSQL/邀请密钥的独立进程必须 fail-closed；仅显式 `development`/`test` 可用内存默认值。 | `apps/api/src/runtime-config.test.ts` |
| TC-HISTORY-36 | 结算事件离开 500 条牌桌快照窗口后，仍以权威结算序号恢复未满 10 天的审计和回放；回退为 active 的同一手不得挂载较新结算材料。 | `apps/api/src/postgres.integration.test.ts` |
| TC-AUTH-37 | 未认证 Socket 握手被拒绝；受邀玩家不能关闭/轮换邀请、移除成员或解散房间，失败命令不改变状态。 | `apps/api/src/socket.test.ts`、`apps/api/src/index.test.ts` |
| TC-E2E-38 | 桌面/移动 Chromium 完成本地审计验证、审计 JSON 下载、真实断线重连倒计时和解散后的私人最终积分历史。 | `tests/e2e/private-table.spec.ts` |
| TC-PG-E2E-39 | 编译后生产 API 使用独立 PostgreSQL 16；两名浏览器玩家在 API 进程重启后恢复相同底牌并继续完成手牌。 | `tests/e2e/production-persistence.spec.ts` |
| TC-GATE-40 | 强制 PostgreSQL 模式在无 Docker 时失败；CI 执行构建、类型、风险模块覆盖率、持久化专用覆盖率和两套 E2E。 | `scripts/test-postgres.mjs`、`.github/workflows/verify.yml` |
| TC-ACTION-41 | 未知动作、旧版本、并发重复 `actionId` 和多标签连接均通过公开 Socket ack 验证恰好一次语义。 | `apps/api/src/socket.test.ts` |
| TC-SESSION-42 | 页面已持有身份但服务端会话失效时，创建房间收到 401 后关闭邀请码弹窗并返回设备身份创建页。 | `tests/e2e/private-table.spec.ts` |

规则基线已补足 6 人顺序、folded/all-in 跳过、翻后 short opening all-in、完整加注、精确多层边池、弃牌 dead money、odd chip 和随机动作积分守恒。

## 4. 持续准入条件

1. 新功能先增加失败的最小验收测试，再实现至通过；禁止提交 `it.todo`、`test.skip` 或 `only` 作为验收证据。
2. PostgreSQL 用例必须通过真实迁移与 Testcontainers 运行，不得仅 mock repository。
3. Socket 用例必须建立两个以上独立 Cookie 会话，验证 ack、重连/断线和每个接收者的 payload。
4. E2E 用例在 Chromium desktop 和 mobile 项目均运行；涉及深链的用例必须使用真实路由和独立浏览器上下文。
5. 每个实现 PR 都要更新本矩阵状态，并保持 `npm run verify` 全绿。
6. API 普通覆盖率最低为 statements/lines 68%、branches/functions 80%；牌局引擎、状态机和调度器应用更高的逐模块阈值。Web 只统计可独立测试的视图逻辑，最低 statements/lines 90%、branches 65%、functions 100%；完整 React 交互由 E2E 门禁承担。
7. `persistence.ts` 必须在真 PostgreSQL 测试中达到 statements/lines 80%、branches 70%、functions 80%，不得用 Windows 跳过结果计算门禁。

当前没有待办或被准入命令跳过的需求用例。Windows 根命令会自动在 WSL 临时 Linux 工作区运行真容器；WSL、Docker、镜像或端口条件缺失时命令失败。直接运行 API 工作区的通用 Vitest 命令仍可按环境跳过 PostgreSQL 文件，但它不属于最终验收命令。

## 5. 安全与并发固定场景

- 未认证 Socket 连接被拒绝；成员不能读取其他房间或未参与手牌的完整审计材料。
- 非房主不能补分、暂停、移除成员、轮换邀请码或解散房间。
- 旧状态版本、未知动作、重复 `actionId` 和双击并发动作不会写入重复事件、重复扣积分或重复结算。
- 邀请码错误请求受限速；邀请码关闭、重开或轮换后，旧值不能重新激活；数据库主快照和房间行不保存凭证明文。
- 正在进行的手牌和未结算的完整牌堆永不广播给无权接收者。
- 公开事件不含 `serverSeed`、完整牌堆、底牌或玩家随机贡献；这些字段只存在于参与者授权的 10 天审计材料中。
- 所有权威命令和定时器共用全局串行队列；PostgreSQL 使用数据库序列生成单调持久化 revision，状态与计时同包校验，并以增量事件和稀疏检查点恢复损坏快照；恢复日志规模受周期检查点约束。
- 生产启动必须同时配置 PostgreSQL 与邀请凭证加密密钥；仅显式开发/测试环境允许内存存储。

## 6. 最新执行证据与外部条件

- 提交基线：`e07c7e2` 后的测试门禁增强工作区。
- Web 单元：7 项；API 非数据库测试：64 项；PostgreSQL 16：17 项；桌面/移动 Chromium：14 次执行；生产 PostgreSQL 重启 E2E：1 项。
- 覆盖率门禁：Web 风险模块 statements/lines 91.66%、branches 71.42%、functions 100%；API statements/lines 69.34%、branches 83.29%、functions 82.23%；`persistence.ts` 真数据库 statements/lines 93.28%、branches 80.06%、functions 95.65%。
- 本机条件：WSL2 Debian、`/var/run/docker.sock`、Node.js 22+、npm、Chromium；首次运行需安装 Playwright Chromium。
- 生产测试条件：临时 PostgreSQL 16、`NODE_ENV=production`、`DATABASE_URL`、稳定的 `INVITE_CREDENTIAL_KEY`，以及空闲的 API/Web/控制端口。
- GitHub Actions 工作流已存在；仓库当前未配置 Git remote，因此线上 CI 与 GitHub Issues 状态仍需在添加 remote 并推送后确认。
