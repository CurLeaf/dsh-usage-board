# @qzsy/dsh-usage-board

公司 New API 网关（`ai-api.qzsyzn.com`）的用量看板：**左侧栏底部常驻一张 300×104 的紧凑卡片**，
展示今日用量（¥ + token 双口径）、出错率、短时吞吐；点卡片弹出 760×560 的详情弹窗，
内含 24 小时柱状、7 天趋势、7×24 活跃热力、模型分布与最近请求。

## 界面

**卡片**（侧栏「工作区」列表下方、账号行上方，跟随侧栏宽度 248–404px，固定 84px 高）：

```
┌──────────────────────────────────────────┐
│ 今日用量                       ● 0.00%   │
│ ¥111.3                      累计 ¥1.99万 │
│ 185 t/s   1.02s 首字        余额 ¥3.11万  │
└──────────────────────────────────────────┘
```

悬停卡片会显示明细 tooltip（今日 ¥ / 输入 / 输出 / 总用量）。

- 侧栏折叠成 56px 导轨时（`wide === false`，或窗口 <1024px），退化为 36px 图标按钮，避免被裁切。
- 点击卡片任意位置打开详情；Esc、点遮罩、点关闭按钮都能关。

**弹窗**：头部（标题/站点·更新时间/刷新/关闭）→ 4 格 KPI 带 → 双列（左：24h 柱状、7 天、热力；右：模型分布、最近请求）→ 口径注脚。模型分布只显示请求数与金额（窗口与近 7 天一致），最近请求按两行排布避免窄列溢出。
滚动只在弹窗正文内发生；再点遮罩或按 Esc 关闭。移动端自动变成全屏。

## 视觉

「安静的仪表面」而不是重玻璃：

- 不透明 token 底（卡片 `bg-layer-2`、弹窗 `bg-layer-1`）+ 1px `border-l1/l2/l3`，**没有 `backdrop-filter`、没有光斑、没有渐变文字**
- 单一强调色 `--dsw-alias-brand-primary`；成功/错误只用 `state-success-primary` / `state-error-primary`
- 数字全部 `font-variant-numeric: tabular-nums`
- 所有颜色来自 `--dsw-*` token 或 `color-mix()`，与 dream-skin 等主题共存
- 动效 ≤200ms，`prefers-reduced-motion` 下全关

## 数据从哪来

只用 `sk-` 密钥就能读的三个只读路由（实测 New API `202610151846`）：

| 路由 | 用途 | 备注 |
|---|---|---|
| `GET /api/usage/token/` | 本密钥累计额度 | 与 `/v1/dashboard/billing/usage` 一致 |
| `GET /api/log/token` | 最近 **1000** 条请求明细 | `quota`、`prompt/completion_tokens`、`use_time`、`is_stream`、`type`、`other.frt` |
| `GET /api/status` | 站点配置（`quota_per_unit`、`price`） | 仅人工核对 |
| `GET /api/user/self` | **系统访问令牌**：余额、累计已用、累计请求数 | 精确口径 |
| `GET /api/data/self?start_timestamp&end_timestamp` | **系统访问令牌**：按小时×模型聚合的额度/请求数/token | 就是后台「用量概览」的数据源 |
| `GET /api/log/self` | **系统访问令牌**：分页日志，支持 `type` 与时间范围 | 最近请求 + 错误数 |

> 一旦配置了 `accessTokenRef`，插件就**优先走后台聚合口径**：今日、近 24 小时与网关后台完全同源，
> 不再受 1000 条日志截断影响。没有令牌时自动退回日志窗口法（只能给「近 N 小时」下限）。

口径：

- **金额** = `quota / quotaPerUnit × price`（默认 `500000` / `7.3`）
- **吞吐 t/s** = `completion_tokens / (use_time − other.frt/1000)`，仅 `is_stream` 且 `use_time > 0`
- **token 合计** = `prompt_tokens + other.cache_tokens + other.cache_creation_tokens + completion_tokens`。
  本网关的 `prompt_tokens` **不含缓存命中**，只算 prompt+completion 会把输入量低估一个数量级（实测某天：7.2M vs 281M）
- **出错率** = `type === 5` 的行数 / 窗口行数
- **今日用量**：日志覆盖当天时按日志求和，否则用「当日总额基线差值」兜底，仍不精确标 `下限`

## 金额换算对不上怎么办

面板金额 = `quota / quotaPerUnit × price`，两个值都来自 `cordis.patch.yml`。

**实测结论（2026-11-17）**：网关后台「近 24 小时消耗 ¥431.4」实际等于 `quota / 500000`，
并没有乘 7.3 —— 也就是说它显示的是额度单位、只是带了 ¥ 符号。所以默认取 `price: 1`，这样与后台同刻度。

- 想让数字和后台完全一致：`quotaPerUnit: 500000` + `price: 1`（默认）
- 想换算成真正的人民币：`price: 7.3`（后台那个 `price` 字段）
- 只看额度原值：`quotaPerUnit: 1` + `price: 1`

## 已知边界

1. `/api/log/token` **固定只返最新 1000 条**，`p` / `page_size` / `type` / `start_timestamp` 全部被忽略。
2. `use_time` 是**整秒**，t/s 粒度约 ±10%。
3. `/v1/dashboard/billing/usage` **忽略日期参数**，不能用来算今日。
4. 网关对读接口**有限流**（429、空 body）：宿主默认 5 分钟缓存、失败后 2 分钟冷却，面板轮询只读宿主缓存。
5. `/api/log/self`、`/api/user/self` 需要系统访问令牌，本插件不碰。
6. `sidebar.footer.action` 这一行也被内置 `ui-cordis` 占用（无动态插件时它不渲染）；装 Cordis 动态插件后两者可能互相挤压，必要时调整 `order`。

## 配置

```yaml
- insert:
    - id: usage-board
      name: "@qzsy/dsh-usage-board"
      config:
        baseUrl: https://ai-api.qzsyzn.com
        apiKeyRef: DEEPSEEK_API_KEY
        quotaPerUnit: 500000
        price: 7.3
        refreshMs: 300000
```

- `accessTokenRef`：系统访问令牌的凭据名（默认 `QZSY_ACCESS_TOKEN`），在网关「个人设置 → 访问令牌」生成；
  需要配合 `New-Api-User` 头，插件会用密钥接口自动识别 `user_id`，也可显式配置 `userId`
- `apiKey`：明文密钥（优先于 `apiKeyRef`，只建议本地调试）
- `dataDir`：小时桶历史，默认 `$DSH_HOME/usage-board`

## 安全边界

密钥只在宿主进程：面板读 `/usage-board/api/summary`，该前缀用一次一密的进程令牌鉴权
（`webserver/index-inject` 注入 `window.__DSH_USAGE_BOARD__`，客户端带 `x-usage-board` 头），未带令牌一律 403。

## 结构

```
index.js          宿主：凭据解析、缓存/冷却、路由、index 注入
lib/gateway.js    三个只读路由的取数
lib/aggregate.js  纯函数：行归一化、窗口统计、小时/日/热力桶、金额换算
lib/history.js    逐小时历史落盘（7 天热力 + 今日基线）
client.js         浏览器模块：左栏卡片 + 详情弹窗（手写 React.createElement）
test/*.test.mjs   纯函数 + 宿主工具 + 客户端注册/渲染冒烟
```

## 测试

```bash
node --test test/*.test.mjs
```

覆盖：吞吐算式、错误率窗口、今日基线兜底、7 天热力桶、历史落盘与损坏容错、配置归一化、
凭据文件解析、进程令牌比较、左栏席位注册、卡片宽/窄态、弹窗语义与正文渲染。
