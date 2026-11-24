import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 够用的 React 替身：createElement / Fragment / hook。 */
function createReactStub() {
  const stub = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const flat = children.flat()
      const merged = { ...(props ?? {}) }
      // 与 React 一致：children 也进 props.children，函数组件才拿得到
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      return { type, props: merged, children: flat }
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
  return stub
}

function load() {
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
    TextDecoder,
    AbortController,
  }
  vm.runInNewContext(SOURCE, sandbox)
  assert.ok(sandbox.registration !== undefined, 'client.js 必须调用 __ModuleLoader__.load')
  return sandbox.registration
}

function face() {
  const React = createReactStub()
  const module = load().factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${name}`)
  })
  return { module, React }
}

/** 递归收集文本节点；函数组件就地展开渲染（这些组件都不依赖 hook）。 */
function textOf(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((item) => textOf(item, depth)).join(' ')
  if (typeof node !== 'object') return ''
  if (depth > 40) return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props), depth + 1)
  return textOf(node.children, depth)
}

/** 递归找满足条件的节点；函数组件同样展开。 */
function findAll(node, predicate, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out, depth)
    return out
  }
  if (depth > 40) return out
  if (typeof node.type === 'function') {
    findAll(node.type(node.props), predicate, out, depth + 1)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out, depth)
  return out
}

const t = (key) => key

const WANDAPI_SNAPSHOT = {
  ok: true,
  provider: { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://api.wandapi.com' },
  unit: 'CNY',
  caps: ['periods', 'models'],
  timeZone: 'Asia/Shanghai',
  generatedAt: Date.now(),
  account: { remaining: 501.55, used: 1.45, total: 503, requestCount: null },
  today: { date: '2026-11-19', cost: 1.45, requests: 307, errors: 0, errorRate: 0, tokens: 18_702_294, tokensIn: 18_531_045, tokensOut: 171_249 },
  periods: [
    { key: 'today', label: '今日', cost: 1.45, requests: 307, tokens: 18_702_294, errorRate: 0, to: '2026-11-19' },
    { key: 'last7d', label: '近 7 天', cost: 2.5, requests: 500, tokens: 20_200_000, errorRate: 0.01, to: '2026-11-19' },
    { key: 'last30d', label: '近 30 天', cost: 4.5, requests: 900, tokens: 30_300_000, errorRate: 0.0111, to: '2026-11-19' },
  ],
  models: [{ model: 'deepseek-flash', requests: 890, cost: 4.49, tokens: 30_000_000 }],
  notes: ['账户级口径'],
  site: { baseUrl: 'https://api.wandapi.com' },
}

const NEWAPI_SNAPSHOT = {
  ok: true,
  provider: { id: 'qzsy', kind: 'newapi', name: '公司网关', baseUrl: 'https://ai-api.qzsyzn.com' },
  unit: 'CNY',
  caps: ['hourly', 'daily', 'heatmap', 'models', 'recent', 'throughput'],
  timeZone: 'Asia/Shanghai',
  generatedAt: Date.now(),
  account: { remaining: 30_000, used: 20_000, total: 50_000, requestCount: 160_000 },
  today: { date: '2026-11-19', cost: 3.5, requests: 19, errors: 0, errorRate: 0, tokens: 70_000 },
  window: { cost: 36.5, requests: 801, errors: 3, errorRate: 0.0037, tokens: 2_162_287, tps: 162, tpsP50: 156, ttftMs: 248 },
  hours: Array.from({ length: 24 }, (_, index) => ({ at: index, label: String(index).padStart(2, '0'), day: '2026-11-19', cost: index, requests: index })),
  days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-11-1${index}`, label: `11-1${index}`, cost: index, requests: index })),
  heat: Array.from({ length: 7 }, (_, index) => ({
    date: `2026-11-1${index}`,
    label: `11-1${index}`,
    cells: Array.from({ length: 24 }, (_, hour) => ({ hour, cost: hour, requests: hour })),
  })),
  models: [{ model: 'deepseek-flash', requests: 14, cost: 3.5, tokens: 70_000 }],
  recent: [{ id: 1, t: Date.now(), timeLabel: '13:50:00', model: 'deepseek-flash', ok: true, stream: true, tps: 142, ttftMs: 500, totalMs: 4000, cost: 0.1, tokens: 1800 }],
  notes: [],
}

