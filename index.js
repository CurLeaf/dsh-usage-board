/**
 * Host 半边：读网关 → 聚合 → 挂一条同源只读路由给右栏面板。
 *
 * 密钥不出宿主进程：面板只拿到 `/usage-board/api/summary` 的聚合结果，且该前缀
 * 自带一次一密的进程令牌（通过 `webserver/index-inject` 写进已鉴权的 index 页面，
 * 客户端用 `x-usage-board` 头带回）。DSH 的 `/api` 鉴权不覆盖自定义前缀，所以
 * 这条前缀必须自带鉴权。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildSummary, buildSummaryFromApi, bucketize, hourKey, normalizeRow, startOfDay } from './lib/aggregate.js'
import { createGateway, readGatewayBodies } from './lib/gateway.js'
import { createHistoryStore } from './lib/history.js'

export const name = 'usage-board'

/** 与 cordis.patch.yml 的 insert[].id 一致。 */
export const API_PATH = '/usage-board/api'

/** 注入 index 的全局名；客户端从这里读进程令牌。 */
export const TOKEN_GLOBAL = '__DSH_USAGE_BOARD__'

/** 客户端携带令牌的请求头。 */
export const TOKEN_HEADER = 'x-usage-board'

const DEFAULTS = {
  baseUrl: 'https://ai-api.qzsyzn.com',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  accessTokenRef: 'QZSY_ACCESS_TOKEN',
  quotaPerUnit: 500_000,
  price: 1,
  refreshMs: 300_000,
}

function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/**
 * 归一化 patch 里的 config。
 * @param {Record<string, unknown>} raw
 */
export function normalizeConfig(raw = {}) {
  const baseUrl = String(raw.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '')
  const quotaPerUnit = Number(raw.quotaPerUnit)
  const price = Number(raw.price)
  const refreshMs = Number(raw.refreshMs)
  const userId = Number(raw.userId)
  return {
    baseUrl,
    apiKeyRef: String(raw.apiKeyRef ?? DEFAULTS.apiKeyRef),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    accessTokenRef: String(raw.accessTokenRef ?? DEFAULTS.accessTokenRef),
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : '',
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    quotaPerUnit: Number.isFinite(quotaPerUnit) && quotaPerUnit > 0 ? quotaPerUnit : DEFAULTS.quotaPerUnit,
    price: Number.isFinite(price) && price > 0 ? price : DEFAULTS.price,
    refreshMs: Number.isFinite(refreshMs) && refreshMs > 0 ? Math.max(60_000, refreshMs) : DEFAULTS.refreshMs,
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir !== '' ? raw.dataDir : join(dshHome(), 'usage-board'),
  }
}

/**
 * 兜底读法：从 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段取密钥。
 * 正常路径走 `ctx.credentials.resolve`，这个函数只在服务缺席时用。
 * @param {string} ref
 * @returns {string} 空串表示没有
 */
export function readKeyFromDisk(ref) {
  let text
  try {
    text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  } catch {
    return ''
  }
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break
    const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/)
    if (match === null || match[1] !== ref) continue
    let value = match[2]
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    return value
  }
  return ''
}

/**
 * 常量时间比较请求头里的进程令牌。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 */
export function authorize(req, token) {
  const header = req.headers[TOKEN_HEADER]
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value.length !== token.length) return false
  return timingSafeEqual(Buffer.from(value), Buffer.from(token))
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 用密钥接口先拿到 user_id：系统访问令牌的请求必须带 `New-Api-User` 头。 */
async function detectUserId(options, apiKey) {
  const gateway = createGateway({ baseUrl: options.baseUrl, apiKey })
  const logs = await gateway.logs()
  const rows = Array.isArray(logs?.data) ? logs.data : []
  for (const row of rows) {
    const id = Number(row?.user_id)
    if (Number.isFinite(id) && id > 0) return id
  }
  return null
}

/**
 * 登录态路径：`/api/user/self` + `/api/data/self` + `/api/log/self`。
 * 这里的今日/近 24h 是网关后台自己的聚合值，不受 1000 条日志截断影响。
 * @param {{
 *   options: ReturnType<typeof normalizeConfig>,
 *   resolveApiKey: () => Promise<string>,
 *   accessToken: string,
 *   cachedUserId: number | null,
 *   now?: () => number,
 * }} input
 */
export async function refreshFromApi({ options, resolveApiKey, accessToken, cachedUserId = null, now = () => Date.now() }) {
  const at = now()
  const apiKey = await resolveApiKey()
  let userId = options.userId ?? cachedUserId
  if (userId === null || userId === undefined) userId = await detectUserId(options, apiKey)
  if (userId === null || userId === undefined) {
    return { ok: false, error: '无法从日志里识别 user_id（系统访问令牌需要 New-Api-User 头）' }
  }

  const gateway = createGateway({ baseUrl: options.baseUrl, apiKey, accessToken, userId })
  const end = Math.floor(at / 1000)
  const weekAgo = end - 7 * 86_400
  const dayAgo = end - 86_400
  const todayStart = Math.floor(startOfDay(at) / 1000)

  const [user, quota, logs, errors] = await Promise.all([
    gateway.userSelf(),
    gateway.quotaData(Math.min(weekAgo, todayStart), end),
    gateway.userLogs({ page: 1, pageSize: 100 }),
    gateway.userLogs({ page: 1, pageSize: 1, type: 5, start: dayAgo, end }),
  ])

  const userData = user?.data
  if (userData === null || typeof userData !== 'object') throw new Error('user/self 未返回 data')
  const quotaRows = Array.isArray(quota?.data) ? quota.data : []
  if (quotaRows.length === 0 && Array.isArray(quota?.data) === false) throw new Error('data/self 未返回数组')

  const logRows = Array.isArray(logs?.data?.items) ? logs.data.items : []
  const errors24h = Number(errors?.data?.total) || 0

  const payload = buildSummaryFromApi({
    quotaRows,
    logRows,
    user: userData,
    errors24h,
    now: at,
    quotaPerUnit: options.quotaPerUnit,
    price: options.price,
    refreshMs: options.refreshMs,
  })
  return { ...payload, site: { baseUrl: options.baseUrl }, userId }
}

