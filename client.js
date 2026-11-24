// 注册 id 必须等于包名（DSH 客户端模块表按包名索引；写裸名会
// "loaded without registering" → 整个客户端半边不激活，面板消失）。
window.__ModuleLoader__.load({
  id: '@qzsy/dsh-usage-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** react-dom 在模块表里；取不到时退化为就地渲染（会被侧栏裁切）。 */
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
    const TOKEN_GLOBAL = '__DSH_USAGE_BOARD__'
    const TOKEN_HEADER = 'x-usage-board'

    /**
     * 这些 code 表示「配置/密钥/余额要人处理」，失效视图直接给出修复入口；
     * 其余（限流、网络）只需要重试。与宿主 lib/http.js 的 SETUP_CODES 对齐。
     */
    const SETUP_CODES = ['missing_credentials', 'invalid_credentials', 'forbidden', 'payment_required']

    /** code → 文案 key。新增错误码时两边字典一起补。 */
    const CODE_KEYS = {
      missing_credentials: 'codeMissingCredentials',
      invalid_credentials: 'codeInvalidCredentials',
      forbidden: 'codeForbidden',
      payment_required: 'codePaymentRequired',
      rate_limited: 'codeRateLimited',
      network: 'codeNetwork',
      not_found: 'codeNotFound',
      invalid_response: 'codeInvalidResponse',
      unsupported_provider: 'codeUnsupported',
      token_mismatch: 'codeTokenMismatch',
    }

    /* ------------------------------------------------------------------ 文案 */

    const ZH = {
      title: '用量看板',
      open: '打开用量看板',
      today: '今日用量',
      requests: '次',
      requestsTotal: '请求数',
      requestsToday: '今日请求',
      tokens: 'tokens',
      balance: '余额',
      cumulative: '累计',
      errorRate: '出错率',
      successRate: '成功率',
      throughput: '吞吐',
      ttft: '首字',
      hour24: '近 24 小时',
      hour24Short: '近24h',
      day7: '近 7 天',
      day30: '近 30 天',
      week: '7 天',
      heat: '活跃热力',
      models: '模型分布',
      recent: '最近请求',
      periods: '计费周期',
      refresh: '刷新',
      close: '关闭',
      retry: '重试',
      loading: '正在读取用量…',
      empty: '暂无数据',
      updated: '更新于',
      live: '实时',
      liveHint: '面板刷新完成时通过 SSE 推送同一份快照',
      connecting: '连接中',
      disconnected: '未连接',
      reconnecting: '重连中',
      provider: '供应商',
      switching: '切换中…',
      switchFailed: '切换失败',
      noCredential: '未配置凭据',
      tokenTitle: '系统访问令牌',
      tokenPlaceholder: '粘贴网关「个人设置 → 访问令牌」里的令牌',
      tokenSave: '保存并重试',
      tokenSaving: '保存中…',
      tokenHint: '令牌只写入本机 DSH 凭据服务，浏览器不回传明文',
      failedTitle: '用量不可用',
      failedHintSetup: '修好下面这一项即可恢复；也可以先切到另一个供应商。',
      failedHintRetry: '供应商临时不可用，稍后重试即可；也可以先切到另一个供应商。',
      codeMissingCredentials: '凭据缺失',
      codeInvalidCredentials: '密钥或令牌无效',
      codeForbidden: '密钥无权限或被禁用',
      codePaymentRequired: '余额不足',
      codeRateLimited: '供应商限流',
      codeNetwork: '网络或服务异常',
      codeNotFound: '接口不存在',
      codeInvalidResponse: '返回格式不符合预期',
      codeUnsupported: '供应商不可用',
      codeTokenMismatch: '页面令牌已失效',
      reloadPage: '刷新页面',
      reloadHint: '页面来自重启前的进程，刷新后即可恢复',
      failedShort: '失效',
      openDetail: '点击查看原因',
      detailsTitle: '供应商与凭据',
      current: '当前',
      copyError: '复制错误',
      copied: '已复制',
      tokenMissing: '插件令牌缺失，请重启 dsh web',
      keyStatus: '密钥',
      tokenStatus: '令牌',
      configured: '已配置',
      missing: '缺失',
      notRequired: '不需要',
      noteAccount: '账户级口径',
      settings: '供应商设置',
    }

    const EN = {
      title: 'Usage',
      open: 'Open usage board',
      today: 'Today',
      requests: 'req',
      requestsTotal: 'Requests',
      requestsToday: 'Today',
      tokens: 'tokens',
      balance: 'Balance',
      cumulative: 'Used',
      errorRate: 'Errors',
      successRate: 'Success',
      throughput: 'Throughput',
      ttft: 'TTFT',
      hour24: 'Last 24 hours',
      hour24Short: '24h',
      day7: 'Last 7 days',
      day30: 'Last 30 days',
      week: '7d',
      heat: 'Activity',
      models: 'Models',
      recent: 'Recent requests',
      periods: 'Billing periods',
      refresh: 'Refresh',
      close: 'Close',
      retry: 'Retry',
      loading: 'Loading usage…',
      empty: 'No data',
      updated: 'Updated',
      live: 'Live',
      liveHint: 'Pushed over SSE when the host refresh completes',
      connecting: 'Connecting',
      disconnected: 'Offline',
      reconnecting: 'Reconnecting',
      provider: 'Provider',
      switching: 'Switching…',
      switchFailed: 'Switch failed',
      noCredential: 'No credentials',
      tokenTitle: 'Access token',
      tokenPlaceholder: 'Paste the gateway access token',
      tokenSave: 'Save and retry',
      tokenSaving: 'Saving…',
      tokenHint: 'Stored in the local DSH credential service only',
      failedTitle: 'Usage unavailable',
      failedHintSetup: 'Fix the item below, or switch to the other provider.',
      failedHintRetry: 'Provider is temporarily unavailable. Retry later, or switch provider.',
      codeMissingCredentials: 'Credentials missing',
      codeInvalidCredentials: 'Invalid key or token',
      codeForbidden: 'Key lacks permission',
      codePaymentRequired: 'Insufficient balance',
      codeRateLimited: 'Rate limited',
      codeNetwork: 'Network or service error',
      codeNotFound: 'Endpoint not found',
      codeInvalidResponse: 'Unexpected response',
      codeUnsupported: 'Provider unavailable',
      codeTokenMismatch: 'Page token expired',
      reloadPage: 'Reload page',
      reloadHint: 'This page predates the last dsh-web restart; reload to recover',
      failedShort: 'Down',
      openDetail: 'Click for details',
      detailsTitle: 'Providers & credentials',
      current: 'Current',
      copyError: 'Copy error',
      copied: 'Copied',
      tokenMissing: 'Plugin token missing, restart dsh web',
      keyStatus: 'Key',
      tokenStatus: 'Token',
      configured: 'configured',
      missing: 'missing',
      notRequired: 'n/a',
      noteAccount: 'Account-wide',
      settings: 'Providers',
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
.ub-card:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:2px}
.ub-card[data-error="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}
.ub-card-gauge{position:absolute;left:0;right:0;bottom:0;height:3px;z-index:1;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent)}
.ub-card-gauge-fill{display:block;height:100%;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 42%,transparent);
  transition:width .3s ease-out,background .2s ease-out}
.ub-card-gauge[data-level="mid"] .ub-card-gauge-fill{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-success-primary)) 50%,transparent)}
.ub-card-gauge[data-level="low"] .ub-card-gauge-fill{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 52%,transparent)}
.ub-card-main{position:relative;z-index:1;display:flex;align-items:center;gap:8px;min-width:0}
.ub-card-label{flex:0 0 auto;font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary);
  letter-spacing:.02em}
