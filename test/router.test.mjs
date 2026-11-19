import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import {
  MAX_BODY_BYTES,
  SOURCE_PATH,
  SOURCE_TEST_PATH,
  STREAM_PATH,
  SUMMARY_PATH,
  TOKEN_HEADER,
  createRouter,
} from '../index.js'

const TOKEN = 'test-token'

/** 起一个真 http 服务，返回基址与调用记录。 */
async function withServer(routes, run) {
  const calls = []
  const handler = createRouter({
    token: TOKEN,
    loadSummary: async (request) => {
      calls.push(['summary', request])
      return routes.summary ? routes.summary(request) : { ok: true, provider: { id: 'wandapi' }, cost: 1 }
    },
    readCache: () => routes.cache ?? null,
    stream: routes.stream ?? null,
    describeSource: async () => {
      calls.push(['describe'])
      return { ok: true, providers: [], selected: 'wandapi' }
    },
    switchProvider: async (body) => {
      calls.push(['switch', body])
      return { ok: true, selected: body.provider, snapshot: { ok: true } }
    },
    testProvider: async (body) => {
      calls.push(['test', body])
      return { ok: true, caps: ['periods'] }
    },
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    return await run({ base, calls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const authed = { [TOKEN_HEADER]: TOKEN }

test('没有进程令牌一律 403，并带 token_mismatch 供面板提示刷新', async () => {
  await withServer({}, async ({ base }) => {
    for (const path of [SUMMARY_PATH, SOURCE_PATH, STREAM_PATH]) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 403, path)
      const body = await response.json()
      assert.equal(body.code, 'token_mismatch')
      assert.match(body.error, /刷新页面/)
    }
    // /source/test 是 POST-only：鉴权在方法检查之后，先 405 再 403
    const post = await fetch(`${base}${SOURCE_TEST_PATH}`, { method: 'POST', body: '{}' })
    assert.equal(post.status, 403)
  })
})

test('GET /summary 走 loadSummary，force 透传', async () => {
  await withServer({}, async ({ base, calls }) => {
    const first = await fetch(`${base}${SUMMARY_PATH}`, { headers: authed })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true, provider: { id: 'wandapi' }, cost: 1 })
    assert.deepEqual(calls.at(-1), ['summary', { force: false }])

    await fetch(`${base}${SUMMARY_PATH}?force=1`, { headers: authed })
    assert.deepEqual(calls.at(-1), ['summary', { force: true }])
  })
})

test('失败载荷回 502（面板据此进失效视图）', async () => {
  await withServer({
    summary: async () => ({ ok: false, code: 'payment_required', error: '余额不足' }),
  }, async ({ base }) => {
    const response = await fetch(`${base}${SUMMARY_PATH}`, { headers: authed })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.code, 'payment_required')
    assert.equal(body.ok, false)
  })
})

test('GET /source 返回供应商清单', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}${SOURCE_PATH}`, { headers: authed })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).selected, 'wandapi')
  })
})

test('POST /source 切换供应商，body 原样交给宿主', async () => {
  await withServer({}, async ({ base, calls }) => {
    const response = await fetch(`${base}${SOURCE_PATH}`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'qzsy' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, selected: 'qzsy', snapshot: { ok: true } })
    assert.deepEqual(calls.at(-1), ['switch', { provider: 'qzsy' }])
  })
})

test('POST /source 的非法 JSON 与超大 body 被拦下', async () => {
  await withServer({}, async ({ base }) => {
    const invalid = await fetch(`${base}${SOURCE_PATH}`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).code, 'invalid_body')

    const tooLarge = await fetch(`${base}${SOURCE_PATH}`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'x'.repeat(MAX_BODY_BYTES + 16) }),
    })
    assert.equal(tooLarge.status, 413)
    assert.equal((await tooLarge.json()).code, 'body_too_large')
  })
})

test('POST /source/test 只探测', async () => {
  await withServer({}, async ({ base, calls }) => {
    const response = await fetch(`${base}${SOURCE_TEST_PATH}`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'wandapi' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, caps: ['periods'] })
    assert.deepEqual(calls.at(-1), ['test', { provider: 'wandapi' }])
  })
})

test('未知路径 404，方法不对 405', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/usage-board/api/nope`, { headers: authed })).status, 404)
    assert.equal((await fetch(`${base}${SUMMARY_PATH}`, { method: 'POST', headers: authed })).status, 405)
    assert.equal((await fetch(`${base}${STREAM_PATH}`, { method: 'POST', headers: authed })).status, 405)
  })
})

test('SSE 路由把缓存快照先发给新连接', async () => {
  const attached = []
  const stream = {
    size: 1,
    attach(req, res, options) {
      attached.push(options)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end()
      return { id: 1 }
    },
    publish() {},
    close() {},
  }
  await withServer({ stream, cache: { ok: true, provider: { id: 'wandapi' } } }, async ({ base }) => {
    const response = await fetch(`${base}${STREAM_PATH}`, { headers: authed, signal: AbortSignal.timeout(2_000) })
    assert.equal(response.status, 200)
    await response.text().catch(() => {})
    assert.equal(attached.length, 1)
    assert.deepEqual(attached[0].payload, { ok: true, provider: { id: 'wandapi' } })
  })
})
