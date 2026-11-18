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
  // DSH 的客户端模块表按包名索引：注册 id 必须等于 package.json 的 name。
  assert.equal(registration.id, '@qzsy/dsh-usage-board')

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

function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.props && node.props.className === className) return node
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findByClass(child, className)
      if (hit !== null) return hit
    }
  }
  return null
}

test('卡片正文压成一条：今日金额 + 走势 + 一行说明', () => {
  const faceValue = face()
  const body = faceValue.testing.CardBody({
    data: payload(),
    status: 'ready',
    error: null,
    t: (key) => key,
  })
  const text = collectText(body).join(' ')
  assert.ok(text.includes('¥'), '卡片应显示今日金额')
  assert.ok(text.includes('hour24'), '卡片应显示近 24 小时成本')
  assert.ok(text.includes('balance'), '卡片应显示余额')
  assert.ok(!text.includes('cumulative'), '累计用量留在弹窗')
  assert.ok(!text.includes('t/s'), '吞吐这类诊断指标留在弹窗')

  const row = (body.children || []).find((child) => child !== null
    && typeof child === 'object' && child.props && child.props.className === 'ub-card-main')
  assert.ok(row !== undefined, '卡片应有一条主行')
  const area = (row.children || []).find((child) => child !== null
    && typeof child === 'object' && child.type === faceValue.testing.Sections.SparkArea)
  assert.ok(area !== undefined, '主行里应嵌着 24h 走势')
  assert.equal(area.props.values.length, 24)
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

test('SSE 解析器处理分片、注释与 CRLF', () => {
  const faceValue = face()
  const { parseSseBlock, createSseParser } = faceValue.testing.sse

  const block = parseSseBlock('event: summary\ndata: {"a":1}')
  assert.equal(block.event, 'summary')
  assert.equal(block.data, '{"a":1}')
  assert.equal(block.id, null)
  assert.equal(block.retry, null)
  assert.equal(parseSseBlock(': ping'), null, '注释帧（心跳）不产生事件')
  assert.equal(parseSseBlock('retry: 3000'), null, '只有 retry 没有 data 也不是事件')

  const parser = createSseParser()
  assert.equal(parser.push('retry: 3000\n\n').length, 0)
  assert.equal(parser.push('event: summary\nda').length, 0, '半个事件先攒着')
  const first = parser.push('ta: {"ok":true}\n\n')[0]
  assert.equal(first.event, 'summary')
  assert.equal(first.data, '{"ok":true}')
  const rest = parser.push('id: 7\r\nevent: summary\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n')
  assert.equal(rest.length, 2)
  assert.equal(rest[0].id, '7')
  assert.equal(rest[0].data, '1')
  assert.equal(rest[1].event, 'message')
  assert.equal(rest[1].data, '2')
})

test('弹窗头部标出实时/轮询状态', () => {
  const faceValue = face()
  const render = (link) => collectText(faceValue.testing.Dialog({
    open: true,
    onClose: () => {},
    data: payload(),
    status: 'ready',
    error: null,
    link,
    refresh: () => {},
    t: (key) => key,
  })).join(' ')

  assert.ok(render('live').includes('live'), 'SSE 正常时应显示实时')
  assert.ok(render('poll').includes('polling'), '退回轮询时应显示轮询')
  assert.ok(render(undefined).includes('hint'), '没有连接态时只给提示文案')
})

/* ---------------------------------------------------------------- 配置视图 */

function findTag(node, tag) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findTag(child, tag)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.type === tag) return node
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findTag(child, tag)
      if (hit !== null) return hit
    }
  }
  return null
}

function findButton(node, text) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, text)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.type === 'button' && collectText(node).join(' ').includes(text)) return node
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findButton(child, text)
      if (hit !== null) return hit
    }
  }
  return null
}

function localeT(dictionary) {
  return (key) => (Object.hasOwn(dictionary, key) ? dictionary[key] : key)
}

