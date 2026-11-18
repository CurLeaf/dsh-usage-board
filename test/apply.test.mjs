import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TOKEN_GLOBAL, apply } from '../index.js'

/** 记录宿主注册了什么，并给出一条能用的 fake webServer。 */
function createCtx() {
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
  const ctx = {
    inject(names, run) {
      record.injections.push(names)
      if (names.includes('webServer')) run(webCtx)
    },
    effect(fn) {
      record.effects.push({ dispose: fn() })
    },
  }
  return { ctx, record }
}

function fakeRes() {
  const chunks = []
  return {
    chunks,
    status: 0,
    headers: null,
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    on() {},
    off() {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(chunk)
      return true
    },
    end() {
      this.writableEnded = true
    },
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('apply 把 SSE 路由挂到 webServer，取数失败也会推给订阅者', async () => {
  const previousHome = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-apply-'))
  process.env.DSH_HOME = dir
  try {
    const { ctx, record } = createCtx()
    apply(ctx, {
      // 指向一个必然连不上的地址：走真实的失败路径，不碰公司网关
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-test',
      dataDir: dir,
    })

    const route = record.routes[0]
    assert.ok(route !== undefined, '应注册一条前缀路由')
    assert.equal(route.kind, 'prefix')

    // 进程令牌是通过 index 注入的，从这里取
    const table = []
    for (const event of record.events) {
      if (event.event === 'webserver/index-inject') event.fn(table)
    }
    const token = table.find((row) => row.name === TOKEN_GLOBAL)?.value
    assert.equal(typeof token, 'string')
    assert.ok(token.length >= 16)

    const res = fakeRes()
    const req = { method: 'GET', url: '/usage-board/api/stream', headers: { 'x-usage-board': token }, on() {} }
    route.handler(req, res)

    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.ok(res.chunks[0].startsWith('retry: '))

    await waitFor(() => res.chunks.join('').includes('event: summary'))
    assert.ok(res.chunks.join('').includes('"ok":false'), '取数失败应立刻推错误快照，而不是干等')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply 的刷新链路：真网关替身 → 聚合 → SSE 收到 ok 快照', async () => {
  const hits = []
  const gateway = createServer((req, res) => {
    hits.push(req.url)
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
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const { port } = gateway.address()

  const previousHome = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-live-'))
  process.env.DSH_HOME = dir
  try {
    const { ctx, record } = createCtx()
    apply(ctx, { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', dataDir: dir })

    const table = []
    for (const event of record.events) {
      if (event.event === 'webserver/index-inject') event.fn(table)
    }
    const token = table.find((row) => row.name === TOKEN_GLOBAL)?.value

    const res = fakeRes()
    record.routes[0].handler(
      { method: 'GET', url: '/usage-board/api/stream', headers: { 'x-usage-board': token }, on() {} },
      res,
    )

    await waitFor(() => res.chunks.join('').includes('"ok":true'))
    const text = res.chunks.join('')
    assert.ok(text.includes('event: summary'), '应推送 summary 事件')
    assert.ok(text.includes('"today"'), '推送的应是聚合后的看板快照')
    assert.ok(text.includes('demo-model'), '模型分布应来自网关替身')
    assert.deepEqual(hits.sort(), ['/api/log/token', '/api/usage/token/'])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
    gateway.closeAllConnections?.()
    await new Promise((resolve) => gateway.close(resolve))
  }
})
