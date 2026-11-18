// 注册 id 必须等于包名（DSH 客户端模块表按包名索引；写裸名会
// "loaded without registering" → 整个客户端半边不激活，面板消失）。
window.__ModuleLoader__.load({
  id: '@qzsy/dsh-usage-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** react-dom 在模块表里；取不到时退化为就地渲染（会被侧栏裁切，仅兜底）。 */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    const NS = 'usageBoard'
    const CARD_ID = 'usage-board-card'
    const API = '/usage-board/api/summary'
    const STREAM = '/usage-board/api/stream'
    const SOURCE = '/usage-board/api/source'
    const SOURCE_TEST = '/usage-board/api/source/test'
    const TOKEN_GLOBAL = '__DSH_USAGE_BOARD__'
    const TOKEN_HEADER = 'x-usage-board'

    /**
     * 失败载荷里这些 code 意味着「先修配置」而不是「稍后再试」。和宿主
     * buildFailurePayload 的 SETUP_CODES 对齐；needsSetup 缺失时用它兜底。
     */
    const SETUP_CODES = ['missing_credentials', 'invalid_credentials', 'forbidden', 'unsupported_provider']

    /** code → 文案 key。新增错误码时两边字典一起补。 */
    const CODE_KEYS = {
      missing_credentials: 'codeMissingCredentials',
      invalid_credentials: 'codeInvalidCredentials',
      forbidden: 'codeForbidden',
      rate_limited: 'codeRateLimited',
      network: 'codeNetwork',
      unsupported_provider: 'codeUnsupportedProvider',
    }

    /* ------------------------------------------------------------------ 文案 */

    const ZH = {
      open: '打开用量看板',
      today: '今日用量',
      total: '总用量',
      errorRate: '出错率',
      successRate: '正确率',
      throughput: '吞吐',
      ttft: '首字',
      since: '额度累计',
      cumulative: '累计',
      balance: '余额',
      hour24: '近 24 小时',
      hour24Short: '近24h',
      week: '近 7 天',
      heat: '活跃热力',
      models: '模型分布',
      recent: '最近请求',
      refresh: '刷新',
      close: '关闭',
      loading: '读取中',
      errorTitle: '取数失败',
      retry: '重试',
      partial: '下限',
      empty: '暂无请求',
      requests: '次',
      requestsTotal: '请求',
      quotaLeft: '额度剩余',
      title: '用量看板',
      hint: '点卡片查看详情',
      footnote: '网关只提供最近 1000 条明细；非流式请求不计入吞吐',
      updated: '更新于',
      live: '实时',
      liveHint: 'SSE 推送：网关刷新完成后立即更新',
      polling: '轮询',
      pollHint: 'SSE 不可用，已退回 60 秒轮询',
      setup: '设置',
      setupOpenHint: '点开配置',
      setupTitle: '网关与供应商',
      setupSub: '供应商来自 DSH「设置 → 模型」，这里只做选择',
      setupSourceLoading: '读取供应商…',
      setupSourceFailed: '读取供应商失败',
      setupNoCandidates: '没有找到指向该网关的模型供应商',
      setupNoCandidatesHint: '请到 设置 → 模型 配置',
      setupGateway: '网关',
      setupProvider: '模型供应商',
      setupUsageBaseUrl: '用量地址',
      setupKeyStatus: 'API 密钥',
      setupKeyConfigured: '已配置',
      setupKeyMissing: '缺失',
      setupKeyMissingHint: '该供应商的 API 密钥未配置，请到 设置 → 模型 补充',
      setupToken: '访问令牌',
      setupTokenOptional: '可选',
      setupTokenPlaceholder: '填了才走精确口径，不填用日志口径',
      setupTokenSaved: '已保存，尾号',
      setupTokenClear: '清除已保存令牌',
      setupTest: '测试连接',
      setupTesting: '测试中…',
      setupTestOkAggregate: '连接正常，将使用聚合口径',
      setupTestOkLogs: '连接正常，将使用日志口径',
      setupTestFailed: '连接失败',
      setupSave: '保存并刷新',
      setupSaving: '保存中…',
      setupSavedRefreshFailed: '已保存，但刷新失败',
      setupCancel: '取消',
      setupFoot: '令牌只存在本机，不写入浏览器存储',
      tokenMissing: '插件未注入访问令牌（请重启 dsh web）',
      errorUnknown: '读取失败',
      codeMissingCredentials: '未配置凭据',
      codeInvalidCredentials: '凭证已失效',
      codeForbidden: '令牌权限不足',
      codeRateLimited: '网关限流',
      codeNetwork: '网络异常',
      codeUnsupportedProvider: '未找到可用供应商',
    }

    const EN = {
      open: 'Open usage board',
      today: 'Today',
      total: 'Total',
      errorRate: 'Errors',
      successRate: 'Success rate',
      throughput: 'Throughput',
      ttft: 'TTFT',
      since: 'Lifetime quota',
      cumulative: 'Total',
      balance: 'Balance',
      hour24: 'Last 24 hours',
      hour24Short: '24h',
      week: 'Last 7 days',
      heat: 'Activity',
      models: 'Models',
      recent: 'Recent requests',
      refresh: 'Refresh',
      close: 'Close',
      loading: 'Loading',
      errorTitle: 'Failed to load',
      retry: 'Retry',
      partial: 'lower bound',
      empty: 'No requests',
      requests: 'req',
      requestsTotal: 'Requests',
      quotaLeft: 'Quota left',
      title: 'Usage Board',
      hint: 'Click for details',
      footnote: 'The gateway exposes only the latest 1000 rows; non-stream requests are excluded from throughput',
      updated: 'Updated',
      live: 'Live',
      liveHint: 'Pushed over SSE the moment the gateway refresh completes',
      polling: 'Polling',
      pollHint: 'SSE unavailable, fell back to 60s polling',
      setup: 'Settings',
      setupOpenHint: 'Click to configure',
      setupTitle: 'Gateway & provider',
      setupSub: 'Providers come from DSH Models settings; pick one here',
      setupSourceLoading: 'Loading providers…',
      setupSourceFailed: 'Failed to load providers',
      setupNoCandidates: 'No model provider points to this gateway',
      setupNoCandidatesHint: 'Configure one in Settings → Models',
      setupGateway: 'Gateway',
      setupProvider: 'Model provider',
      setupUsageBaseUrl: 'Usage URL',
      setupKeyStatus: 'API key',
      setupKeyConfigured: 'Configured',
      setupKeyMissing: 'Missing',
      setupKeyMissingHint: 'This provider has no API key. Add one in Settings → Models.',
      setupToken: 'Access token',
      setupTokenOptional: 'optional',
      setupTokenPlaceholder: 'Add one for exact metrics; leave blank to use logs',
      setupTokenSaved: 'Saved, ending',
      setupTokenClear: 'Clear saved token',
      setupTest: 'Test connection',
      setupTesting: 'Testing…',
      setupTestOkAggregate: 'Connection OK, aggregate metrics will be used',
      setupTestOkLogs: 'Connection OK, log-based metrics will be used',
      setupTestFailed: 'Connection failed',
      setupSave: 'Save & refresh',
      setupSaving: 'Saving…',
      setupSavedRefreshFailed: 'Saved, but refresh failed',
      setupCancel: 'Cancel',
      setupFoot: 'Tokens stay on this machine; nothing is stored in the browser',
      tokenMissing: 'The plugin token is missing (restart dsh web)',
      errorUnknown: 'Could not load',
      codeMissingCredentials: 'Credentials missing',
      codeInvalidCredentials: 'Credentials expired',
      codeForbidden: 'Token lacks permission',
      codeRateLimited: 'Gateway rate limited',
      codeNetwork: 'Network error',
      codeUnsupportedProvider: 'No usable provider',
    }

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.ub-card{
  box-sizing:border-box;width:100%;max-width:100%;height:66px;overflow:hidden;
  position:relative;display:flex;flex-direction:column;justify-content:center;gap:4px;
  padding:8px 12px 10px;margin:0 0 8px;
  border-radius:10px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);
  box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);
  color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family,inherited);
  text-align:left;cursor:pointer;
  transition:border-color .16s ease-out,background .16s ease-out;
}
.ub-card:hover{border-color:var(--dsw-alias-border-l2)}
.ub-card-battery{position:absolute;left:0;top:0;bottom:0;z-index:0;border-radius:inherit;
  --ub-battery:var(--dsw-alias-label-primary);
  background:color-mix(in srgb,var(--ub-battery) 5%,transparent);
  transition:width .3s ease-out,background .2s ease-out}
.ub-card-battery[data-level="mid"]{--ub-battery:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-success-primary));
  background:color-mix(in srgb,var(--ub-battery) 6%,transparent)}
.ub-card-battery[data-level="low"]{--ub-battery:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--ub-battery) 7%,transparent)}
.ub-card-battery[data-level="unknown"]{background:transparent}
.ub-card-gauge{position:absolute;left:0;right:0;bottom:0;height:4px;z-index:1;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent)}
.ub-card-gauge-fill{display:block;height:100%;border-radius:0 2px 2px 0;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 46%,transparent);
  transition:width .3s ease-out,background .2s ease-out}
