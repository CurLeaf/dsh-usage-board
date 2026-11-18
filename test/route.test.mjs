import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SOURCE_PATH, SOURCE_TEST_PATH, SUMMARY_PATH, STREAM_PATH, TOKEN_HEADER, createRouter } from '../index.js'
import { createSourceService, createSourceStore } from '../lib/source.js'
import { createStreamHub } from '../lib/stream.js'

const TOKEN = 'test-process-token'

/** 起一个真 node:http 服务，把路由挂上去；返回的 state 记录取数调用。 */
async function withServer(run, { stream = true, source = null } = {}) {
  const state = { cache: null, calls: 0, forces: [] }
  const hub = stream ? createStreamHub({ heartbeatMs: 0, retryMs: 1_234 }) : null
  const loadSummary = async (request = {}) => {
    state.calls += 1
    state.forces.push(request.force === true)
    const payload = { ok: true, generatedAt: 1, today: { cny: state.calls } }
    state.cache = payload
    // 宿主在 apply 里就是这样做的：刷新完把同一份快照推给所有订阅者
    hub?.publish(payload)
    return payload
  }
  const handler = createRouter({
    token: TOKEN,
    loadSummary,
    readCache: () => state.cache,
    stream: hub,
    source,
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run({ base: `http://127.0.0.1:${port}`, state, hub })
  } finally {
    hub?.close()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * 用假的 llm/settings/credentials 造一个真实的来源服务。
 * `candidates[].baseURL` 是 profile 里的原始地址，可以是 `.../v1`。
 */
function makeSource({
  gatewayBase,
  candidates = [{ id: 'gateway', name: '公司网关', baseURL: `${gatewayBase}/v1`, keyRef: 'GATEWAY_KEY' }],
  keyValues = { GATEWAY_KEY: 'sk-good' },
  initialAccessToken = 'access-token-abcd',
  onSourceChanged = async () => ({ ok: true }),
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-route-source-'))
  const calls = { set: [], unset: [], refresh: 0, resolveKey: [] }
  const tokenState = { value: initialAccessToken }
  const providers = candidates.map((candidate) => ({
    provider: candidate.id,
    displayName: candidate.name,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', candidate.id],
  }))
  const profiles = {}
  for (const candidate of candidates) {
    profiles[candidate.id] = { baseURL: candidate.baseURL }
    if (candidate.keyRef !== undefined) profiles[candidate.id].apiKeyEnv = candidate.keyRef
  }
  const services = {
    llm: { listConfigurableProviders: () => providers },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] },
    credentials: {
      async describe(ref) {
        return { configured: typeof keyValues[ref] === 'string' && keyValues[ref] !== '', writable: true }
      },
      async set(ref, value) {
        calls.set.push([ref, value])
        tokenState.value = value
      },
      async unset(ref) {
        calls.unset.push(ref)
        tokenState.value = ''
      },
    },
  }
  const source = createSourceService({
    options: {
      baseUrl: gatewayBase,
      apiKeyRef: 'DEFAULT_KEY',
      accessTokenRef: 'QZSY_ACCESS_TOKEN',
      userId: null,
    },
    store: createSourceStore(dir),
    services,
    resolveAccessToken: async () => tokenState.value,
    resolveKey: async (ref) => {
      calls.resolveKey.push(ref)
      return keyValues[ref] ?? ''
    },
    onSourceChanged: async () => {
      calls.refresh += 1
      return onSourceChanged()
    },
  })
  return {
    source,
    dir,
    calls,
    tokenState,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 起一个网关替身；`routes` 按 pathname 前缀映射 `[status, body]` 或处理函数。 */
async function withGateway(routes, run) {
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null })
    const match = Object.entries(routes).find(([prefix]) => req.url.startsWith(prefix))
    if (match === undefined) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end('{}')
      return
    }
    const route = match[1]
    if (typeof route === 'function') {
      route(req, res)
      return
    }
    const [status, body] = route
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    await run({ base, hits })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

const authHeaders = { [TOKEN_HEADER]: TOKEN }
const jsonHeaders = { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
}


async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('没有进程令牌一律 403', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}${SUMMARY_PATH}`)).status, 403)
    assert.equal((await fetch(`${base}${STREAM_PATH}`)).status, 403)
  })
})

test('SSE：先发 retry，连上后立刻收到快照，publish 继续推送', async () => {
  await withServer(async ({ base, hub }) => {
    const controller = new AbortController()
    const response = await fetch(`${base}${STREAM_PATH}`, {
      headers: { [TOKEN_HEADER]: TOKEN, accept: 'text/event-stream' },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`连接提前结束，未见 ${needle}`)
        text += decoder.decode(value, { stream: true })
      }
    }

    await readUntil('event: summary')
    assert.ok(text.includes('retry: 1234'), '首帧应带 retry 提示')
    assert.ok(text.includes('"cny":1'), '应立刻给出当前快照')

    hub.publish({ ok: true, today: { cny: 9 } })
    await readUntil('"cny":9')

    controller.abort()
    await waitFor(() => hub.size === 0)
  })
})

test('SSE：断开后宿主释放订阅，重连能拿到最新快照', async () => {
  await withServer(async ({ base, hub }) => {
    const first = new AbortController()
    const response = await fetch(`${base}${STREAM_PATH}`, {
      headers: { [TOKEN_HEADER]: TOKEN },
      signal: first.signal,
    })
    const reader = response.body.getReader()
    await reader.read()
    first.abort()
    await waitFor(() => hub.size === 0)

    const second = new AbortController()
    const again = await fetch(`${base}${STREAM_PATH}`, {
      headers: { [TOKEN_HEADER]: TOKEN },
      signal: second.signal,
    })
    const text = new TextDecoder().decode((await again.body.getReader().read()).value)
    assert.ok(text.startsWith('retry: 1234'), '重连同样先给 retry')
    second.abort()
  })
})

test('summary 路由：默认读缓存、force=1 透传', async () => {
  await withServer(async ({ base, state }) => {
    const first = await fetch(`${base}${SUMMARY_PATH}`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(first.status, 200)
    assert.equal((await first.json()).ok, true)
    assert.equal(state.calls, 1)
    assert.deepEqual(state.forces, [false])

    const forced = await fetch(`${base}${SUMMARY_PATH}?force=1`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(forced.status, 200)
    assert.deepEqual(state.forces, [false, true])
  })
})

test('方法/路径边界：POST 405、未知路径 404、HEAD 可用', async () => {
  await withServer(async ({ base }) => {
    const headers = { [TOKEN_HEADER]: TOKEN }
    assert.equal((await fetch(`${base}${STREAM_PATH}`, { method: 'POST', headers })).status, 405)
    assert.equal((await fetch(`${base}${SUMMARY_PATH}`, { method: 'POST', headers })).status, 405)
    assert.equal((await fetch(`${base}/usage-board/api/nope`, { headers })).status, 404)
    const head = await fetch(`${base}${SUMMARY_PATH}`, { method: 'HEAD', headers })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  })
})

test('没有 hub 时 /stream 返回 503，客户端会退回轮询', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}${STREAM_PATH}`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'stream-unavailable')
  }, { stream: false })
})

