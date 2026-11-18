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
import { GatewayError, createGateway, readGatewayBodies } from './lib/gateway.js'
import { createHistoryStore } from './lib/history.js'
import { createSourceService, createSourceStore } from './lib/source.js'
import { createStreamHub } from './lib/stream.js'

export const name = 'usage-board'

/** 与 cordis.patch.yml 的 insert[].id 一致。 */
export const API_PATH = '/usage-board/api'

/** 一次性快照：`?force=1` 绕过宿主缓存，仍受限流冷却保护。 */
export const SUMMARY_PATH = `${API_PATH}/summary`

/** 用量来源（供应商发现 / 选择 / 测试）：GET + POST。 */
export const SOURCE_PATH = `${API_PATH}/source`

/** 只探测不保存：POST。 */
export const SOURCE_TEST_PATH = `${API_PATH}/source/test`

/** SSE 长连接：刷新完成时把同一份快照推给所有标签页。 */
export const STREAM_PATH = `${API_PATH}/stream`

/** 新路由的 JSON body 上限。 */
export const MAX_BODY_BYTES = 4 * 1024

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
 * summary 失败载荷的错误分类。客户端只认 `code`/`needsSetup`，不解析文案。
 * `unsupported_provider` 由来源发现与刷新链路共同产生（例如没有可用供应商）。
 */
const FAILURE_CODES = new Set([
  'missing_credentials',
  'invalid_credentials',
  'forbidden',
  'rate_limited',
  'network',
  'unsupported_provider',
])

/** 这些错误需要用户去「设置 → 模型」修配置，面板应展示设置入口。 */
const SETUP_CODES = new Set([
  'missing_credentials',
  'invalid_credentials',
  'forbidden',
  'unsupported_provider',
])

/** @param {unknown} error @returns {string} */
export function classifyRefreshError(error) {
  if (error instanceof GatewayError && FAILURE_CODES.has(error.code)) return error.code
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && FAILURE_CODES.has(error.code)) {
    return error.code
  }
  // fetch 之外的意外失败（聚合异常等）也只能归到网络/请求失败，避免面板没有 code 可读。
  return 'network'
}

/**
 * 把刷新异常构造成面板契约里的失败载荷。
 * @param {unknown} error
 * @param {number} [generatedAt]
 */
export function buildFailurePayload(error, generatedAt = Date.now()) {
  const code = classifyRefreshError(error)
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code,
    needsSetup: SETUP_CODES.has(code),
    generatedAt,
  }
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
    throw new GatewayError(
      '缺少网关密钥：请在「设置 → 模型」里选择一个已配置密钥、指向该网关的供应商',
      'missing_credentials',
      0,
    )
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

/** 请求体读取失败；status/code 直接用于 JSON 错误响应。 */
class BodyError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'BodyError'
    this.code = code
    this.status = status
  }
}

/**
 * 读 JSON 请求体：上限 4KB，必须是对象型 JSON。
 * 超限时继续把剩余字节读完（丢弃），确保客户端能收到 413 而不是连接重置。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false
    const cleanup = () => {
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      req.off?.('aborted', onAborted)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== null) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      if (tooLarge) {
        finish(new BodyError('body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`, 413), null)
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        finish(new BodyError('invalid_body', '请求体必须是 JSON', 400), null)
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        finish(new BodyError('invalid_body', '请求体必须是 JSON', 400), null)
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(new BodyError('invalid_body', '请求体必须是 JSON 对象', 400), null)
        return
      }
      finish(null, parsed)
    }
    const onError = (error) => {
      finish(new BodyError('invalid_body', error instanceof Error ? error.message : '读取请求体失败', 400), null)
    }
    const onAborted = () => {
      finish(new BodyError('invalid_body', '请求体读取被中止', 400), null)
    }
    req.on?.('data', onData)
    req.on?.('end', onEnd)
    req.on?.('error', onError)
    req.on?.('aborted', onAborted)
  })
}

/** @param {import('node:http').ServerResponse} res @param {unknown} error */
function sendRouteError(res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
  const code = typeof error?.code === 'string' ? error.code : 'network'
  sendJson(res, status, {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
  })
}

/**
 * 路由分发：`/summary` 一次性快照、`/stream` SSE 长连接、`/source` 来源设置，
 * 共用同一枚进程令牌。抽成纯函数，方便在 node:http 上直接起服务做端到端测试。
 *
 * @param {{
 *   token: string,
 *   loadSummary: (request?: { force?: boolean }) => Promise<any>,
 *   readCache?: () => unknown,
 *   stream?: ReturnType<typeof createStreamHub> | null,
 *   source?: ReturnType<typeof createSourceService> | null,
 * }} input
 */
