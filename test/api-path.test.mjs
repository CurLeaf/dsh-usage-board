import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSummaryFromApi } from '../lib/aggregate.js'

const NOW = Date.parse('2026-11-17T12:00:00+08:00')
const sec = (ts) => Math.floor(ts / 1000)

function logRow(over = {}) {
  return {
    id: 1,
    created_at: sec(NOW) - 60,
    type: 2,
    quota: 5000,
    prompt_tokens: 100,
    completion_tokens: 200,
    use_time: 4,
    is_stream: true,
    model_name: 'deepseek-flash',
    other: JSON.stringify({ frt: 400 }),
    ...over,
  }
}

test('登录态聚合：今日 / 近 24h 直接用后台桶，不做窗口截断', () => {
  const todayHour = sec(NOW) - 3600
  const yesterdayHour = sec(NOW) - 20 * 3600
  const summary = buildSummaryFromApi({
    quotaRows: [
      { created_at: todayHour, model_name: 'deepseek-flash', quota: 500_000, count: 10, token_used: 1000 },
      { created_at: todayHour, model_name: 'deepseek-v4-flash', quota: 100_000, count: 4, token_used: 200 },
      { created_at: yesterdayHour, model_name: 'deepseek-flash', quota: 250_000, count: 5, token_used: 500 },
    ],
    logRows: [logRow(), logRow({ id: 2, created_at: sec(NOW) - 30 })],
    user: { quota: 2_000_000, used_quota: 9_000_000, request_count: 42 },
    errors24h: 1,
    now: NOW,
    quotaPerUnit: 500_000,
    price: 1,
    refreshMs: 300_000,
  })

  assert.equal(summary.source, 'api')
  assert.equal(summary.today.quota, 600_000)
  assert.equal(summary.today.cny, 1.2, 'price=1 时 600000 额度 = 1.2')
  assert.equal(summary.today.requests, 14)
  assert.equal(summary.today.exact, true)
  assert.equal(summary.window.quota, 850_000)
  assert.equal(summary.window.requests, 19)
  assert.equal(summary.window.errors, 1)
  assert.ok(Math.abs(summary.window.errorRate - 1 / 19) < 1e-9)
  assert.equal(summary.account.totalUsedQuota, 9_000_000)
  assert.equal(summary.account.remainingQuota, 2_000_000)
  assert.equal(summary.account.requestCount, 42)
  assert.equal(summary.hours.length, 24)
  assert.equal(summary.days.length, 7)
  assert.equal(summary.heat.length, 7)
  assert.equal(summary.models[0].model, 'deepseek-flash')
  assert.equal(summary.recent.length, 2)
  assert.ok(summary.window.tps > 0)
})

test('登录态聚合：空桶不抛错且今日为 0', () => {
  const summary = buildSummaryFromApi({
    quotaRows: [],
    logRows: [],
    user: { quota: 0, used_quota: 0, request_count: 0 },
    errors24h: 0,
    now: NOW,
    quotaPerUnit: 500_000,
    price: 1,
    refreshMs: 300_000,
  })
  assert.equal(summary.today.quota, 0)
  assert.equal(summary.today.cny, 0)
  assert.equal(summary.window.requests, 0)
  assert.equal(summary.window.errorRate, 0)
  assert.deepEqual(summary.recent, [])
})