test('GET /source：鉴权、只回 token 尾 4 位、HEAD 可用', async () => {
  const gatewayBase = 'https://ai-api.qzsyzn.com'
  const fixture = makeSource({ gatewayBase })
  try {
    await withServer(async ({ base }) => {
      assert.equal((await fetch(`${base}${SOURCE_PATH}`)).status, 403)

      const response = await fetch(`${base}${SOURCE_PATH}`, { headers: authHeaders })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.deepEqual(body.gateway, { baseUrl: gatewayBase })
      assert.equal(body.readable, true)
      assert.deepEqual(body.selected, {
        providerId: 'gateway',
        name: '公司网关',
        usageBaseUrl: gatewayBase,
        keyStatus: 'configured',
      })
      assert.equal(body.candidates.length, 1)
      assert.deepEqual(body.candidates[0], {
        providerId: 'gateway',
        name: '公司网关',
        baseUrl: `${gatewayBase}/v1`,
        usageBaseUrl: gatewayBase,
        keyStatus: 'configured',
        selected: true,
      })
      assert.deepEqual(body.token, { configured: true, tail: '…abcd' })
      const text = JSON.stringify(body)
      assert.ok(!text.includes('access-token-abcd'), '不能回全量访问令牌')
      assert.ok(!text.includes('sk-good'), '不能回 API key')

      const head = await fetch(`${base}${SOURCE_PATH}`, { method: 'HEAD', headers: authHeaders })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
    }, { source: fixture.source })
  } finally {
    fixture.cleanup()
  }
})