.ub-card-gauge[data-level="mid"] .ub-card-gauge-fill{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-success-primary)) 50%,transparent)}
.ub-card-gauge[data-level="low"] .ub-card-gauge-fill{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 52%,transparent)}
.ub-card-gauge-ticks{position:absolute;inset:0;pointer-events:none;
  background-image:repeating-linear-gradient(90deg,
    var(--dsw-alias-bg-layer-2) 0 1px, transparent 1px 25%)}
.ub-card:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:2px}
.ub-card-main{position:relative;z-index:1;display:flex;align-items:center;gap:8px;min-width:0}
.ub-card-label{flex:0 0 auto;font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary);
  letter-spacing:.02em}
.ub-card-value{flex:0 0 auto;font-size:20px;line-height:24px;font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ub-card-area{display:block;flex:1 1 auto;min-width:24px;height:20px;margin:0 0 0 2px}
.ub-card-area-fill{fill:url(#ub-card-area-grad)}
.ub-card-area-line{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,var(--dsw-alias-label-tertiary));
  stroke-width:1.1;stroke-linejoin:round;stroke-linecap:round}
.ub-card-stats{position:relative;z-index:1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;min-width:0}
.ub-card-stat{display:inline-flex;align-items:baseline;gap:5px;min-width:0;white-space:nowrap}
.ub-card-stat-label{font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary)}
.ub-card-stat-value{font-size:12px;line-height:15px;font-weight:500;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.ub-card-error{display:flex;flex-direction:column;gap:2px;min-width:0}
.ub-card-error-msg{font-size:10px;line-height:13px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ub-card-retry{font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary)}
.ub-skel{height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 22%,transparent)}
.ub-skel.is-wide{width:70%}
.ub-rail{box-sizing:border-box;width:36px;height:36px;margin:0 0 8px;padding:0;
  display:grid;place-items:center;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:border-color .16s ease-out,color .16s ease-out}
.ub-rail:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.ubd-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.ubd-mask{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-mask-2) 58%,transparent);
  backdrop-filter:blur(2px);animation:ubd-fade .16s ease-out}
.ubd-dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;
  width:min(760px,100%);max-height:min(660px,calc(100dvh - 48px));overflow:hidden;
  border-radius:18px;border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent);
  backdrop-filter:blur(24px) saturate(1.05);
  box-shadow:0 32px 80px -48px color-mix(in srgb,var(--dsw-alias-bg-mask-1) 95%,transparent);
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherited);
  animation:ubd-in .18s cubic-bezier(.2,.8,.2,1)}
