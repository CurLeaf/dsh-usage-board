import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clockLabel, dayKey, hourKey, startOfDay, zoneOffsetMs } from '../lib/time.js'

const SHANGHAI = 'Asia/Shanghai'
/** 2026-11-19 13:50:00 +08:00 */
const AT = Date.parse('2026-11-19T13:50:00+08:00')

test('zoneOffsetMs 按 IANA 时区算偏移', () => {
  assert.equal(zoneOffsetMs(SHANGHAI, AT), 8 * 3_600_000)
  assert.equal(zoneOffsetMs('UTC', AT), 0)
  // 冬令时的时区不能按写死的 +8 算
  assert.equal(zoneOffsetMs('America/New_York', AT), -5 * 3_600_000)
})

test('时区名非法时抛错而不是静默按 UTC', () => {
  assert.throws(() => zoneOffsetMs('Mars/Olympus', AT), /无效的 timeZone/)
})

test('startOfDay 给出当地 00:00', () => {
  const start = startOfDay(AT, SHANGHAI)
  assert.equal(new Date(start).toISOString(), '2026-11-18T16:00:00.000Z')
  assert.equal(dayKey(start, SHANGHAI), '2026-11-19')
})

test('dayKey / hourKey / clockLabel 用当地时区', () => {
  assert.equal(dayKey(AT, SHANGHAI), '2026-11-19')
  assert.equal(hourKey(AT, SHANGHAI), '2026-11-19 13')
  assert.equal(clockLabel(AT, SHANGHAI), '13:50:00')
  // 同一时刻在 UTC 下是另一个日期
  assert.equal(dayKey(AT, 'UTC'), '2026-11-19')
  // AT 在 UTC 是 05:50，往前 9 小时跨到前一天
  assert.equal(hourKey(AT - 9 * 3_600_000, 'UTC'), '2026-11-18 20')
})

test('跨日边界：当地 00:30 属于新的一天', () => {
  const early = Date.parse('2026-11-19T00:30:00+08:00')
  assert.equal(dayKey(early, SHANGHAI), '2026-11-19')
  assert.equal(dayKey(early - 3_600_000, SHANGHAI), '2026-11-18')
  assert.equal(startOfDay(early, SHANGHAI), Date.parse('2026-11-19T00:00:00+08:00'))
})
