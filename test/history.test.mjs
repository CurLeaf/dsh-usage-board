import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHistoryStore } from '../lib/history.js'

const NOW = Date.parse('2026-11-17T10:48:00+08:00')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-board-'))
}

test('小时桶落盘后能被新实例读回', () => {
  const dir = tempDir()
  try {
    const first = createHistoryStore(dir)
    first.mergeHours({ '2026-11-17 09': { requests: 3, quota: 900, prompt: 10, completion: 20, errors: 0 } }, null, NOW)
    first.save()

    const second = createHistoryStore(dir)
    assert.deepEqual(second.hours['2026-11-17 09'], { requests: 3, quota: 900, prompt: 10, completion: 20, errors: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('残缺边界小时取较大值，别被后一次刷新改小', () => {
  const dir = tempDir()
  try {
    const store = createHistoryStore(dir)
    const key = '2026-11-17 10'
    store.mergeHours({ [key]: { requests: 40, quota: 1000, prompt: 0, completion: 0, errors: 0 } }, null, NOW)
    store.mergeHours({ [key]: { requests: 12, quota: 300, prompt: 0, completion: 0, errors: 0 } }, key, NOW)
    assert.equal(store.hours[key].requests, 40)
    assert.equal(store.hours[key].quota, 1000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('跨过 14 天的旧桶被清掉', () => {
  const dir = tempDir()
  try {
    const store = createHistoryStore(dir)
    store.mergeHours({
      '2026-10-01 09': { requests: 1, quota: 1, prompt: 0, completion: 0, errors: 0 },
      '2026-11-16 09': { requests: 1, quota: 1, prompt: 0, completion: 0, errors: 0 },
    }, null, NOW)
    assert.equal(store.hours['2026-10-01 09'], undefined)
    assert.ok(store.hours['2026-11-16 09'] !== undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('每天只记一次总额基线，跨天重置', () => {
  const dir = tempDir()
  try {
    const store = createHistoryStore(dir)
    const first = store.ensureToday(1_000, NOW)
    assert.equal(first.date, '2026-11-17')
    assert.equal(first.baseUsed, 1_000)

    const again = store.ensureToday(9_999, NOW + 60_000)
    assert.equal(again.baseUsed, 1_000, '同一天不覆盖基线')

    const nextDay = store.ensureToday(5_000, NOW + 24 * 3_600_000)
    assert.equal(nextDay.date, '2026-11-18')
    assert.equal(nextDay.baseUsed, 5_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏的历史文件按空历史处理', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'history.json'), '{not json', 'utf8')
    const store = createHistoryStore(dir)
    assert.deepEqual(store.hours, {})
    assert.equal(store.today, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
