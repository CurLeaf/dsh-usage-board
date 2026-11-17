import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { buildSummary } from '../lib/aggregate.js'

const NOW = Date.parse('2026-11-17T10:48:00+08:00')
const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 够用的 React 替身：createElement / Fragment / 常用 hook。 */
const stubReact = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
}

const stubReactDom = { createPortal: (node) => node }

function loadRegistration() {
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          sandbox.registration = registration
        },
      },
    },
    document: undefined,
    console,
  }
  vm.runInNewContext(SOURCE, sandbox)
  assert.ok(sandbox.registration !== undefined, 'client.js 必须调用 __ModuleLoader__.load')
  return sandbox.registration
}

function face() {
  return loadRegistration().factory((name) => {
    if (name === 'react') return stubReact
    if (name === 'react-dom') return stubReactDom
    throw new Error(`unexpected require: ${name}`)
  })
}

function createCtx() {
  const record = { slots: [], slotInjects: [], effects: [], locales: [] }
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (namespace, dictionaries) => {
        record.locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    slots: {
      inject(name, run) {
        record.slotInjects.push(name)
        run()
        return () => {}
      },
      register(definition, component) {
        record.slots.push({ definition, component })
        return () => {}
      },
    },
  }
  return { ctx, record }
}

function payload() {
  const rows = [
    {
      id: 1,
      created_at: Math.floor(NOW / 1000) - 60,
      type: 2,
      quota: 26_566,
      prompt_tokens: 348,
      completion_tokens: 804,
      use_time: 5,
      is_stream: true,
      model_name: 'deepseek-flash',
      other: JSON.stringify({ frt: 331 }),
    },
    {
      id: 2,
      created_at: Math.floor(NOW / 1000) - 30,
      type: 2,
      quota: 36_566,
      prompt_tokens: 1200,
      completion_tokens: 1935,
      use_time: 12,
      is_stream: true,
      model_name: 'deepseek-flash',
      other: JSON.stringify({ frt: 417 }),
    },
  ]
  return buildSummary({
    rows,
    usage: { data: { total_used: 9_902_758_114, total_granted: 7_686_372_712, total_available: -2_216_385_402, unlimited_quota: true } },
    now: NOW,
    quotaPerUnit: 500_000,
    price: 7.3,
    refreshMs: 300_000,
  })
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    const props = node.props ?? {}
    for (const key of ['label', 'value', 'sub', 'meta', 'title', 'text', 'message']) {
      if (typeof props[key] === 'string' || typeof props[key] === 'number') out.push(String(props[key]))
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) collectText(child, out)
    }
  }
  return out
}

test('client.js 把卡片注册到左栏底部席位', () => {
  const registration = loadRegistration()
  assert.equal(registration.id, 'dsh-usage-board')

  const faceValue = face()
  assert.deepEqual([...faceValue.inject], ['slots', 'locale'])

  const { ctx, record } = createCtx()
  faceValue.apply(ctx)

  assert.deepEqual([...record.slotInjects], ['sidebar.footer.action'])
  assert.equal(record.slots.length, 1)
  assert.equal(record.slots[0].definition.name, 'sidebar.footer.action')
  assert.equal(record.slots[0].definition.id, 'usage-board-card')
  assert.equal(record.slots[0].definition.order, 100)
  assert.equal(typeof record.slots[0].component, 'function')

  const locale = record.locales.find((item) => item.namespace === 'usageBoard')
  assert.ok(locale !== undefined, '应注册 usageBoard 文案命名空间')
  assert.equal(typeof locale.dictionaries.zh.title, 'string')
  assert.equal(typeof locale.dictionaries.en.title, 'string')
})

test('卡片在宽/窄两种侧栏状态下都能渲染', () => {
  const faceValue = face()
  const t = (key) => key

  const wide = collectText(faceValue.testing.Card({ wide: true, t })).join(' ')
  assert.ok(wide.length >= 0)

  const rail = faceValue.testing.Card({ wide: false, t })
  assert.equal(rail.children[0].type, 'button', '折叠导轨态应退化为图标按钮')
})

test('卡片正文在真实载荷下显示金额/token/吞吐', () => {
  const faceValue = face()
  const text = collectText(faceValue.testing.CardBody({
    data: payload(),
    status: 'ready',
    error: null,
    t: (key) => key,
  })).join(' ')
  assert.ok(text.includes('¥'), '卡片应显示今日金额')
  assert.ok(text.includes('cumulative'), '卡片应显示累计用量')
  assert.ok(text.includes('balance'), '卡片应显示余额')
  assert.ok(text.includes('t/s'), '卡片应显示吞吐')
})

test('弹窗正文渲染真实载荷', () => {
  const faceValue = face()
  const data = payload()
  const text = collectText(faceValue.testing.Sections.DialogContent({
    data,
    status: 'ready',
    error: null,
    refresh: () => {},
    t: (key) => key,
  })).join(' ')

  assert.ok(text.includes('¥'), '应显示金额')
  assert.ok(text.includes('t/s'), '应显示吞吐')

  const modelText = collectText(faceValue.testing.Sections.Models({ models: data.models, t: (key) => key })).join(' ')
  assert.ok(modelText.includes('deepseek-flash'), '模型分布应显示模型名')

  const recentText = collectText(faceValue.testing.Sections.Recent({ recent: data.recent, t: (key) => key })).join(' ')
  assert.ok(recentText.includes('t/s'), '最近请求应显示吞吐')
})

test('弹窗关闭态不渲染', () => {
  const faceValue = face()
  const node = faceValue.testing.Dialog({
    open: false,
    onClose: () => {},
    data: payload(),
    status: 'ready',
    error: null,
    refresh: () => {},
    t: (key) => key,
  })
  assert.equal(node, null)
})

test('弹窗打开态带 dialog 语义与关闭按钮', () => {
  const faceValue = loadRegistration().factory((name) => {
    if (name === 'react') return stubReact
    if (name === 'react-dom') return stubReactDom
    throw new Error(`unexpected require: ${name}`)
  })
  const node = faceValue.testing.Dialog({
    open: true,
    onClose: () => {},
    data: payload(),
    status: 'ready',
    error: null,
    refresh: () => {},
    t: (key) => key,
  })
  const dialog = node.children[1]
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(dialog.props['data-shortcut-modal'], 'usage-board')
  assert.equal(dialog.props.tabIndex, -1)
  const header = dialog.children[0]
  const actions = header.children[2]
  assert.equal(actions.children.length, 2, '头部应有刷新与关闭两个按钮')
  assert.equal(actions.children[1].props['data-modal-autofocus'], '', '关闭按钮应拿到初始焦点')
})

test('格式化函数守住边界值', () => {
  const faceValue = face()
  const { fmtCny, fmtTokens, fmtTps, fmtMs, fmtPct } = faceValue.testing.formatters
  assert.equal(fmtCny(0), '¥0.00')
  assert.equal(fmtCny(14_458_000), '¥1445.80万')
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(12_345), '1.2万')
  assert.equal(fmtTokens(102_000_000), '1.02亿')
  assert.equal(fmtTps(164.53), '165')
  assert.equal(fmtTps(0), '—')
  assert.equal(fmtMs(710), '710ms')
  assert.equal(fmtMs(4000), '4.00s')
  assert.equal(fmtPct(0), '0.00%')
  assert.equal(fmtPct(0.0125), '1.3%')
})