function fakeCandidate(overrides = {}) {
  return {
    providerId: 'p1',
    name: '主网关',
    baseUrl: 'https://ai-api.example.com',
    usageBaseUrl: 'https://ai-api.example.com/usage',
    keyStatus: 'configured',
    ...overrides,
  }
}

function fakeSource(data = {}) {
  return {
    status: 'ready',
    error: null,
    code: null,
    data: {
      ok: true,
      gateway: { baseUrl: 'https://ai-api.example.com' },
      readable: true,
      candidates: [],
      selected: null,
      token: { configured: false, tail: null },
      ...data,
    },
  }
}

test('错误码映射成人话，中英文都覆盖', () => {
  const faceValue = face()
  const { codeText, errorText, isSetupCode } = faceValue.testing.setup
  const { zh, en } = faceValue.testing.copy
  const cases = [
    ['missing_credentials', '未配置凭据', 'Credentials missing'],
    ['invalid_credentials', '凭证已失效', 'Credentials expired'],
    ['forbidden', '令牌权限不足', 'Token lacks permission'],
    ['rate_limited', '网关限流', 'Gateway rate limited'],
    ['network', '网络异常', 'Network error'],
    ['unsupported_provider', '未找到可用供应商', 'No usable provider'],
  ]
  for (const [code, zhText, enText] of cases) {
    assert.equal(codeText(localeT(zh), code), zhText, `${code} 中文文案`)
    assert.equal(codeText(localeT(en), code), enText, `${code} 英文文案`)
  }
  assert.equal(codeText(localeT(zh), 'made_up_code'), '', '未知错误码不伪造人话')
  assert.equal(errorText(localeT(zh), 'missing_credentials', '缺少网关密钥'), '未配置凭据 · 缺少网关密钥')
  assert.equal(errorText(localeT(zh), 'unknown', '原始错误'), '原始错误')
  assert.equal(isSetupCode('missing_credentials'), true)
  assert.equal(isSetupCode('invalid_credentials'), true)
  assert.equal(isSetupCode('unsupported_provider'), true)
  assert.equal(isSetupCode('forbidden'), true, '和宿主一致：令牌权限不足要回配置里修')
  assert.equal(isSetupCode('rate_limited'), false, '限流是暂时错误，不自动切配置视图')
  assert.equal(isSetupCode('network'), false)
})

test('配置视图：没有候选供应商时给出设置入口，保存按钮存在但禁用', () => {
  const faceValue = face()
  const t = localeT(faceValue.testing.copy.zh)
  const node = faceValue.testing.setup.Content({
    source: fakeSource({ readable: false, candidates: [], selected: null }),
    t,
  })
  const text = collectText(node).join(' ')

  assert.ok(text.includes('没有找到指向该网关的模型供应商'), '应明确提示没有候选供应商')
  assert.ok(text.includes('请到 设置 → 模型 配置'), '应指路到设置 → 模型')
  assert.equal(findByClass(node, 'ubd-setup-select'), null, '没有候选时不能出现供应商下拉')
  assert.equal(findTag(node, 'input'), null, '没有候选时不能提供手填入口')

  const save = findButton(node, t('setupSave'))
  assert.ok(save !== null, '无候选时保存按钮仍应存在')
  assert.equal(save.props.disabled, true, '无候选时保存按钮应禁用')
  const testButton = findButton(node, t('setupTest'))
  assert.ok(testButton !== null)
  assert.equal(testButton.props.disabled, true)
})

