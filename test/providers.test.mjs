import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createProvider as createNewApi, detectUserId } from '../lib/providers/newapi.js'
import { createProvider as createWandapi } from '../lib/providers/wandapi.js'
import { RequestError } from '../lib/http.js'

const AT = Date.parse('2026-11-19T13:50:00+08:00')
const TZ = 'Asia/Shanghai'

/** 按 URL 片段返回固定 JSON 的 fetch 替身。 */
function stubFetch(routes) {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    for (const [fragment, handler] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        const result = typeof handler === 'function' ? handler() : handler
        if (result instanceof Error) throw result
        return new Response(JSON.stringify(result), { status: result?.__status ?? 200, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 })
  }
  return {
    seen,
    restore() {
      globalThis.fetch = original
    },
  }
}

const WANDAPI_BODY = {
  remaining: 501.55,
  used: 1.45,
  total: 503,
  unit: 'Credits',
  timezone: 'Asia/Shanghai',
  periods: {
    today: {
      from: '2026-11-19', to: '2026-11-19', days: 1,
      requests: 307, successCount: 307, failedCount: 0, successRate: 1,
      promptTokens: 18_531_045, completionTokens: 171_249, totalTokens: 18_702_294,
      cost: 1.448055948,
      topModels: [
        { modelId: 'mp_x', modelName: 'deepseek-flash', requests: 306, cost: 1.447, totalTokens: 18_702_037, promptTokens: 18_530_838, completionTokens: 171_199, successCount: 306, failedCount: 0, successRate: 1 },
      ],
    },
    last7d: {
      from: '2026-11-13', to: '2026-11-19', days: 7,
      requests: 500, successCount: 495, failedCount: 5, successRate: 0.99,
      promptTokens: 20_000_000, completionTokens: 200_000, totalTokens: 20_200_000,
      cost: 2.5,
      topModels: [],
    },
    last30d: {
      from: '2026-10-21', to: '2026-11-19', days: 30,
      requests: 900, successCount: 890, failedCount: 10, successRate: 0.9889,
      promptTokens: 30_000_000, completionTokens: 300_000, totalTokens: 30_300_000,
      cost: 4.5,
      topModels: [
        { modelId: 'mp_x', modelName: 'deepseek-flash', requests: 890, cost: 4.49, totalTokens: 30_000_000 },
        { modelId: 'mp_y', modelName: 'MiniMax-M3.1-Flash', requests: 10, cost: 0.01, totalTokens: 300_000 },
      ],
    },
  },
}

test('wandapi：金额不换算，单位是 CNY，能力只有 periods/models', async () => {
  const stub = stubFetch({ '/v1/usage': WANDAPI_BODY })
  try {
    const provider = createWandapi({
      provider: { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://api.wandapi.com' },
      secrets: { apiKey: 'sk-test' },
    })
    const snapshot = await provider.fetchSnapshot({ now: AT })

    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.unit, 'CNY')
    assert.deepEqual([...snapshot.caps], ['periods', 'models'])
    assert.equal(snapshot.timeZone, 'Asia/Shanghai')
    assert.equal(snapshot.account.remaining, 501.55)
    assert.equal(snapshot.account.used, 1.45)
    // 原值直出，不做任何 quota/汇率换算
    assert.equal(snapshot.today.cost, 1.448055948)
    assert.equal(snapshot.today.tokensIn, 18_531_045)
    assert.equal(snapshot.today.tokensOut, 171_249)
    assert.equal(snapshot.periods.length, 3)
    assert.deepEqual(snapshot.periods.map((item) => item.key), ['today', 'last7d', 'last30d'])
    // successRate 换成出错率
    assert.ok(Math.abs(snapshot.periods[1].errorRate - 0.01) < 1e-12)
    assert.equal(snapshot.models[0].model, 'deepseek-flash')
    assert.equal(snapshot.models[0].requests, 890)
    // 没有小时粒度就不该出现这些键
    assert.equal(snapshot.hours, undefined)
    assert.equal(snapshot.heat, undefined)
    assert.equal(snapshot.recent, undefined)
    assert.equal(snapshot.notes.length, 1)
    // 只打一次 v1/usage
    assert.deepEqual(stub.seen, ['https://api.wandapi.com/v1/usage'])
  } finally {
    stub.restore()
  }
})