.ub-card-provider{flex:0 1 auto;min-width:0;margin-left:auto;font-size:9px;line-height:12px;
  color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  text-align:right}
.ub-card-value{flex:0 0 auto;font-size:20px;line-height:24px;font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ub-card-area{display:block;flex:1 1 auto;min-width:24px;height:20px;margin:0 0 0 2px}
.ub-card-area-fill{fill:url(#ub-card-area-grad)}
.ub-card-area-line{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,var(--dsw-alias-label-tertiary));
  stroke-width:1.1;stroke-linejoin:round;stroke-linecap:round}
.ub-card-right{flex:0 0 auto;margin-left:auto;font-size:9.5px;line-height:12px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ub-card-pill{flex:0 0 auto;margin-left:auto;display:inline-flex;align-items:center;gap:4px;
  font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ub-card-pill::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.7}
.ub-card-pill[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}
.ub-card-stats{position:relative;z-index:1;display:flex;align-items:baseline;
  justify-content:space-between;gap:10px;min-width:0}
.ub-card-stat{display:inline-flex;align-items:baseline;gap:5px;min-width:0;white-space:nowrap;overflow:hidden}
.ub-card-stat-label{flex:0 1 auto;min-width:0;font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis}
.ub-card-stat-value{flex:0 0 auto;font-size:12px;line-height:15px;font-weight:500;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.ub-card-stat-value[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}
.ub-card-value-fail{font-size:16px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.ub-card-error{position:relative;z-index:1;display:flex;align-items:baseline;gap:6px;min-width:0}
.ub-card-error-msg{font-size:10px;line-height:13px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ub-card-error-hint{flex:0 0 auto;font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
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
.ubd-head{display:flex;flex:0 0 auto;align-items:center;gap:12px;padding:13px 14px 12px 22px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-title{margin:0;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.01em;flex:0 0 auto}
.ubd-head-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.ubd-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-live{display:inline-flex;align-items:center;gap:5px;margin-left:8px;font-size:9.5px;
  color:var(--dsw-alias-state-success-primary)}
.ubd-live::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}
.ubd-live[data-live="retrying"],.ubd-live[data-live="connecting"]{color:var(--dsw-alias-label-tertiary)}
.ubd-head-actions{margin-left:0;flex:0 0 auto;display:flex;align-items:center;gap:2px}
.ubd-btn{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:background .12s ease-out,color .12s ease-out}
.ubd-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ubd-btn[data-spin="true"] svg{animation:ub-spin .2s linear}

/* 供应商切换：分段控件，两个供应商时一眼可见 */
.ubd-switch{flex:0 0 auto;display:inline-flex;align-items:center;gap:2px;padding:2px;
  border-radius:9px;border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 7%,transparent)}
.ubd-switch-btn{appearance:none;border:0;border-radius:7px;padding:3px 9px;
  font-size:10px;line-height:15px;font-weight:500;font-family:inherit;
  color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;
  white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;
  transition:background .14s ease-out,color .14s ease-out}
.ubd-switch-btn:hover{color:var(--dsw-alias-label-primary)}
/* 选中项必须最亮：不要给它加 disabled（那会把 opacity 降到 .55，比未选中的还暗，
   看上去就像标错了供应商）。bg-layer-1 在深色主题下与弹窗底同色，改用文字色叠一层。 */
.ubd-switch-btn[aria-pressed="true"]{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-bg-mask-2) 24%,transparent)}
.ubd-switch-btn:disabled{cursor:default;opacity:.55}
.ubd-switch-btn:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:1px}

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
.ubd-body[data-cols="1"]{grid-template-columns:minmax(0,1fr)}
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
.ubd-model-cost{color:var(--dsw-alias-label-secondary);
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
.ubd-req-cost{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  white-space:nowrap;font-size:9px;min-width:42px;text-align:right}

/* 周期对比：wandapi 这类只有 今日 / 7 天 / 30 天 的供应商 */
.ubd-periods{display:flex;flex-direction:column;gap:9px}
.ubd-period{display:grid;grid-template-columns:52px minmax(0,1fr) auto;align-items:center;gap:10px}
.ubd-period-label{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.ubd-period-bar{position:relative;height:8px;border-radius:4px;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);overflow:hidden}
.ubd-period-fill{display:block;height:100%;border-radius:4px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent)}
.ubd-period[data-now="true"] .ubd-period-fill{background:var(--dsw-alias-brand-primary)}
.ubd-period-value{font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right;min-width:64px}
.ubd-period-meta{display:flex;gap:12px;margin-top:10px;font-size:9px;line-height:13px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}

.ubd-foot{flex:0 0 auto;padding:10px 22px 12px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-tertiary);letter-spacing:.01em}
.ubd-empty{padding:18px 8px;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}

/* 失效视图：说清楚哪一项坏了，并给出「重试 / 切换 / 补令牌」 */
.ubd-fail{flex:1;min-height:0;overflow-y:auto;display:block;padding:26px 24px 30px}
.ubd-fail-inner{width:100%;max-width:460px;margin:0 auto;display:flex;flex-direction:column;align-items:center;
  gap:9px;text-align:center}
.ubd-fail-icon{width:40px;height:40px;border-radius:13px;display:grid;place-items:center;margin:2px 0 4px;
  color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}
.ubd-fail-title{font-size:15px;line-height:22px;font-weight:600;letter-spacing:.01em}
.ubd-fail-msg{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);
  word-break:break-word;max-width:100%}
.ubd-fail-hint{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);max-width:380px}
.ubd-fail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:5px}
.ubd-fail-details{align-self:stretch;margin-top:14px;padding-top:14px;display:flex;flex-direction:column;gap:7px;
  text-align:left;border-top:1px solid var(--dsw-alias-border-l1)}
.ubd-fail-details-title{font-size:9px;line-height:13px;color:var(--dsw-alias-label-tertiary);
  letter-spacing:.06em}