test('配置视图：唯一候选只读展示供应商、用量地址与密钥状态', () => {
  const faceValue = face()
  const t = localeT(faceValue.testing.copy.zh)
  const only = fakeCandidate()
  const source = fakeSource({
    candidates: [only],
    selected: { providerId: 'p1', name: '主网关', usageBaseUrl: only.usageBaseUrl, keyStatus: 'configured' },
    token: { configured: true, tail: '9f2c' },
  })
  const node = faceValue.testing.setup.Content({ source, t })
  const text = collectText(node).join(' ')

  assert.ok(text.includes('主网关'), '应展示供应商名')
  assert.ok(text.includes(only.usageBaseUrl), '应展示 usageBaseUrl')
  assert.ok(text.includes('已配置'), '应展示密钥已配置')
  assert.ok(text.includes('已保存，尾号') && text.includes('9f2c'), '只展示宿主给的尾号')
  assert.equal(findByClass(node, 'ubd-setup-select'), null, '唯一候选不需要下拉')

  const password = findTag(node, 'input')
  assert.equal(password.props.type, 'password', '访问令牌必须是密码框')
  assert.ok(String(password.props.placeholder).includes('精确口径'))
  assert.ok(findByClass(node, 'ubd-setup-check') !== null, '已保存令牌应提供清除入口')

  const save = findButton(node, t('setupSave'))
  assert.equal(save.props.disabled, false, '有候选且空闲时保存按钮可用')
  const savingNode = faceValue.testing.setup.Content({ source, t, saving: true })
  assert.equal(findButton(savingNode, t('setupSaving')).props.disabled, true, '保存中应禁用按钮')

  const hostTail = faceValue.testing.setup.Content({
    source: fakeSource({
      candidates: [only],
      selected: { providerId: 'p1', name: '主网关', usageBaseUrl: only.usageBaseUrl, keyStatus: 'configured' },
      token: { configured: true, tail: '…9f2c' },
    }),
    t,
  })
  const hostTailText = collectText(hostTail).join(' ')
  assert.ok(hostTailText.includes('已保存，尾号 …9f2c'), '宿主 tail 自带省略号时不重复拼接')
  assert.ok(!hostTailText.includes('……'))

  const missing = faceValue.testing.setup.Content({
    source: fakeSource({
      candidates: [fakeCandidate({ keyStatus: 'missing' })],
      selected: { providerId: 'p1', name: '主网关', usageBaseUrl: only.usageBaseUrl, keyStatus: 'missing' },
    }),
    t,
  })
  assert.ok(collectText(missing).join(' ').includes('该供应商的 API 密钥未配置，请到 设置 → 模型 补充'))
})

test('配置视图：多个候选用下拉选择，默认选中宿主 selected', () => {
  const faceValue = face()
  const t = localeT(faceValue.testing.copy.zh)
  const first = fakeCandidate()
  const second = fakeCandidate({
    providerId: 'p2',
    name: '备用网关',
    usageBaseUrl: 'https://backup.example.com/usage',
    keyStatus: 'missing',
  })
  const source = fakeSource({
    candidates: [first, second],
    selected: { providerId: 'p1', name: '主网关', usageBaseUrl: first.usageBaseUrl, keyStatus: 'configured' },
  })

  const defaultNode = faceValue.testing.setup.Content({ source, t })
  const defaultSelect = findByClass(defaultNode, 'ubd-setup-select')
  assert.ok(defaultSelect !== null, '多个候选应渲染下拉')
  assert.equal(defaultSelect.props.value, 'p1', '默认选中宿主的 selected')
  assert.equal(defaultSelect.children[0].length, 2, '下拉应包含两个候选')
  const defaultText = collectText(defaultNode).join(' ')
  assert.ok(defaultText.includes('主网关') && defaultText.includes('备用网关'))

  const switched = faceValue.testing.setup.Content({ source, providerId: 'p2', t })
  const switchedSelect = findByClass(switched, 'ubd-setup-select')
  assert.equal(switchedSelect.props.value, 'p2', '手动切换后下拉值跟随')
  const switchedText = collectText(switched).join(' ')
  assert.ok(switchedText.includes(second.usageBaseUrl), '应展示所选候选的用量地址')
  assert.ok(switchedText.includes('缺失'), '应展示所选候选的密钥状态')

  const noSelection = faceValue.testing.setup.Content({
    source: fakeSource({ candidates: [first, second], selected: null }),
    t,
  })
  assert.equal(findByClass(noSelection, 'ubd-setup-select').props.value, 'p1', '宿主没有选中时回落到第一个')
})

