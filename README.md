# @qzsy/dsh-usage-board

DSH Web 左栏底部的用量看板：**一张卡片 + 一个详情弹窗**，可以在两个供应商之间切换。

| 供应商 | 计费口径 | 数据来源 | 能力 |
|---|---|---|---|
| `newapi`（公司网关 `ai-api.qzsyzn.com`） | quota 整数 → `quota / quotaPerUnit × price`（¥） | 系统访问令牌：`/api/user/self`、`/api/data/self`、`/api/log/self` | 24 小时柱、7 天柱、7×24 热力、模型分布、最近请求、吞吐/首字 |
| `wandapi`（`api.wandapi.com`） | Credits 浮点原值，按 **¥** 展示（不换算） | 密钥：`/v1/usage`（today / last7d / last30d） | 周期对比（今日 / 7 天 / 30 天）、模型分布 |

两家「有什么」不一样，所以**能力由适配器声明、界面按能力渲染**：没有的东西不编、不兜底、不拿别的口径凑。

## 界面

**卡片**（侧栏「工作区」列表下方，宽 248–404px、高 66px）：

```
┌──────────────────────────────────────────┐
│ 今日用量  ¥1.45   近30天 ¥4.50   wandapi │
│ 近7天 ¥2.50    余额 ¥501.6   成功率 100%  │
└──────────────────────────────────────────┘
```

- 金额统一用 `¥`：`newapi` 由 quota 换算，`wandapi` 直接展示 Credits 原值（不换算汇率）；
- `newapi` 金额后跟 24 小时迷你折线；`wandapi` 没有小时粒度，那里改显示「近 30 天」总额；
- 统计行三项都是短文案（`近24h`/`近7天`、`余额`、`成功率`），300px 宽也不换行；
- 供应商名固定在右上角，切到哪家一眼可见；
- 失败时卡片只剩「供应商名 + 失效 + 原因 + 点击查看原因」两行，细节进弹窗；
- 底部细条是余额占总额比例（绿→黄→红）；
- 侧栏折叠成 56px 导轨时退化为图标按钮。

**弹窗**（760×560）：头部是「标题 + 供应商分段切换 + 更新时间/实时徽标 + 刷新/关闭」，
正文按 `caps` 装配：

- `newapi`：今日消费 + 7 天迷你柱 → 健康条（出错率 / p50 / 首字 / 吞吐 / 请求数）→ 24h 柱 + 最近请求 ｜ 模型分布 + 热力；
- `wandapi`：今日消费 → 健康条（成功率 / 请求数 / 今日 token）→ 周期对比 ｜ 模型分布。

## 切换供应商

弹窗头部的分段控件就是切换入口，两个供应商一眼可见、点一下即切：

1. 客户端 `POST /usage-board/api/source { provider }`；
2. 宿主把选择写进 `<dataDir>/source.json`（只存 id，0600），清缓存、按新供应商立刻刷新；
3. 宿主把同一份快照回给请求、并通过 SSE 推给所有标签页；
4. 密钥仍由 DSH 凭据服务按 `keyRef` 解析，**换 key 不需要改插件**。

切换是全局的（`source.json` 只有一份），多个标签页会同步到同一个供应商。

## 失效界面

失败**不留旧数据**：宿主推一份失败载荷，卡片与弹窗直接进失效视图，避免「数字是旧的但看起来是新的」。

卡片：两行——「供应商名 / 失效」+「原因 + 点击查看原因」，点击进弹窗。

弹窗：

```
用量不可用
密钥或令牌无效
<宿主返回的原始错误>
修好下面这一项即可恢复；也可以先切到另一个供应商。

供应商
[公司网关] [WandAPI]          ← 分段切换，坏的那家不必先修好才能切走
公司网关   密钥: 已配置   令牌: 缺失   ai-api.qzsyzn.com
WandAPI    密钥: 已配置   令牌: 不需要  api.wandapi.com

系统访问令牌
[________________________]  [保存并重试]   ← 仅 newapi 且令牌缺失时出现
令牌只写入本机 DSH 凭据服务，浏览器不回传明文

[重试]
```

错误码与处置：