.ubd-fail-details .ubd-switch{align-self:flex-start;margin:1px 0 3px}
.ubd-prov{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:1px 8px;
  padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
.ubd-prov[data-selected="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1))}
.ubd-prov-name{font-size:11px;line-height:15px;font-weight:600;color:var(--dsw-alias-label-primary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-prov-current{flex:0 0 auto;font-size:8.5px;line-height:13px;padding:1px 6px;border-radius:999px;
  color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);
  align-self:center}
.ubd-prov-host{grid-column:1 / -1;font-size:9px;line-height:13px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-prov-pills{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.ubd-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
  font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent)}
.ubd-pill::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.75}
.ubd-pill[data-ok="true"]::before{background:var(--dsw-alias-state-success-primary);opacity:1}
.ubd-pill[data-ok="false"]::before{background:var(--dsw-alias-state-error-primary);opacity:1}
.ubd-pill[data-ok="true"]{color:var(--dsw-alias-state-success-primary)}
.ubd-pill[data-ok="false"]{color:var(--dsw-alias-state-error-primary)}
.ubd-action{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;
  font-family:inherit;font-size:10.5px;color:var(--dsw-alias-label-primary);cursor:pointer;
  transition:background .12s ease-out,border-color .12s ease-out}
.ubd-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ubd-action[data-primary="true"]{border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-1));
  background:var(--dsw-alias-brand-primary);font-weight:500}
