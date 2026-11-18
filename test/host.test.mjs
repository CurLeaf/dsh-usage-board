import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SUMMARY_PATH,
  TOKEN_GLOBAL,
  TOKEN_HEADER,
  apply,
  authorize,
  buildFailurePayload,
  normalizeConfig,
  readKeyFromDisk,
  refreshSummary,
} from '../index.js'
import { GatewayError, createGateway } from '../lib/gateway.js'

test('normalizeConfig 有默认值并夹紧异常输入', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.baseUrl, 'https://ai-api.qzsyzn.com')
  assert.equal(defaults.apiKeyRef, 'DEEPSEEK_API_KEY')
  assert.equal(defaults.quotaPerUnit, 500_000)
  assert.equal(defaults.price, 1)
  assert.equal(defaults.refreshMs, 300_000)

  const custom = normalizeConfig({
    baseUrl: 'https://gw.example.com///',
    quotaPerUnit: 0,
    price: -1,
    refreshMs: 1000,
    dataDir: '/tmp/usage-board',
  })
  assert.equal(custom.baseUrl, 'https://gw.example.com')
  assert.equal(custom.quotaPerUnit, 500_000)
  assert.equal(custom.price, 1)
  assert.equal(custom.refreshMs, 60_000, '刷新间隔不短于 60s')
  assert.equal(custom.dataDir, '/tmp/usage-board')
})

test('readKeyFromDisk 只认 refs 段并去掉引号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-home-'))
  const previous = process.env.DSH_HOME
  try {
    writeFileSync(join(dir, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  some/record:',
      '    kind: grant',
      'refs:',
      '  DEEPSEEK_API_KEY: sk-abc123',
      '  QUOTED: "sk-quoted"',
      '',
    ].join('\n'), 'utf8')
    process.env.DSH_HOME = dir

    assert.equal(readKeyFromDisk('DEEPSEEK_API_KEY'), 'sk-abc123')
    assert.equal(readKeyFromDisk('QUOTED'), 'sk-quoted')
    assert.equal(readKeyFromDisk('MISSING'), '')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authorize 只接受等长的进程令牌', () => {
  assert.equal(authorize({ headers: { 'x-usage-board': 'abcdef' } }, 'abcdef'), true)
  assert.equal(authorize({ headers: { 'x-usage-board': 'abcdeg' } }, 'abcdef'), false)
  assert.equal(authorize({ headers: { 'x-usage-board': 'abc' } }, 'abcdef'), false)
  assert.equal(authorize({ headers: {} }, 'abcdef'), false)
})

