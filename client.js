window.__ModuleLoader__.load({
  id: 'dsh-usage-board',
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
    const TOKEN_GLOBAL = '__DSH_USAGE_BOARD__'
    const TOKEN_HEADER = 'x-usage-board'

    /* ------------------------------------------------------------------ 文案 */

    const ZH = {
      open: '打开用量看板',
      today: '今日用量',
      total: '总用量',
      errorRate: '出错率',
      throughput: '吞吐',
      ttft: '首字',
      since: '额度累计',
      cumulative: '累计',
      balance: '余额',
      hour24: '近 24 小时',
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
      title: '用量看板',
      hint: '点卡片查看详情',
      footnote: '网关只提供最近 1000 条明细；非流式请求不计入吞吐',
      updated: '更新于',
    }

    const EN = {
      open: 'Open usage board',
      today: 'Today',
      total: 'Total',
      errorRate: 'Errors',
      throughput: 'Throughput',
      ttft: 'TTFT',
      since: 'Lifetime quota',
      cumulative: 'Total',
      balance: 'Balance',
      hour24: 'Last 24 hours',
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
      title: 'Usage Board',
      hint: 'Click for details',
      footnote: 'The gateway exposes only the latest 1000 rows; non-stream requests are excluded from throughput',
      updated: 'Updated',
    }

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.ub-card{
  box-sizing:border-box;width:100%;max-width:100%;height:84px;overflow:hidden;
  display:flex;flex-direction:column;
  padding:9px 11px 8px;margin:0 0 8px;
  border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);
  box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-bg-mask-1) 30%,transparent);
  color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family,inherited);
  text-align:left;cursor:pointer;
  transition:border-color .14s ease-out,box-shadow .14s ease-out;
}
.ub-card:hover{border-color:var(--dsw-alias-border-l3);
  box-shadow:0 2px 6px color-mix(in srgb,var(--dsw-alias-bg-mask-1) 34%,transparent)}
.ub-card:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:2px}
.ub-card[data-error="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2))}
.ub-card-head{display:flex;align-items:center;gap:6px;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ub-card-head .ub-label{flex:0 0 auto}
.ub-card-head .ub-rate{margin-left:auto;display:inline-flex;align-items:center;gap:4px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ub-card[data-error="true"] .ub-rate{color:var(--dsw-alias-state-error-primary)}
.ub-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.ub-card[data-error="true"] .ub-dot{background:var(--dsw-alias-state-error-primary)}
.ub-card-main{display:flex;align-items:baseline;gap:8px;margin-top:1px;min-width:0}
.ub-card-value{font-size:19px;line-height:23px;font-weight:600;letter-spacing:-.01em;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ub-card-tokens{margin-left:auto;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ub-card-foot{display:flex;align-items:center;gap:10px;margin-top:auto;font-size:10.5px;line-height:15px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ub-card-foot .ub-foot-right{margin-left:auto;color:var(--dsw-alias-label-secondary)}
.ub-skel{height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 22%,transparent)}
.ub-skel.is-wide{width:72%}
.ub-rail{box-sizing:border-box;width:36px;height:36px;margin:0 0 8px;padding:0;
  display:grid;place-items:center;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer}
.ub-rail:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.ubd-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.ubd-mask{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-mask-2) 74%,transparent);
  animation:ubd-fade .12s ease-out}
.ubd-dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;
  width:min(800px,100%);max-height:min(720px,calc(100dvh - 48px));overflow:hidden;
  border-radius:16px;border:1px solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 24px 64px -32px color-mix(in srgb,var(--dsw-alias-bg-mask-1) 90%,transparent);
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherited);
  animation:ubd-in .16s cubic-bezier(.2,.8,.2,1)}
.ubd-dialog:focus{outline:none}
.ubd-head{display:flex;align-items:center;gap:10px;padding:16px 14px 12px 20px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-title{margin:0;font-size:15px;line-height:20px;font-weight:600}
.ubd-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-head-actions{margin-left:auto;display:flex;align-items:center;gap:4px}
.ubd-btn{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:background .12s ease-out,color .12s ease-out}
.ubd-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ubd-btn[data-spin="true"] svg{animation:ub-spin .2s linear}
.ubd-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ubd-kpi{padding:14px 16px;display:flex;flex-direction:column;gap:2px;min-width:0}
.ubd-kpi+.ubd-kpi{border-left:1px solid var(--dsw-alias-border-l1)}
.ubd-kpi-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ubd-kpi-value{font-size:19px;line-height:24px;font-weight:600;letter-spacing:-.01em;
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-kpi-value[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}
.ubd-kpi-value[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.ubd-kpi-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding:10px 18px 12px;display:grid;grid-template-columns:minmax(0,1fr) 262px;gap:14px}
.ubd-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.ubd-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px 9px;min-width:0}
.ubd-panel-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.ubd-panel-title{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary);
  letter-spacing:.02em}
.ubd-panel-meta{margin-left:auto;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-bars{display:flex;align-items:flex-end;gap:2px;height:78px;padding-top:2px}
.ubd-bar{position:relative;flex:1;min-width:0;height:100%;display:flex;align-items:flex-end}
.ubd-bar-fill{width:100%;min-height:2px;border-radius:3px 3px 0 0;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 34%,transparent);
  transition:height .18s cubic-bezier(.2,.7,0,1),background .12s ease-out}
.ubd-bar[data-now="true"] .ubd-bar-fill{background:var(--dsw-alias-brand-primary)}
.ubd-bar:hover .ubd-bar-fill{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,transparent)}
.ubd-bar-tip{position:absolute;left:50%;bottom:calc(100% + 4px);transform:translateX(-50%);
  padding:3px 6px;border-radius:6px;font-size:10px;line-height:14px;white-space:nowrap;
  pointer-events:none;opacity:0;z-index:2;
  color:var(--dsw-alias-tooltip-label);background:var(--dsw-alias-tooltip-bg);
  transition:opacity .12s ease-out}
