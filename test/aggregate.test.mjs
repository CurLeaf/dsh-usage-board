import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSummary,
  dayKey,
  hourKey,
  normalizeRow,
  startOfDay,
  toCny,
} from '../lib/aggregate.js'

const NOW = Date.parse('2026-11-17T10:48:00+08:00')
const MONEY = { quotaPerUnit: 500_000, price: 7.3 }

/** 一条正常消费日志（默认今天 10:46，流式，804 输出 token / 5s / 首字 331ms） */
function row(over = {}) {
  return {
    id: 1,
    created_at: Math.floor(NOW / 1000) - 120,
    type: 2,
    quota: 16_566,
    prompt_tokens: 348,
    completion_tokens: 804,
    use_time: 5,
    is_stream: true,
    model_name: 'deepseek-flash',
    other: JSON.stringify({ frt: 331, cache_tokens: 119_040 }),
    ...over,
  }
}

const usage = (totalUsed, totalGranted = 7_686_360_685) => ({
  data: {
    total_used: totalUsed,
    total_granted: totalGranted,
    total_available: totalGranted - totalUsed,
    unlimited_quota: true,
  },
})

test('normalizeRow 用 use_time 减首字算解码吞吐', () => {
  const record = normalizeRow(row({ completion_tokens: 900, use_time: 10, other: JSON.stringify({ frt: 500 }) }))
  assert.equal(record.ttftMs, 500)
  assert.equal(record.totalMs, 10_000)
  // 900 / 9.5s
  assert.ok(Math.abs(record.tps - 94.7368) < 0.01, `tps=${record.tps}`)
  assert.equal(record.error, false)
  assert.equal(record.tokens, 348 + 900)

  const cached = normalizeRow(row())
  assert.equal(cached.tokens, 348 + 119_040 + 804, 'token 合计含缓存命中')
})

test('normalizeRow 对非流式 / 缺字段不产生吞吐', () => {
  const sync = normalizeRow(row({ is_stream: false }))
  assert.equal(sync.tps, null)
  const broken = normalizeRow({ id: 9, created_at: 1, type: 2 })
  assert.equal(broken.tps, null)
  assert.equal(broken.ttftMs, null)
  assert.equal(broken.quota, 0)
})

test('buildSummary 汇总今日、窗口错误率与金额', () => {
  const base = Math.floor(NOW / 1000)
  const rows = [
    row({ id: 1, created_at: base - 400, quota: 10_000, completion_tokens: 1000, use_time: 5 }),
    row({ id: 2, created_at: base - 300, quota: 20_000, completion_tokens: 2000, use_time: 8 }),
    row({ id: 3, created_at: base - 200, type: 5, quota: 0, completion_tokens: 0, use_time: 0, content: 'upstream error' }),
    row({ id: 4, created_at: base - 100, quota: 30_000, completion_tokens: 3000, use_time: 12 }),
  ]
  const summary = buildSummary({
    rows,
    usage: usage(9_900_000_000),
    now: NOW,
    quotaPerUnit: MONEY.quotaPerUnit,
    price: MONEY.price,
    refreshMs: 60_000,
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.window.requests, 4)
  assert.equal(summary.window.errors, 1)
  assert.equal(summary.window.errorRate, 0.25)
  assert.equal(summary.window.quota, 60_000)
  assert.ok(Math.abs(summary.window.cny - toCny(60_000, MONEY)) < 1e-9)
  assert.equal(summary.today.requests, 4)
  // 错误日志不计入 token 合计：3 条消费行，每行含 119040 缓存 token
  assert.equal(summary.today.tokens, (348 + 119_040) * 3 + 6000)
  // 窗口只覆盖今天，因此今日用量按「下限」标记，且没有基线可用
  assert.equal(summary.today.exact, false)
  assert.equal(summary.today.basis, 'logs-partial')
  assert.ok(summary.tps === undefined)
  assert.equal(summary.account.unlimited, true)
  assert.equal(summary.hours.length, 24)
  assert.equal(summary.days.length, 7)
  assert.equal(summary.heat.length, 7)
  assert.equal(summary.heat[0].cells.length, 24)
  assert.ok(summary.short.tps > 0)
  assert.equal(summary.recent.length, 4)
  assert.ok(summary.recent[0].t > summary.recent[1].t, '最近请求应倒序')
  assert.equal(summary.models[0].model, 'deepseek-flash')
})

test('窗口跨过零点时今日用量按日志精确统计', () => {
  const yesterday = Math.floor((startOfDay(NOW) - 2 * 3_600_000) / 1000)
  const rows = [
    row({ id: 1, created_at: yesterday, quota: 5_000 }),
    row({ id: 2, quota: 60_000 }),
  ]
  const summary = buildSummary({
    rows,
    usage: usage(1_000_000),
    now: NOW,
    quotaPerUnit: MONEY.quotaPerUnit,
    price: MONEY.price,
    refreshMs: 60_000,
  })
  assert.equal(summary.today.exact, true)
  assert.equal(summary.today.basis, 'logs')
  assert.equal(summary.today.quota, 60_000)
  assert.equal(summary.today.requests, 1)
})

test('窗口被截断时用总额基线差值兜底今日用量', () => {
  const baseUsed = 9_000_000_000
  const summary = buildSummary({
    rows: [row({ id: 1, quota: 20_000 })],
    usage: usage(baseUsed + 500_000),
    now: NOW,
    quotaPerUnit: MONEY.quotaPerUnit,
    price: MONEY.price,
    refreshMs: 60_000,
    todayBaseline: { date: dayKey(NOW), baseUsed, capturedAt: startOfDay(NOW) + 5 * 60_000 },
  })
  assert.equal(summary.today.exact, true)
  assert.equal(summary.today.basis, 'baseline')
  assert.equal(summary.today.quota, 500_000)
  assert.ok(Math.abs(summary.today.cny - toCny(500_000, MONEY)) < 1e-9)
})

test('历史小时桶并入近 7 天与热力图', () => {
  const yesterdayKey = hourKey(startOfDay(NOW) - 24 * 3_600_000 + 9 * 3_600_000)
  const summary = buildSummary({
    rows: [row({ id: 1 })],
    usage: usage(1),
    now: NOW,
    quotaPerUnit: MONEY.quotaPerUnit,
    price: MONEY.price,
    refreshMs: 60_000,
    hourBuckets: {
      [yesterdayKey]: { requests: 12, quota: 240_000, prompt: 100, completion: 200, errors: 0 },
    },
  })
  const yesterdayId = dayKey(startOfDay(NOW) - 24 * 3_600_000)
  const bucket = summary.days.find((day) => day.date === yesterdayId)
  assert.ok(bucket !== undefined, '昨日应出现在近 7 天里')
  assert.equal(bucket.requests, 12)
  assert.ok(Math.abs(bucket.cny - toCny(240_000, MONEY)) < 1e-9)
  const heatRow = summary.heat.find((day) => day.date === yesterdayId)
  assert.equal(heatRow.cells[9].requests, 12)
})

test('空日志窗口不抛错', () => {
  const summary = buildSummary({
    rows: [],
    usage: usage(0),
    now: NOW,
    quotaPerUnit: MONEY.quotaPerUnit,
    price: MONEY.price,
    refreshMs: 60_000,
  })
  assert.equal(summary.window.requests, 0)
  assert.equal(summary.window.errorRate, 0)
  assert.equal(summary.today.exact, false)
  assert.equal(summary.hours.length, 24)
  assert.deepEqual(summary.recent, [])
})