test('GET /source：服务缺失时 readable:false、selected:null，不抛 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-route-source-'))
  try {
    const source = createSourceService({
      options: { baseUrl: 'https://ai-api.qzsyzn.com', apiKeyRef: 'DEFAULT_KEY', accessTokenRef: 'TOKEN' },
      store: createSourceStore(dir),
      services: null,
      resolveAccessToken: async () => '',
    })
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}${SOURCE_PATH}`, { headers: authHeaders })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.readable, false)
      assert.deepEqual(body.candidates, [])
      assert.equal(body.selected, null)
      assert.deepEqual(body.token, { configured: false, tail: null })
    }, { source })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /source：单候选自动选中、写 credentials、触发刷新并持久化 providerId', async () => {
  const gatewayBase = 'https://ai-api.qzsyzn.com'
  const fixture = makeSource({ gatewayBase })
  try {
    await withServer(async ({ base }) => {
      const response = await postJson(base, SOURCE_PATH, { accessToken: 'new-token-wxyz' })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.selected.providerId, 'gateway')
      assert.deepEqual(body.token, { configured: true, tail: '…wxyz' })
      assert.equal(body.refresh, undefined, '刷新成功时不额外塞 refresh')
      assert.deepEqual(fixture.calls.set, [['QZSY_ACCESS_TOKEN', 'new-token-wxyz']])
      assert.equal(fixture.calls.refresh, 1)
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.dir, 'source.json'), 'utf8')), { providerId: 'gateway' })
    }, { source: fixture.source })
  } finally {
    fixture.cleanup()
  }
})

test('POST /source：多候选必须指定 providerId，无候选报 unsupported_provider', async () => {
  const gatewayBase = 'https://ai-api.qzsyzn.com'
  const multi = makeSource({
    gatewayBase,
    candidates: [
      { id: 'gateway', name: '公司网关', baseURL: gatewayBase, keyRef: 'GATEWAY_KEY' },
      { id: 'gateway-2', name: '备用网关', baseURL: `${gatewayBase}/v1`, keyRef: 'SECOND_KEY' },
    ],
    keyValues: { GATEWAY_KEY: 'sk-good', SECOND_KEY: 'sk-second' },
  })
  const empty = makeSource({ gatewayBase, candidates: [], keyValues: {} })
  try {
    await withServer(async ({ base }) => {
      const missing = await postJson(base, SOURCE_PATH, {})
      assert.equal(missing.status, 400)
      assert.deepEqual(await missing.json(), {
        ok: false,
        code: 'provider_required',
        error: '存在多个指向该网关的供应商，请指定 providerId',
      })
      assert.equal(multi.calls.refresh, 0, '校验失败不应触发刷新')
      assert.deepEqual(multi.calls.set, [])

      const invalid = await postJson(base, SOURCE_PATH, { providerId: 'nope' })
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).code, 'unsupported_provider')

      const chosen = await postJson(base, SOURCE_PATH, { providerId: 'gateway-2' })
      assert.equal(chosen.status, 200)
      const body = await chosen.json()
      assert.equal(body.selected.providerId, 'gateway-2')
      assert.equal(body.selected.name, '备用网关')
      assert.deepEqual(JSON.parse(readFileSync(join(multi.dir, 'source.json'), 'utf8')), { providerId: 'gateway-2' })
    }, { source: multi.source })

    await withServer(async ({ base }) => {
      const response = await postJson(base, SOURCE_PATH, {})
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'unsupported_provider')
    }, { source: empty.source })
  } finally {
    multi.cleanup()
    empty.cleanup()
  }
})

test('POST /source：clearAccessToken 调用 unset，刷新失败仍返回已保存的 selected/token', async () => {
  const gatewayBase = 'https://ai-api.qzsyzn.com'
  const fixture = makeSource({ gatewayBase })
  try {
    await withServer(async ({ base }) => {
      const cleared = await postJson(base, SOURCE_PATH, { providerId: 'gateway', clearAccessToken: true })
      assert.equal(cleared.status, 200)
      const clearedBody = await cleared.json()
      assert.deepEqual(fixture.calls.unset, ['QZSY_ACCESS_TOKEN'])
      assert.deepEqual(clearedBody.token, { configured: false, tail: null })
      assert.equal(clearedBody.selected.providerId, 'gateway')
    }, { source: fixture.source })
  } finally {
    fixture.cleanup()
  }

  const failing = makeSource({
    gatewayBase,
    onSourceChanged: async () => ({ ok: false, code: 'rate_limited', error: '网关限流' }),
  })
  try {
    await withServer(async ({ base }) => {
      const response = await postJson(base, SOURCE_PATH, {})
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.selected.providerId, 'gateway')
      assert.deepEqual(body.token, { configured: true, tail: '…abcd' })
      assert.deepEqual(body.refresh, { ok: false, code: 'rate_limited', error: '网关限流' })
      assert.deepEqual(JSON.parse(readFileSync(join(failing.dir, 'source.json'), 'utf8')), { providerId: 'gateway' })
    }, { source: failing.source })
  } finally {
    failing.cleanup()
  }
})

test('POST /source：body 必须是 JSON 且不超过 4KB', async () => {
  const gatewayBase = 'https://ai-api.qzsyzn.com'
  const fixture = makeSource({ gatewayBase })
  try {
    await withServer(async ({ base }) => {
      const tooLarge = await fetch(`${base}${SOURCE_PATH}`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ filler: 'x'.repeat(5_000) }),
      })
      assert.equal(tooLarge.status, 413)
      const largeBody = await tooLarge.json()
      assert.equal(largeBody.ok, false)
      assert.equal(largeBody.code, 'body_too_large')

      const broken = await fetch(`${base}${SOURCE_PATH}`, {
        method: 'POST',
        headers: jsonHeaders,
        body: '{not-json',
      })
      assert.equal(broken.status, 400)
      const brokenBody = await broken.json()
      assert.equal(brokenBody.ok, false)
      assert.equal(brokenBody.code, 'invalid_body')

      const noAuth = await fetch(`${base}${SOURCE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(noAuth.status, 403)
    }, { source: fixture.source })
  } finally {
    fixture.cleanup()
  }
})