.ubd-bar:hover .ubd-bar-tip{opacity:1}
.ubd-axis{display:flex;justify-content:space-between;margin-top:6px;font-size:10px;line-height:14px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ubd-week{display:flex;flex-direction:column;gap:6px}
.ubd-week-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:8px;
  font-size:10.5px;line-height:17px}
.ubd-week-day{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ubd-track{height:6px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);
  overflow:hidden}
.ubd-track-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);
  transition:width .18s cubic-bezier(.2,.7,0,1)}
.ubd-week-val{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-heat{display:flex;flex-direction:column;gap:3px}
.ubd-heat-row{display:grid;grid-template-columns:26px repeat(24,minmax(0,1fr));gap:3px;align-items:center}
.ubd-heat-day{font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ubd-heat-cell{height:7px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 9%,transparent)}
.ubd-heat-cell[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.ubd-heat-cell[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.ubd-heat-cell[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 56%,transparent)}
.ubd-heat-cell[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,transparent)}
.ubd-heat-legend{display:flex;align-items:center;gap:4px;margin-top:8px;font-size:10px;line-height:14px;
  color:var(--dsw-alias-label-tertiary)}
.ubd-heat-legend i{display:block;width:10px;height:8px;border-radius:2px;
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 9%,transparent)}
.ubd-heat-legend i[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.ubd-heat-legend i[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.ubd-heat-legend i[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 56%,transparent)}
.ubd-heat-legend i[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,transparent)}
.ubd-models{display:flex;flex-direction:column;gap:2px}
.ubd-model{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:baseline;gap:8px;
  padding:4px 6px;margin:0 -6px;border-radius:6px;font-size:11px;line-height:16px}
