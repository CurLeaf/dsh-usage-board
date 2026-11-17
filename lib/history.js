/**
 * 逐小时历史桶的落盘。
 *
 * 为什么要历史：网关日志只给最近 1000 条（约半天到一天），热力图要跨 7 天，
 * 所以每次刷新把「当前窗口完整覆盖到的小时」写进 `hours`，残缺的边界小时保留
 * 旧值。今日基线（`today`）用于窗口被截断时用 `total_used` 差值兜底。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey, startOfDay } from './aggregate.js'

const KEEP_DAYS = 14

const EMPTY = () => ({ version: 1, hours: {}, today: null })

/**
 * @param {string} directory 持久化目录（不存在时自动创建）
 */
export function createHistoryStore(directory) {
  const file = join(directory, 'history.json')
  let state = load()
  let dirty = false

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return EMPTY()
      const hours = parsed.hours !== null && typeof parsed.hours === 'object' ? parsed.hours : {}
      const today = parsed.today !== null && typeof parsed.today === 'object' ? parsed.today : null
      return { version: 1, hours, today }
    } catch {
      return EMPTY()
    }
  }

  function prune(now) {
    const floor = startOfDay(now) - KEEP_DAYS * 86_400_000
    for (const key of Object.keys(state.hours)) {
      const stamp = Date.parse(`${key.slice(0, 10)}T00:00:00+08:00`)
      if (!Number.isFinite(stamp) || stamp < floor) {
        delete state.hours[key]
        dirty = true
      }
    }
  }

  /**
   * 把本轮的完整小时桶并入历史。
   * @param {Record<string, Record<string, number>>} buckets `YYYY-MM-DD HH` → 桶
   * @param {string | null} partialHour 窗口最早、可能被截断的小时
   * @param {number} now
   */
  function mergeHours(buckets, partialHour, now) {
    for (const [key, bucket] of Object.entries(buckets)) {
      if (partialHour !== null && key === partialHour && state.hours[key] !== undefined) {
        const previous = state.hours[key]
        // 同一残缺小时：取两者较大值，避免后一次刷新把前一次统计得更全的值覆盖掉
        state.hours[key] = {
          requests: Math.max(previous.requests ?? 0, bucket.requests ?? 0),
          quota: Math.max(previous.quota ?? 0, bucket.quota ?? 0),
          prompt: Math.max(previous.prompt ?? 0, bucket.prompt ?? 0),
          completion: Math.max(previous.completion ?? 0, bucket.completion ?? 0),
          errors: Math.max(previous.errors ?? 0, bucket.errors ?? 0),
        }
      } else {
        state.hours[key] = { ...bucket }
      }
      dirty = true
    }
    prune(now)
  }

  /**
   * 每换一天记一次总额基线。只在当天前 10 小时内记录，晚于这个点就不再改，
   * 免得把「已经用掉的部分」当成 0。
   * @param {number} totalUsed 网关报告的累计额度
   * @param {number} now
   * @returns {{ date: string, baseUsed: number, capturedAt: number } | null}
   */
  function ensureToday(totalUsed, now) {
    const date = dayKey(now)
    if (state.today !== null && state.today.date === date) return state.today
    const capturedAt = now
    state.today = { date, baseUsed: Number(totalUsed) || 0, capturedAt }
    dirty = true
    return state.today
  }

  function save() {
    if (!dirty) return
    try {
      mkdirSync(directory, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state), 'utf8')
      renameSync(tmp, file)
      dirty = false
    } catch (error) {
      // 落盘失败不影响本轮数据展示，下一轮再试
      dirty = true
    }
  }

  return {
    get hours() {
      return state.hours
    },
    get today() {
      return state.today
    },
    mergeHours,
    ensureToday,
    save,
    path: file,
  }
}
