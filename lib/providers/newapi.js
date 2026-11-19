/**
 * New API 供应商适配器（公司网关 `ai-api.qzsyzn.com`）。
 *
 * 只走管理员聚合口径，不再有「日志窗口法」：三个接口都要系统访问令牌，
 * 今日/近 24 小时/近 7 天与网关后台完全同源，不做截断兜底。
 *
 * - `GET /api/user/self`                     余额、累计已用、累计请求数
 * - `GET /api/data/self?start&end`           按小时 × 模型聚合的 quota/count/token
 * - `GET /api/log/self?p&page_size[&type=5]` 最近明细（吞吐 / 首字 / 出错数）
 *
 * 金额 = `quota / quotaPerUnit × price`，单位随配置；这里只输出数值，
 * 单位由 `unit` 字段声明，客户端据此格式化。
 */

import { getJson, RequestError } from '../http.js'
import { DAY, HOUR, clockLabel, dayKey, floorHour, hourKey, startOfDay } from '../time.js'

export const KIND = 'newapi'

/** 这个供应商真正具备的能力；客户端只渲染声明过的区块。 */
export const CAPS = Object.freeze(['hourly', 'daily', 'heatmap', 'models', 'recent', 'throughput'])

const pad = (value) => String(value).padStart(2, '0')