| code | 含义 | 界面 |
|---|---|---|
| `missing_credentials` | 缺密钥/令牌 | 进失效视图，`newapi` 给令牌输入框 |
| `invalid_credentials` | 401，密钥或令牌无效 | 失效视图 + 切换入口 |
| `forbidden` | 403，密钥被禁用/无权限 | 同上 |
| `payment_required` | 402，余额不足（wandapi 常见） | 同上，提示去充值 |
| `rate_limited` | 429 | 失效视图，提示稍后重试 |
| `network` / `invalid_response` / `not_found` | 网络、格式、路径 | 失效视图，提示重试 |
| `token_mismatch` | 页面令牌与宿主进程不一致（dsh-web 刚重启过） | 失效视图，**刷新页面**为主操作 |

## 架构

```
index.js                宿主：配置归一化、选择解析、刷新缓存、SSE 扇出、路由、失败载荷
lib/providers/index.js  注册表：kind → 适配器
lib/providers/newapi.js New API 适配器（系统访问令牌 + 聚合口径）
lib/providers/wandapi.js WandAPI 适配器（/v1/usage）
lib/http.js             只读 GET + 两家错误信封归一成同一组 code
lib/time.js             按 IANA 时区切日/切小时（偏移按小时缓存）
lib/source.js           source.json 持久化 + 选中解析 + 供应商视图
lib/stream.js           SSE 帧格式化与多客户端扇出（心跳、背压、断连清理）
client.js               浏览器模块：卡片、弹窗、切换器、失效视图（手写 createElement）
```

新增一个供应商 = 在 `lib/providers/` 实现 `createProvider({ provider, secrets, userId, timeZone })`
（返回 `{ kind, unit, caps, probe, fetchSnapshot }`）并在注册表登记一行；宿主和客户端都不按
`kind` 分支。

### 快照契约

```jsonc
{
  "ok": true,
  "provider": { "id": "wandapi", "kind": "wandapi", "name": "WandAPI", "baseUrl": "https://api.wandapi.com" },
  "unit": "CNY",                       // CNY | USD，客户端据此选 ¥ / $
  "caps": ["periods", "models"],       // 有哪几项，界面只渲染这几项
  "timeZone": "Asia/Shanghai",
  "generatedAt": 1795070002881,
  "account":  { "remaining": 501.55, "used": 1.45, "total": 503, "requestCount": null },
  "today":    { "date": "2026-11-19", "cost": 1.45, "requests": 307, "errors": 0,
                "errorRate": 0, "tokens": 18702294, "tokensIn": 18531045, "tokensOut": 171249 },

  // 以下键**只在对应 caps 存在时出现**
  "window":  { "from": 0, "to": 0, "cost": 0, "requests": 0, "errors": 0, "errorRate": 0,
               "tokens": 0, "tps": 0, "tpsP50": 0, "ttftMs": 0 },   // throughput
  "hours":   [{ "at": 0, "label": "13", "day": "2026-11-19", "cost": 0, "requests": 0, "tokens": 0 }], // hourly
  "days":    [{ "date": "2026-11-19", "label": "11-19", "cost": 0, "requests": 0, "tokens": 0 }],     // daily
  "heat":    [{ "date": "…", "label": "…", "cells": [{ "hour": 0, "cost": 0, "requests": 0 }] }],     // heatmap
  "models":  [{ "model": "deepseek-flash", "requests": 890, "cost": 4.49, "tokens": 30000000 }],      // models
  "recent":  [{ "timeLabel": "13:50:00", "model": "…", "ok": true, "tps": 142, "ttftMs": 500,
                "totalMs": 4000, "cost": 0.1, "tokens": 1800 }],                                      // recent
  "periods": [{ "key": "today", "label": "今日", "from": "…", "to": "…", "cost": 1.45,
                "requests": 307, "errorRate": 0, "tokens": 18702294 }],                              // periods
  "notes": ["账户级口径（该账号所有密钥合并），金额为 Credits 原值，按 ¥ 显示"]
}
```

失败载荷（无旧数据）：

```jsonc
{ "ok": false, "provider": { "id": "wandapi", "kind": "wandapi", "name": "WandAPI" },
  "code": "payment_required", "error": "余额不足（402），请先充值",
  "needsSetup": true, "generatedAt": 1795070002881 }
```