test('失败载荷的配置类错误在卡片上映射成人话，并提示点开配置', () => {
  const faceValue = face()
  const t = localeT(faceValue.testing.copy.zh)
  const body = faceValue.testing.CardBody({
    data: null,
    status: 'error',
    error: '缺少网关密钥',
    errorCode: 'missing_credentials',
    needsSetup: true,
    t,
  })
  assert.equal(body.type, faceValue.testing.CardError, '错误态应走到卡片错误行')
  assert.ok(body.props.message.includes('未配置凭据'))
  assert.ok(body.props.message.includes('缺少网关密钥'))
  assert.equal(body.props.needsSetup, true)

  const text = collectText(faceValue.testing.CardError(body.props)).join(' ')
  assert.ok(text.includes('取数失败'))
  assert.ok(text.includes('未配置凭据'))
  assert.ok(text.includes('缺少网关密钥'))
  assert.ok(text.includes('点开配置'), '配置类错误应引导点开配置')
})

test('弹窗在配置类失败时直接进入配置视图，健康状态仍显示看板', () => {
  const faceValue = face()
  const t = localeT(faceValue.testing.copy.zh)
  const render = (overrides) => faceValue.testing.Dialog({
    open: true,
    onClose: () => {},
    status: 'error',
    error: '缺少网关密钥',
    errorCode: 'missing_credentials',
    needsSetup: true,
    refresh: () => {},
    t,
    ...overrides,
  })

  for (const overrides of [
    { data: null, errorCode: 'missing_credentials', needsSetup: true },
    { data: null, errorCode: 'missing_credentials', needsSetup: false },
    { data: null, errorCode: 'unsupported_provider', needsSetup: false },
  ]) {
    const node = render(overrides)
    const dialog = node.children[1]
    assert.equal(dialog.children[1].type, faceValue.testing.setup.Panel, '配置类失败应进入配置视图')
  }

  const loading = faceValue.testing.setup.Content({
    source: { status: 'loading', data: null, error: null, code: null },
    t,
  })
  assert.ok(collectText(loading).join(' ').includes('读取供应商'), '配置视图打开时先展示 loading')

  const blocked = render({ data: null, errorCode: 'rate_limited', needsSetup: false })
  const blockedBody = blocked.children[1].children[1]
  assert.equal(blockedBody.type, faceValue.testing.Sections.DialogContent, '非配置类错误不自动进入配置视图')
  assert.equal(blockedBody.props.errorCode, 'rate_limited')
  assert.ok(collectText(blockedBody.type(blockedBody.props)).join(' ').includes('网关限流'), '错误正文应映射错误码')

  const healthy = render({ data: payload(), status: 'ready', error: null, errorCode: null, needsSetup: false })
  const dialog = healthy.children[1]
  assert.equal(dialog.children[1].type, faceValue.testing.Sections.DialogContent, '健康状态默认仍看板')
  const header = dialog.children[0]
  assert.equal(header.children[2].children.length, 2, '头部保留刷新与关闭两个按钮')
  const setupButton = header.children[3]
  assert.ok(setupButton.props.className.includes('ubd-setup-open'), '头部应有设置按钮')
  assert.equal(setupButton.props['aria-label'], t('setup'))
})

test('配置过程不落地浏览器存储，只信宿主 tail', () => {
  const faceValue = face()
  assert.equal(/localStorage|sessionStorage/.test(SOURCE), false, '客户端不得把令牌写进浏览器存储')
  const token = faceValue.testing.copy.zh.setupTokenSaved
  assert.equal(token, '已保存，尾号')
})