/** `other` 字段是 JSON 字符串，缺字段/坏 JSON 都要能容忍。 */
function parseOther(raw) {
  if (raw === null || raw === undefined || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 一条日志 → 展示用记录（吞吐、首字、令牌拆分）。 */
function normalizeLog(row, timeZone, toMoney) {
  const other = parseOther(row.other)
  const prompt = Number(row.prompt_tokens) || 0
  const completion = Number(row.completion_tokens) || 0
  const cache = Number(other.cache_tokens) || 0
  const cacheCreation = Number(other.cache_creation_tokens) || 0
  const useSeconds = Number(row.use_time) || 0
  const ttft = Number(other.frt) || 0
  const stream = row.is_stream === true
  const totalMs = useSeconds > 0 ? useSeconds * 1000 : null
  const decodeMs = totalMs === null ? 0 : (ttft > 0 ? totalMs - ttft : totalMs)
  const tps = stream && completion > 0 && decodeMs > 50 ? completion / (decodeMs / 1000) : null
  const at = (Number(row.created_at) || 0) * 1000
  return {
    id: row.id,
    t: at,
    timeLabel: at > 0 ? clockLabel(at, timeZone) : '—',
    model: typeof row.model_name === 'string' ? row.model_name : '',
    ok: Number(row.type) !== 5,
    stream,
    tps,
    ttftMs: ttft > 0 ? ttft : null,
    totalMs,
    cost: toMoney(Number(row.quota) || 0),
    tokens: prompt + cache + cacheCreation + completion,
    completionTokens: completion,
  }
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

/** @param {unknown} value */
function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * 从 `sk-` 密钥的日志里读一次 user_id：系统访问令牌的请求必须带 `New-Api-User`。
 * @param {{ baseUrl: string, apiKey: string }} input
 * @returns {Promise<number | null>}
 */
export async function detectUserId({ baseUrl, apiKey }) {
  const body = await getJson(`${baseUrl}/api/log/token`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  const rows = Array.isArray(body.data) ? body.data : []
  for (const row of rows) {
    const id = Number(row?.user_id)
    if (Number.isFinite(id) && id > 0) return id
  }
  return null
}

/**
 * @param {{
 *   provider: { id: string, name: string, baseUrl: string, quotaPerUnit: number, price: number },
 *   secrets: { apiKey: string, accessToken: string },
 *   userId: number,
 *   timeZone: string,
 * }} input
 */
export function createProvider({ provider, secrets, userId, timeZone }) {
  const baseUrl = provider.baseUrl
  const accessToken = secrets.accessToken
  const quotaPerUnit = positiveNumber(provider.quotaPerUnit) || 500_000
  const price = positiveNumber(provider.price) || 1
  const toMoney = (quota) => (quota / quotaPerUnit) * price
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'new-api-user': String(userId),
  }

  const get = (path) => getJson(`${baseUrl}${path}`, { headers })

  async function probe() {
    const body = await get('/api/user/self')
    if (body.data === null || typeof body.data !== 'object') {
      throw new RequestError('user/self 未返回 data', 'invalid_response', 200)
    }
    return { ok: true, caps: CAPS }
  }

  /**
   * @param {{ now: number }} input
   */
  async function fetchSnapshot({ now }) {
    const todayStart = startOfDay(now, timeZone)
    const rangeStart = todayStart - 6 * DAY
    const end = Math.floor(now / 1000)
    const start = Math.floor(rangeStart / 1000)
    const dayAgo = Math.floor((now - DAY) / 1000)

    const [user, quota, logs, errorLogs] = await Promise.all([
      get('/api/user/self'),
      get(`/api/data/self?start_timestamp=${start}&end_timestamp=${end}`),
      get('/api/log/self?p=1&page_size=60'),
      get(`/api/log/self?p=1&page_size=1&type=5&start_timestamp=${dayAgo}&end_timestamp=${end}`),
    ])

    const userData = user.data
    if (userData === null || typeof userData !== 'object') {
      throw new RequestError('user/self 未返回 data', 'invalid_response', 200)
    }
    if (!Array.isArray(quota.data)) {
      throw new RequestError('data/self 未返回数组', 'invalid_response', 200)
    }
    const logItems = Array.isArray(logs?.data?.items) ? logs.data.items : []
    const errors24h = Number(errorLogs?.data?.total) || 0

    const bins = quota.data.map((row) => ({
      t: (Number(row.created_at) || 0) * 1000,
      model: typeof row.model_name === 'string' ? row.model_name : '',
      quota: Number(row.quota) || 0,
      requests: Number(row.count) || 0,
      tokens: Number(row.token_used) || 0,
    }))

    /** @type {Map<string, {cost: number, requests: number, tokens: number}>} */
    const hourMap = new Map()
    for (const bin of bins) {
      const key = hourKey(bin.t, timeZone)
      const cell = hourMap.get(key) ?? { quota: 0, requests: 0, tokens: 0 }
      cell.quota += bin.quota
      cell.requests += bin.requests
      cell.tokens += bin.tokens
      hourMap.set(key, cell)
    }

    const hours = []
    for (let i = 23; i >= 0; i -= 1) {
      const at = floorHour(now) - i * HOUR
      const key = hourKey(at, timeZone)
      const cell = hourMap.get(key)
      hours.push({
        at,
        label: key.slice(11),
        day: key.slice(0, 10),
        cost: toMoney(cell?.quota ?? 0),
        requests: cell?.requests ?? 0,
        tokens: cell?.tokens ?? 0,
      })
    }

    const days = []
    for (let i = 6; i >= 0; i -= 1) {
      const date = dayKey(todayStart - i * DAY, timeZone)
      let quota = 0
      let requests = 0
      let tokens = 0
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = hourMap.get(`${date} ${pad(hour)}`)
        if (cell === undefined) continue
        quota += cell.quota
        requests += cell.requests
        tokens += cell.tokens
      }
      days.push({ date, label: date.slice(5), cost: toMoney(quota), requests, tokens })
    }

    const heat = days.map((day) => {
      const cells = []
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = hourMap.get(`${day.date} ${pad(hour)}`)
        cells.push({ hour, cost: toMoney(cell?.quota ?? 0), requests: cell?.requests ?? 0 })
      }
      return { date: day.date, label: day.label, cells }
    })

    /** @type {Map<string, {requests: number, quota: number, tokens: number}>} */
    const modelMap = new Map()
    for (const bin of bins) {
      if (bin.t < rangeStart) continue
      const entry = modelMap.get(bin.model) ?? { requests: 0, quota: 0, tokens: 0 }
      entry.requests += bin.requests
      entry.quota += bin.quota
      entry.tokens += bin.tokens
      modelMap.set(bin.model, entry)
    }
    const models = [...modelMap.entries()]
      .map(([model, value]) => ({
        model,
        requests: value.requests,
        cost: toMoney(value.quota),
        tokens: value.tokens,
      }))
      .sort((left, right) => right.requests - left.requests)

    const todayBins = bins.filter((bin) => bin.t >= todayStart)
    const dayBins = bins.filter((bin) => bin.t >= now - DAY)
    const sum = (list, key) => list.reduce((total, bin) => total + bin[key], 0)

    const todayQuota = sum(todayBins, 'quota')
    const todayRequests = sum(todayBins, 'requests')
    const todayTokens = sum(todayBins, 'tokens')
    const windowQuota = sum(dayBins, 'quota')
    const windowRequests = sum(dayBins, 'requests')
    const windowTokens = sum(dayBins, 'tokens')

    const recent = logItems
      .map((row) => normalizeLog(row, timeZone, toMoney))
      .sort((left, right) => right.t - left.t)

    const tpsList = recent.map((row) => row.tps).filter((value) => value !== null).sort((a, b) => a - b)
    const ttftList = recent.map((row) => row.ttftMs).filter((value) => value !== null).sort((a, b) => a - b)
    let tpsNum = 0
    let tpsDen = 0
    for (const row of recent) {
      if (row.tps === null) continue
      // 解码吞吐只数 completion tokens，分母扣掉首字时间（与逐行 tps 同口径）。
      const decodeSeconds = ((row.totalMs ?? 0) - (row.ttftMs ?? 0)) / 1000
      if (decodeSeconds <= 0) continue
      tpsNum += row.completionTokens
      tpsDen += decodeSeconds
    }

    const windowErrors = errors24h
    const windowTotal = windowRequests + windowErrors

    return {
      ok: true,
      provider: { id: provider.id, kind: KIND, name: provider.name, baseUrl },
      unit: 'CNY',
      caps: CAPS,
      timeZone,
      generatedAt: now,
      account: {
        remaining: toMoney(Number(userData.quota) || 0),
        used: toMoney(Number(userData.used_quota) || 0),
        total: toMoney((Number(userData.quota) || 0) + (Number(userData.used_quota) || 0)),
        requestCount: Number(userData.request_count) || 0,
        raw: {
          remainingQuota: Number(userData.quota) || 0,
          usedQuota: Number(userData.used_quota) || 0,
        },
      },
      today: {
        date: dayKey(now, timeZone),
        cost: toMoney(todayQuota),
        requests: todayRequests,
        errors: 0,
        errorRate: 0,
        tokens: todayTokens,
        tokensIn: null,
        tokensOut: null,
      },
      window: {
        from: now - DAY,
        to: now,
        cost: toMoney(windowQuota),
        requests: windowRequests,
        errors: windowErrors,
        errorRate: windowTotal > 0 ? windowErrors / windowTotal : 0,
        tokens: windowTokens,
        tps: tpsDen > 0 ? tpsNum / tpsDen : null,
        tpsP50: percentile(tpsList, 0.5),
        ttftMs: percentile(ttftList, 0.5),
      },
      hours,
      days,
      heat,
      models,
      recent: recent.slice(0, 20),
      notes: [],
    }
  }

  return { kind: KIND, unit: 'CNY', caps: CAPS, probe, fetchSnapshot }
}