export function createRouter({ token, loadSummary, readCache = () => null, stream = null, source = null }) {
  return function handler(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://usage-board.local')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-url' })
      return
    }
    const path = url.pathname.replace(/\/+$/, '')
    const method = req.method ?? 'GET'

    if (path === STREAM_PATH) {
      if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!authorize(req, token)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (stream === null) {
        sendJson(res, 503, { ok: false, error: 'stream-unavailable' })
        return
      }
      // 先回当前快照（可能已过期）让面板立刻有数，再异步焐热缓存
      const client = stream.attach(req, res, { payload: readCache() })
      if (client !== null) loadSummary({}).catch(() => {})
      return
    }

    if (path === SOURCE_TEST_PATH) {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!authorize(req, token)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (source === null) {
        sendJson(res, 503, { ok: false, code: 'unsupported_provider', error: 'source-unavailable' })
        return
      }
      readJsonBody(req)
        .then((body) => source.test(body))
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendRouteError(res, error))
      return
    }

    if (path === SOURCE_PATH) {
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!authorize(req, token)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (source === null) {
        sendJson(res, 503, { ok: false, code: 'unsupported_provider', error: 'source-unavailable' })
        return
      }
      if (method === 'POST') {
        readJsonBody(req)
          .then((body) => source.save(body))
          .then((payload) => sendJson(res, 200, payload))
          .catch((error) => sendRouteError(res, error))
        return
      }
      source.describe().then(
        (payload) => sendJson(res, 200, payload),
        (error) => sendRouteError(res, error),
      )
      return
    }

    if (path !== SUMMARY_PATH) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
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
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const token = randomBytes(16).toString('hex')
  const history = createHistoryStore(options.dataDir)

  /**
   * 只在有面板订阅时刷新：没人看就不打网关。
   * 下一次唤醒按「缓存年龄」算，而不是固定 interval —— 面板可能在缓存快过期时才打开，
   * 对齐 cache.at 才能既不提前打网关、也不让数据多放一个周期。
   *
   * 醒来时用不带 force 的 `loadSummary`：走缓存 TTL 判断，即使唤醒早了也不会白打一次网关。
   */
  let tick = null
  function scheduleTick() {
    const now = Date.now()
    const age = cache.payload === null ? options.refreshMs : now - cache.at
    const wait = now < cooldownUntil
      ? Math.max(5_000, cooldownUntil - now + 1_000)
      : Math.max(5_000, options.refreshMs - age)
    tick = setTimeout(() => {
      tick = null
      if (hub.size === 0) return
      loadSummary({}).catch(() => {}).finally(() => {
        if (hub.size > 0) scheduleTick()
      })
    }, wait)
    if (typeof tick.unref === 'function') tick.unref()
  }
  function startTicks() {
    if (tick === null) scheduleTick()
  }
  function stopTicks() {
    if (tick === null) return
    clearTimeout(tick)
    tick = null
  }

  const hub = createStreamHub({
    heartbeatMs: 25_000,
    retryMs: 5_000,
    onAttach: () => startTicks(),
    onDetach: () => {
      if (hub.size === 0) stopTicks()
    },
  })

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

  /**
   * 按 ref 解析 key：明文 `apiKey` 优先（只建议本地调试），其后凭据服务、最后磁盘。
   * @param {string} ref
   */
  async function resolveKeyByRef(ref) {
    if (options.apiKey !== '') return options.apiKey
    if (credentials !== null) {
      try {
        const resolved = await credentials.resolve(ref)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      } catch {
        // 凭据服务异常时退回磁盘读法
      }
    }
    return readKeyFromDisk(ref)
  }

  const sourceStore = createSourceStore(options.dataDir)
  /** 来源发现/选择/测试；服务未注入时 describe 会返回 readable:false。 */
  const source = createSourceService({
    options,
    store: sourceStore,
    resolveAccessToken,
    resolveKey: resolveKeyByRef,
    onSourceChanged: reloadSummary,
  })
  ctx.inject(['llm', 'settings', 'credentials'], (scoped) => {
    source.attach({ llm: scoped.llm, settings: scoped.settings, credentials: scoped.credentials })
  })

  async function resolveApiKey() {
    if (options.apiKey !== '') return options.apiKey
    let ref = options.apiKeyRef
    try {
      // 每次刷新重新发现：设置里换了供应商、或改了选中来源，下一次请求就生效，不需要重启。
      const selectedRef = await source.keyRef()
      if (typeof selectedRef === 'string' && selectedRef !== '') ref = selectedRef
    } catch {
      // 发现失败时回落到 config.apiKeyRef，保持旧行为
    }
    return resolveKeyByRef(ref)
  }

  let cache = { at: 0, payload: null }
  let inflight = null
  /** 系统访问令牌需要 `New-Api-User`，首次解析后缓存。 */
  let cachedUserId = null
  /** 网关限流/异常后的冷却截止时间；冷却期内直接给旧数据，不再打网关。 */
  let cooldownUntil = 0

  /**
   * POST /source 保存后调用：丢弃旧快照（可能来自旧供应商/旧令牌）、清冷却，
   * 立刻按新配置刷新一次。返回刷新载荷，供路由把失败原因带回。
   */
  async function reloadSummary() {
    cache = { at: 0, payload: null }
    cooldownUntil = 0
    cachedUserId = null
    // 若旧配置的刷新还在路上，先等它结束，避免 loadSummary 直接复用旧 inflight
    if (inflight !== null) {
      try {
        await inflight
      } catch {
        // 旧刷新失败不影响新配置的刷新
      }
    }
    return loadSummary({ force: true })
  }

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
        // 刷新完立刻推给所有打开的面板：同一份快照，多标签页各自渲染
        hub.publish(payload)
        return payload
      } catch (error) {
        const failure = buildFailurePayload(error)
        // 限流或网关异常时进入 2 分钟冷却，避免把公司网关打疼
        cooldownUntil = Date.now() + 120_000
        // 有旧数据时继续给旧数据，附带错误说明，避免面板整块空掉
        const result = cache.payload !== null
          ? {
              ...cache.payload,
              staleError: failure.error,
              staleCode: failure.code,
              staleNeedsSetup: failure.needsSetup,
            }
          : failure
        // 失败也让订阅者知道，而不是干等下一个刷新周期
        hub.publish(result)
        return result
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  const handler = createRouter({
    token,
    loadSummary,
    readCache: () => cache.payload,
    stream: hub,
    source,
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token })
    })
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PATH, handler }),
      'usage-board: summary api',
    )
    webCtx.effect(() => () => {
      stopTicks()
      hub.close()
    }, 'usage-board: stream hub')
  })
}