.ubd-action[data-primary="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-label-secondary))}
.ubd-action:disabled{opacity:.55;cursor:default}
.ubd-token{display:flex;flex-direction:column;gap:6px}
.ubd-token-row{display:flex;gap:8px}
.ubd-input{flex:1 1 auto;min-width:0;height:28px;box-sizing:border-box;padding:0 9px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:11px}
.ubd-input:focus{outline:2px solid var(--dsw-alias-border-selected);outline-offset:-1px}
.ubd-token-hint{font-size:9.5px;line-height:13px;color:var(--dsw-alias-label-tertiary)}

@keyframes ubd-fade{from{opacity:0}to{opacity:1}}
@keyframes ubd-in{from{opacity:0;transform:translateY(6px) scale(.995)}to{opacity:1;transform:none}}
@keyframes ub-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
  .ub-card,.ubd-dialog,.ubd-mask,.ubd-bar-fill,.ubd-card-gauge-fill{animation:none;transition:none}
}
@media (max-width:720px){
  .ubd-root{padding:10px}
  .ubd-dialog{width:100%;max-height:calc(100dvh - 20px);border-radius:14px}
  .ubd-body{grid-template-columns:minmax(0,1fr)}
  .ubd-hero{grid-template-columns:minmax(0,1fr) auto;gap:14px}
  .ubd-spark{display:none}
}
`

    /** 样式只挂一次；卸载时移除，避免重载后叠加多份。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-usage-board="styles"]')
      if (existing !== null) return () => {}
      const style = document.createElement('style')
      style.setAttribute('data-usage-board', 'styles')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    /* ------------------------------------------------------------------ 图标 */

    function IconRefresh() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.6', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }),
        h('path', { d: 'M13 3.2V6h-2.8', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    }

    function IconClose() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }))
    }

    function IconBars() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 12V7M8 12V4M13 12V9', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }))
    }

    function IconAlert() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M8 2.6l5.6 10.2H2.4L8 2.6z', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
        h('path', { d: 'M8 6.6v3M8 11.3v.1', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' }))
    }

    /* ------------------------------------------------------------------ 格式化 */

    /** 金额：金额单位由快照的 `unit` 决定，不在客户端做汇率换算。 */
    function fmtMoney(value, unit) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '—'
      const symbol = unit === 'USD' ? '$' : '¥'
      const abs = Math.abs(num)
      if (unit === 'USD') {
        if (abs >= 100_000) return `${symbol}${(num / 1000).toFixed(0)}k`
        if (abs >= 10_000) return `${symbol}${(num / 1000).toFixed(1)}k`
        if (abs >= 1_000) return `${symbol}${Math.round(num).toLocaleString('en-US')}`
        if (abs >= 100) return `${symbol}${num.toFixed(1)}`
        return `${symbol}${num.toFixed(2)}`
      }
      if (abs >= 10_000) return `${symbol}${(num / 10_000).toFixed(2)}万`
      if (abs >= 1_000) return `${symbol}${Math.round(num).toLocaleString('zh-CN')}`
      if (abs >= 100) return `${symbol}${num.toFixed(1)}`
      return `${symbol}${num.toFixed(2)}`
    }

    function fmtTokens(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '0'
      if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`
      if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`
      if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`
      return String(Math.round(num))
    }

    function fmtCount(value) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '—'
      return Math.round(num).toLocaleString('zh-CN')
    }

    function fmtTps(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '—'
      return num >= 100 ? String(Math.round(num)) : num.toFixed(1)
    }

    function fmtMs(value) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) return '—'
      return num >= 1000 ? `${(num / 1000).toFixed(2)}s` : `${Math.round(num)}ms`
    }

    function fmtPct(value, digits = 0) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '—'
      return `${(num * 100).toFixed(digits)}%`
    }

    function fmtClock(ts) {
      const num = Number(ts)
      if (!Number.isFinite(num) || num <= 0) return '—'
      const date = new Date(num)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function codeText(t, code) {
      const key = CODE_KEYS[code]
      return key === undefined ? '' : t(key)
    }

    function isSetupCode(code) {
      return SETUP_CODES.includes(code)
    }

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

    const SSE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

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

    const INITIAL = {
      status: 'loading',
      data: null,
      failure: null,
      link: 'connecting',
    }

    /** 快照 → 视图状态。失败载荷不带旧数据，所以这里直接清空 data。 */
    function reducePayload(state, payload) {
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        return { ...state, status: 'ready', data: payload, failure: null }
      }
      // 路由级 403 只带 error:'forbidden'：这是进程令牌对不上，不是网关报错
      const forbidden = payload !== null && typeof payload === 'object'
        && payload.code === undefined && payload.error === 'forbidden'
      const failure = payload !== null && typeof payload === 'object'
        ? (forbidden ? { ...payload, code: 'token_mismatch' } : payload)
        : { code: 'network', error: '供应商未返回数据', needsSetup: false }
      return { ...state, status: 'error', data: null, failure }
    }

    function useSummary() {
      const [state, setState] = useState(INITIAL)
      const alive = useRef(true)

      const apply = useCallback((payload) => {
        if (!alive.current) return
        setState((previous) => reducePayload(previous, payload))
      }, [])

      const setLink = useCallback((link) => {
        if (!alive.current) return
        setState((previous) => (previous.link === link ? previous : { ...previous, link }))
      }, [])

      /** 用户点刷新：force=1 绕过宿主缓存；结果同时推给其他标签页。 */
      const refresh = useCallback(() => {
        const token = readToken()
        if (token === '') {
          setState({
            status: 'error',
            data: null,
            failure: { code: 'missing_credentials', error: '', needsSetup: true, plugin: true },
            link: 'off',
          })
          return Promise.resolve(null)
        }
        setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        return fetch(`${API}?force=1`, { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' })
          .then((response) => {
            if (response.status === 403) {
              if (alive.current) {
                setState((previous) => reducePayload(previous, {
                  ok: false,
                  code: 'token_mismatch',
                  error: '页面令牌与宿主进程不一致',
                  needsSetup: false,
                }))
              }
              return null
            }
            return response.json()
          })
          .then((payload) => {
            apply(payload)
            return payload
          })
          .catch((error) => {
            if (!alive.current) return null
            setState((previous) => reducePayload(previous, {
              ok: false,
              code: 'network',
              error: String(error && error.message ? error.message : error),
              needsSetup: false,
            }))
            return null
          })
      }, [apply])

      useEffect(() => {
        alive.current = true
        let stopped = false
        let controller = null
        let reconnectTimer = null
        let attempt = 0
        let generation = 0

        async function connect() {
          if (stopped) return
          const mine = ++generation
          const token = readToken()
          if (token === '') {
            setState({
              status: 'error',
              data: null,
              failure: { code: 'missing_credentials', error: '', needsSetup: true, plugin: true },
              link: 'off',
            })
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
            if (response.status === 403) {
              if (alive.current) {
                setState((previous) => reducePayload(previous, {
                  ok: false,
                  code: 'token_mismatch',
                  error: '页面令牌与宿主进程不一致',
                  needsSetup: false,
                }))
                setLink('off')
              }
              return
            }
            if (!response.ok) throw new Error(`SSE HTTP ${response.status}`)
            if (response.body === null || typeof response.body.getReader !== 'function') throw new Error('SSE 不可用')
            attempt = 0
            setLink('live')
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            const parser = createSseParser()
            for (;;) {
              const { value, done } = await reader.read()
              if (done || stopped || mine !== generation) break
              for (const event of parser.push(decoder.decode(value, { stream: true }))) {
                if (event.event !== 'summary') continue
                try {
                  apply(JSON.parse(event.data))
                } catch {
                  // 单帧坏 JSON 不掐断长连接，等下一帧覆盖
                }
              }
            }
            throw new Error('SSE closed')
          } catch (error) {
            if (stopped || mine !== generation) return
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return
            setLink(attempt === 0 ? 'connecting' : 'retrying')
            const delay = SSE_BACKOFF_MS[Math.min(attempt, SSE_BACKOFF_MS.length - 1)]
            attempt += 1
            reconnectTimer = window.setTimeout(() => {
              reconnectTimer = null
              connect()
            }, delay)
          }
        }

        const onVisible = () => {
          if (typeof document === 'undefined') return
          if (document.hidden) {
            generation += 1
            controller?.abort()
            controller = null
            if (reconnectTimer !== null) {
              window.clearTimeout(reconnectTimer)
              reconnectTimer = null
            }
            setLink('connecting')
            return
          }
          if (controller === null && reconnectTimer === null) connect()
        }

        connect()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          stopped = true
          generation += 1
          controller?.abort()
          if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [apply, setLink])

      return { ...state, refresh, apply }
    }

    /** 供应商清单：只用于切换控件与失效视图里的状态行。 */
    function useProviders(open) {
      const [state, setState] = useState({ status: 'idle', list: [] })
      const alive = useRef(true)

      const load = useCallback(() => {
        const token = readToken()
        if (token === '') return Promise.resolve()
        setState((previous) => ({ ...previous, status: 'loading' }))
        return fetch(SOURCE, { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive.current) return
            const list = payload !== null && Array.isArray(payload.providers) ? payload.providers : []
            setState({ status: 'ready', list })
          })
          .catch(() => {
            if (!alive.current) return
            setState({ status: 'error', list: [] })
          })
      }, [])

      useEffect(() => {
        alive.current = true
        if (open) load()
        return () => {
          alive.current = false
        }
      }, [open, load])

      return { ...state, load }
    }

    /** 切换：POST /source，返回的快照直接顶上来（SSE 之后还会推同一份）。 */
    function useSwitchProvider(onSnapshot) {
      const [pending, setPending] = useState(null)
      const [error, setError] = useState(null)

      const switchTo = useCallback((target, options = {}) => {
        const token = readToken()
        if (token === '') return Promise.resolve(null)
        const provider = typeof target === 'string' ? target : (target !== null && typeof target === 'object' ? target.id : '')
        if (provider === '') return Promise.resolve(null)
        setPending(provider)
        setError(null)
        const body = { provider }
        if (typeof options.accessToken === 'string' && options.accessToken !== '') body.accessToken = options.accessToken
        return fetch(SOURCE, {
          method: 'POST',
          headers: { [TOKEN_HEADER]: token, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null)
            if (!response.ok) {
              throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
            }
            if (payload !== null && payload.snapshot !== undefined) onSnapshot(payload.snapshot)
            return payload
          })
          .catch((failure) => {
            setError(String(failure && failure.message ? failure.message : failure))
            return null
          })
          .finally(() => setPending(null))
      }, [onSnapshot])

      return { pending, error, switchTo }
    }

    /* ------------------------------------------------------------------ 卡片 */

    function QuotaRing(props) {
      const ratio = Number(props.ratio)
      const size = 44
      const stroke = 3.5
      const radius = (size - stroke) / 2
      const circumference = 2 * Math.PI * radius
      const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
      return h('svg', { className: 'ubd-ring', width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
        h('circle', { className: 'ubd-ring-track', cx: size / 2, cy: size / 2, r: radius, fill: 'none', 'stroke-width': stroke }),
        h('circle', {
          className: 'ubd-ring-fill',
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          'stroke-width': stroke,
          'stroke-linecap': 'round',
          'stroke-dasharray': `${circumference * clamped} ${circumference}`,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        }),
        h('text', {
          className: 'ubd-ring-text',
          x: size / 2,
          y: size / 2 + 3,
          'text-anchor': 'middle',
        }, Number.isFinite(ratio) ? `${Math.round(clamped * 100)}%` : '—'))
    }

    function SparkArea(props) {
      const values = Array.isArray(props.values) ? props.values.map((value) => Number(value) || 0) : []
      if (values.length < 2) return null
      const width = 100
      const height = 20
      const max = Math.max(...values, 1)
      const step = width / (values.length - 1)
      const points = values.map((value, index) => [index * step, height - (value / max) * (height - 2) - 1])
      const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
      const area = `0,${height} ${line} ${width},${height}`
      return h('svg', {
        className: 'ub-card-area',
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': props.label ?? '',
      },
        h('defs', null,
          h('linearGradient', { id: 'ub-card-area-grad', x1: 0, y1: 0, x2: 0, y2: 1 },
            h('stop', { offset: '0%', style: { stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: 0.28 } }),
            h('stop', { offset: '100%', style: { stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: 0.02 } }))),
        h('polygon', { className: 'ub-card-area-fill', points: area }),
        h('polyline', { className: 'ub-card-area-line', points: line }))
    }

    function CardSkeleton(props) {
      return h('div', { className: 'ub-card-main' },
        h('span', { className: 'ub-card-label' }, props.t('today')),
        h('span', { className: 'ub-skel is-wide' }))
    }

    /**
     * 卡片失败态：只有两行，不把错误刷满整张卡。
     * 令牌失配（dsh-web 重启过）单独提示刷新，不写成「网络错误」。
     */
    function CardFailure(props) {
      const t = props.t
      const failure = props.failure ?? {}
      const plugin = failure.plugin === true
      const code = typeof failure.code === 'string' ? failure.code : 'network'
      const reload = plugin || code === 'token_mismatch'
      const name = failure.provider !== null && typeof failure.provider === 'object' ? failure.provider.name : ''
      const label = reload ? (plugin ? t('codeMissingCredentials') : t('codeTokenMismatch')) : codeText(t, code)
      // 卡片只说「坏在哪」，细节留给弹窗；这里不再塞长错误文本
      const detail = reload ? t('reloadPage') : t('openDetail')
      return h(React.Fragment, null,
        h('div', { className: 'ub-card-main' },
          h('span', { className: 'ub-card-label' }, name === '' ? t('today') : name),
          h('span', { className: 'ub-card-value ub-card-value-fail' }, t('failedShort'))),
        h('div', { className: 'ub-card-error' },
          h('span', { className: 'ub-card-error-msg' }, label || t('failedTitle')),
          h('span', { className: 'ub-card-error-hint' }, detail)))
    }

    function CardBody(props) {
      const t = props.t
      if (props.failure !== null) return h(CardFailure, { t, failure: props.failure })
      const data = props.data
      if (data === null || typeof data !== 'object') return h(CardSkeleton, { t })

      const unit = data.unit
      const caps = Array.isArray(data.caps) ? data.caps : []
      const hourly = caps.includes('hourly')
      const periods = Array.isArray(data.periods) ? data.periods : []
      const today = data.today ?? {}
      const account = data.account ?? {}
      const win = data.window ?? {}
      const last7 = periods.find((item) => item.key === 'last7d')
      const last30 = periods.find((item) => item.key === 'last30d')
      const successRate = hourly
        ? (Number.isFinite(Number(win.errorRate)) ? 1 - Number(win.errorRate) : null)
        : (Number.isFinite(Number(today.errorRate)) ? 1 - Number(today.errorRate) : null)
      const remaining = Number(account.remaining)
      const total = Number(account.total)
      const ratio = Number.isFinite(remaining) && Number.isFinite(total) && total > 0 ? remaining / total : null
      const level = ratio === null ? 'unknown' : ratio >= 0.5 ? 'high' : ratio >= 0.2 ? 'mid' : 'low'
      const providerName = data.provider !== null && typeof data.provider === 'object' ? data.provider.name : ''
      // 三列都短，300px 也不会挤；供应商名放右上角（成功率在统计行第三列）
      const stats = [
        hourly
          ? { label: t('hour24Short'), value: fmtMoney(win.cost, unit) }
          : { label: t('day7'), value: fmtMoney(last7?.cost, unit) },
        { label: t('balance'), value: fmtMoney(account.remaining, unit) },
        {
          label: t('successRate'),
          value: successRate === null ? '—' : fmtPct(successRate),
          tone: successRate !== null && successRate < 0.98 ? 'bad' : undefined,
        },
      ]

      return h(React.Fragment, null,
        h('div', { className: 'ub-card-main' },
          h('span', { className: 'ub-card-label' }, t('today')),
          h('span', { className: 'ub-card-value' }, fmtMoney(today.cost, unit)),
          hourly
            ? h(SparkArea, { values: (data.hours ?? []).map((item) => item.cost), label: t('hour24') })
            : h('span', { className: 'ub-card-right' }, `${t('day30')} ${fmtMoney(last30?.cost, unit)}`),
          providerName === ''
            ? null
            : h('span', { className: 'ub-card-provider', title: providerName }, providerName)),
        h('div', { className: 'ub-card-stats' },
          stats.map((item, index) => h('span', { className: 'ub-card-stat', key: `${item.label}-${index}` },
            h('span', { className: 'ub-card-stat-label' }, item.label),
            h('span', { className: 'ub-card-stat-value', 'data-tone': item.tone }, item.value)))),
        ratio === null ? null : h('span', { className: 'ub-card-gauge', 'data-level': level },
          h('span', { className: 'ub-card-gauge-fill', style: { width: `${Math.max(0, Math.min(100, ratio * 100))}%` } })))
    }

    /* ------------------------------------------------------------------ 弹窗区块 */

    function Panel(props) {
      return h('section', { className: 'ubd-panel' }, props.children)
    }

    function PanelHead(props) {
      return h('div', { className: 'ubd-panel-head' },
        h('span', { className: 'ubd-panel-title' }, props.title),
        props.meta === undefined || props.meta === '' ? null : h('span', { className: 'ubd-panel-meta' }, props.meta))
    }

    /** 近 24 小时：柱高按金额，悬停给金额 / 请求数。 */
    function HourBars(props) {
      const hours = Array.isArray(props.hours) ? props.hours : []
      const unit = props.unit
      if (hours.length === 0) return h('div', { className: 'ubd-empty' }, props.t('empty'))
      let max = 0
      let total = 0
      let requests = 0
      for (const item of hours) {
        const cost = Number(item.cost) || 0
        max = Math.max(max, cost)
        total += cost
        requests += Number(item.requests) || 0
      }
      return h(React.Fragment, null,
        h(PanelHead, {
          title: props.t('hour24'),
          meta: `${fmtMoney(total, unit)} · ${fmtCount(requests)} ${props.t('requests')}`,
        }),
        h('div', { className: 'ubd-bars' }, hours.map((item, index) => {
          const value = Number(item.cost) || 0
          const height = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0
          return h('div', {
            className: 'ubd-bar',
            key: item.at ?? index,
            'data-now': index === hours.length - 1 ? 'true' : undefined,
          },
            h('div', { className: 'ubd-bar-fill', style: { height: `${height}%` } }),
            h('span', { className: 'ubd-bar-tip' },
              `${item.label}:00 · ${fmtMoney(value, unit)} · ${fmtCount(item.requests)} ${props.t('requests')}`))
        })),
        h('div', { className: 'ubd-axis' },
          h('span', null, hours[0] ? `${hours[0].label}:00` : ''),
          h('span', null, hours[12] ? `${hours[12].label}:00` : ''),
          h('span', null, hours[hours.length - 1] ? `${hours[hours.length - 1].label}:00` : '')))
    }

    /** 7 天柱状（hero 内的紧凑版）。 */
    function WeekSpark(props) {
      const days = Array.isArray(props.days) ? props.days : []
      const unit = props.unit
      if (days.length === 0) return null
      let peak = 0
      let total = 0
      for (const day of days) {
        peak = Math.max(peak, Number(day.cost) || 0)
        total += Number(day.cost) || 0
      }
      return h('div', { className: 'ubd-spark' },
        h('div', { className: 'ubd-spark-head' },
          h('span', { className: 'ubd-spark-title' }, props.t('day7')),
          h('span', { className: 'ubd-spark-total' }, fmtMoney(total, unit))),
        h('div', { className: 'ubd-spark-bars' }, days.map((day, index) => h('div', {
          className: 'ubd-spark-col',
          key: day.date ?? index,
          title: `${day.label} · ${fmtMoney(day.cost, unit)}`,
        }, h('div', {
          className: 'ubd-spark-bar',
          style: { height: `${Math.max(3, Math.round(((Number(day.cost) || 0) / (peak || 1)) * 100))}%` },
        })))),
        h('div', { className: 'ubd-spark-axis' },
          h('span', null, days[0]?.label ?? ''),
          h('span', null, days[Math.floor(days.length / 2)]?.label ?? ''),
          h('span', null, days[days.length - 1]?.label ?? '')))
    }

    /** 7×24 热力：颜色只跟金额比，图例复用同一套 level。 */
    function Heatmap(props) {
      const heat = Array.isArray(props.heat) ? props.heat : []
      const unit = props.unit
      if (heat.length === 0) return null
      let max = 0
      for (const day of heat) for (const cell of day.cells) max = Math.max(max, Number(cell.cost) || 0)
      const level = (value) => {
        if (!(value > 0)) return 0
        const ratio = value / (max || 1)
        if (ratio > 0.7) return 4
        if (ratio > 0.4) return 3
        if (ratio > 0.15) return 2
        return 1
      }
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('heat'), meta: props.t('week') }),
        h('div', { className: 'ubd-heat' }, heat.map((day) =>
          h('div', { className: 'ubd-heat-row', key: day.date },
            h('span', { className: 'ubd-heat-day' }, day.label),
            day.cells.map((cell) => h('span', {
              key: `${day.date}-${cell.hour}`,
              className: 'ubd-heat-cell',
              'data-level': String(level(Number(cell.cost) || 0)),
              title: `${day.date} ${String(cell.hour).padStart(2, '0')}:00 · ${fmtMoney(cell.cost, unit)} · ${fmtCount(cell.requests)}`,
            }))))),
        h('div', { className: 'ubd-heat-legend' },
          h('span', null, '0'),
          h('i', { 'data-level': '1' }), h('i', { 'data-level': '2' }),
          h('i', { 'data-level': '3' }), h('i', { 'data-level': '4' }),
          h('span', null, fmtMoney(max, unit))))
    }

    function Models(props) {
      const models = Array.isArray(props.models) ? props.models : []
      const unit = props.unit
      if (models.length === 0) return null
      let total = 0
      for (const item of models) total += Number(item.cost) || 0
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('models'), meta: `${props.meta ?? props.t('week')} · ${fmtMoney(total, unit)}` }),
        h('div', { className: 'ubd-models' }, models.slice(0, 8).map((item, index) =>
          h('div', {
            className: 'ubd-model',
            key: `${item.model || 'unknown'}-${index}`,
            title: `${item.model || '—'} · ${fmtCount(item.requests)} ${props.t('requests')} · ${fmtMoney(item.cost, unit)}`,
          },
            h('span', { className: 'ubd-model-name' }, item.model || '—'),
            h('span', { className: 'ubd-model-req' }, `${fmtCount(item.requests)} ${props.t('requests')}`),
            h('span', { className: 'ubd-model-cost' }, fmtMoney(item.cost, unit))))))
    }

    function Recent(props) {
      const list = Array.isArray(props.recent) ? props.recent : []
      const unit = props.unit
      if (list.length === 0) return null
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('recent'), meta: fmtTokens(props.tokens) }),
        h('div', { className: 'ubd-recent' }, list.slice(0, 8).map((row, index) =>
          h('div', {
            className: 'ubd-req',
            key: row.id ?? `${row.t}-${index}`,
            'data-error': row.ok === false ? 'true' : undefined,
            title: `${row.model || '—'} · ${fmtMoney(row.cost, unit)} · ${fmtMs(row.totalMs)} · ${props.t('ttft')} ${fmtMs(row.ttftMs)}`,
          },
            h('span', { className: 'ubd-req-time' }, row.timeLabel || ''),
            h('span', { className: 'ubd-req-model' }, `${row.model || '—'}${row.stream ? ' ⚡' : ''}`),
            h('span', { className: 'ubd-req-meta' },
              row.ok === false
                ? props.t('errorRate')
                : (row.tps === null || row.tps === undefined ? fmtMs(row.totalMs) : `${fmtTps(row.tps)} t/s`)),
            h('span', { className: 'ubd-req-cost' }, fmtMoney(row.cost, unit))))))
    }

    /** 周期对比：只有「今日 / 7 天 / 30 天」汇总的供应商用这个区块。 */
    function PeriodRows(props) {
      const periods = Array.isArray(props.periods) ? props.periods : []
      const unit = props.unit
      if (periods.length === 0) return null
      let max = 0
      for (const item of periods) max = Math.max(max, Number(item.cost) || 0)
      const widest = periods[periods.length - 1]
      return h(React.Fragment, null,
        h(PanelHead, {
          title: props.t('periods'),
          meta: widest?.to ?? '',
        }),
        h('div', { className: 'ubd-periods' }, periods.map((item) => h('div', {
          className: 'ubd-period',
          key: item.key,
          'data-now': item.key === 'today' ? 'true' : undefined,
        },
          h('span', { className: 'ubd-period-label' }, item.label),
          h('span', { className: 'ubd-period-bar' },
            h('span', {
              className: 'ubd-period-fill',
              style: { width: `${max > 0 ? Math.max(2, Math.round(((Number(item.cost) || 0) / max) * 100)) : 0}%` },
            })),
          h('span', { className: 'ubd-period-value' }, fmtMoney(item.cost, unit))))),
        h('div', { className: 'ubd-period-meta' },
          h('span', null, `${props.t('requestsTotal')} ${fmtCount(widest?.requests)}`),
          h('span', null, `${fmtTokens(widest?.tokens)} tok`),
          h('span', null, `${props.t('errorRate')} ${fmtPct(widest?.errorRate, 1)}`)))
    }

    function Health(props) {
      return h('span', { className: 'ubd-health-item' },
        h('span', { className: 'ubd-health-label' }, props.label),
        h('span', { className: 'ubd-health-value', 'data-tone': props.tone }, props.value))
    }

    /* ------------------------------------------------------------------ 供应商切换 */

    /** 分段切换器：选中态由快照/失败载荷决定，点击直接切。 */
    function ProviderSwitch(props) {
      const list = Array.isArray(props.providers) ? props.providers : []
      const selected = props.selected
      if (list.length < 2) {
        return list.length === 1
          ? h('span', { className: 'ubd-switch' }, h('button', {
              className: 'ubd-switch-btn',
              type: 'button',
              'aria-pressed': 'true',
              disabled: true,
            }, list[0].name))
          : null
      }
      return h('div', { className: 'ubd-switch', role: 'group', 'aria-label': props.t('provider') },
        list.map((provider) => {
          const active = provider.id === selected
          const busy = props.pending === provider.id
          return h('button', {
            key: provider.id,
            type: 'button',
            className: 'ubd-switch-btn',
            'aria-pressed': active ? 'true' : 'false',
            // 选中项保持可点（点击是空操作），只有切换过程中整组禁用：
            // 用 disabled 表达「当前」会把它降到 .55 透明，反而比未选中的暗。
            disabled: props.pending !== null,
            title: `${provider.name} · ${provider.baseUrl}`,
            onClick: () => {
              if (active || props.pending !== null) return
              props.onSwitch(provider)
            },
          }, busy ? props.t('switching') : provider.name)
        }))
    }

    /* ------------------------------------------------------------------ 失效视图 */

    /**
     * 失效视图：居中一屏说清「哪里坏了 / 现在能做什么」。
     * 令牌失配与缺凭据都给出直接动作（刷新页面 / 补令牌 / 切换），不需要用户自己猜。
     */
    function FailureView(props) {
      const t = props.t
      const failure = props.failure ?? {}
      const plugin = failure.plugin === true
      const code = typeof failure.code === 'string' ? failure.code : 'network'
      const reload = plugin || code === 'token_mismatch'
      const setup = isSetupCode(code) && !plugin && !reload
      const selected = props.providers.find((item) => item.selected === true) ?? null
      const needsToken = selected !== null && selected.kind === 'newapi' && selected.credentials.token !== 'configured'
      const [token, setToken] = useState('')
      const [saving, setSaving] = useState(false)
      const [copied, setCopied] = useState(false)

      const saveToken = () => {
        if (selected === null || token.trim() === '' || saving) return
        setSaving(true)
        Promise.resolve(props.onSwitch(selected, { accessToken: token.trim() })).finally(() => {
          setSaving(false)
          setToken('')
        })
      }

      const copyError = () => {
        const text = typeof failure.error === 'string' ? failure.error : ''
        if (text === '' || typeof navigator === 'undefined' || navigator.clipboard === undefined) return
        navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {})
      }

      const title = reload
        ? (plugin ? t('tokenMissing') : t('codeTokenMismatch'))
        : t('failedTitle')
      const body = reload
        ? ''
        : (typeof failure.error === 'string' ? failure.error.trim() : '')
      const hint = reload
        ? t('reloadHint')
        : (setup ? t('failedHintSetup') : t('failedHintRetry'))

      return h('div', { className: 'ubd-fail' },
        h('div', { className: 'ubd-fail-inner' },
          h('span', { className: 'ubd-fail-icon' }, h(IconAlert)),
          h('div', { className: 'ubd-fail-title' }, title),
          reload || plugin ? null : h('span', { className: 'ubd-pill', 'data-ok': 'false' }, codeText(t, code) || code),
          body === '' ? null : h('div', { className: 'ubd-fail-msg' }, body),
          h('div', { className: 'ubd-fail-hint' }, hint),

          h('div', { className: 'ubd-fail-actions' },
            h('button', {
              className: 'ubd-action',
              type: 'button',
              'data-primary': reload ? 'false' : 'true',
              disabled: props.pending !== null,
              onClick: () => props.onRetry(),
            }, t('retry')),
            reload
              ? h('button', {
                  className: 'ubd-action',
                  type: 'button',
                  'data-primary': 'true',
                  onClick: () => {
                    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') window.location.reload()
                  },
                }, t('reloadPage'))
              : null,
            body === '' ? null : h('button', {
              className: 'ubd-action',
              type: 'button',
              onClick: copyError,
            }, copied ? t('copied') : t('copyError'))),

          props.switchError === null || props.switchError === undefined
            ? null
            : h('div', { className: 'ubd-fail-hint' }, props.switchError),

          props.providers.length === 0
            ? null
            : h('div', { className: 'ubd-fail-details' },
                h('div', { className: 'ubd-fail-details-title' }, t('detailsTitle')),
                props.providers.map((provider) => h('div', {
                  className: 'ubd-prov',
                  key: provider.id,
                  'data-selected': provider.selected === true ? 'true' : undefined,
                },
                  h('span', { className: 'ubd-prov-name' }, provider.name),
                  provider.selected === true
                    ? h('span', { className: 'ubd-prov-current' }, t('current'))
                    : h('span', null),
                  h('span', { className: 'ubd-prov-host' }, provider.baseUrl.replace(/^https?:\/\//, '')),
                  h('span', { className: 'ubd-prov-pills' },
                    h('span', { className: 'ubd-pill', 'data-ok': String(provider.credentials.key === 'configured') },
                      `${t('keyStatus')} ${provider.credentials.key === 'configured' ? t('configured') : t('missing')}`),
                    provider.credentials.token === 'not_required'
                      ? h('span', { className: 'ubd-pill' }, `${t('tokenStatus')} ${t('notRequired')}`)
                      : h('span', { className: 'ubd-pill', 'data-ok': String(provider.credentials.token === 'configured') },
                          `${t('tokenStatus')} ${provider.credentials.token === 'configured' ? (provider.credentials.tokenTail ?? t('configured')) : t('missing')}`))))),

          needsToken
            ? h('div', { className: 'ubd-fail-details' },
                h('div', { className: 'ubd-fail-details-title' }, t('tokenTitle')),
                h('div', { className: 'ubd-token' },
                  h('div', { className: 'ubd-token-row' },
                    h('input', {
                      className: 'ubd-input',
                      type: 'password',
                      value: token,
                      placeholder: t('tokenPlaceholder'),
                      onChange: (event) => setToken(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') saveToken()
                      },
                    }),
                    h('button', {
                      className: 'ubd-action',
                      type: 'button',
                      'data-primary': 'true',
                      disabled: token.trim() === '' || saving,
                      onClick: saveToken,
                    }, saving ? t('tokenSaving') : t('tokenSave'))),
                  h('div', { className: 'ubd-token-hint' }, t('tokenHint'))))
            : null))
    }

    /* ------------------------------------------------------------------ 弹窗内容 */

    function DialogContent(props) {
      const t = props.t
      const data = props.data
      const unit = data?.unit ?? 'CNY'
      const caps = Array.isArray(data?.caps) ? data.caps : []
      const hourly = caps.includes('hourly')
      const daily = caps.includes('daily')
      const heatmap = caps.includes('heatmap')
      const models = caps.includes('models')
      const recent = caps.includes('recent')
      const throughput = caps.includes('throughput')
      const periods = caps.includes('periods')

      const today = data?.today ?? {}
      const win = data?.window ?? {}
      const account = data?.account ?? {}
      const remaining = Number(account.remaining)
      const total = Number(account.total)
      const ratio = Number.isFinite(remaining) && Number.isFinite(total) && total > 0 ? remaining / total : null
      const successRate = hourly
        ? (Number.isFinite(Number(win.errorRate)) ? 1 - Number(win.errorRate) : null)
        : (Number.isFinite(Number(today.errorRate)) ? 1 - Number(today.errorRate) : null)

      const healthItems = throughput
        ? [
            { label: t('errorRate'), value: fmtPct(win.errorRate, 2), tone: Number(win.errors) > 0 ? 'bad' : undefined },
            { label: 'p50', value: `${fmtTps(win.tpsP50)} t/s` },
            { label: t('ttft'), value: fmtMs(win.ttftMs) },
            { label: t('throughput'), value: `${fmtTps(win.tps)} t/s` },
            { label: t('requestsTotal'), value: fmtCount(win.requests) },
          ]
        : [
            { label: t('successRate'), value: fmtPct(successRate, 1) },
            { label: t('requestsTotal'), value: fmtCount(today.requests) },
            { label: t('tokens'), value: fmtTokens(today.tokens) },
          ]

      const leftPanels = []
      if (hourly) leftPanels.push(h(Panel, { key: 'hours' }, h(HourBars, { hours: data.hours, unit, t })))
      if (periods) leftPanels.push(h(Panel, { key: 'periods' }, h(PeriodRows, { periods: data.periods, unit, t })))
      if (recent) leftPanels.push(h(Panel, { key: 'recent' },
        h(Recent, { recent: data.recent, unit, tokens: win.tokens, t })))

      const rightPanels = []
      if (models) {
        rightPanels.push(h(Panel, { key: 'models' },
          h(Models, { models: data.models, unit, t, meta: periods ? t('day30') : t('week') })))
      }
      if (heatmap) rightPanels.push(h(Panel, { key: 'heat' }, h(Heatmap, { heat: data.heat, unit, t })))

      const columns = rightPanels.length === 0 ? 1 : 2

      return h(React.Fragment, null,
        h('div', { className: 'ubd-hero' },
          h('div', { className: 'ubd-hero-main' },
            h('div', { className: 'ubd-hero-label' }, t('today')),
            h('div', { className: 'ubd-hero-value' }, fmtMoney(today.cost, unit)),
            h('div', { className: 'ubd-hero-sub' },
              `${fmtCount(today.requests)} ${t('requests')} · ${fmtTokens(today.tokens)} tok`)),
          daily ? h(WeekSpark, { days: data.days, unit, t }) : null,
          h('div', { className: 'ubd-hero-side' },
            h(QuotaRing, { ratio }),
            h('div', { className: 'ubd-hero-side-text' },
              h('span', { className: 'ubd-hero-side-label' }, t('balance')),
              h('span', { className: 'ubd-hero-side-value' }, fmtMoney(account.remaining, unit)),
              h('span', { className: 'ubd-hero-side-sub' },
                `${t('cumulative')} ${fmtMoney(account.used, unit)}`)))),
        h('div', { className: 'ubd-health' },
          healthItems.map((item, index) => h(Health, { key: `${item.label}-${index}`, label: item.label, value: item.value, tone: item.tone }))),
        h('div', { className: 'ubd-body', 'data-cols': String(columns) },
          h('div', { className: 'ubd-col' }, leftPanels),
          rightPanels.length === 0 ? null : h('div', { className: 'ubd-col' }, rightPanels)))
    }

    /* ------------------------------------------------------------------ 弹窗外壳 */

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
          if (event.shiftKey && (active === first || active === node)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          const previous = restoreRef.current
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [open, onClose, dialogRef])
    }

    function Dialog(props) {
      const dialogRef = useRef(null)
      useDialogBehavior(dialogRef, props.open, props.onClose)
      if (!props.open) return null

      const t = props.t
      const failure = props.data === null ? props.failure : null
      const selected = props.data !== null && props.data.provider !== null && typeof props.data.provider === 'object'
        ? props.data.provider.id
        : (failure !== null && failure.provider !== null && typeof failure.provider === 'object' ? failure.provider.id : null)
      const providers = props.providers
      const providerName = props.data !== null && typeof props.data.provider === 'object' ? props.data.provider.name : ''
      const site = props.data !== null && props.data.site !== null && typeof props.data.site === 'object'
        ? String(props.data.site.baseUrl).replace(/^https?:\/\//, '')
        : (providers.find((item) => item.id === selected)?.baseUrl ?? '').replace(/^https?:\/\//, '')
      const notes = props.data !== null && Array.isArray(props.data.notes) ? props.data.notes.filter(Boolean).join(' · ') : ''
      const linkLabel = props.link === 'live'
        ? t('live')
        : (props.link === 'off' ? t('disconnected') : (props.link === 'retrying' ? t('reconnecting') : t('connecting')))

      const node = h('div', { className: 'ubd-root' },
        h('div', { className: 'ubd-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          ref: dialogRef,
          className: 'ubd-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('title'),
          'data-shortcut-modal': 'usage-board',
          tabIndex: -1,
        },
          h('header', { className: 'ubd-head' },
            h('h2', { className: 'ubd-title' }, t('title')),
            h('div', { className: 'ubd-head-main' },
              h('span', { className: 'ubd-sub' },
                site === '' ? '' : `${site} · `,
                props.data !== null ? `${t('updated')} ${fmtClock(props.data.generatedAt)} · ` : '',
                h('span', { className: 'ubd-live', 'data-live': props.link, title: t('liveHint') }, linkLabel))),
            h(ProviderSwitch, {
              providers,
              selected,
              pending: props.pending,
              onSwitch: props.onSwitch,
              t,
            }),
            h('div', { className: 'ubd-head-actions' },
              h('button', {
                className: 'ubd-btn',
                type: 'button',
                title: t('refresh'),
                'aria-label': t('refresh'),
                'data-spin': props.status === 'refreshing' ? 'true' : 'false',
                onClick: props.refresh,
              }, h(IconRefresh)),
              h('button', {
                className: 'ubd-btn',
                type: 'button',
                title: t('close'),
                'aria-label': t('close'),
                'data-modal-autofocus': '',
                onClick: props.onClose,
              }, h(IconClose)))),
          props.data === null
            ? h(FailureView, {
                failure: props.failure,
                providers,
                selected,
                pending: props.pending,
                switchError: props.switchError,
                onSwitch: props.onSwitch,
                onRetry: props.refresh,
                t,
              })
            : h(DialogContent, { data: props.data, t }),
          props.data === null || notes === '' ? null : h('footer', { className: 'ubd-foot' }, notes)),
      )
      if (createPortal === null || typeof document === 'undefined') return node
      return createPortal(node, document.body)
    }

    /* ------------------------------------------------------------------ 入口 */

    function UsageCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const wide = props.wide !== false
      const [open, setOpen] = useState(false)
      const summary = useSummary()
      const providers = useProviders(open || summary.data === null)
      // 切换成功后宿主回一份完整快照，直接顶到本地状态（SSE 随后还会推同一份）。
      const { pending, error: switchError, switchTo } = useSwitchProvider(summary.apply)
      const openDialog = useCallback(() => setOpen(true), [])
      const closeDialog = useCallback(() => setOpen(false), [])

      const trigger = wide
        ? h('div', {
            className: 'ub-card',
            role: 'button',
            tabIndex: 0,
            'data-live': summary.link,
            'data-error': summary.failure !== null ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': t('open'),
            title: t('open'),
            onClick: openDialog,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openDialog()
              }
            },
          }, h(CardBody, {
            data: summary.data,
            failure: summary.failure,
            status: summary.status,
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
          data: summary.data,
          failure: summary.failure,
          status: summary.status,
          link: summary.link,
          providers: providers.list,
          pending,
          switchError,
          refresh: summary.refresh,
          onSwitch: switchTo,
          t,
        }))
    }

    return {
      inject: ['slots', 'locale'],
      testing: {
        Card: UsageCard,
        CardBody,
        CardFailure,
        Dialog,
        DialogContent,
        FailureView,
        ProviderSwitch,
        PeriodRows,
        HourBars,
        Heatmap,
        Models,
        Recent,
        WeekSpark,
        QuotaRing,
        SparkArea,
        reducePayload,
        isSetupCode,
        codeText,
        errorText,
        copy: { zh: ZH, en: EN },
        formatters: { fmtMoney, fmtTokens, fmtCount, fmtTps, fmtMs, fmtPct },
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