.ubd-model:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ubd-model-name{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-model-req{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-model-cny{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;
  min-width:56px;text-align:right}
.ubd-recent{display:flex;flex-direction:column;gap:1px;margin:0 -6px;padding:0 6px}
.ubd-req{display:flex;flex-direction:column;gap:1px;padding:4px 6px;border-radius:6px;
  font-size:11px;line-height:16px;transition:background .12s ease-out;min-width:0}
.ubd-req:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ubd-req[data-error="true"]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary)}
.ubd-req-line{display:flex;align-items:center;gap:5px;min-width:0}
.ubd-req-sub{font-size:9.5px;line-height:13px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ubd-pill{padding:1px 5px;border-radius:5px;font-size:10px;font-weight:600;
  font-variant-numeric:tabular-nums;white-space:nowrap;
  color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.ubd-pill[data-dim="true"]{color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent)}
.ubd-flow{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-req-time{margin-left:auto;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ubd-foot{padding:10px 20px 12px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.ubd-empty{padding:16px 8px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ubd-error{display:flex;flex-direction:column;gap:8px;padding:4px 0}
.ubd-error-title{font-size:12px;line-height:16px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.ubd-error-body{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ubd-retry{align-self:flex-start;padding:4px 10px;border-radius:8px;font:inherit;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.ubd-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}
@keyframes ubd-fade{from{opacity:0}}
@keyframes ubd-in{from{opacity:0;transform:scale(.985)}}
@keyframes ub-spin{to{transform:rotate(360deg)}}
@media (max-width:720px),(pointer:coarse) and (max-width:1024px){
  .ubd-root{padding:0;align-items:stretch}
  .ubd-dialog{width:100%;height:100dvh;max-height:100dvh;border-radius:0;border:0;
    padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
  .ubd-body{grid-template-columns:minmax(0,1fr);padding:14px 16px 18px}
  .ubd-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ubd-kpi:nth-child(3){border-left:0}
  .ubd-kpi:nth-child(n+3){border-top:1px solid var(--dsw-alias-border-l1)}
}
@media (prefers-reduced-motion:reduce){
  .ub-card,.ubd-bar-fill,.ubd-track-fill,.ubd-req{transition:none}
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

    /* ------------------------------------------------------------------ 取数 */

    function readToken() {
      if (typeof window === 'undefined') return ''
      const value = window[TOKEN_GLOBAL]
      return typeof value === 'string' ? value : ''
    }

    function useSummary() {
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const alive = useRef(true)

      const load = useCallback((force) => {
        const token = readToken()
        if (token === '') {
          setState({ status: 'error', data: null, error: '插件未注入访问令牌（请重启 dsh web）' })
          return Promise.resolve()
        }
        setState((previous) => ({ status: previous.data === null ? 'loading' : 'refreshing', data: previous.data, error: null }))
        const url = force ? `${API}?force=1` : API
        return fetch(url, { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive.current) return
            if (payload === null || payload.ok !== true) {
              setState({ status: 'error', data: null, error: (payload && payload.error) || '网关返回异常' })
              return
            }
            setState({ status: 'ready', data: payload, error: payload.staleError || null })
          })
          .catch((error) => {
            if (!alive.current) return
            setState((previous) => ({
              status: previous.data === null ? 'error' : 'ready',
              data: previous.data,
              error: String(error && error.message ? error.message : error),
            }))
          })
      }, [])

      useEffect(() => {
        alive.current = true
        load(false)
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          load(false)
        }, 60_000)
        return () => {
          alive.current = false
          window.clearInterval(timer)
        }
      }, [load])

      return { ...state, refresh: () => load(true) }
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

    function Panel(props) {
      return h('section', { className: 'ubd-panel' }, props.children)
    }

    function PanelHead(props) {
      return h('div', { className: 'ubd-panel-head' },
        h('span', { className: 'ubd-panel-title' }, props.title),
        props.meta !== undefined ? h('span', { className: 'ubd-panel-meta' }, props.meta) : null)
    }

    function Kpi(props) {
      return h('div', { className: 'ubd-kpi' },
        h('div', { className: 'ubd-kpi-label' }, props.label),
        h('div', { className: 'ubd-kpi-value', 'data-tone': props.tone }, props.value),
        h('div', { className: 'ubd-kpi-sub' }, props.sub))
    }

    /* ------------------------------------------------------------------ 卡片 */

    function CardSkeleton(props) {
      return h(React.Fragment, null,
        h('div', { className: 'ub-card-head' },
          h('span', { className: 'ub-label' }, props.t('today')),
          h('span', { className: 'ub-rate' }, h('span', { className: 'ub-dot' }), '—')),
        h('div', { className: 'ub-card-main' },
          h('div', { className: 'ub-skel is-wide', style: { height: 16, marginTop: 2 } })),
        h('div', { className: 'ub-card-foot' },
          h('span', null, '—'),
          h('span', { className: 'ub-foot-right' }, '—')))
    }

    function CardError(props) {
      return h(React.Fragment, null,
        h('div', { className: 'ub-card-head' },
          h('span', { className: 'ub-label' }, props.t('errorTitle')),
          h('span', { className: 'ub-rate' }, '—')),
        h('div', { className: 'ub-card-main' },
          h('span', { className: 'ub-card-value', style: { fontSize: 13, lineHeight: '20px', fontWeight: 500 } }, props.message)),
        h('div', { className: 'ub-card-foot' },
          h('span', null, props.t('retry'))))
    }

    function CardBody(props) {
      const t = props.t
      const data = props.data
      if (props.status === 'error' && data === null) {
        return h(CardError, { t, message: props.error || '—' })
      }
      if (data === null) return h(CardSkeleton, { t })
      const today = data.today || {}
      const win = data.window || {}
      const short = data.short || {}
      const account = data.account || {}
      const tokensIn = Number(today.tokensIn) || 0
      const tokensOut = Number(today.tokensOut) || 0
      const coverage = today.coverage && Number(today.coverage.hours) > 0 ? Number(today.coverage.hours) : 0
      // 日志接口只给最近 1000 条；覆盖不足一天时不能标成「今日」
      const label = today.exact === true
        ? t('today')
        : (coverage > 0 ? `近 ${coverage < 1 ? coverage.toFixed(1) : Math.round(coverage)}h` : t('today'))
      const bound = today.exact === true ? '' : '≥'
      const used = Number(account.usedCny) || 0
      const balance = Number(account.quotaCny) || 0
      const hint = [
        `${label} ${bound}${fmtCny(today.cny)}`,
        `近 24h ${fmtCny(win.cny)}`,
        `${today.requests} 次请求`,
        `${t('cumulative')} ${fmtCny(used)}`,
        `${t('balance')} ${fmtCny(balance)}`,
      ].join(' · ')
      return h(React.Fragment, null,
        h('div', { className: 'ub-card-head' },
          h('span', { className: 'ub-label' }, label),
          h('span', { className: 'ub-rate' }, h('span', { className: 'ub-dot' }), fmtPct(win.errorRate))),
        h('div', { className: 'ub-card-main', title: hint },
          h('span', { className: 'ub-card-value' }, `${bound}${fmtCny(today.cny)}`),
          h('span', { className: 'ub-card-tokens' }, `${t('cumulative')} ${fmtCny(used)}`)),
        h('div', { className: 'ub-card-foot' },
          h('span', null, `${fmtTps(short.tps)} t/s`),
          h('span', null, `${fmtMs(short.ttftMs)} ${t('ttft')}`),
          h('span', { className: 'ub-foot-right' }, `${t('balance')} ${fmtCny(balance)}`)))
    }

    /* ------------------------------------------------------------------ 弹窗 */

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
            h('div', { className: 'ubd-bar-fill', style: { height: `${Math.max(2, Math.round(ratio * 100))}%` } }))
        })),
        h('div', { className: 'ubd-axis' },
          h('span', null, hours[0] ? `${hours[0].label}:00` : ''),
          h('span', null, hours[12] ? `${hours[12].label}:00` : ''),
          h('span', null, lastHour ? `${lastHour.label}:00` : '')))
    }

    function WeekBars(props) {
      const days = props.days || []
      if (days.length === 0) return null
      let max = 0.0001
      for (const day of days) max = Math.max(max, day.cny)
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('week'), meta: fmtCny(days.reduce((sum, day) => sum + day.cny, 0)) }),
        h('div', { className: 'ubd-week' }, days.map((day) =>
          h('div', { className: 'ubd-week-row', key: day.date },
            h('span', { className: 'ubd-week-day' }, day.label),
            h('div', { className: 'ubd-track' },
              h('div', { className: 'ubd-track-fill', style: { width: `${Math.max(2, Math.round((day.cny / max) * 100))}%` } })),
            h('span', { className: 'ubd-week-val' }, fmtCny(day.cny))))))
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
      return h(React.Fragment, null,
        h(PanelHead, { title: props.t('models') }),
        h('div', { className: 'ubd-models' }, models.map((item) =>
          h('div', { className: 'ubd-model', key: item.model },
            h('span', { className: 'ubd-model-name', title: item.model }, item.model || '—'),
            h('span', { className: 'ubd-model-req' }, `${Number(item.requests).toLocaleString('zh-CN')} ${props.t('requests')}`),
            h('span', { className: 'ubd-model-cny' }, fmtCny(item.cny))))))
    }

    function Recent(props) {
      const list = props.recent || []
      if (list.length === 0) return h('div', { className: 'ubd-empty' }, props.t('empty'))
      return h('div', { className: 'ubd-recent' }, list.slice(0, 6).map((row, index) =>
        h('div', { className: 'ubd-req', key: `${row.id}-${index}`, 'data-error': row.ok === false ? 'true' : 'false' },
          h('div', { className: 'ubd-req-line' },
            h('span', { className: 'ubd-pill' }, fmtMs(row.totalMs)),
            h('span', { className: 'ubd-pill', 'data-dim': 'true' }, fmtMs(row.ttftMs)),
            row.ok === false
              ? h('span', { className: 'ubd-flow', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '错误')
              : h('span', { className: 'ubd-flow' }, `${fmtTps(row.tps)} t/s`),
            h('span', { className: 'ubd-req-time' }, row.timeLabel)),
          h('div', { className: 'ubd-req-sub' }, `${row.model || '—'} · ${fmtCny(row.cny)}`))))
    }

    function DialogContent(props) {
      const data = props.data
      const t = props.t
      if (data === null) {
        if (props.status === 'error') {
          return h('div', { className: 'ubd-error' },
            h('div', { className: 'ubd-error-title' }, t('errorTitle')),
            h('div', { className: 'ubd-error-body' }, props.error || '—'),
            h('button', { className: 'ubd-retry', type: 'button', onClick: props.refresh }, t('retry')))
        }
        return h('div', { className: 'ubd-empty' }, t('loading'))
      }
      const today = data.today || {}
      const win = data.window || {}
      const short = data.short || {}
      const account = data.account || {}
      return h(React.Fragment, null,
        h('div', { className: 'ubd-kpis' },
          h(Kpi, { label: t('cumulative'), value: fmtCny(account.usedCny), sub: `${t('balance')} ${fmtCny(account.quotaCny)}` }),
          h(Kpi, {
            label: `${t('today')}${today.exact === false ? ` · ${t('partial')}` : ''}`,
            value: fmtCny(today.cny),
            sub: `${fmtTokens(today.tokens)} tok · ${today.requests} ${t('requests')}`,
          }),
          h(Kpi, {
            label: t('errorRate'),
            tone: Number(win.errors) > 0 ? 'bad' : 'ok',
            value: fmtPct(win.errorRate),
            sub: `${win.errors || 0} / ${win.requests || 0}`,
          }),
          h(Kpi, {
            label: t('throughput'),
            value: `${fmtTps(short.tps)} t/s`,
            sub: `${t('ttft')} ${fmtMs(short.ttftMs)} · p50 ${fmtTps(win.tpsP50)} t/s`,
          })),
        h('div', { className: 'ubd-body' },
          h('div', { className: 'ubd-col' },
            h(Panel, null, h(HourBars, { hours: data.hours, t })),
            h(Panel, null, h(WeekBars, { days: data.days, t })),
            h(Panel, null, h(Heatmap, { heat: data.heat, t }))),
          h('div', { className: 'ubd-col' },
            h(Panel, null, h(Models, { models: data.models, t })),
            h(Panel, null,
              h(PanelHead, { title: t('recent'), meta: fmtTokens(win.tokens) }),
              h(Recent, { recent: data.recent, t })))))
    }

    function Dialog(props) {
      const dialogRef = useRef(null)
      useDialogBehavior(dialogRef, props.open, props.onClose)
      if (!props.open) return null
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
                : props.t('hint')),
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
              }, h(IconClose)))),
          h(DialogContent, {
            data: props.data,
            status: props.status,
            error: props.error,
            refresh: props.refresh,
            t: props.t,
          }),
          h('footer', { className: 'ubd-foot' },
            props.error !== null && props.data !== null ? `${props.error} · ` : '',
            props.data !== null && Array.isArray(props.data.notes) ? props.data.notes.join(' ') : props.t('footnote'))))
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
      const openDialog = useCallback(() => setOpen(true), [])
      const closeDialog = useCallback(() => setOpen(false), [])

      const trigger = wide
        ? h('div', {
            className: 'ub-card',
            role: 'button',
            tabIndex: 0,
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
          }, h(CardBody, { data, status: summary.status, error: summary.error, t }))
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
          refresh: summary.refresh,
          t,
        }))
    }

    return {
      inject: ['slots', 'locale'],
      testing: {
        Card: UsageCard,
        CardBody,
        Dialog,
        Sections: { HourBars, WeekBars, Heatmap, Models, Recent, DialogContent },
        formatters: { fmtCny, fmtTokens, fmtTps, fmtMs, fmtPct },
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