/**
 * 一次网关刷新：两份响应 → 历史桶更新 → 看板载荷。
 * @param {{
 *   options: ReturnType<typeof normalizeConfig>,
 *   resolveApiKey: () => Promise<string>,
 *   history: ReturnType<typeof createHistoryStore>,
 *   now?: () => number,
 * }} input
 */
export async function refreshSummary({
  options,
  resolveApiKey,
  resolveAccessToken = null,
  cachedUserId = null,
  history,
  now = () => Date.now(),
}) {
  const apiKey = await resolveApiKey()
  if (apiKey === '') {
    return { ok: false, error: '缺少网关密钥：请在凭据里配置 ' + options.apiKeyRef }
  }

  // 有系统访问令牌时优先走后台聚合接口：今日/近 24h 与网关后台完全同源
  let accessToken = options.accessToken
  if (accessToken === '' && resolveAccessToken !== null) accessToken = await resolveAccessToken()
  if (accessToken !== '') {
    return refreshFromApi({ options, resolveApiKey, accessToken, cachedUserId, now })
  }
  const gateway = createGateway({ baseUrl: options.baseUrl, apiKey })
  const [logsBody, usageBody] = await Promise.all([gateway.logs(), gateway.tokenUsage()])
  const { rows, usage } = readGatewayBodies(logsBody, usageBody)

  const at = now()
  const normalized = rows.map(normalizeRow)
  const buckets = bucketize(normalized)
  let earliest = null
  for (const row of normalized) {
    if (row.t <= 0) continue
    if (earliest === null || row.t < earliest) earliest = row.t
  }
  const partialHour = earliest !== null ? hourKey(earliest) : null
  history.mergeHours(buckets, partialHour, at)
  history.ensureToday(Number(usage.data.total_used) || 0, at)
  history.save()

  const payload = buildSummary({
    rows,
    usage,
    now: at,
    quotaPerUnit: options.quotaPerUnit,
    price: options.price,
    refreshMs: options.refreshMs,
    hourBuckets: history.hours,
    partialHour,
    todayBaseline: history.today,
  })
  return { ...payload, site: { baseUrl: options.baseUrl }, dataFile: history.path }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const token = randomBytes(16).toString('hex')
  const history = createHistoryStore(options.dataDir)

  /** @type {unknown} */
  let credentials = null
  ctx.inject(['credentials'], (scoped) => {
    credentials = scoped.credentials
  })

  async function resolveAccessToken() {
    if (options.accessToken !== '') return options.accessToken
    if (credentials !== null) {
      try {
        const resolved = await credentials.resolve(options.accessTokenRef)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      } catch {
        // 回落磁盘
      }
    }
    return readKeyFromDisk(options.accessTokenRef)
  }

  async function resolveApiKey() {
    if (options.apiKey !== '') return options.apiKey
    if (credentials !== null) {
      try {
        const resolved = await credentials.resolve(options.apiKeyRef)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      } catch {
        // 凭据服务异常时退回磁盘读法
      }
    }
    return readKeyFromDisk(options.apiKeyRef)
  }

  let cache = { at: 0, payload: null }
  let inflight = null
  /** 系统访问令牌需要 `New-Api-User`，首次解析后缓存。 */
  let cachedUserId = null
  /** 网关限流/异常后的冷却截止时间；冷却期内直接给旧数据，不再打网关。 */
  let cooldownUntil = 0

  /**
   * @param {{ force?: boolean }} [request]
   */
  async function loadSummary(request = {}) {
    const force = request.force === true
    const at = Date.now()
    if (at < cooldownUntil && cache.payload !== null) return cache.payload
    if (!force && cache.payload !== null && at - cache.at < options.refreshMs) return cache.payload
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const payload = await refreshSummary({ options, resolveApiKey, resolveAccessToken, cachedUserId, history })
        if (payload !== null && Number(payload.userId) > 0) cachedUserId = Number(payload.userId)
        cache = { at: Date.now(), payload }
        return payload
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 限流或网关异常时进入 2 分钟冷却，避免把公司网关打疼
        cooldownUntil = Date.now() + 120_000
        const payload = { ok: false, error: message, generatedAt: Date.now() }
        // 有旧数据时继续给旧数据，附带错误说明，避免面板整块空掉
        return cache.payload !== null ? { ...cache.payload, staleError: message } : payload
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  const handler = (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://usage-board.local')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-url' })
      return
    }
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== `${API_PATH}/summary`) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!authorize(req, token)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const force = url.searchParams.get('force') === '1'
    loadSummary({ force }).then(
      (payload) => sendJson(res, payload?.ok === false ? 502 : 200, payload),
      (error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token })
    })
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PATH, handler }),
      'usage-board: summary api',
    )
  })
}
