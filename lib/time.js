/**
 * 时区相关的纯函数。
 *
 * 两个供应商的切日口径不同：New API 没有时区字段（配置里给），wandapi 在
 * `/v1/usage` 里直接回 `timezone`。所以这里不写死 +08:00，而是按传入的 IANA
 * 时区算偏移；偏移按小时缓存，避免每行日志都调 Intl。
 */

export const HOUR = 3_600_000
export const DAY = 86_400_000

const OFFSET_CACHE = new Map()

/**
 * 某个 IANA 时区在 `at` 时刻相对 UTC 的偏移（毫秒，东八区为 +8h）。
 * @param {string} timeZone
 * @param {number} at epoch ms
 * @returns {number}
 */
export function zoneOffsetMs(timeZone, at) {
  const zone = typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'UTC'
  const hourBucket = Math.floor(at / HOUR)
  const cacheKey = `${zone}#${hourBucket}`
  const hit = OFFSET_CACHE.get(cacheKey)
  if (hit !== undefined) return hit

  let offset = 0
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = {}
    for (const part of format.formatToParts(new Date(at))) parts[part.type] = part.value
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    offset = asUtc - Math.floor(at / 1000) * 1000
  } catch {
    // 非法时区名：让调用方知道配置错了，而不是悄悄按 UTC 算
    throw new Error(`usage-board: 无效的 timeZone「${zone}」`)
  }
  if (OFFSET_CACHE.size > 4096) OFFSET_CACHE.clear()
  OFFSET_CACHE.set(cacheKey, offset)
  return offset
}

const pad = (value) => String(value).padStart(2, '0')

/** @param {number} ts @param {string} timeZone @returns {number} 当地 00:00 的 epoch ms */
export function startOfDay(ts, timeZone) {
  const offset = zoneOffsetMs(timeZone, ts)
  return Math.floor((ts + offset) / DAY) * DAY - offset
}

/** @param {number} ts @param {string} timeZone @returns {string} `YYYY-MM-DD` */
export function dayKey(ts, timeZone) {
  const offset = zoneOffsetMs(timeZone, ts)
  const date = new Date(ts + offset)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** @param {number} ts @param {string} timeZone @returns {string} `YYYY-MM-DD HH` */
export function hourKey(ts, timeZone) {
  const offset = zoneOffsetMs(timeZone, ts)
  return `${dayKey(ts, timeZone)} ${pad(new Date(ts + offset).getUTCHours())}`
}

/** @param {number} ts @param {string} timeZone @returns {string} `HH:MM:SS` */
export function clockLabel(ts, timeZone) {
  const offset = zoneOffsetMs(timeZone, ts)
  return new Date(ts + offset).toISOString().slice(11, 19)
}

/** 整点对齐（当地时区），用于 24 小时柱的槽位。 */
export function floorHour(ts) {
  return Math.floor(ts / HOUR) * HOUR
}