## 配置

```yaml
- insert:
    - id: usage-board
      name: '@qzsy/dsh-usage-board'
      config:
        refreshMs: 300000
        defaultProvider: qzsy
        providers:
          - id: qzsy
            kind: newapi
            name: 公司网关
            baseUrl: https://ai-api.qzsyzn.com
            keyRef: DEEPSEEK_API_KEY
            accessTokenRef: QZSY_ACCESS_TOKEN
            quotaPerUnit: 500000
            price: 1
          - id: wandapi
            kind: wandapi
            name: wandapi
            baseUrl: https://api.wandapi.com
            keyRef: WANDAPI_API_KEY
```

- `newapi` 必须要**系统访问令牌**（聚合口径的前提）；`userId` 缺省时用 `sk-` 密钥的日志自动识别一次；
- `wandapi` 只要密钥，不需要令牌；金额按 ¥ 展示；
- 配置错误（缺 `providers`、`kind` 未知、`id` 重复、`defaultProvider` 不合法）在插件加载时直接抛错，
  不会带着半份配置去请求供应商；
- 金额换算只发生在 `newapi`：`quota / quotaPerUnit × price`；`wandapi` 的 `cost` 就是接口原值。

## 路由与安全

| 路由 | 方法 | 用途 |
|---|---|---|
| `/usage-board/api/summary` | GET | 快照；`?force=1` 绕过缓存 |
| `/usage-board/api/stream` | GET | SSE，刷新完成推同一份快照 |
| `/usage-board/api/source` | GET | 供应商清单 + 凭据状态（只有状态和令牌尾号） |
| `/usage-board/api/source` | POST | 切换供应商，可写入/清除访问令牌 |
| `/usage-board/api/source/test` | POST | 只探测，不切换、不落盘 |

前缀用页面令牌鉴权（`webserver/index-inject` 注入 `window.__DSH_USAGE_BOARD__`，
请求头带 `x-usage-board`），未带令牌一律 403。

令牌持久化在 `<dataDir>/api-token`（0600）：dsh-web 重启后沿用同一枚，
已经打开的页面能自动重连、不必刷新；随机网站依旧读不到它，CSRF 防护不变。
若整页一直停在「页面令牌已失效」（例如手动删了该文件），刷新一次即可。SSE 走 `fetch` 流而不是 `EventSource`，
就是这个头能带上、令牌不进 URL。配置弹窗从不回传完整密钥，只回状态和尾号。

## 边界

1. `wandapi` 的数据面只有 `/v1/usage`：没有小时粒度、没有逐请求明细，控制台接口
   `/api/iam/usage/*` 只认登录会话，插件不碰。所以那两块界面在 wandapi 下**不存在**。
2. `wandapi` 是**账户级**口径：多个 key 合并统计，换 key 数字不变；单 key 限额看不到。
3. `/v1/usage` 计入 RPM，`refreshMs` 最小 60s；没人看面板时不刷新（订阅驱动）。
4. `newapi` 的 `data/self` 提供小时 × 模型聚合；今日/近 24h 与网关后台同源，不做截断估算。
5. 供应商限流/余额不足期间失败载荷会持续覆盖缓存，恢复后下一次刷新自动回到正常视图。
6. 失败载荷只缓存 60s（`FAILURE_TTL_MS`），成功快照仍按 `refreshMs`：代理换节点、TUN 重建
   这类几十秒的自愈不该让面板停在「失效」五分钟。
7. `getJson` 对连接层失败（`fetch failed` / `ECONNRESET` / 套接字被对面掐掉）自动重发两次
   （300ms、900ms）；超时和调用方取消不重试。`undici` 的 cause code 会拼进错误文案，便于复制排查。

## 测试

```bash
npm test
```

覆盖：时区切日/切小时、HTTP 错误归一、两个适配器的金额与能力、配置校验、`source.json`
持久化与选择解析、路由鉴权/切换/失败载荷、apply 接线（真 http）、客户端注册/卡片/弹窗/
切换器/失效视图与 SSE 解析。