/** 起一个真 node:http 服务并执行 run；handler 可以是 apply 注册的路由。 */
async function withHandler(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 起一个网关替身；handler 原样处理请求，返回 hits 供断言。 */
async function withGateway(handler, run) {
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null })
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`, hits)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 最小可用的 apply 上下文：只模拟 inject / effect / webserver / index-inject。 */
function createApplyCtx({ credentials = null, llm = null, settings = null } = {}) {
  const record = { routes: [], events: [], effects: [], injections: [] }
  const webCtx = {
    on(event, fn) {
      record.events.push({ event, fn })
    },
    effect(fn, label) {
      const dispose = fn()
      record.effects.push({ label, dispose })
      return dispose
    },
    webServer: {
      register(route) {
        record.routes.push(route)
        return () => {}
      },
    },
  }
  const services = { credentials, llm, settings }
  const ctx = {
    inject(names, run) {
      record.injections.push(names)
      if (names.includes('webServer')) {
        run(webCtx)
        return
      }
      if (names.every((name) => services[name] !== null && services[name] !== undefined)) {
        run({ ...services })
      }
    },
  }
  return { ctx, record }
}

function processToken(record) {
  const table = []
  for (const event of record.events) {
    if (event.event === 'webserver/index-inject') event.fn(table)
  }
  return table.find((row) => row.name === TOKEN_GLOBAL)?.value
}

function fakeCredentials(values = {}, fallback = undefined) {
  return {
    async resolve(ref) {
      const value = Object.hasOwn(values, ref) ? values[ref] : fallback
      return typeof value === 'string' && value !== '' ? { value, source: 'test' } : undefined
    },
    async describe(ref) {
      const value = Object.hasOwn(values, ref) ? values[ref] : fallback
      return { configured: typeof value === 'string' && value !== '', writable: true }
    },
    async set() {},
    async unset() {},
  }
}

test('buildFailurePayload：GatewayError 映射 code/needsSetup，未知错误归 network', () => {
  assert.deepEqual(buildFailurePayload(new GatewayError('缺少密钥', 'missing_credentials'), 42), {
    ok: false,
    error: '缺少密钥',
    code: 'missing_credentials',
    needsSetup: true,
    generatedAt: 42,
  })
  assert.deepEqual(buildFailurePayload(new GatewayError('限流', 'rate_limited'), 42), {
    ok: false,
    error: '限流',
    code: 'rate_limited',
    needsSetup: false,
    generatedAt: 42,
  })
  assert.equal(buildFailurePayload(new GatewayError('权限', 'forbidden')).needsSetup, true)
  assert.equal(buildFailurePayload(new GatewayError('供应商', 'unsupported_provider')).needsSetup, true)
  assert.equal(buildFailurePayload(new Error('boom')).code, 'network')
  assert.equal(buildFailurePayload(Object.assign(new Error('x'), { code: 'rate_limited' })).code, 'rate_limited')
})

test('createGateway：success:false 信封与 HTTP 状态都映射成带 code 的错误', async () => {
  /** 每个场景起一个只回固定响应的网关替身，走真实的 createGateway 方法。 */
  const cases = [
    { name: 'success:false invalid', path: '/api/log/token', status: 200, body: { success: false, message: 'invalid token' }, code: 'invalid_credentials' },
    { name: 'success:false permission', path: '/api/log/token', status: 200, body: { success: false, message: 'permission denied: missing scope' }, code: 'forbidden' },
    { name: 'success:false 无法识别', path: '/api/log/token', status: 200, body: { success: false, message: 'something bad' }, code: 'invalid_credentials' },
    { name: 'HTTP 401', path: '/api/log/token', status: 401, body: { success: false, message: 'invalid token' }, code: 'invalid_credentials' },
    { name: 'HTTP 403', path: '/api/log/token', status: 403, body: { message: 'forbidden' }, code: 'forbidden' },
    { name: 'HTTP 429', path: '/api/log/token', status: 429, body: { message: 'rate limit' }, code: 'rate_limited' },
    { name: 'HTTP 500 非 JSON', path: '/api/log/token', status: 500, raw: 'boom', code: 'network' },
    { name: 'HTTP 401 非 JSON', path: '/api/log/token', status: 401, raw: '<html>login</html>', code: 'invalid_credentials' },
    { name: 'HTTP 200 非 JSON', path: '/api/log/token', status: 200, raw: 'not-json', code: 'network' },
  ]

  for (const scenario of cases) {
    await withHandler((req, res) => {
      assert.equal(req.url, scenario.path, '方案与真实客户端路由应对齐')
      res.statusCode = scenario.status
      res.setHeader('content-type', 'application/json')
      res.end(scenario.raw ?? JSON.stringify(scenario.body))
    }, async (base) => {
      const gateway = createGateway({ baseUrl: base, apiKey: 'sk-test', timeoutMs: 1_000 })
      await assert.rejects(gateway.logs(), (error) => {
        assert.ok(error instanceof GatewayError, `${scenario.name}: 应抛 GatewayError，实际 ${error}`)
        assert.equal(error.code, scenario.code, scenario.name)
        assert.equal(error.status, scenario.status, scenario.name)
        return true
      })
    })
  }

  // `/api/usage/token/` 没有 success 字段：缺失时视为成功，不能误判。
  await withHandler((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { total_used: 1 } }))
  }, async (base) => {
    const gateway = createGateway({ baseUrl: base, apiKey: 'sk-test', timeoutMs: 1_000 })
    assert.deepEqual(await gateway.tokenUsage(), { data: { total_used: 1 } })
  })

  // 系统访问令牌路径同样受信封校验保护。
  await withHandler((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer access-token')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ success: false, message: 'permission denied' }))
  }, async (base) => {
    const gateway = createGateway({ baseUrl: base, accessToken: 'access-token', userId: 1, timeoutMs: 1_000 })
    await assert.rejects(gateway.userSelf(), (error) => error.code === 'forbidden')
  })
})

test('createGateway：连接失败/超时都归 network', async () => {
  const refused = createGateway({ baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', timeoutMs: 300 })
  await assert.rejects(refused.status(), (error) => error instanceof GatewayError && error.code === 'network')

  await withHandler((req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json')
      res.end('{"data":{}}')
    }, 200)
  }, async (base) => {
    const slow = createGateway({ baseUrl: base, apiKey: 'sk-test', timeoutMs: 20 })
    await assert.rejects(slow.status(), (error) => error instanceof GatewayError && error.code === 'network')
  })
})

test('refreshSummary：没有可用供应商/密钥时抛 missing_credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-host-'))
  try {
    await assert.rejects(
      refreshSummary({
        options: normalizeConfig({ dataDir: dir, baseUrl: 'http://127.0.0.1:9' }),
        resolveApiKey: async () => '',
        history: {},
      }),
      (error) => error instanceof GatewayError && error.code === 'missing_credentials',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summary 失败载荷：missing_credentials / invalid_credentials / forbidden / rate_limited / network', async (t) => {
  const cases = [
    {
      name: 'missing_credentials',
      credential: '',
      gateway: null,
      expected: { code: 'missing_credentials', needsSetup: true },
    },
    {
      name: 'invalid_credentials（HTTP 401）',
      credential: 'sk-bad',
      gateway: { status: 401, body: { success: false, message: 'invalid token' } },
      expected: { code: 'invalid_credentials', needsSetup: true },
    },
    {
      name: 'forbidden（success:false + permission）',
      credential: 'sk-limited',
      gateway: { status: 200, body: { success: false, message: 'permission denied' } },
      expected: { code: 'forbidden', needsSetup: true },
    },
    {
      name: 'rate_limited（HTTP 429）',
      credential: 'sk-busy',
      gateway: { status: 429, body: { success: false, message: 'rate limited' } },
      expected: { code: 'rate_limited', needsSetup: false },
    },
    {
      name: 'network（非 JSON）',
      credential: 'sk-bad',
      gateway: { status: 200, raw: '<html>oops</html>' },
      expected: { code: 'network', needsSetup: false },
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'usage-board-host-'))
      const previousHome = process.env.DSH_HOME
      process.env.DSH_HOME = dir
      let gatewayServer = null
      let baseUrl = 'http://127.0.0.1:9'
      if (scenario.gateway !== null) {
        gatewayServer = createServer((req, res) => {
          res.setHeader('content-type', 'application/json')
          const route = scenario.gateway
          res.statusCode = route.status
          res.end(route.raw ?? JSON.stringify(route.body))
        })
        await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve))
        baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`
      }
      try {
        const { ctx, record } = createApplyCtx({
          credentials: fakeCredentials({}, scenario.credential),
        })
        apply(ctx, { baseUrl, dataDir: dir })
        const token = processToken(record)
        assert.equal(typeof token, 'string')

        await withHandler(record.routes[0].handler, async (base) => {
          const response = await fetch(`${base}${SUMMARY_PATH}`, {
            headers: { [TOKEN_HEADER]: token },
          })
          assert.equal(response.status, 502)
          const body = await response.json()
          assert.equal(body.ok, false)
          assert.equal(body.code, scenario.expected.code)
          assert.equal(body.needsSetup, scenario.expected.needsSetup)
          assert.equal(typeof body.error, 'string')
          assert.equal(typeof body.generatedAt, 'number')
        })
      } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        if (gatewayServer !== null) {
          gatewayServer.closeAllConnections?.()
          await new Promise((resolve) => gatewayServer.close(resolve))
        }
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

