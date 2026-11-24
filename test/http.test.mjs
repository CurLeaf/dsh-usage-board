import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RequestError, classifyError, codeFromStatus, getJson } from '../lib/http.js'

/** 用一次性 fetch 替身跑 getJson，验证状态码/信封归一。 */
function withFetch(response, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } })
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original
    })
    .then(() => calls)
}

test('codeFromStatus 覆盖供应商会返回的状态', () => {
  assert.equal(codeFromStatus(401), 'invalid_credentials')
  assert.equal(codeFromStatus(402), 'payment_required')
  assert.equal(codeFromStatus(403), 'forbidden')
  assert.equal(codeFromStatus(404), 'not_found')
  assert.equal(codeFromStatus(429), 'rate_limited')
  assert.equal(codeFromStatus(503), 'network')
  assert.equal(codeFromStatus(200), null)
})

test('wandapi 的 error 信封被读成人话', async () => {
  await withFetch({ status: 402, body: JSON.stringify({ error: { type: 'balance_exhausted', message: 'Insufficient balance' } }) }, async () => {
    await assert.rejects(getJson('https://example.test/v1/usage'), (error) => {
      assert.ok(error instanceof RequestError)
      assert.equal(error.code, 'payment_required')
      assert.equal(error.message, 'Insufficient balance')
      return true
    })
  })
})

test('New API 的 success:false 归到凭据无效', async () => {
  await withFetch({ status: 200, body: JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }) }, async () => {
    await assert.rejects(getJson('https://example.test/api/user/self'), (error) => {
      assert.equal(error.code, 'invalid_credentials')
      assert.match(error.message, /无权/)
      return true
    })
  })
})

test('非 JSON 返回在 200 下归到 invalid_response', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  try {
    await assert.rejects(getJson('https://example.test/x'), (error) => {
      assert.equal(error.code, 'invalid_response')
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

test('网络失败归到 network，并带上超时说明', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  try {
    await assert.rejects(getJson('https://example.test/x'), (error) => {
      assert.equal(error.code, 'network')
      assert.match(error.message, /ECONNREFUSED/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

test('classifyError 只认已知 code，其余归 network', () => {
  assert.equal(classifyError(new RequestError('x', 'rate_limited')), 'rate_limited')
  assert.equal(classifyError({ code: 'forbidden' }), 'forbidden')
  assert.equal(classifyError({ code: 'weird' }), 'network')
  assert.equal(classifyError(new Error('boom')), 'network')
  assert.equal(classifyError(null), 'network')
})

test('连接层抖一下会重发一次，不把整份快照打死', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async () => {
    seen.push(1)
    if (seen.length === 1) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    assert.deepEqual(await getJson('https://example.test/x'), { ok: true })
    assert.equal(seen.length, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('一直连不上时把 undici 的 cause code 写进人话', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async () => {
    seen.push(1)
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  }
  try {
    await assert.rejects(getJson('https://example.test/x'), (error) => {
      assert.equal(error.code, 'network')
      assert.match(error.message, /fetch failed/)
      assert.match(error.message, /ECONNRESET/)
      return true
    })
    assert.equal(seen.length, 3, '一共试 3 次（1 次 + 2 次重试）')
  } finally {
    globalThis.fetch = original
  }
})
