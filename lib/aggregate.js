/**
 * 纯函数层：把网关 `/api/log/token` 的原始行折成看板需要的聚合结果。
 *
 * 口径说明（实测 2026-11-17，New API 202610151846）：
 * - 该路由固定返回最近 1000 条，`p` / `page_size` / `type` / `start_timestamp`
 *   全部无效，所以窗口类指标（吞吐、出错率）都是「最近 1000 次」而非全量。
 * - 行内 `use_time` 是整秒，`other.frt` 是首字节毫秒，故解码吞吐按
 *   `completion_tokens / (use_time - frt/1000)` 计，粒度约 ±10%。
 * - `type === 5` 才是错误日志（New API 约定：1 充值 / 2 消费 / 3 管理 / 4 系统 / 5 错误）。
 */

const HOUR = 3_600_000
const DAY = 86_400_000
/** 网关与看板都按北京时间切日；中国无夏令时，固定 +08:00 即可。 */
const TZ = 8 * HOUR

const pad = (n) => String(n).padStart(2, '0')

/** @param {number} ts epoch ms @returns {number} 当日 00:00 的 epoch ms */
export function startOfDay(ts) {
  return Math.floor((ts + TZ) / DAY) * DAY - TZ
}

/** @param {number} ts epoch ms @returns {string} `YYYY-MM-DD`（北京时区） */
export function dayKey(ts) {
  const d = new Date(ts + TZ)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** @param {number} ts epoch ms @returns {string} `YYYY-MM-DD HH`（北京时区整点） */
export function hourKey(ts) {
  return `${dayKey(ts)} ${pad(new Date(ts + TZ).getUTCHours())}`
}

function safeJson(text) {
  if (text === null || text === undefined || text === '') return {}
  if (typeof text === 'object') return text
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 一条日志行 → 计算用记录。字段全部防御式读取：网关不同版本、图片/非流式请求
 * 都可能缺字段。
 * @param {Record<string, unknown>} row 原始日志行
 * @returns {Record<string, unknown>} 规范化记录
 */
export function normalizeRow(row) {
  const other = safeJson(row.other)
  const quota = Number(row.quota) || 0
  const promptTokens = Number(row.prompt_tokens) || 0
  const completionTokens = Number(row.completion_tokens) || 0
  // 本网关的 prompt_tokens 不含缓存命中部分，缓存单独记在 other.cache_tokens /
  // other.cache_creation_tokens 里；只算 prompt+completion 会把输入严重低估。
  const cacheTokens = Number(other.cache_tokens) || 0
  const cacheCreationTokens = Number(other.cache_creation_tokens) || 0
  const useSeconds = Number(row.use_time) || 0
  const ttftMs = Number(other.frt) || 0
  const stream = row.is_stream === true
  const totalMs = useSeconds > 0 ? useSeconds * 1000 : 0
  const decodeMs = totalMs > 0 && ttftMs > 0 ? totalMs - ttftMs : totalMs
  const tps = stream && completionTokens > 0 && decodeMs > 50 ? completionTokens / (decodeMs / 1000) : null
  const createdSeconds = Number(row.created_at) || 0
  return {
    id: row.id,
    t: createdSeconds * 1000,
    model: typeof row.model_name === 'string' ? row.model_name : '',
    type: Number(row.type) || 0,
    error: Number(row.type) === 5,
    quota,
    promptTokens,
    completionTokens,
    cacheTokens,
    cacheCreationTokens,
    tokens: promptTokens + cacheTokens + cacheCreationTokens + completionTokens,
    stream,
    ttftMs: ttftMs > 0 ? ttftMs : null,
    totalMs: totalMs > 0 ? totalMs : null,
    tps,
  }
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

/**
 * 一组记录的统计块。
 * @param {Array<Record<string, unknown>>} rows 规范化后的记录
 * @param {{ quotaPerUnit: number, price: number }} money 金额换算
 */
export function summarize(rows, money) {
  let quota = 0
  let tokensIn = 0
  let tokensOut = 0
  let errors = 0
  let streamed = 0
  let tpsNum = 0
  let tpsDen = 0
  const tpsList = []
  const ttftList = []
  const totalList = []
  for (const row of rows) {
    if (row.error) {
      errors += 1
      continue
    }
    quota += row.quota
    tokensIn += row.promptTokens + (row.cacheTokens || 0) + (row.cacheCreationTokens || 0)
    tokensOut += row.completionTokens
    if (row.stream) streamed += 1
    if (row.tps !== null) {
      tpsNum += row.completionTokens
      tpsDen += row.totalMs / 1000 - (row.ttftMs ?? 0) / 1000
      tpsList.push(row.tps)
    }
    if (row.ttftMs !== null) ttftList.push(row.ttftMs)
    if (row.totalMs !== null) totalList.push(row.totalMs)
  }
  tpsList.sort((a, b) => a - b)
  ttftList.sort((a, b) => a - b)
  totalList.sort((a, b) => a - b)
  const requests = rows.length
  return {
    requests,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
    quota,
    cny: toCny(quota, money),
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    streamShare: requests > 0 ? streamed / Math.max(1, requests - errors) : 0,
    tps: tpsDen > 0 ? tpsNum / tpsDen : null,
    tpsP10: percentile(tpsList, 0.1),
    tpsP50: percentile(tpsList, 0.5),
    tpsP90: percentile(tpsList, 0.9),
    ttftMs: percentile(ttftList, 0.5),
    totalMs: percentile(totalList, 0.5),
  }
}

/** @param {number} quota @param {{ quotaPerUnit: number, price: number }} money */
export function toCny(quota, money) {
  const perUnit = Number(money?.quotaPerUnit) > 0 ? Number(money.quotaPerUnit) : 500_000
  const price = Number(money?.price) > 0 ? Number(money.price) : 1
  return (quota / perUnit) * price
}

/**
 * 按小时分桶，键为 `YYYY-MM-DD HH`。
 * @param {Array<Record<string, unknown>>} rows 规范化记录
 */
export function bucketize(rows) {
  /** @type {Record<string, {requests: number, quota: number, prompt: number, completion: number, errors: number}>} */
  const buckets = {}
  for (const row of rows) {
    const key = hourKey(row.t)
    const bucket = buckets[key] ?? (buckets[key] = { requests: 0, quota: 0, prompt: 0, completion: 0, errors: 0 })
    bucket.requests += 1
    if (row.error) {
      bucket.errors += 1
      continue
    }
    bucket.quota += row.quota
    bucket.prompt += row.promptTokens + (row.cacheTokens || 0) + (row.cacheCreationTokens || 0)
    bucket.completion += row.completionTokens
  }
  return buckets
}

/**
 * 组装看板载荷。所有金额同时给额度与 CNY，客户端据此双显。
 * @param {{
 *   rows: Array<Record<string, unknown>>,
 *   usage?: { data?: Record<string, unknown> } | null,
 *   now: number,
 *   quotaPerUnit: number,
 *   price: number,
 *   refreshMs: number,
 *   hourBuckets?: Record<string, Record<string, number>>,
 *   partialHour?: string | null,
 *   todayBaseline?: { date: string, baseUsed: number, capturedAt: number } | null,
 * }} input
 */
export function buildSummary(input) {
  const money = { quotaPerUnit: input.quotaPerUnit, price: input.price }
  const now = Number(input.now) || Date.now()
  const rows = (input.rows ?? []).map(normalizeRow).sort((a, b) => a.t - b.t)
  const usageData = input.usage?.data ?? {}
  const totalUsedQuota = Number(usageData.total_used) || 0
  const totalGrantedQuota = Number(usageData.total_granted) || 0
  const remainingQuota = Number(usageData.total_available) || 0
  const unlimited = usageData.unlimited_quota === true

  const windowStats = summarize(rows, money)
  const short = summarize(rows.slice(-60), money)
  const todayStart = startOfDay(now)
  const todayRows = rows.filter((row) => row.t >= todayStart)
  const todayStats = summarize(todayRows, money)

  const earliest = rows.length > 0 ? rows[0].t : null
  const covered = earliest !== null && earliest <= todayStart
  const baseline = input.todayBaseline ?? null
  const baselineFresh =
    baseline !== null &&
    baseline.date === dayKey(now) &&
    Number(baseline.capturedAt) >= todayStart &&
    Number(baseline.capturedAt) - todayStart <= 10 * HOUR
  let todayQuota = todayStats.quota
  let todayExact = covered
  let todayBasis = covered ? 'logs' : 'logs-partial'
  if (!covered && baselineFresh && totalUsedQuota > 0) {
    const delta = Math.max(0, totalUsedQuota - Number(baseline.baseUsed))
    if (delta > todayQuota) {
      todayQuota = delta
      todayExact = true
      todayBasis = 'baseline'
    }
  }
  const coverageStart = rows.length > 0 ? rows[0].t : null
  const today = {
    ...todayStats,
    date: dayKey(now),
    quota: todayQuota,
    cny: toCny(todayQuota, money),
    exact: todayExact,
    basis: todayBasis,
    coverage: {
      start: coverageStart,
      hours: coverageStart === null ? 0 : Math.round(((now - coverageStart) / 3_600_000) * 10) / 10,
    },
  }

  const merged = { ...(input.hourBuckets ?? {}) }
  Object.assign(merged, bucketize(rows))
  const partialHour = input.partialHour ?? null
  if (partialHour !== null && input.hourBuckets?.[partialHour] !== undefined) {
    // 窗口最早一小时是残缺的，别用当前窗口覆盖历史里更完整的值
    merged[partialHour] = input.hourBuckets[partialHour]
  }

  const hours = []
  for (let i = 23; i >= 0; i -= 1) {
    const at = Math.floor(now / HOUR) * HOUR - i * HOUR
    const key = hourKey(at)
    const bucket = merged[key] ?? { requests: 0, quota: 0, prompt: 0, completion: 0, errors: 0 }
    hours.push({
      at,
      label: key.slice(11),
      day: key.slice(0, 10),
      requests: bucket.requests,
      quota: bucket.quota,
      cny: toCny(bucket.quota, money),
      tokens: (bucket.prompt ?? 0) + (bucket.completion ?? 0),
    })
  }

  const days = []
  for (let i = 6; i >= 0; i -= 1) {
    const at = startOfDay(now) - i * DAY
    const date = dayKey(at)
    let bucket = { requests: 0, quota: 0, prompt: 0, completion: 0, errors: 0 }
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = merged[`${date} ${pad(hour)}`]
      if (cell === undefined) continue
      bucket = {
        requests: bucket.requests + (cell.requests ?? 0),
        quota: bucket.quota + (cell.quota ?? 0),
        prompt: bucket.prompt + (cell.prompt ?? 0),
        completion: bucket.completion + (cell.completion ?? 0),
        errors: bucket.errors + (cell.errors ?? 0),
      }
    }
    days.push({
      date,
      label: date.slice(5),
      requests: bucket.requests,
      quota: bucket.quota,
      cny: toCny(bucket.quota, money),
      tokens: bucket.prompt + bucket.completion,
    })
  }

  const heat = days.map((day) => {
    const cells = []
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = merged[`${day.date} ${pad(hour)}`]
      cells.push({
        hour,
        requests: cell?.requests ?? 0,
        cny: toCny(cell?.quota ?? 0, money),
        quota: cell?.quota ?? 0,
      })
    }
    return { date: day.date, label: day.label, cells }
  })

  const byModel = new Map()
  for (const row of rows) {
    if (row.error) continue
    const entry = byModel.get(row.model) ?? { rows: [], quota: 0, tokens: 0 }
    entry.rows.push(row)
    entry.quota += row.quota
    entry.tokens += row.tokens
    byModel.set(row.model, entry)
  }
  const models = [...byModel.entries()]
    .map(([model, entry]) => ({
      model,
      requests: entry.rows.length,
      cny: toCny(entry.quota, money),
      tokens: entry.tokens,
      tps: summarize(entry.rows, money).tps,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 6)

  const recent = rows
    .slice(-14)
    .reverse()
    .map((row) => ({
      id: row.id,
      t: row.t,
      timeLabel: `${new Date(row.t + TZ).toISOString().slice(11, 19)}`,
      model: row.model,
      stream: row.stream,
      ok: !row.error,
      tps: row.tps,
      ttftMs: row.ttftMs,
      totalMs: row.totalMs,
      cny: toCny(row.quota, money),
      tokens: row.tokens,
    }))

  const notes = []
  if (rows.length >= 990) {
    notes.push('网关日志路由固定只给最近 1000 条，窗口类指标据此统计。')
  }
  if (!todayExact) {
    notes.push('今日用量可能被 1000 条窗口截断，显示为下限。')
  }

  return {
    ok: true,
    generatedAt: now,
    config: {
      quotaPerUnit: Number(input.quotaPerUnit) || 500_000,
      price: Number(input.price) || 1,
      refreshMs: Number(input.refreshMs) || 60_000,
    },
    account: {
      totalUsedQuota,
      totalGrantedQuota,
      remainingQuota,
      unlimited,
      usedCny: toCny(totalUsedQuota, money),
      grantedCny: toCny(totalGrantedQuota, money),
      quotaCny: toCny(Math.max(0, remainingQuota), money),
    },
    today,
    window: {
      ...windowStats,
      from: rows.length > 0 ? rows[0].t : null,
      to: rows.length > 0 ? rows[rows.length - 1].t : null,
    },
    short,
    hours,
    days,
    heat,
    models,
    recent,
    notes,
  }
}

/**
 * 登录态（系统访问令牌）路径的看板载荷。
 *
 * 数据源换成网关后台自己的聚合接口：
 * - `/api/user/self`：余额、累计已用、累计请求数
 * - `/api/data/self?start_timestamp&end_timestamp`：按小时 × 模型聚合的
 *   `{created_at, model_name, quota, count, token_used}`，就是后台「用量概览」的来源
 * - `/api/log/self`：分页日志（可过滤 `type`），用于最近请求与吞吐
 *
 * 与日志窗口法的区别：这里的「今日 / 近 24 小时」是全量精确值，不再被 1000 条
 * 日志截断，也不依赖本地历史。
 *
 * @param {{
 *   quotaRows: Array<Record<string, unknown>>,
 *   logRows: Array<Record<string, unknown>>,
 *   user?: Record<string, unknown> | null,
 *   errors24h?: number | null,
 *   now: number,
 *   quotaPerUnit: number,
 *   price: number,
 *   refreshMs: number,
 * }} input
 */
export function buildSummaryFromApi(input) {
  const money = { quotaPerUnit: input.quotaPerUnit, price: input.price }
  const now = Number(input.now) || Date.now()
  const todayStart = startOfDay(now)
  const dayAgo = now - DAY

  const bins = (input.quotaRows ?? []).map((row) => ({
    t: (Number(row.created_at) || 0) * 1000,
    quota: Number(row.quota) || 0,
    count: Number(row.count) || 0,
    tokens: Number(row.token_used) || 0,
    model: typeof row.model_name === 'string' ? row.model_name : '',
  }))

  const hourMap = new Map()
  const modelMap = new Map()
  for (const bin of bins) {
    const key = hourKey(bin.t)
    const hour = hourMap.get(key) ?? { quota: 0, count: 0, tokens: 0 }
    hour.quota += bin.quota
    hour.count += bin.count
    hour.tokens += bin.tokens
    hourMap.set(key, hour)

    const model = modelMap.get(bin.model) ?? { quota: 0, count: 0, tokens: 0 }
    model.quota += bin.quota
    model.count += bin.count
    model.tokens += bin.tokens
    modelMap.set(bin.model, model)
  }

  const hours = []
  for (let i = 23; i >= 0; i -= 1) {
    const at = Math.floor(now / HOUR) * HOUR - i * HOUR
    const key = hourKey(at)
    const hour = hourMap.get(key) ?? { quota: 0, count: 0, tokens: 0 }
    hours.push({
      at,
      label: key.slice(11),
      day: key.slice(0, 10),
      requests: hour.count,
      quota: hour.quota,
      cny: toCny(hour.quota, money),
      tokens: hour.tokens,
    })
  }

  const days = []
  for (let i = 6; i >= 0; i -= 1) {
    const at = startOfDay(now) - i * DAY
    const date = dayKey(at)
    let quota = 0
    let count = 0
    let tokens = 0
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = hourMap.get(`${date} ${pad(hour)}`)
      if (cell === undefined) continue
      quota += cell.quota
      count += cell.count
      tokens += cell.tokens
    }
    days.push({ date, label: date.slice(5), requests: count, quota, cny: toCny(quota, money), tokens })
  }

  const heat = days.map((day) => {
    const cells = []
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = hourMap.get(`${day.date} ${pad(hour)}`)
      cells.push({
        hour,
        requests: cell?.count ?? 0,
        cny: toCny(cell?.quota ?? 0, money),
        quota: cell?.quota ?? 0,
      })
    }
    return { date: day.date, label: day.label, cells }
  })

  const todayBins = bins.filter((bin) => bin.t >= todayStart)
  const last24 = bins.filter((bin) => bin.t >= dayAgo)
  const sumOf = (list, key) => list.reduce((sum, bin) => sum + bin[key], 0)
  const todayQuota = sumOf(todayBins, 'quota')
  const todayRequests = sumOf(todayBins, 'count')
  const todayTokens = sumOf(todayBins, 'tokens')
  const windowQuota = sumOf(last24, 'quota')
  const windowRequests = sumOf(last24, 'count')
  const windowTokens = sumOf(last24, 'tokens')
  const errors = Number.isFinite(Number(input.errors24h)) ? Number(input.errors24h) : 0

  const normalizedLogs = (input.logRows ?? []).map(normalizeRow).sort((a, b) => b.t - a.t)
  const recentStats = summarize(normalizedLogs.slice(0, 60), money)

  // 模型分布只用与「近 7 天」图同一窗口的桶，避免合计大于 7 天总量
  const weekStart = startOfDay(now) - 6 * DAY
  modelMap.clear()
  for (const bin of bins) {
    if (bin.t < weekStart) continue
    const model = modelMap.get(bin.model) ?? { quota: 0, count: 0, tokens: 0 }
    model.quota += bin.quota
    model.count += bin.count
    model.tokens += bin.tokens
    modelMap.set(bin.model, model)
  }

  const models = [...modelMap.entries()]
    .map(([model, value]) => ({
      model,
      requests: value.count,
      cny: toCny(value.quota, money),
      tokens: value.tokens,
      tps: null,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 6)

  const recent = normalizedLogs.slice(0, 20).map((row) => ({
    id: row.id,
    t: row.t,
    timeLabel: `${new Date(row.t + TZ).toISOString().slice(11, 19)}`,
    model: row.model,
    stream: row.stream,
    ok: !row.error,
    tps: row.tps,
    ttftMs: row.ttftMs,
    totalMs: row.totalMs,
    cny: toCny(row.quota, money),
    tokens: row.tokens,
  }))

  const user = input.user ?? {}
  const firstBucket = bins.length > 0 ? Math.min(...bins.map((bin) => bin.t)) : null

  return {
    ok: true,
    generatedAt: now,
    source: 'api',
    config: {
      quotaPerUnit: Number(input.quotaPerUnit) || 500_000,
      price: Number(input.price) || 1,
      refreshMs: Number(input.refreshMs) || 300_000,
    },
    account: {
      totalUsedQuota: Number(user.used_quota) || 0,
      remainingQuota: Number(user.quota) || 0,
      totalGrantedQuota: (Number(user.used_quota) || 0) + (Number(user.quota) || 0),
      unlimited: false,
      requestCount: Number(user.request_count) || 0,
      usedCny: toCny(Number(user.used_quota) || 0, money),
      quotaCny: toCny(Number(user.quota) || 0, money),
    },
    today: {
      date: dayKey(now),
      requests: todayRequests,
      errors: 0,
      errorRate: 0,
      quota: todayQuota,
      cny: toCny(todayQuota, money),
      tokens: todayTokens,
      tokensIn: todayTokens,
      tokensOut: 0,
      exact: true,
      basis: 'api',
      coverage: {
        start: firstBucket,
        hours: firstBucket === null ? 0 : Math.round(((now - firstBucket) / HOUR) * 10) / 10,
      },
    },
    window: {
      requests: windowRequests,
      errors,
      errorRate: windowRequests > 0 ? errors / windowRequests : 0,
      quota: windowQuota,
      cny: toCny(windowQuota, money),
      tokens: windowTokens,
      tokensIn: windowTokens,
      tokensOut: 0,
      streamShare: recentStats.streamShare,
      tps: recentStats.tps,
      tpsP10: recentStats.tpsP10,
      tpsP50: recentStats.tpsP50,
      tpsP90: recentStats.tpsP90,
      ttftMs: recentStats.ttftMs,
      totalMs: recentStats.totalMs,
      from: dayAgo,
      to: now,
    },
    short: recentStats,
    hours,
    days,
    heat,
    models,
    recent,
    notes: [],
  }
}