.ubd-dialog:focus{outline:none}
.ubd-head{display:flex;flex:0 0 auto;align-items:center;gap:10px;padding:14px 14px 12px 22px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-title{margin:0;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.01em}
.ubd-sub{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-live{display:inline-flex;align-items:center;gap:5px;margin-left:8px;font-size:9.5px;
  color:var(--dsw-alias-state-success-primary)}
.ubd-live::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}
.ubd-live[data-live="poll"]{color:var(--dsw-alias-label-tertiary)}
.ubd-head-actions{margin-left:0;order:3;display:flex;align-items:center;gap:2px}
.ubd-btn{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:background .12s ease-out,color .12s ease-out}
.ubd-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ubd-btn[data-spin="true"] svg{animation:ub-spin .2s linear}
.ubd-hero{display:grid;flex:0 0 auto;grid-template-columns:minmax(0,auto) minmax(0,1fr) auto;
  align-items:end;gap:24px;padding:16px 22px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-hero-main{min-width:0}
.ubd-hero-label{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);letter-spacing:.03em}
.ubd-hero-value{margin-top:2px;font-size:32px;line-height:38px;font-weight:600;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-hero-sub{margin-top:2px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-spark{min-width:0;padding-bottom:2px}
.ubd-spark-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  font-size:9.5px;line-height:13px;color:var(--dsw-alias-label-tertiary)}
.ubd-spark-title{letter-spacing:.03em}
.ubd-spark-total{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.ubd-spark-bars{display:flex;align-items:flex-end;gap:6px;height:30px;margin-top:6px}
.ubd-spark-col{flex:1;height:100%;display:flex;align-items:flex-end;min-width:0}
.ubd-spark-bar{width:100%;min-height:2px;border-radius:2px 2px 0 0;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 26%,transparent)}
.ubd-spark-col:last-child .ubd-spark-bar{background:var(--dsw-alias-brand-primary)}
.ubd-spark-axis{display:flex;gap:6px;margin-top:4px;font-size:8.5px;line-height:12px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ubd-spark-axis span{flex:1;text-align:center;white-space:nowrap}
.ubd-hero-side{display:flex;align-items:center;gap:10px;padding-bottom:1px}
.ubd-ring{flex:0 0 auto;display:block}
.ubd-ring-track{stroke:color-mix(in srgb,var(--dsw-alias-label-tertiary) 16%,transparent)}
.ubd-ring-fill{stroke:var(--dsw-alias-brand-primary)}
.ubd-ring-text{fill:var(--dsw-alias-label-secondary);font-size:8.5px;font-variant-numeric:tabular-nums}
.ubd-hero-side-text{display:flex;flex-direction:column;gap:0}
.ubd-hero-side-label{font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary);letter-spacing:.03em}
.ubd-hero-side-value{font-size:13px;line-height:18px;font-weight:600;letter-spacing:-.01em;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-hero-side-sub{font-size:9px;line-height:13px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-health{display:flex;flex:0 0 auto;align-items:baseline;flex-wrap:wrap;
  gap:0 18px;padding:9px 22px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-health-item{display:flex;align-items:baseline;gap:6px;min-width:0}
.ubd-health-item+.ubd-health-item{border-left:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);
  padding-left:18px}
.ubd-health-label{font-size:9px;line-height:13px;color:var(--dsw-alias-label-tertiary);letter-spacing:.03em}
.ubd-health-value{font-size:11px;line-height:13px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-health-value[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}
.ubd-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding:16px 22px 18px;display:grid;grid-template-columns:minmax(0,1fr) 236px;gap:22px}
.ubd-body::-webkit-scrollbar{width:8px}
.ubd-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 24%,transparent);
  border-radius:4px}
.ubd-col{display:flex;flex-direction:column;gap:16px;min-width:0}
.ubd-panel{min-width:0}
.ubd-panel-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.ubd-panel-title{font-size:10px;line-height:14px;font-weight:600;color:var(--dsw-alias-label-secondary);
  letter-spacing:.05em}
.ubd-panel-meta{margin-left:auto;font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-bars{display:flex;align-items:flex-end;gap:3px;height:84px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-bar{position:relative;flex:1;min-width:0;height:100%;display:flex;align-items:flex-end}
.ubd-bar-fill{width:100%;min-height:0;border-radius:2px 2px 0 0;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 24%,transparent);
  transition:height .18s cubic-bezier(.2,.7,0,1),background .12s ease-out}
.ubd-bar[data-now="true"] .ubd-bar-fill{background:var(--dsw-alias-brand-primary)}
.ubd-bar:hover .ubd-bar-fill{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 76%,transparent)}
.ubd-bar-tip{position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);
  padding:3px 6px;border-radius:6px;font-size:10px;line-height:14px;white-space:nowrap;
  pointer-events:none;opacity:0;z-index:2;
  color:var(--dsw-alias-tooltip-label);background:var(--dsw-alias-tooltip-bg);
  transition:opacity .12s ease-out}
.ubd-bar:hover .ubd-bar-tip{opacity:1}
.ubd-axis{display:flex;justify-content:space-between;margin-top:7px;font-size:9px;line-height:13px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.ubd-heat{display:flex;flex-direction:column;gap:3px}
.ubd-heat-row{display:grid;grid-template-columns:24px repeat(24,minmax(0,1fr));gap:2px;align-items:center}
.ubd-heat-day{font-size:8.5px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ubd-heat-cell{height:8px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 8%,transparent)}
.ubd-heat-cell[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.ubd-heat-cell[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.ubd-heat-cell[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent)}
.ubd-heat-cell[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent)}
.ubd-heat-legend{display:flex;align-items:center;gap:4px;margin-top:7px;font-size:8.5px;line-height:12px;
  color:var(--dsw-alias-label-tertiary)}
.ubd-heat-legend i{display:block;width:9px;height:6px;border-radius:2px;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 8%,transparent)}
.ubd-heat-legend i[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.ubd-heat-legend i[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.ubd-heat-legend i[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent)}
.ubd-heat-legend i[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent)}
.ubd-models{display:flex;flex-direction:column;gap:1px}
.ubd-model{display:grid;grid-template-columns:minmax(0,1fr) auto auto;
  align-items:baseline;gap:8px;padding:6px 8px;margin:0 -8px;border-radius:6px;
  font-size:10.5px;line-height:16px;overflow:hidden;transition:background .12s ease-out}
.ubd-model:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ubd-model-name{color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-model-req{color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap;font-size:9px}
.ubd-model-cny{color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;white-space:nowrap;min-width:46px;text-align:right;font-size:10px}
.ubd-recent{display:flex;flex-direction:column}
.ubd-req{display:grid;grid-template-columns:48px minmax(0,1fr) auto auto;align-items:baseline;
  gap:10px;padding:5px 6px;margin:0 -6px;border-radius:6px;font-size:10.5px;line-height:16px;
  min-width:0;transition:background .12s ease-out}
.ubd-req:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ubd-req[data-error="true"]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary)}
.ubd-req-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  font-size:9px;letter-spacing:.02em}
.ubd-req-model{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-req-meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  white-space:nowrap;font-size:9px}
.ubd-req-cny{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  white-space:nowrap;font-size:9px;min-width:42px;text-align:right}
.ubd-req-fail{color:var(--dsw-alias-state-error-primary)}
.ubd-foot{flex:0 0 auto;padding:10px 22px 12px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-tertiary);letter-spacing:.01em}
.ubd-empty{padding:18px 8px;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ubd-error{display:flex;flex-direction:column;gap:8px;padding:6px 0}
.ubd-error-title{font-size:12px;line-height:16px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.ubd-error-body{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ubd-retry{align-self:flex-start;padding:4px 10px;border-radius:8px;font:inherit;font-size:10.5px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.ubd-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ubd-setup-open{order:2;margin-left:auto}
.ubd-setup{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding:16px 22px 18px;display:flex;flex-direction:column;gap:14px}
.ubd-setup::-webkit-scrollbar{width:8px}
.ubd-setup::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 24%,transparent);
  border-radius:4px}
.ubd-setup-head{display:flex;flex-direction:column;gap:2px}
.ubd-setup-title{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary);
  letter-spacing:.04em}
.ubd-setup-sub{font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.ubd-setup-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.ubd-setup-row{display:grid;grid-template-columns:112px minmax(0,1fr);gap:10px;align-items:baseline;min-width:0}
.ubd-setup-label{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.ubd-setup-value{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;word-break:break-all;min-width:0}
.ubd-setup-code{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px}
.ubd-setup-status{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;line-height:16px;
  color:var(--dsw-alias-label-secondary)}
.ubd-setup-status::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.55}
.ubd-setup-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.ubd-setup-status[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}
.ubd-setup-control{display:flex;flex-direction:column;gap:6px;min-width:0}
.ubd-setup-input,.ubd-setup-select{box-sizing:border-box;width:100%;height:28px;padding:0 9px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:11px;line-height:26px;outline:none;
  transition:border-color .12s ease-out}
.ubd-setup-select{cursor:pointer;padding-right:6px}
.ubd-setup-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ubd-setup-input:focus-visible,.ubd-setup-select:focus-visible{border-color:var(--dsw-alias-border-selected)}
.ubd-setup-input:disabled{opacity:.5;cursor:not-allowed}
.ubd-setup-note{font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.ubd-setup-note code{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:9.5px;color:var(--dsw-alias-label-secondary)}
.ubd-setup-hint{font-size:9.5px;line-height:14px;
  color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.ubd-setup-empty{display:flex;flex-direction:column;align-items:center;gap:3px;padding:20px 10px;
  text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
.ubd-setup-empty-title{font-size:11.5px;line-height:17px;font-weight:600;
  color:var(--dsw-alias-label-secondary)}
.ubd-setup-empty-hint{font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.ubd-setup-check{display:inline-flex;align-items:center;gap:6px;font-size:10px;line-height:16px;
  color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.ubd-setup-check input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
.ubd-setup-result{font-size:10px;line-height:15px;padding:6px 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);word-break:break-word}
.ubd-setup-result[data-tone="ok"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 42%,transparent);
  color:var(--dsw-alias-state-success-primary)}
.ubd-setup-result[data-tone="bad"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);
  color:var(--dsw-alias-state-error-primary)}
.ubd-setup-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ubd-setup-spacer{margin-left:auto}
.ubd-setup-btn{box-sizing:border-box;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:10.5px;line-height:16px;
  cursor:pointer;transition:background .12s ease-out,border-color .12s ease-out,opacity .12s ease-out}
.ubd-setup-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ubd-setup-btn:disabled{opacity:.45;cursor:default}
.ubd-setup-btn[data-primary="true"]{border-color:var(--dsw-alias-border-selected);
  color:var(--dsw-alias-brand-primary)}
.ubd-setup-btn[data-primary="true"]:hover:not(:disabled){
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.ubd-setup-skel{display:flex;flex-direction:column;gap:10px}
.ubd-setup-skel-row{height:28px;border-radius:7px;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent)}
.ubd-setup-skel-row.is-short{width:46%}
@keyframes ubd-fade{from{opacity:0}}
@keyframes ubd-in{from{opacity:0;transform:scale(.988)}}
@keyframes ub-spin{to{transform:rotate(360deg)}}
@media (max-width:720px),(pointer:coarse) and (max-width:1024px){
  .ubd-root{padding:0;align-items:stretch}
  .ubd-dialog{width:100%;height:100dvh;max-height:100dvh;border-radius:0;border:0;
    padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
  .ubd-hero{grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
  .ubd-hero-side{padding-top:2px}
  .ubd-body{grid-template-columns:minmax(0,1fr);padding:14px 16px 18px}
  .ubd-setup{padding:14px 16px 18px}
  .ubd-setup-row{grid-template-columns:minmax(0,1fr);gap:4px}
  .ubd-health{padding:9px 16px}
}
@media (prefers-reduced-motion:reduce){
  .ub-card,.ubd-bar-fill,.ub-card-sparkbar,.ubd-req{transition:none}
  .ubd-mask,.ubd-dialog{animation:none}
  .ubd-btn[data-spin="true"] svg{animation:none}
}
`

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const marker = 'style[data-plugin-css="dsh-usage-board"]'
      if (document.querySelector(marker) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-usage-board'
      tag.dataset.pluginCss = 'dsh-usage-board'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* -------------------------------------------------------------- 格式化 */

    function fmtCny(value) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '—'
      const abs = Math.abs(num)
      if (abs >= 10_000) return `¥${(num / 10_000).toFixed(2)}万`
      if (abs >= 1_000) return `¥${Math.round(num).toLocaleString('zh-CN')}`
      if (abs >= 100) return `¥${num.toFixed(1)}`
      return `¥${num.toFixed(2)}`
    }

    function fmtTokens(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '0'
      if (num >= 1e8) return `${(num / 1e8).toFixed(2)}亿`
      if (num >= 1e4) return `${(num / 1e4).toFixed(1)}万`
      return String(Math.round(num))
    }

    function fmtTps(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '—'
      return num >= 100 ? String(Math.round(num)) : num.toFixed(1)
    }

    function fmtMs(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '—'
      if (num < 1_000) return `${Math.round(num)}ms`
      return `${(num / 1_000).toFixed(num < 10_000 ? 2 : 1)}s`
    }

    function fmtPct(value) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '—'
      return `${(num * 100).toFixed(num > 0.01 ? 1 : 2)}%`
    }

    function fmtClock(ts) {
      if (!Number.isFinite(Number(ts))) return '—'
      const d = new Date(Number(ts))
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    }

    /* ------------------------------------------------------------ 错误码文案 */

    /** 只有配置类失败才值得把用户直接送进配置视图。 */
    function isSetupCode(code) {
      return typeof code === 'string' && SETUP_CODES.includes(code)
    }

    /** 错误码 → 人话；未知 code 返回空串，交给调用方保留原始错误。 */
    function codeText(t, code) {
      const key = CODE_KEYS[code]
      if (key === undefined || typeof t !== 'function') return ''
      const text = t(key)
      return typeof text === 'string' ? text : ''
    }

    /** 组合「人话 · 宿主原始错误」；两侧都空时返回空串。 */
    function errorText(t, code, message) {
      const label = codeText(t, code)
      const raw = typeof message === 'string' ? message.trim() : ''
      if (label === '') return raw
      return raw === '' ? label : `${label} · ${raw}`
    }

    /* ------------------------------------------------------------------ 取数 */

    function readToken() {
      if (typeof window === 'undefined') return ''
      const value = window[TOKEN_GLOBAL]
      return typeof value === 'string' ? value : ''
    }

    /** SSE 重连退避：1s 起步翻倍到 30s 封顶，加一点抖动防止多标签页同时打进来。 */
    const SSE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
    /** SSE 连续失败后启用的兜底轮询间隔，与旧实现保持一致。 */
    const POLL_MS = 60_000

    /**
     * 解析一个 SSE 事件块（空行之前的部分）。
     * 只认规范里的 event / data / id / retry；`:` 开头是注释（心跳），跳过。
     */
    function parseSseBlock(block) {
      let event = 'message'
      let data = null
      let id = null
      let retry = null
      for (const raw of String(block).split('\n')) {
        if (raw === '' || raw.charAt(0) === ':') continue
        const at = raw.indexOf(':')
        const field = at === -1 ? raw : raw.slice(0, at)
        let value = at === -1 ? '' : raw.slice(at + 1)
        if (value.charAt(0) === ' ') value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data = data === null ? value : `${data}\n${value}`
        else if (field === 'id') id = value
        else if (field === 'retry') {
          const parsed = Number(value)
          if (Number.isFinite(parsed) && parsed >= 0) retry = parsed
        }
      }
      if (data === null) return null
      return { event, data, id, retry }
    }

    /** 增量解析：喂 chunk 吐完整事件，兼容 \r\n 和跨包截断。 */
    function createSseParser() {
      let buffer = ''
      return {
        push(chunk) {
          buffer += String(chunk).replace(/\r\n?/g, '\n')
          const events = []
          for (;;) {
            const at = buffer.indexOf('\n\n')
            if (at === -1) break
            const block = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            const event = parseSseBlock(block)
            if (event !== null) events.push(event)
          }
          return events
        },
      }
    }

    function useSummary() {
      const [state, setState] = useState({
        status: 'loading',
        data: null,
        error: null,
        errorCode: null,
        needsSetup: false,
        link: 'connecting',
      })
      const alive = useRef(true)

      const apply = useCallback((payload) => {
        if (!alive.current) return
        if (payload === null || payload.ok !== true) {
          const errorCode = payload !== null && typeof payload === 'object' && typeof payload.code === 'string'
            ? payload.code
            : null
          const needsSetup = payload !== null && typeof payload === 'object' && payload.needsSetup === true
          setState((previous) => ({
            status: previous.data === null ? 'error' : 'ready',
            data: previous.data,
            error: (payload && payload.error) || '网关返回异常',
            errorCode,
            needsSetup,
            link: previous.link,
          }))
          return
        }
        setState((previous) => ({
          status: 'ready',
          data: payload,
          error: payload.staleError || null,
          errorCode: typeof payload.staleError === 'string' && payload.staleError !== '' && typeof payload.staleCode === 'string'
            ? payload.staleCode
            : null,
          needsSetup: typeof payload.staleError === 'string' && payload.staleError !== '' && payload.staleNeedsSetup === true,
          link: previous.link,
        }))
      }, [])

      /** 兜底通道：SSE 连续失败时按 60s 拉一次，数据和推送走同一个接口。 */
      const loadOnce = useCallback(() => {
        const token = readToken()
        if (token === '') return Promise.resolve()
        return fetch(API, { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' })
          .then((response) => response.json())
          .then(apply)
          .catch(() => {})
      }, [apply])

      /** 用户点刷新：force=1 让宿主绕过缓存；结果会同时推给其他标签页。 */
      const refresh = useCallback(() => {
        const token = readToken()
        if (token === '') {
          setState({ status: 'error', data: null, error: '插件未注入访问令牌（请重启 dsh web）', errorCode: null, needsSetup: false, link: 'off' })
          return Promise.resolve()
        }
        setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        return fetch(`${API}?force=1`, { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' })
          .then((response) => response.json())
          .then(apply)
          .catch((error) => {
            if (!alive.current) return
            setState((previous) => ({
              ...previous,
              status: previous.data === null ? 'error' : 'ready',
              error: String(error && error.message ? error.message : error),
              errorCode: 'network',
              needsSetup: false,
            }))
          })
      }, [apply])

      useEffect(() => {
        alive.current = true
        let stopped = false
        let paused = false
        let controller = null
        let reconnectTimer = null
        let pollTimer = null
        let attempt = 0
        // 每次连接一个代号：隐藏/显示切换时旧连接可能晚到，不能让它再排一次重连
        let generation = 0

        const setLink = (link) => {
          if (!alive.current) return
          setState((previous) => (previous.link === link ? previous : { ...previous, link }))
        }

        const stopPolling = () => {
          if (pollTimer === null) return
          window.clearInterval(pollTimer)
          pollTimer = null
        }

        const startPolling = () => {
          if (pollTimer !== null) return
          pollTimer = window.setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return
            loadOnce()
          }, POLL_MS)
          loadOnce()
        }

        async function connect() {
          reconnectTimer = null
          if (stopped || paused) return
          const mine = ++generation
          const token = readToken()
          if (token === '') {
            setState({ status: 'error', data: null, error: '插件未注入访问令牌（请重启 dsh web）', errorCode: null, needsSetup: false, link: 'off' })
            return
          }
          controller = new AbortController()
          try {
            const response = await fetch(STREAM, {
              headers: { [TOKEN_HEADER]: token, accept: 'text/event-stream' },
              cache: 'no-store',
              credentials: 'same-origin',
              signal: controller.signal,
            })
            if (!response.ok) throw new Error(`SSE HTTP ${response.status}`)
            if (response.body === null || typeof response.body.getReader !== 'function') throw new Error('SSE 不可用')
            attempt = 0
            stopPolling()
            setLink('live')
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            const parser = createSseParser()
            for (;;) {
              const { value, done } = await reader.read()
              if (stopped || paused || mine !== generation) return
              if (done) break
              for (const event of parser.push(decoder.decode(value, { stream: true }))) {
                if (event.event !== 'summary') continue
                try {
                  apply(JSON.parse(event.data))
                } catch {
                  // 半包或畸形帧：跳过，等下一帧快照
                }
              }
            }
            if (stopped || paused || mine !== generation) return
            throw new Error('SSE 连接结束')
          } catch (error) {
            if (stopped || paused || mine !== generation) return
            if (error !== null && error !== undefined && error.name === 'AbortError') return
            attempt += 1
            if (attempt >= 2) {
              setLink('poll')
              startPolling()
            } else {
              setLink('retry')
            }
            const wait = SSE_BACKOFF_MS[Math.min(attempt - 1, SSE_BACKOFF_MS.length - 1)]
            reconnectTimer = window.setTimeout(() => {
              connect()
            }, wait + Math.round(Math.random() * 400))
          }
        }

        /** 页面隐藏时断开（省电、省连接）；回到前台立刻重连，慢的数据靠首帧快照补齐。 */
        const onVisibility = () => {
          if (typeof document === 'undefined') return
          if (document.hidden) {
            paused = true
            if (controller !== null) controller.abort()
            stopPolling()
            setLink('paused')
            return
          }
          paused = false
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer)
            reconnectTimer = null
          }
          connect()
        }

        connect()
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility)
        }

        return () => {
          stopped = true
          alive.current = false
          if (controller !== null) controller.abort()
          if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
          stopPolling()
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [apply, loadOnce])

      return { ...state, refresh }
    }

    /* -------------------------------------------------------------- 基础组件 */

    function IconRefresh() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M13.4 2.4v3.2h-3.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconClose() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    function IconBars() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M3.5 12.5V8M8 12.5V4.5M12.5 12.5V6.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    function IconGear() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M8 1.8l1.05 1.09 1.51-.3.6 1.42 1.42.6-.3 1.51L13.37 7.2l-1.09 1.05.3 1.51-1.42.6-.6 1.42-1.51-.3L8 12.57l-1.05-1.09-1.51.3-.6-1.42-1.42-.6.3-1.51L2.63 7.2l1.09-1.05-.3-1.51 1.42-.6.6-1.42 1.51.3L8 1.8z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8, cy: 7.2, r: 1.9, stroke: 'currentColor', strokeWidth: 1.2 }))
    }

    function Panel(props) {
      return h('section', { className: 'ubd-panel' }, props.children)
    }

    function PanelHead(props) {
      return h('div', { className: 'ubd-panel-head' },
        h('span', { className: 'ubd-panel-title' }, props.title),
        props.meta !== undefined ? h('span', { className: 'ubd-panel-meta' }, props.meta) : null)
    }

    /* ------------------------------------------------------------------ 卡片 */

    /** 24h 支出的面积走势：直接把小时桶画成一条带填充的曲线，比一根根柱子更像「趋势」。 */
    function SparkArea(props) {
      const values = Array.isArray(props.values) ? props.values : []
      if (values.length === 0) return null
      let max = 0
      for (const value of values) max = Math.max(max, Number(value) || 0)
      if (!(max > 0)) max = 1
      const W = 100
      const H = 18
      const pad = 2
      const step = values.length > 1 ? (W - pad * 2) / (values.length - 1) : W - pad * 2
      const points = values.map((value, index) => {
        const x = pad + index * step
        const y = H - 2 - Math.max(1.5, (Math.max(0, Number(value) || 0) / max) * (H - 4))
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      const line = `M${points.join(' L')}`
      return h('svg', {
        className: 'ub-card-area',
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        'aria-hidden': true,
      },
        h('title', null, props.label || ''),
        h('defs', null,
          h('linearGradient', { id: 'ub-card-area-grad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: '0.22' }),
            h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: '0' }))),
        h('path', { className: 'ub-card-area-fill', d: `M${points[0]} L${points.slice(1).join(' L')} L${W},${H} L${pad},${H} Z` }),
        h('path', { className: 'ub-card-area-line', d: line, vectorEffect: 'non-scaling-stroke' }))
    }

    function CardSkeleton(props) {
      return h(React.Fragment, null,
        h('div', { className: 'ub-card-main' },
          h('div', { className: 'ub-skel is-wide', style: { height: 14, width: 64 } }),
          h('div', { className: 'ub-skel', style: { flex: '1 1 auto', height: 14 } })),
        h('div', { className: 'ub-card-stats' },
          h('div', { className: 'ub-skel', style: { width: 62 } }),
          h('div', { className: 'ub-skel', style: { width: 56 } }),
          h('div', { className: 'ub-skel', style: { width: 48 } })))
    }

    function CardError(props) {
      return h(React.Fragment, null,
        h('div', { className: 'ub-card-main' },
          h('span', { className: 'ub-card-label' }, props.t('errorTitle')),
          h('span', { className: 'ub-card-error-msg' }, props.message)),
        h('span', { className: 'ub-card-retry' }, props.needsSetup ? props.t('setupOpenHint') : props.t('retry')))
    }

    function CardBody(props) {
      const t = props.t
      const data = props.data
      if (props.status === 'error' && data === null) {
        return h(CardError, {
          t,
          message: errorText(t, props.errorCode, props.error) || '—',
          needsSetup: props.needsSetup === true || isSetupCode(props.errorCode),
        })
      }
      if (data === null) return h(CardSkeleton, { t })
      const today = data.today || {}
      const win = data.window || {}
      const account = data.account || {}
      const hours = Array.isArray(data.hours) ? data.hours : []
      const coverage = today.coverage && Number(today.coverage.hours) > 0 ? Number(today.coverage.hours) : 0
      // 日志接口只给最近 1000 条；覆盖不足一天时不能标成「今日」
      const label = today.exact === true
        ? t('today')
        : (coverage > 0 ? `近 ${coverage < 1 ? coverage.toFixed(1) : Math.round(coverage)}h` : t('today'))
      const bound = today.exact === true ? '' : '≥'
      const granted = Number(account.totalGrantedQuota)
      const remaining = Number(account.remainingQuota)
      const quotaRatio = granted > 0 && Number.isFinite(remaining) ? remaining / granted : null
      const values = hours.map((item) => Number(item.cny) || 0)
      const errorRate = Number(win.errorRate)
      const successRate = Number.isFinite(errorRate) ? Math.max(0, Math.min(1, 1 - errorRate)) : null
      const quotaPct = quotaRatio === null ? null : Math.max(0, Math.min(100, Math.round(quotaRatio * 100)))
      const quotaLevel = quotaPct === null ? 'unknown' : quotaPct >= 50 ? 'high' : quotaPct >= 20 ? 'mid' : 'low'
      return h(React.Fragment, null,
        quotaPct === null ? null : h('span', {
          className: 'ub-card-battery',
          'data-level': quotaLevel,
          style: { width: `${quotaPct}%` },
          title: `${t('quotaLeft')} ${quotaPct}%`,
        }),
        h('div', { className: 'ub-card-main' },
          h('span', { className: 'ub-card-value' }, `${bound}${fmtCny(today.cny)}`),
          h(SparkArea, { values, label: `${label} · 近 24 小时支出走势` })),
        h('div', { className: 'ub-card-stats' },
          h('span', { className: 'ub-card-stat' },
            h('span', { className: 'ub-card-stat-label' }, t('hour24Short')),
            h('span', { className: 'ub-card-stat-value' }, fmtCny(win.cny))),
          h('span', { className: 'ub-card-stat' },
            h('span', { className: 'ub-card-stat-label' }, t('balance')),
            h('span', { className: 'ub-card-stat-value' }, fmtCny(account.quotaCny))),
          h('span', { className: 'ub-card-stat' },
            h('span', { className: 'ub-card-stat-label' }, t('successRate')),
            h('span', { className: 'ub-card-stat-value' }, successRate === null ? '—' : fmtPct(successRate)))),
        quotaPct === null ? null : h('span', { className: 'ub-card-gauge', 'data-level': quotaLevel },
          h('span', { className: 'ub-card-gauge-fill', style: { width: `${quotaPct}%` } }),
          h('span', { className: 'ub-card-gauge-ticks', 'aria-hidden': true })))
    }

    function useDialogBehavior(dialogRef, open, onClose) {
      const restoreRef = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined') return undefined
        restoreRef.current = document.activeElement
        const root = dialogRef.current
        if (root !== null) {
          const target = root.querySelector('[data-modal-autofocus]') || root
          if (typeof target.focus === 'function') target.focus()
        }
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const node = dialogRef.current
          if (node === null) return
          const items = [...node.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex="0"]')]
          const first = items[0] || node
          const last = items[items.length - 1] || node
          const active = document.activeElement
          if (active === node || node.contains(active) === false) {
            event.preventDefault()
            first.focus()
            return
          }
          if (event.shiftKey && active === first) {
            event.preventDefault()
            last.focus()
            return
          }
          if (event.shiftKey === false && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          const restore = restoreRef.current
          if (restore !== null && restore !== undefined && restore.isConnected === true) {
            if (typeof restore.focus === 'function') restore.focus()
          }
          restoreRef.current = null
        }
      }, [dialogRef, open, onClose])
    }

    function QuotaRing(props) {
      const ratio = Number(props.ratio)
      const pct = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : null
      const radius = 18.5
      const circumference = 2 * Math.PI * radius
      return h('svg', { className: 'ubd-ring', width: 44, height: 44, viewBox: '0 0 44 44', 'aria-hidden': true },
        h('circle', { cx: 22, cy: 22, r: radius, fill: 'none', strokeWidth: 3, className: 'ubd-ring-track' }),
        pct === null ? null : h('circle', {
          cx: 22,
          cy: 22,
          r: radius,
          fill: 'none',
          strokeWidth: 3,
          className: 'ubd-ring-fill',
          strokeDasharray: `${(circumference * pct).toFixed(2)} ${circumference.toFixed(2)}`,
          strokeLinecap: 'round',
          transform: 'rotate(-90 22 22)',
        }),
        h('text', {
          x: 22,
          y: 22.5,
          textAnchor: 'middle',
          dominantBaseline: 'central',
          className: 'ubd-ring-text',
        }, pct === null ? '—' : `${Math.round(pct * 100)}%`))
    }

    function WeekSpark(props) {
      const days = props.days || []
      if (days.length === 0) return null
      let peak = 0.0001
      let total = 0
      for (const day of days) {
        peak = Math.max(peak, Number(day.cny) || 0)
        total += Number(day.cny) || 0
      }
      return h('div', { className: 'ubd-spark' },
        h('div', { className: 'ubd-spark-head' },
          h('span', { className: 'ubd-spark-title' }, props.t('week')),
          h('span', { className: 'ubd-spark-total' }, fmtCny(total))),
        h('div', { className: 'ubd-spark-bars' }, days.map((day) => h('div', {
          className: 'ubd-spark-col',
          key: day.date,
          title: `${day.label} · ${fmtCny(day.cny)}`,
        }, h('div', {
          className: 'ubd-spark-bar',
          style: { height: `${Math.max(3, Math.round(((Number(day.cny) || 0) / peak) * 100))}%` },
        })))),
        h('div', { className: 'ubd-spark-axis' }, days.map((day) => h('span', { key: day.date }, String(day.label).slice(-2)))))
    }

    function Health(props) {
      return h('div', { className: 'ubd-health-item' },
        h('span', { className: 'ubd-health-label' }, props.label),
        h('span', { className: 'ubd-health-value', 'data-tone': props.tone }, props.value))
    }

    function HourBars(props) {
      const hours = props.hours || []
      if (hours.length === 0) return h('div', { className: 'ubd-empty' }, props.t('empty'))
      let max = 0.0001
      let total = 0
      let requests = 0
      for (const item of hours) {
        max = Math.max(max, item.cny)
        total += item.cny
        requests += item.requests
      }
      const lastHour = hours[hours.length - 1]
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('hour24'), meta: `${fmtCny(total)} · ${requests} ${props.t('requests')}` }),
        h('div', { className: 'ubd-bars' }, hours.map((item) => {
          const ratio = item.cny / max
          const isNow = lastHour !== undefined && item.at === lastHour.at
          return h('div', { className: 'ubd-bar', key: item.at, 'data-now': isNow ? 'true' : 'false' },
            h('div', { className: 'ubd-bar-tip' },
              `${item.label}:00 · ${fmtCny(item.cny)} · ${item.requests} ${props.t('requests')}`),
            h('div', { className: 'ubd-bar-fill', style: { height: ratio > 0 ? `${Math.max(2, Math.round(ratio * 100))}%` : '0%' } }))
        })),
        h('div', { className: 'ubd-axis' },
          h('span', null, hours[0] ? `${hours[0].label}:00` : ''),
          h('span', null, hours[12] ? `${hours[12].label}:00` : ''),
          h('span', null, lastHour ? `${lastHour.label}:00` : '')))
    }

    function heatLevel(cny, max) {
      if (!(cny > 0)) return 0
      const ratio = cny / max
      if (ratio > 0.72) return 4
      if (ratio > 0.46) return 3
      if (ratio > 0.2) return 2
      return 1
    }

    function Heatmap(props) {
      const heat = props.heat || []
      if (heat.length === 0) return null
      let max = 0.0001
      for (const day of heat) {
        for (const cell of day.cells) max = Math.max(max, cell.cny)
      }
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('heat'), meta: props.t('week') }),
        h('div', { className: 'ubd-heat' }, heat.map((day) =>
          h('div', { className: 'ubd-heat-row', key: day.date },
            h('span', { className: 'ubd-heat-day' }, day.label),
            day.cells.map((cell) => h('span', {
              key: `${day.date}-${cell.hour}`,
              className: 'ubd-heat-cell',
              'data-level': String(heatLevel(cell.cny, max)),
              title: `${day.date} ${String(cell.hour).padStart(2, '0')}:00 · ${fmtCny(cell.cny)} · ${cell.requests}`,
            }))))),
        h('div', { className: 'ubd-heat-legend' },
          h('span', null, '少'),
          h('i', { 'data-level': '1' }),
          h('i', { 'data-level': '2' }),
          h('i', { 'data-level': '3' }),
          h('i', { 'data-level': '4' }),
          h('span', null, '多')))
    }

    function Models(props) {
      const models = props.models || []
      if (models.length === 0) return null
      let total = 0
      for (const item of models) total += Number(item.cny) || 0
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('models'), meta: `${props.t('week')} · ${fmtCny(total)}` }),
        h('div', { className: 'ubd-models' }, models.map((item) =>
          h('div', {
            className: 'ubd-model',
            key: item.model,
            title: `${item.model || '—'} · ${Number(item.requests).toLocaleString('zh-CN')} ${props.t('requests')} · ${fmtCny(item.cny)}`,
          },
            h('span', { className: 'ubd-model-name' }, item.model || '—'),
            h('span', { className: 'ubd-model-req' }, `${Number(item.requests).toLocaleString('zh-CN')} ${props.t('requests')}`),
            h('span', { className: 'ubd-model-cny' }, fmtCny(item.cny))))))
    }

    function Recent(props) {
      const list = props.recent || []
      if (list.length === 0) return h('div', { className: 'ubd-empty' }, props.t('empty'))
      return h('div', { className: 'ubd-recent' }, list.slice(0, 6).map((row, index) =>
        h('div', {
          className: 'ubd-req',
          key: `${row.id}-${index}`,
          'data-error': row.ok === false ? 'true' : 'false',
          title: `${row.model || '—'} · ${fmtCny(row.cny)} · ${fmtMs(row.totalMs)} · ${props.t('ttft')} ${fmtMs(row.ttftMs)}`,
        },
          h('span', { className: 'ubd-req-time' }, row.timeLabel),
          h('span', { className: 'ubd-req-model' }, row.model || '—'),
          row.ok === false
            ? h('span', { className: 'ubd-req-meta' }, h('span', { className: 'ubd-req-fail' }, '错误'))
            : h('span', { className: 'ubd-req-meta' }, `${fmtMs(row.totalMs)} · ${fmtTps(row.tps)} t/s`),
          h('span', { className: 'ubd-req-cny' }, fmtCny(row.cny)))))
    }

    /* -------------------------------------------------------------- 配置视图 */

    /** 宿主约定：没有可读供应商时 `readable:false`，正常时给 candidates 数组。 */
    function sourceCandidates(data) {
      if (data === null || data === undefined || data.readable === false) return []
      return Array.isArray(data.candidates) ? data.candidates : []
    }

    /** 默认选中宿主标的 selected，其次第一项；找不到时回落到第一项。 */
    function pickCandidate(data, providerId) {
      const list = sourceCandidates(data)
      if (list.length === 0) return null
      const wanted = typeof providerId === 'string' && providerId !== ''
        ? providerId
        : (data.selected && data.selected.providerId) || list[0].providerId
      return list.find((item) => item.providerId === wanted) || list[0]
    }

    /**
     * 配置视图的纯展示层：不取数、不依赖 React 状态，方便测试直接喂三种候选形态。
     * 展示层只读宿主给的 tail，永远不接收完整令牌。
     */
    function SetupContent(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const source = props.source !== null && typeof props.source === 'object'
        ? props.source
        : { status: 'loading', data: null, error: null, code: null }
      const cancel = typeof props.onCancel === 'function' ? props.onCancel : () => {}
      const head = h('div', { className: 'ubd-setup-head' },
        h('div', { className: 'ubd-setup-title' }, t('setupTitle')),
        h('div', { className: 'ubd-setup-sub' }, t('setupSub')))

      if (source.status === 'loading') {
        return h('div', { className: 'ubd-setup' },
          head,
          h('div', { className: 'ubd-setup-card' },
            h('div', { className: 'ubd-setup-sub' }, t('setupSourceLoading')),
            h('div', { className: 'ubd-setup-skel' },
              h('div', { className: 'ubd-setup-skel-row is-short' }),
              h('div', { className: 'ubd-setup-skel-row' }),
              h('div', { className: 'ubd-setup-skel-row' }))))
      }

      if (source.status === 'error') {
        const retry = typeof props.onRetry === 'function' ? props.onRetry : () => {}
        return h('div', { className: 'ubd-setup' },
          head,
          h('div', { className: 'ubd-error' },
            h('div', { className: 'ubd-error-title' }, t('setupSourceFailed')),
            h('div', { className: 'ubd-error-body' }, errorText(t, source.code, source.error) || t('errorUnknown')),
            h('button', { className: 'ubd-retry', type: 'button', onClick: retry }, t('retry'))),
          h('div', { className: 'ubd-setup-actions' },
            h('span', { className: 'ubd-setup-spacer' }),
            h('button', { className: 'ubd-setup-btn', type: 'button', onClick: cancel }, t('setupCancel'))))
      }

      const data = source.data !== null && typeof source.data === 'object' ? source.data : {}
      const gateway = data.gateway !== null && typeof data.gateway === 'object' ? data.gateway : {}
      const token = data.token !== null && typeof data.token === 'object' ? data.token : null
      const candidates = sourceCandidates(data)
      const selectedCandidate = pickCandidate(data, props.providerId)
      const noProvider = data.readable === false || candidates.length === 0
      // 访问令牌按网关保存（宿主只有一份 accessTokenRef），切换候选时沿用同一份。
      const activeToken = token
      const tail = activeToken !== null && typeof activeToken.tail === 'string'
        ? activeToken.tail.trim().slice(-8)
        : ''
      const tailText = tail === ''
        ? ''
        : (/^[.…]/.test(tail) ? tail : `…${tail}`)
      const tokenNote = activeToken !== null && activeToken.configured === true
        ? `${t('setupTokenSaved')}${tailText === '' ? '' : ` ${tailText}`}`
        : ''
      const keyOk = selectedCandidate !== null && selectedCandidate.keyStatus === 'configured'
      const busy = props.saving === true || props.testing === true
      const providerLocked = busy || noProvider
      const testResult = props.testResult !== null && typeof props.testResult === 'object' ? props.testResult : null
      const notice = props.notice !== null && typeof props.notice === 'object' ? props.notice : null

      const providerRow = selectedCandidate === null
        ? null
        : candidates.length > 1
          ? h('label', { className: 'ubd-setup-row' },
              h('span', { className: 'ubd-setup-label' }, t('setupProvider')),
              h('select', {
                className: 'ubd-setup-select',
                value: selectedCandidate.providerId,
                disabled: busy,
                'aria-label': t('setupProvider'),
                onChange: (event) => {
                  if (typeof props.onProviderChange === 'function') props.onProviderChange(event.target.value)
                },
              }, candidates.map((item) => h('option', {
                key: item.providerId,
                value: item.providerId,
              }, item.name || item.providerId || '—'))))
          : h('div', { className: 'ubd-setup-row' },
              h('span', { className: 'ubd-setup-label' }, t('setupProvider')),
              h('span', { className: 'ubd-setup-value' }, selectedCandidate.name || selectedCandidate.providerId || '—'))

      const detailRows = selectedCandidate === null
        ? null
        : [
            h('div', { className: 'ubd-setup-row', key: 'usage' },
              h('span', { className: 'ubd-setup-label' }, t('setupUsageBaseUrl')),
              h('span', { className: 'ubd-setup-value ubd-setup-code' }, selectedCandidate.usageBaseUrl || '—')),
            h('div', { className: 'ubd-setup-row', key: 'key' },
              h('span', { className: 'ubd-setup-label' }, t('setupKeyStatus')),
              h('span', { className: 'ubd-setup-status', 'data-tone': keyOk ? 'ok' : 'bad' },
                keyOk ? t('setupKeyConfigured') : t('setupKeyMissing'))),
          ]

      const empty = noProvider
        ? h('div', { className: 'ubd-setup-empty' },
            h('div', { className: 'ubd-setup-empty-title' }, t('setupNoCandidates')),
            h('div', { className: 'ubd-setup-empty-hint' }, t('setupNoCandidatesHint')))
        : null

      const tokenCard = selectedCandidate === null
        ? null
        : h('div', { className: 'ubd-setup-card' },
            h('div', { className: 'ubd-setup-row' },
              h('span', { className: 'ubd-setup-label' }, `${t('setupToken')} · ${t('setupTokenOptional')}`),
              h('div', { className: 'ubd-setup-control' },
                h('input', {
                  className: 'ubd-setup-input',
                  type: 'password',
                  value: typeof props.accessToken === 'string' ? props.accessToken : '',
                  placeholder: t('setupTokenPlaceholder'),
                  autoComplete: 'new-password',
                  spellCheck: false,
                  disabled: busy || props.clearAccessToken === true,
                  'aria-label': t('setupToken'),
                  onChange: (event) => {
                    if (typeof props.onTokenChange === 'function') props.onTokenChange(event.target.value)
                  },
                }),
                tokenNote === '' ? null : h('div', { className: 'ubd-setup-note' }, tokenNote),
                activeToken !== null && activeToken.configured === true
                  ? h('label', { className: 'ubd-setup-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: props.clearAccessToken === true,
                        disabled: busy,
                        onChange: (event) => {
                          if (typeof props.onClearTokenChange === 'function') props.onClearTokenChange(event.target.checked)
                        },
                      }),
                      t('setupTokenClear'))
                  : null)))

      const keyHint = selectedCandidate !== null && !keyOk
        ? h('div', { className: 'ubd-setup-hint' }, t('setupKeyMissingHint'))
        : null

      const resultNode = testResult === null
        ? null
        : h('div', { className: 'ubd-setup-result', 'data-tone': testResult.ok === true ? 'ok' : 'bad' },
            testResult.ok === true
              ? (testResult.mode === 'aggregate' ? t('setupTestOkAggregate') : t('setupTestOkLogs'))
              : `${t('setupTestFailed')} · ${errorText(t, testResult.code, testResult.error) || t('errorUnknown')}`)

      const noticeNode = notice === null
        ? null
        : h('div', { className: 'ubd-setup-result', 'data-tone': 'bad' },
            notice.kind === 'refresh'
              ? `${t('setupSavedRefreshFailed')} · ${errorText(t, notice.code, notice.error) || t('errorUnknown')}`
              : (errorText(t, notice.code, notice.error) || t('errorUnknown')))

      return h('div', { className: 'ubd-setup' },
        head,
        h('div', { className: 'ubd-setup-card' },
          gateway.baseUrl ? h('div', { className: 'ubd-setup-row' },
            h('span', { className: 'ubd-setup-label' }, t('setupGateway')),
            h('span', { className: 'ubd-setup-value ubd-setup-code' }, String(gateway.baseUrl))) : null,
          providerRow,
          detailRows,
          keyHint,
          empty),
        tokenCard,
        resultNode,
        noticeNode,
        h('div', { className: 'ubd-setup-actions' },
          h('button', {
            className: 'ubd-setup-btn',
            type: 'button',
            disabled: providerLocked,
            onClick: () => {
              if (typeof props.onTest === 'function') props.onTest()
            },
          }, props.testing === true ? t('setupTesting') : t('setupTest')),
          h('button', {
            className: 'ubd-setup-btn',
            type: 'button',
            'data-primary': 'true',
            disabled: providerLocked,
            onClick: () => {
              if (typeof props.onSave === 'function') props.onSave()
            },
          }, props.saving === true ? t('setupSaving') : t('setupSave')),
          h('span', { className: 'ubd-setup-spacer' }),
          h('button', {
            className: 'ubd-setup-btn',
            type: 'button',
            disabled: props.saving === true,
            onClick: cancel,
          }, t('setupCancel'))))
    }

    /** 有状态外壳：打开配置视图时 GET /source，按钮各自带 loading 且防重复提交。 */
    function SetupPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const tRef = useRef(t)
      tRef.current = t
      const [source, setSource] = useState({ status: 'loading', data: null, error: null, code: null })
      const [providerId, setProviderId] = useState('')
      const [accessToken, setAccessToken] = useState('')
      const [clearAccessToken, setClearAccessToken] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const [notice, setNotice] = useState(null)
      const [testing, setTesting] = useState(false)
      const [saving, setSaving] = useState(false)
      const alive = useRef(true)
      /** 同步锁：state 要等下一次渲染才禁用按钮，双击仍可能并发。 */
      const inFlight = useRef(false)

      const loadSource = useCallback(() => {
        const token = readToken()
        if (token === '') {
          setSource({ status: 'error', data: null, error: tRef.current('tokenMissing'), code: null })
          return Promise.resolve()
        }
        setSource({ status: 'loading', data: null, error: null, code: null })
        setTestResult(null)
        setNotice(null)
        return fetch(SOURCE, {
          headers: { [TOKEN_HEADER]: token },
          cache: 'no-store',
          credentials: 'same-origin',
        })
          .then(async (response) => {
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            return { payload, status: response.status }
          })
          .then(({ payload, status }) => {
            if (!alive.current) return
            if (payload === null || payload.ok !== true) {
              setSource({
                status: 'error',
                data: null,
                error: (payload && payload.error) || `HTTP ${status}`,
                code: (payload && payload.code) || null,
              })
              return
            }
            setSource({ status: 'ready', data: payload, error: null, code: null })
            setProviderId((previous) => {
              if (previous !== '') return previous
              if (payload.selected && payload.selected.providerId) return payload.selected.providerId
              const candidates = sourceCandidates(payload)
              return candidates.length > 0 ? candidates[0].providerId : ''
            })
          })
          .catch((error) => {
            if (!alive.current) return
            setSource({
              status: 'error',
              data: null,
              error: String(error && error.message ? error.message : error),
              code: 'network',
            })
          })
      }, [])

      useEffect(() => {
        alive.current = true
        loadSource()
        return () => {
          alive.current = false
        }
      }, [loadSource])

      const sendSource = useCallback((url, body) => {
        const token = readToken()
        if (token === '') {
          return Promise.resolve({ ok: false, error: tRef.current('tokenMissing'), code: null })
        }
        return fetch(url, {
          method: 'POST',
          headers: { [TOKEN_HEADER]: token, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
          credentials: 'same-origin',
        }).then(async (response) => {
          try {
            const payload = await response.json()
            return payload !== null && typeof payload === 'object'
              ? payload
              : { ok: false, error: `HTTP ${response.status}`, code: null }
          } catch {
            return { ok: false, error: `HTTP ${response.status}`, code: 'network' }
          }
        })
      }, [])

      const changeProvider = useCallback((value) => {
        setProviderId(value)
        setAccessToken('')
        setClearAccessToken(false)
        setTestResult(null)
        setNotice(null)
      }, [])

      const changeToken = useCallback((value) => {
        setAccessToken(value)
        setTestResult(null)
        setNotice(null)
      }, [])

      const toggleClearToken = useCallback((checked) => {
        setClearAccessToken(checked)
        if (checked) setAccessToken('')
        setTestResult(null)
        setNotice(null)
      }, [])

      const runTest = useCallback(() => {
        if (inFlight.current || testing || saving || source.status !== 'ready') return
        const candidate = pickCandidate(source.data, providerId)
        if (candidate === null) return
        inFlight.current = true
        const body = {}
        if (candidate.providerId) body.providerId = candidate.providerId
        const typed = accessToken.trim()
        if (typed !== '' && clearAccessToken !== true) body.accessToken = typed
        setTesting(true)
        setTestResult(null)
        setNotice(null)
        sendSource(SOURCE_TEST, body)
          .then((payload) => {
            if (!alive.current) return
            if (payload === null || payload.ok !== true) {
              setTestResult({
                ok: false,
                code: (payload && payload.code) || 'network',
                error: (payload && payload.error) || tRef.current('errorUnknown'),
              })
              return
            }
            setTestResult({ ok: true, mode: payload.mode === 'aggregate' ? 'aggregate' : 'logs' })
          })
          .catch((error) => {
            if (!alive.current) return
            setTestResult({
              ok: false,
              code: 'network',
              error: String(error && error.message ? error.message : error),
            })
          })
          .finally(() => {
            inFlight.current = false
            if (alive.current) setTesting(false)
          })
      }, [testing, saving, source, providerId, accessToken, clearAccessToken, sendSource])

      const runSave = useCallback(() => {
        if (inFlight.current || saving || testing || source.status !== 'ready') return
        const candidate = pickCandidate(source.data, providerId)
        if (candidate === null) return
        inFlight.current = true
        const body = {}
        if (candidate.providerId) body.providerId = candidate.providerId
        const typed = accessToken.trim()
        if (typed !== '' && clearAccessToken !== true) body.accessToken = typed
        if (clearAccessToken === true) body.clearAccessToken = true
        setSaving(true)
        setTestResult(null)
        setNotice(null)
        sendSource(SOURCE, body)
          .then((payload) => {
            if (!alive.current) return
            if (payload === null || payload.ok !== true) {
              setNotice({
                kind: 'save',
                code: (payload && payload.code) || 'network',
                error: (payload && payload.error) || tRef.current('errorUnknown'),
              })
              return
            }
            if (payload.refresh !== null && typeof payload.refresh === 'object' && payload.refresh.ok === false) {
              setNotice({
                kind: 'refresh',
                code: payload.refresh.code || null,
                error: payload.refresh.error || tRef.current('errorUnknown'),
              })
              return
            }
            setAccessToken('')
            setClearAccessToken(false)
            setSource((previous) => (previous.data === null
              ? previous
              : { ...previous, data: { ...previous.data, selected: payload.selected || previous.data.selected } }))
            if (typeof props.onSaved === 'function') props.onSaved()
          })
          .catch((error) => {
            if (!alive.current) return
            setNotice({
              kind: 'save',
              code: 'network',
              error: String(error && error.message ? error.message : error),
            })
          })
          .finally(() => {
            inFlight.current = false
            if (alive.current) setSaving(false)
          })
      }, [saving, testing, source, providerId, accessToken, clearAccessToken, sendSource, props.onSaved])

      return h(SetupContent, {
        t,
        source,
        providerId,
        accessToken,
        clearAccessToken,
        testResult,
        notice,
        testing,
        saving,
        onProviderChange: changeProvider,
        onTokenChange: changeToken,
        onClearTokenChange: toggleClearToken,
        onTest: runTest,
        onSave: runSave,
        onCancel: props.onCancel,
        onRetry: loadSource,
      })
    }

    function DialogContent(props) {
      const data = props.data
      const t = props.t
      if (data === null) {
        if (props.status === 'error') {
          return h('div', { className: 'ubd-error' },
            h('div', { className: 'ubd-error-title' }, t('errorTitle')),
            h('div', { className: 'ubd-error-body' }, errorText(t, props.errorCode, props.error) || '—'),
            h('button', { className: 'ubd-retry', type: 'button', onClick: props.refresh }, t('retry')))
        }
        return h('div', { className: 'ubd-empty' }, t('loading'))
      }
      const today = data.today || {}
      const win = data.window || {}
      const short = data.short || {}
      const account = data.account || {}
      const granted = Number(account.totalGrantedQuota)
      const remaining = Number(account.remainingQuota)
      const ratio = granted > 0 && Number.isFinite(remaining) ? remaining / granted : null
      return h(React.Fragment, null,
        h('div', { className: 'ubd-hero' },
          h('div', { className: 'ubd-hero-main' },
            h('div', { className: 'ubd-hero-label' }, `${t('today')}${today.exact === false ? ` · ${t('partial')}` : ''}`),
            h('div', { className: 'ubd-hero-value' }, fmtCny(today.cny)),
            h('div', { className: 'ubd-hero-sub' }, `${Number(today.requests || 0).toLocaleString('zh-CN')} ${t('requests')} · ${fmtTokens(today.tokens)} tok`)),
          h(WeekSpark, { days: data.days, t }),
          h('div', { className: 'ubd-hero-side' },
            h(QuotaRing, { ratio }),
            h('div', { className: 'ubd-hero-side-text' },
              h('span', { className: 'ubd-hero-side-label' }, t('balance')),
              h('span', { className: 'ubd-hero-side-value' }, fmtCny(account.quotaCny)),
              h('span', { className: 'ubd-hero-side-sub' }, `${t('cumulative')} ${fmtCny(account.usedCny)}`)))),
        h('div', { className: 'ubd-health' },
          h(Health, { label: t('errorRate'), value: fmtPct(win.errorRate), tone: Number(win.errors) > 0 ? 'bad' : undefined }),
          h(Health, { label: 'p50', value: `${fmtTps(win.tpsP50)} t/s` }),
          h(Health, { label: t('ttft'), value: fmtMs(short.ttftMs) }),
          h(Health, { label: t('throughput'), value: `${fmtTps(short.tps)} t/s` }),
          h(Health, { label: t('requestsTotal'), value: Number(win.requests || 0).toLocaleString('zh-CN') })),
        h('div', { className: 'ubd-body' },
          h('div', { className: 'ubd-col' },
            h(Panel, null, h(HourBars, { hours: data.hours, t })),
            h(Panel, null,
              h(PanelHead, { title: t('recent'), meta: fmtTokens(win.tokens) }),
              h(Recent, { recent: data.recent, t }))),
          h('div', { className: 'ubd-col' },
            h(Panel, null, h(Models, { models: data.models, t })),
            h(Panel, null, h(Heatmap, { heat: data.heat, t })))))
    }

    function Dialog(props) {
      const dialogRef = useRef(null)
      useDialogBehavior(dialogRef, props.open, props.onClose)
      // null = 跟随失败载荷自动决定；'board'/'setup' 表示用户手动切过视图。
      const [view, setView] = useState(null)
      const autoSetup = props.data === null
        && (props.needsSetup === true || isSetupCode(props.errorCode))
      const activeView = view === 'setup' || view === 'board' ? view : (autoSetup ? 'setup' : 'board')
      useEffect(() => {
        if (!props.open) setView(null)
      }, [props.open])
      const handleSaved = useCallback(() => {
        setView('board')
        if (typeof props.refresh === 'function') props.refresh()
      }, [props.refresh])
      if (!props.open) return null
      // 密钥口径会给 notes（截断/下限说明），聚合口径没有：没有说明就不占一行
      const notes = props.data !== null && Array.isArray(props.data.notes)
        ? props.data.notes.filter((note) => typeof note === 'string' && note !== '').join(' ')
        : ''
      const footText = activeView === 'setup'
        ? props.t('setupFoot')
        : (props.data === null
            ? ''
            : [props.error !== null ? errorText(props.t, props.errorCode, props.error) : '', notes].filter(Boolean).join(' · '))
      const node = h('div', { className: 'ubd-root' },
        h('div', { className: 'ubd-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          ref: dialogRef,
          className: 'ubd-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.t('title'),
          'data-shortcut-modal': 'usage-board',
          tabIndex: -1,
        },
          h('header', { className: 'ubd-head' },
            h('h2', { className: 'ubd-title' }, props.t('title')),
            h('span', { className: 'ubd-sub' },
              props.data !== null && props.data.site
                ? `${props.data.site.baseUrl.replace(/^https?:\/\//, '')} · ${props.t('updated')} ${fmtClock(props.data.generatedAt)}`
                : props.t('hint'),
              props.link === 'live' || props.link === 'poll'
                ? h('span', {
                    className: 'ubd-live',
                    'data-live': props.link,
                    title: props.link === 'live' ? props.t('liveHint') : props.t('pollHint'),
                  }, props.link === 'live' ? props.t('live') : props.t('polling'))
                : null),
            h('div', { className: 'ubd-head-actions' },
              h('button', {
                className: 'ubd-btn',
                type: 'button',
                title: props.t('refresh'),
                'aria-label': props.t('refresh'),
                'data-spin': props.status === 'refreshing' ? 'true' : 'false',
                onClick: props.refresh,
              }, h(IconRefresh)),
              h('button', {
                className: 'ubd-btn',
                type: 'button',
                title: props.t('close'),
                'aria-label': props.t('close'),
                'data-modal-autofocus': '',
                onClick: props.onClose,
              }, h(IconClose))),
            // 放在 actions 之后、靠 CSS order 显示在前面：健康状态也能随时进配置。
            h('button', {
              className: 'ubd-btn ubd-setup-open',
              type: 'button',
              title: props.t('setup'),
              'aria-label': props.t('setup'),
              'aria-pressed': activeView === 'setup' ? 'true' : 'false',
              onClick: () => setView('setup'),
            }, h(IconGear))),
          activeView === 'setup'
            ? h(SetupPanel, {
                t: props.t,
                refresh: props.refresh,
                onSaved: handleSaved,
                onCancel: () => setView('board'),
              })
            : h(DialogContent, {
                data: props.data,
                status: props.status,
                error: props.error,
                errorCode: props.errorCode,
                refresh: props.refresh,
                t: props.t,
              }),
          footText === '' ? null : h('footer', { className: 'ubd-foot' }, footText)))
      if (createPortal === null || typeof document === 'undefined') return node
      return createPortal(node, document.body)
    }

    /* ------------------------------------------------------------------ 入口 */

    function UsageCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const wide = props.wide !== false
      const [open, setOpen] = useState(false)
      const summary = useSummary()
      const data = summary.data
      const hasError = data !== null && Number((data.window || {}).errors) > 0
      const errorCode = typeof summary.errorCode === 'string' ? summary.errorCode : null
      const needsSetup = summary.needsSetup === true
      const openDialog = useCallback(() => setOpen(true), [])
      const closeDialog = useCallback(() => setOpen(false), [])

      const trigger = wide
        ? h('div', {
            className: 'ub-card',
            role: 'button',
            tabIndex: 0,
            'data-live': summary.link,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': t('open'),
            'data-error': hasError ? 'true' : 'false',
            title: t('open'),
            onClick: openDialog,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openDialog()
              }
            },
          }, h(CardBody, {
            data,
            status: summary.status,
            error: summary.error,
            errorCode,
            needsSetup,
            t,
          }))
        : h('button', {
            className: 'ub-rail',
            type: 'button',
            title: t('open'),
            'aria-label': t('open'),
            'aria-haspopup': 'dialog',
            onClick: openDialog,
          }, h(IconBars))

      return h(React.Fragment, null,
        trigger,
        h(Dialog, {
          open,
          onClose: closeDialog,
          data,
          status: summary.status,
          error: summary.error,
          errorCode,
          needsSetup,
          link: summary.link,
          refresh: summary.refresh,
          t,
        }))
    }

    return {
      inject: ['slots', 'locale'],
      testing: {
        Card: UsageCard,
        CardBody,
        CardError,
        Dialog,
        Sections: { HourBars, Heatmap, Models, Recent, DialogContent, WeekSpark, QuotaRing, SparkArea },
        setup: {
          Content: SetupContent,
          Panel: SetupPanel,
          pickCandidate,
          sourceCandidates,
          isSetupCode,
          codeText,
          errorText,
        },
        copy: { zh: ZH, en: EN },
        formatters: { fmtCny, fmtTokens, fmtTps, fmtMs, fmtPct },
        sse: { parseSseBlock, createSseParser },
      },
      apply(ctx) {
        let t
        try {
          t = ctx.locale.bind(NS)
        } catch {
          t = (key) => key
        }
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'usage-board: copy')
        ctx.effect(installStyles, 'usage-board: styles')

        ctx.effect(
          () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: CARD_ID,
              order: 100,
              locale: NS,
              inject: () => ({ t }),
            },
            UsageCard,
          )),
          'usage-board: sidebar card',
        )
      },
    }
  },
})