test('wandapi：缺 periods.today 视为返回不合法', async () => {
  const stub = stubFetch({ '/v1/usage': { remaining: 1, periods: {} } })
  try {
    const provider = createWandapi({
      provider: { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://api.wandapi.com' },
      secrets: { apiKey: 'sk-test' },
    })
    await assert.rejects(provider.fetchSnapshot({ now: AT }), (error) => {
      assert.ok(error instanceof RequestError)
      assert.equal(error.code, 'invalid_response')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('wandapi：402 余额不足原样冒泡', async () => {
  const stub = stubFetch({
    '/v1/usage': () => Object.assign(new Error('x'), {}),
  })
  stub.restore()
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: 'balance_exhausted', message: 'balance exhausted' } }), { status: 402 })
  try {
    const provider = createWandapi({
      provider: { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://api.wandapi.com' },
      secrets: { apiKey: 'sk-test' },
    })
    await assert.rejects(provider.fetchSnapshot({ now: AT }), (error) => {
      assert.equal(error.code, 'payment_required')
      assert.equal(error.status, 402)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

const NEWAPI_USER = {
  data: {
    quota: 15_000_000_000,
    used_quota: 10_000_000_000,
    request_count: 160_000,
  },
}

/** 两小时的 bins：每小时两个模型。 */
const NEWAPI_BINS = {
  data: [
    { created_at: Math.floor((AT - 2 * 3_600_000) / 1000), model_name: 'deepseek-flash', quota: 500_000, count: 10, token_used: 20_000 },
    { created_at: Math.floor((AT - 2 * 3_600_000) / 1000), model_name: 'deepseek-v4-pro', quota: 1_000_000, count: 5, token_used: 40_000 },
    { created_at: Math.floor((AT - 1 * 3_600_000) / 1000), model_name: 'deepseek-flash', quota: 250_000, count: 4, token_used: 10_000 },
  ],
}

const NEWAPI_LOGS = {
  data: {
    items: [
      {
        id: 1,
        created_at: Math.floor((AT - 60_000) / 1000),
        type: 2,
        model_name: 'deepseek-flash',
        quota: 50_000,
        prompt_tokens: 1_000,
        completion_tokens: 500,
        use_time: 4,
        is_stream: true,
        other: JSON.stringify({ frt: 500, cache_tokens: 200, cache_creation_tokens: 100 }),
      },
    ],
  },
}

const NEWAPI_ERRORS = { data: { total: 3 } }

test('newapi：quota 按 quotaPerUnit×price 换算，能力含 hourly/daily/heatmap', async () => {
  const stub = stubFetch({
    '/api/user/self': NEWAPI_USER,
    '/api/data/self': NEWAPI_BINS,
    '/api/log/self': (() => {
      let calls = 0
      return () => {
        calls += 1
        return calls === 1 ? NEWAPI_LOGS : NEWAPI_ERRORS
      }
    })(),
  })
  try {
    const provider = createNewApi({
      provider: {
        id: 'qzsy', kind: 'newapi', name: '公司网关',
        baseUrl: 'https://ai-api.qzsyzn.com',
        quotaPerUnit: 500_000,
        price: 1,
      },
      secrets: { apiKey: 'sk-test', accessToken: 'token-test' },
      userId: 6,
      timeZone: TZ,
    })
    const snapshot = await provider.fetchSnapshot({ now: AT })

    assert.equal(snapshot.unit, 'CNY')
    assert.deepEqual([...snapshot.caps], ['hourly', 'daily', 'heatmap', 'models', 'recent', 'throughput'])
    // 15e9 / 5e5 * 1 = 30000
    assert.equal(snapshot.account.remaining, 30_000)
    assert.equal(snapshot.account.used, 20_000)
    assert.equal(snapshot.account.total, 50_000)
    assert.equal(snapshot.account.requestCount, 160_000)

    assert.equal(snapshot.hours.length, 24)
    assert.equal(snapshot.days.length, 7)
    assert.equal(snapshot.heat.length, 7)
    assert.equal(snapshot.heat[0].cells.length, 24)

    // 今日：三行都在今天，quota 合计 1_750_000 → 3.5
    assert.equal(snapshot.today.cost, 3.5)
    assert.equal(snapshot.today.requests, 19)
    assert.equal(snapshot.today.date, '2026-11-19')

    // 近 24h 出错率 = errors / (requests + errors)
    assert.equal(snapshot.window.errors, 3)
    assert.equal(snapshot.window.requests, 19)
    assert.ok(Math.abs(snapshot.window.errorRate - 3 / 22) < 1e-9)

    // 模型按请求数排序
    assert.equal(snapshot.models[0].model, 'deepseek-flash')
    assert.equal(snapshot.models[0].requests, 14)

    // 最近请求：吞吐 = completion / (use_time - frt/1000) = 500 / 3.5
    const row = snapshot.recent[0]
    assert.ok(Math.abs(row.tps - 500 / 3.5) < 1e-9)
    assert.equal(row.ttftMs, 500)
    assert.equal(row.tokens, 1_000 + 200 + 100 + 500)
    assert.equal(row.cost, 0.1)
  } finally {
    stub.restore()
  }
})

test('newapi：user/self 缺 data 时判为返回不合法', async () => {
  const stub = stubFetch({
    '/api/user/self': { success: true },
    '/api/data/self': NEWAPI_BINS,
    '/api/log/self': NEWAPI_LOGS,
  })
  try {
    const provider = createNewApi({
      provider: { id: 'qzsy', kind: 'newapi', name: '公司网关', baseUrl: 'https://ai-api.qzsyzn.com', quotaPerUnit: 500_000, price: 1 },
      secrets: { apiKey: 'sk-test', accessToken: 'token-test' },
      userId: 6,
      timeZone: TZ,
    })
    await assert.rejects(provider.fetchSnapshot({ now: AT }), (error) => {
      assert.equal(error.code, 'invalid_response')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('detectUserId 从 sk 日志里取第一个 user_id', async () => {
  const stub = stubFetch({
    '/api/log/token': { data: [{ user_id: 0 }, { user_id: 7 }] },
  })
  try {
    assert.equal(await detectUserId({ baseUrl: 'https://x.test', apiKey: 'sk-test' }), 7)
  } finally {
    stub.restore()
  }
})

test('detectUserId 没有 user_id 时返回 null', async () => {
  const stub = stubFetch({ '/api/log/token': { data: [] } })
  try {
    assert.equal(await detectUserId({ baseUrl: 'https://x.test', apiKey: 'sk-test' }), null)
  } finally {
    stub.restore()
  }
})