test('注册 id 等于包名，apply 注册文案/样式/侧栏卡片', () => {
  const registration = load()
  assert.equal(registration.id, '@qzsy/dsh-usage-board')

  const { module } = face()
  const effects = []
  const slots = []
  const locales = []
  const ctx = {
    locale: {
      bind: () => t,
      register: (ns, dict) => {
        locales.push({ ns, dict })
      },
    },
    slots: {
      inject: (name, fn) => {
        slots.push(name)
        return fn()
      },
      register: (options, component) => {
        slots.push({ options, component })
      },
    },
    effect: (factory, label) => {
      effects.push({ label, cleanup: factory() })
    },
  }
  module.apply(ctx)
  assert.equal(JSON.stringify(module.inject), JSON.stringify(['slots', 'locale']))
  assert.ok(locales.some((item) => item.ns === 'usageBoard' && item.dict.zh.today === '今日用量'))
  assert.ok(effects.some((item) => item.label === 'usage-board: styles'))
  assert.ok(slots.includes('sidebar.footer.action'))
})

test('金额按 unit 格式化，不做汇率换算', () => {
  const { module } = face()
  const { fmtMoney } = module.testing.formatters
  assert.equal(fmtMoney(1.448, 'USD'), '$1.45')
  assert.equal(fmtMoney(1.448, 'CNY'), '¥1.45')
  assert.equal(fmtMoney(12_345, 'CNY'), '¥1.23万')
  assert.equal(fmtMoney(12_345, 'USD'), '$12.3k')
  assert.equal(fmtMoney(undefined, 'USD'), '—')
})

test('wandapi 卡片：$ 金额 + 供应商名 + 近 7 天/余额，没有 24h 折线', () => {
  const { module } = face()
  const tree = module.testing.CardBody({ data: WANDAPI_SNAPSHOT, failure: null, t })
  const text = textOf(tree)
  assert.match(text, /¥1\.45/)
  assert.match(text, /WandAPI/)
  // t 是恒等函数，所以这里断言的是文案 key
  assert.match(text, /day7/)
  assert.match(text, /balance/)
  assert.match(text, /¥501\.6/)
  // 没有 hourly 能力就不画 sparkline
  assert.equal(findAll(tree, (node) => node.type === 'svg').length, 0)
})

test('newapi 卡片：¥ 金额 + 24h 折线 + 成功率', () => {
  const { module } = face()
  const tree = module.testing.CardBody({ data: NEWAPI_SNAPSHOT, failure: null, t })
  const text = textOf(tree)
  assert.match(text, /¥3\.50/)
  assert.match(text, /公司网关/)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ub-card-area').length, 1)
  // 统计行是 24h / 余额 / 成功率；供应商名在右上角
  assert.match(text, /successRate/)
  assert.match(text, /公司网关/)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ub-card-provider').length, 1)
})

test('失败时卡片只说清坏在哪，并给出供应商名', () => {
  const { module } = face()
  const tree = module.testing.CardBody({
    data: null,
    failure: { code: 'invalid_credentials', error: '401', needsSetup: true, provider: { id: 'wandapi', name: 'WandAPI' } },
    t,
  })
  const text = textOf(tree)
  assert.match(text, /WandAPI/)
  assert.match(text, /codeInvalidCredentials/)
})

test('wandapi 弹窗只有周期对比 + 模型，没有 24h/热力/最近请求', () => {
  const { module } = face()
  const tree = module.testing.DialogContent({ data: WANDAPI_SNAPSHOT, t })
  const text = textOf(tree)
  assert.match(text, /¥1\.45/)
  assert.match(text, /periods/)
  assert.match(text, /models/)
  // 没有的能力对应区块必须完全不存在，而不是渲染成空壳
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-bars').length, 0)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-heat').length, 0)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-recent').length, 0)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-periods').length, 1)
})

test('newapi 弹窗有 24h 柱、热力、最近请求与吞吐指标', () => {
  const { module } = face()
  const tree = module.testing.DialogContent({ data: NEWAPI_SNAPSHOT, t })
  const text = textOf(tree)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-bars').length, 1)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-heat').length, 1)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-recent').length, 1)
  assert.equal(findAll(tree, (node) => node.props?.className === 'ubd-periods').length, 0)
  assert.match(text, /ttft/)
  assert.match(text, /throughput/)
})

test('reducePayload：失败载荷清空旧数据，不保留混合视图', () => {
  const { module } = face()
  const { reducePayload } = module.testing
  const ready = reducePayload({ status: 'loading', data: null, failure: null, link: 'live' }, WANDAPI_SNAPSHOT)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.data.ok, true)
  assert.equal(ready.failure, null)

  const failed = reducePayload(ready, { ok: false, code: 'payment_required', error: '余额不足', needsSetup: true })
  assert.equal(failed.status, 'error')
  assert.equal(failed.data, null)
  assert.equal(failed.failure.code, 'payment_required')

  const empty = reducePayload(ready, null)
  assert.equal(empty.data, null)
  assert.equal(empty.failure.code, 'network')
})