test('POST /source/test：key 只通时 logs 口径，带 token 时 aggregate 口径', async () => {
  const gatewayRoutes = {
    '/api/status': [200, { success: true, data: {} }],
    '/api/usage/token/': (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization === 'Bearer sk-good') {
        res.end(JSON.stringify({ data: { total_used: 1 } }))
      } else {
        res.statusCode = 401
        res.end(JSON.stringify({ success: false, message: 'invalid token' }))
      }
    },
    '/api/user/self': (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization === 'Bearer access-good') {
        res.end(JSON.stringify({ data: { id: 1 } }))
      } else {
        res.statusCode = 401
        res.end(JSON.stringify({ success: false, message: 'invalid token' }))
      }
    },
  }
  await withGateway(gatewayRoutes, async ({ base, hits }) => {
    const fixture = makeSource({
      gatewayBase: base,
      candidates: [{ id: 'gateway', name: '公司网关', baseURL: `${base}/v1`, keyRef: 'GATEWAY_KEY' }],
      keyValues: { GATEWAY_KEY: 'sk-good' },
      initialAccessToken: '',
    })
    try {
      await withServer(async ({ base: routeBase }) => {
        const logs = await postJson(routeBase, SOURCE_TEST_PATH, {})
        assert.equal(logs.status, 200)
        assert.deepEqual(await logs.json(), {
          ok: true,
          mode: 'logs',
          capabilities: { account: false, quotaData: true, logs: true },
        })
        assert.ok(hits.some((hit) => hit.url.startsWith('/api/status')))
        assert.ok(hits.some((hit) => hit.url.startsWith('/api/usage/token/')))
        assert.ok(!hits.some((hit) => hit.url.startsWith('/api/user/self')), '没有 token 时不探测 user/self')

        const aggregate = await postJson(routeBase, SOURCE_TEST_PATH, { accessToken: 'access-good' })
        assert.equal(aggregate.status, 200)
        assert.deepEqual(await aggregate.json(), {
          ok: true,
          mode: 'aggregate',
          capabilities: { account: true, quotaData: true, logs: true },
        })
        const userHit = hits.find((hit) => hit.url.startsWith('/api/user/self'))
        assert.equal(userHit?.authorization, 'Bearer access-good')
        assert.equal(fixture.calls.refresh, 0, '/source/test 不应触发刷新')
        assert.deepEqual(fixture.calls.set, [], '/source/test 不应写凭据')
      }, { source: fixture.source })
    } finally {
      fixture.cleanup()
    }
  })
})

test('POST /source/test：凭据无效返回 ok:false + code', async () => {
  const gatewayRoutes = {
    '/api/status': [200, { success: true, data: {} }],
    '/api/usage/token/': [401, { success: false, message: '无效的令牌' }],
  }
  await withGateway(gatewayRoutes, async ({ base }) => {
    const fixture = makeSource({
      gatewayBase: base,
      candidates: [{ id: 'gateway', name: '公司网关', baseURL: base, keyRef: 'GATEWAY_KEY' }],
      keyValues: { GATEWAY_KEY: 'sk-bad' },
      initialAccessToken: '',
    })
    try {
      await withServer(async ({ base: routeBase }) => {
        const response = await postJson(routeBase, SOURCE_TEST_PATH, {})
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.ok, false)
        assert.equal(body.code, 'invalid_credentials')
        assert.match(body.error, /无效/)
      }, { source: fixture.source })
    } finally {
      fixture.cleanup()
    }
  })
})
