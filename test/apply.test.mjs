import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { API_PATH, SUMMARY_PATH, TOKEN_FILE, TOKEN_GLOBAL, TOKEN_HEADER, apply, loadOrCreateToken } from '../index.js'

/**
 * 最小 ctx：「credentials」「webServer」两个注入 + effect 记录，
 * 足够跑通 apply 的真实接线（路由注册、令牌注入、SSE hub 清理）。
 */
function createCtx({ credentials = null } = {}) {
  const record = {
    routes: [],
    globals: [],
    effects: [],
    cleanups: [],
    injects: [],
  }
  const ctx = {
    inject(names, callback) {
      record.injects.push(names)
      if (names.includes('credentials')) callback({ credentials })
      if (names.includes('webServer')) callback({
        on(event, handler) {
          if (event === 'webserver/index-inject') handler(record.globals)
        },
        effect(factory, label) {
          record.effects.push(label)
          record.cleanups.push(factory())
        },
        webServer: {
          register(options) {
            record.routes.push(options)
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, record }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'usage-board-apply-'))
}

test('apply 注册前缀路由并注入进程令牌', async () => {
  const dir = tempDir()
  const { ctx, record } = createCtx({
    credentials: {
      resolve: async (ref) => ({ value: ref === 'WANDAPI_API_KEY' ? 'sk-test' : '' }),
      describe: async () => ({ configured: true }),
      set: async () => {},
      unset: async () => {},
    },
  })
  try {
    apply(ctx, {
      providers: [{ id: 'wandapi', kind: 'wandapi', baseUrl: 'http://127.0.0.1:9', keyRef: 'WANDAPI_API_KEY' }],
      dataDir: dir,
      refreshMs: 300_000,
    })

    const route = record.routes.find((item) => item.path === API_PATH)
    assert.ok(route !== undefined, '必须注册 /usage-board/api 前缀')
    assert.equal(route.kind, 'prefix')

    const token = record.globals.find((item) => item.name === TOKEN_GLOBAL)
    assert.ok(token !== undefined, '必须注入客户端令牌')
    assert.match(token.value, /^[0-9a-f]{32}$/)
    assert.deepEqual(record.injects, [['credentials'], ['webServer']])
    assert.ok(record.effects.includes('usage-board: summary api'))
    assert.ok(record.effects.includes('usage-board: stream hub'))

    // 用真 http 打一次：网关不可达 → 失败载荷（而不是抛错或空白）
    const server = createServer((req, res) => route.handler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const denied = await fetch(`http://127.0.0.1:${port}${SUMMARY_PATH}`)
      assert.equal(denied.status, 403)

      const response = await fetch(`http://127.0.0.1:${port}${SUMMARY_PATH}`, {
        headers: { [TOKEN_HEADER]: token.value },
      })
      assert.equal(response.status, 502)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.code, 'network')
      assert.equal(body.needsSetup, false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    for (const cleanup of record.cleanups) {
      if (typeof cleanup === 'function') cleanup()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply：供应商缺密钥时失败载荷要求进设置视图', async () => {
  const dir = tempDir()
  const { ctx, record } = createCtx({
    credentials: {
      resolve: async () => ({ value: '' }),
      describe: async () => ({ configured: false }),
      set: async () => {},
      unset: async () => {},
    },
  })
  try {
    apply(ctx, {
      providers: [{ id: 'wandapi', kind: 'wandapi', baseUrl: 'http://127.0.0.1:9', keyRef: 'WANDAPI_API_KEY' }],
      dataDir: dir,
    })
    const route = record.routes.find((item) => item.path === API_PATH)
    const token = record.globals[0].value
    const server = createServer((req, res) => route.handler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const response = await fetch(`http://127.0.0.1:${port}${SUMMARY_PATH}`, {
        headers: { [TOKEN_HEADER]: token },
      })
      const body = await response.json()
      assert.equal(body.code, 'missing_credentials')
      assert.equal(body.needsSetup, true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    for (const cleanup of record.cleanups) {
      if (typeof cleanup === 'function') cleanup()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('页面令牌落盘：重启复用同一枚，权限 0600', () => {
  const dir = tempDir()
  try {
    const first = loadOrCreateToken(dir)
    assert.match(first, /^[0-9a-f]{32}$/)
    // 模拟 dsh-web 重启：同一 dataDir 再取一次必须相同，否则已打开页面会 403
    const second = loadOrCreateToken(dir)
    assert.equal(second, first)
    const file = join(dir, TOKEN_FILE)
    assert.equal(readFileSync(file, 'utf8').trim(), first)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('令牌文件损坏或长度不对时重新生成', () => {
  const dir = tempDir()
  try {
    const file = join(dir, TOKEN_FILE)
    writeFileSync(file, 'oops')
    const token = loadOrCreateToken(dir)
    assert.match(token, /^[0-9a-f]{32}$/)
    assert.equal(readFileSync(file, 'utf8').trim(), token)

    writeFileSync(file, '0'.repeat(64))
    const next = loadOrCreateToken(dir)
    assert.match(next, /^[0-9a-f]{32}$/)
    assert.notEqual(next, '0'.repeat(64))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