test('apply：每次刷新重新发现选中供应商，切换 provider 后无需重启就换 key ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const state = { providerId: 'gateway-a', keyRef: 'KEY_A' }
    const credentials = fakeCredentials({ KEY_A: 'sk-a', KEY_B: 'sk-b', CONFIG_KEY: 'sk-config' })

    await withGateway((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/api/log/token')) {
        res.end(JSON.stringify({
          data: [{
            id: 1,
            created_at: Math.floor(Date.now() / 1000) - 5,
            type: 2,
            quota: 1_000,
            prompt_tokens: 10,
            completion_tokens: 20,
            use_time: 2,
            is_stream: true,
            model_name: 'demo-model',
            other: JSON.stringify({ frt: 200 }),
          }],
        }))
        return
      }
      if (req.url.startsWith('/api/usage/token/')) {
        res.end(JSON.stringify({ data: { total_used: 1_000_000, total_granted: 2_000_000, total_available: 1_000_000 } }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    }, async (baseUrl, hits) => {
      // 候选供应商必须指向与 config.baseUrl 相同 host，才能通过来源发现。
      const llm = {
        listConfigurableProviders() {
          return [{
            provider: state.providerId,
            displayName: state.providerId,
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', state.providerId],
          }]
        },
      }
      const settings = {
        describe() {
          return [{
            ns: 'llm-pi-ai',
            value: {
              providers: {
                [state.providerId]: { baseURL: `${baseUrl}/v1`, apiKeyEnv: state.keyRef },
              },
            },
          }]
        },
      }
      const { ctx, record } = createApplyCtx({ credentials, llm, settings })
      apply(ctx, { baseUrl, apiKeyRef: 'CONFIG_KEY', dataDir: dir })
      const token = processToken(record)

      await withHandler(record.routes[0].handler, async (base) => {
        const first = await fetch(`${base}${SUMMARY_PATH}?force=1`, { headers: { [TOKEN_HEADER]: token } })
        assert.equal(first.status, 200)
        assert.equal((await first.json()).ok, true)
        assert.ok(hits.every((hit) => hit.authorization === 'Bearer sk-a'), '应使用选中供应商 KEY_A，而不是 config.apiKeyRef')

        state.providerId = 'gateway-b'
        state.keyRef = 'KEY_B'
        const second = await fetch(`${base}${SUMMARY_PATH}?force=1`, { headers: { [TOKEN_HEADER]: token } })
        assert.equal(second.status, 200)
        assert.equal((await second.json()).ok, true)
        const auths = hits.map((hit) => hit.authorization)
        assert.ok(auths.includes('Bearer sk-a'))
        assert.ok(auths.includes('Bearer sk-b'), '切换供应商后下一次刷新应使用 KEY_B')
        assert.ok(!auths.includes('Bearer sk-config'))
      })
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})
