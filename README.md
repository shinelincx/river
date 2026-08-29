# River Table

受邀制、纯娱乐虚拟积分的私人德州扑克 H5。牌局由服务端权威执行，浏览器只提交意图并接收玩家视角的脱敏状态。

## 本地启动

```bash
npm install
npm run dev
```

打开 `http://localhost:5173`。首次输入昵称创建设备游客身份；另开浏览器窗口并使用邀请码即可测试受邀入房和实时入桌。

`docker compose up -d` 会启动 PostgreSQL 与 Redis；当前开发服务使用内存仓储以便零配置运行，`infra/postgres/init.sql` 是生产持久化仓储的权威表结构。

## 安全边界

- 不存在支付、充值、提现或真实货币兑换。
- 访客会话使用 HTTP-only Cookie；清理浏览器数据后无法找回身份。
- 牌堆、其他玩家手牌和规则校验只存在于服务端。每手会生成洗牌承诺哈希并记录事件序号。