test('reducePayload：路由级 forbidden 归到 token_mismatch，而不是网络错误', () => {
  const { module } = face()
  const forbidden = module.testing.reducePayload(
    { status: 'ready', data: WANDAPI_SNAPSHOT, failure: null, link: 'live' },
    { ok: false, error: 'forbidden' },
  )
  assert.equal(forbidden.data, null)
  assert.equal(forbidden.failure.code, 'token_mismatch')
})

test('切换器：两个供应商，选中项高亮但不禁用，另一个点击触发 onSwitch', () => {
  const { module } = face()
  const clicked = []
  const providers = [
    { id: 'qzsy', kind: 'newapi', name: '公司网关', baseUrl: 'https://a.test', selected: true },
    { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://b.test', selected: false },
  ]
  const tree = module.testing.ProviderSwitch({
    providers,
    selected: 'qzsy',
    pending: null,
    t,
    onSwitch: (provider) => clicked.push(provider.id),
  })
  const buttons = findAll(tree, (node) => node.type === 'button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props['aria-pressed'], 'true')
  // 选中项不能 disabled：:disabled 会把 opacity 压到 .55，比未选中的还暗，看着像标错了供应商
  assert.equal(buttons[0].props.disabled, false)
  buttons[0].props.onClick()
  assert.deepEqual(clicked, [], '点选中项是空操作')
  assert.equal(buttons[1].props['aria-pressed'], 'false')
  buttons[1].props.onClick()
  assert.deepEqual(clicked, ['wandapi'])
})

test('切换器：切换过程中整组禁用，目标项显示「切换中…」', () => {
  const { module } = face()
  const providers = [
    { id: 'qzsy', kind: 'newapi', name: '公司网关', baseUrl: 'https://a.test', selected: true },
    { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://b.test', selected: false },
  ]
  const tree = module.testing.ProviderSwitch({
    providers,
    selected: 'qzsy',
    pending: 'wandapi',
    t,
    onSwitch: () => {
      throw new Error('切换中不该再触发 onSwitch')
    },
  })
  const buttons = findAll(tree, (node) => node.type === 'button')
  assert.equal(buttons.every((node) => node.props.disabled === true), true)
  assert.match(textOf(buttons[1]), /switching/)
})

test('失效视图：newapi 缺令牌时给出令牌输入框与重试', () => {
  const { module } = face()
  const providers = [
    {
      id: 'qzsy', kind: 'newapi', name: '公司网关', baseUrl: 'https://a.test', selected: true,
      credentials: { key: 'configured', token: 'missing', tokenTail: null },
    },
    {
      id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://b.test', selected: false,
      credentials: { key: 'configured', token: 'not_required', tokenTail: null },
    },
  ]
  let retried = 0
  const tree = module.testing.FailureView({
    failure: { code: 'missing_credentials', error: '缺少系统访问令牌', needsSetup: true },
    providers,
    selected: 'qzsy',
    pending: null,
    switchError: null,
    onSwitch: () => {},
    onRetry: () => {
      retried += 1
    },
    t,
  })
  const inputs = findAll(tree, (node) => node.type === 'input')
  assert.equal(inputs.length, 1)
  const text = textOf(tree)
  assert.match(text, /tokenTitle/)
  assert.match(text, /retry/)
  const retryButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('retry')).at(-1)
  retryButton.props.onClick()
  assert.equal(retried, 1)
})

test('令牌失效的失效界面：给出刷新页面而不是只让重试', () => {
  const { module } = face()
  const tree = module.testing.FailureView({
    failure: { code: 'token_mismatch', error: '页面令牌与宿主进程不一致' },
    providers: [],
    selected: null,
    pending: null,
    switchError: null,
    onSwitch: () => {},
    onRetry: () => {},
    t,
  })
  const text = textOf(tree)
  assert.match(text, /reloadPage/)
  assert.match(text, /reloadHint/)
  assert.match(text, /retry/)
  // 令牌失配时重试不是主按钮（刷新才是）
  const buttons = findAll(tree, (node) => node.type === 'button')
  const retry = buttons.find((node) => textOf(node).includes('retry'))
  assert.equal(retry.props['data-primary'], 'false')
})

test('SSE 解析：心跳跳过，多行 data 拼接', () => {
  const { module } = face()
  const { parseSseBlock, createSseParser } = module.testing.sse
  assert.equal(parseSseBlock(': ping'), null)
  assert.equal(JSON.stringify(parseSseBlock('event: summary\ndata: {"a":1}')), JSON.stringify({ event: 'summary', data: '{"a":1}', id: null, retry: null }))
  const parser = createSseParser()
  assert.equal(parser.push('event: summary\ndata: {"ok":').length, 0)
  assert.equal(JSON.stringify(parser.push('true}\n\n')), JSON.stringify([{ event: 'summary', data: '{"ok":true}', id: null, retry: null }]))
})
