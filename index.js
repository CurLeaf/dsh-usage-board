/**
 * 宿主半边：按当前选中的供应商取数 → 归一化快照 → 同源只读路由 + SSE。
 *
 * 设计要点（与 v0.2 的区别都是「减法」）：
 * - 供应商是可切换的：配置里列若干条，选中项落在 `source.json`，随时可在面板里换；
 * - 每个供应商一个适配器，能力由适配器声明（`caps`），宿主不做跨供应商拼装；
 * - 没有日志窗口法、没有本地小时累计、没有「旧数据 + 错误提示」的混合载荷：
 *   失败就是一份失败载荷，面板进失效视图，不假装有数；
 * - 密钥不出宿主：面板只拿聚合结果，前缀用一次一密的进程令牌鉴权。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { RequestError, SETUP_CODES, classifyError } from './lib/http.js'
import { PROVIDER_KINDS, getAdapter } from './lib/providers/index.js'
import { KIND as NEWAPI_KIND, detectUserId } from './lib/providers/newapi.js'
import { SourceError, createSourceStore, providerView, resolveSelection } from './lib/source.js'
import { createStreamHub } from './lib/stream.js'

export const name = 'usage-board'

/** 与 cordis.patch.yml 的 insert[].id 一致。 */
export const API_PATH = '/usage-board/api'
export const SUMMARY_PATH = `${API_PATH}/summary`
export const STREAM_PATH = `${API_PATH}/stream`
export const SOURCE_PATH = `${API_PATH}/source`
export const SOURCE_TEST_PATH = `${API_PATH}/source/test`

/** 新路由的 JSON body 上限（访问令牌可能较长）。 */
export const MAX_BODY_BYTES = 8 * 1024

/**
 * 页面令牌落盘文件名（`<dataDir>/api-token`，0600）。
 *
 * 令牌每次进程启动都换的话，dsh-web 一重启，所有已打开页面立刻 403、看板变「失效」，
 * 直到手动刷新。持久化之后重启仍用同一枚令牌：随机网站依旧读不到它（CSRF 防护不变），
 * 而已经打开的页面能自动重连、无需刷新。
 */
export const TOKEN_FILE = 'api-token'

/** 令牌是 16 字节随机数的 hex，长度固定 32。 */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** 注入 index 的全局名；客户端从这里读进程令牌。 */
export const TOKEN_GLOBAL = '__DSH_USAGE_BOARD__'
/** 客户端携带令牌的请求头。 */
export const TOKEN_HEADER = 'x-usage-board'

/**
 * 进程令牌对不上：最常见的原因是 dsh-web 重启过，页面还带着旧进程注入的令牌。
 * 这条要给出独立 code，面板才知道该提示「刷新页面」而不是「稍后重试」。
 */
export const TOKEN_MISMATCH_CODE = 'token_mismatch'
const TOKEN_MISMATCH_BODY = Object.freeze({
  ok: false,
  code: TOKEN_MISMATCH_CODE,
  error: '页面令牌与宿主进程不一致（dsh-web 重启过），请刷新页面',
})

/** 每种供应商的默认项；配置里只写差异即可。 */
const KIND_DEFAULTS = {
  newapi: {
    keyRef: 'DEEPSEEK_API_KEY',
    accessTokenRef: 'QZSY_ACCESS_TOKEN',
    quotaPerUnit: 500_000,
    price: 1,
  },
  wandapi: {
    keyRef: 'WANDAPI_API_KEY',
    accessTokenRef: '',
    quotaPerUnit: 1,
    price: 1,
  },
}

const DEFAULTS = {
  refreshMs: 300_000,
  timeZone: 'Asia/Shanghai',
}

/** 失败载荷的最长缓存时间；比 refreshMs 短得多，网络抖动恢复后面板要能自己复原。 */
const FAILURE_TTL_MS = 60_000

function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** @param {unknown} value @returns {string} */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 归一化配置。配置错误一律在 apply 时抛出：宁可插件不加载，也不要带着半份
 * 配置去请求网关（那样面板只会显示语义不明的失败）。
 *
 * @param {Record<string, unknown>} [raw]
 */
export function normalizeConfig(raw = {}) {
  const list = Array.isArray(raw.providers) ? raw.providers : []
  if (list.length === 0) {
    throw new Error('usage-board: config.providers 至少要有一个供应商')
  }

  const providers = []
  const seen = new Set()
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      throw new Error('usage-board: config.providers[] 必须是对象')
    }
    const id = trimmed(item.id)
    if (id === '') throw new Error('usage-board: config.providers[].id 不能为空')
    if (seen.has(id)) throw new Error(`usage-board: 供应商 id 重复：${id}`)
    const kind = trimmed(item.kind)
    if (!PROVIDER_KINDS.includes(kind)) {
      throw new Error(`usage-board: 未知供应商类型「${kind}」（可选 ${PROVIDER_KINDS.join(' / ')}）`)
    }
    const baseUrl = trimmed(item.baseUrl).replace(/\/+$/, '')
    if (baseUrl === '') throw new Error(`usage-board: 供应商 ${id} 缺少 baseUrl`)
    const defaults = KIND_DEFAULTS[kind]
    const quotaPerUnit = Number(item.quotaPerUnit)
    const price = Number(item.price)
    const userId = Number(item.userId)
    seen.add(id)
    providers.push({
      id,
      kind,
      name: trimmed(item.name) === '' ? id : trimmed(item.name),
      baseUrl,
      keyRef: trimmed(item.keyRef) === '' ? defaults.keyRef : trimmed(item.keyRef),
      accessTokenRef: trimmed(item.accessTokenRef) === '' ? defaults.accessTokenRef : trimmed(item.accessTokenRef),
      quotaPerUnit: Number.isFinite(quotaPerUnit) && quotaPerUnit > 0 ? quotaPerUnit : defaults.quotaPerUnit,
      price: Number.isFinite(price) && price > 0 ? price : defaults.price,
      userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    })
  }

  const defaultProvider = trimmed(raw.defaultProvider)
  const defaultId = defaultProvider === '' ? providers[0].id : defaultProvider
  if (!providers.some((provider) => provider.id === defaultId)) {
    throw new Error(`usage-board: defaultProvider「${defaultId}」不在 providers 里`)
  }

  const refreshMs = Number(raw.refreshMs)
  return {
    providers,
    defaultProvider: defaultId,
    refreshMs: Number.isFinite(refreshMs) && refreshMs > 0 ? Math.max(60_000, refreshMs) : DEFAULTS.refreshMs,
    timeZone: trimmed(raw.timeZone) === '' ? DEFAULTS.timeZone : trimmed(raw.timeZone),
    dataDir: trimmed(raw.dataDir) === '' ? join(dshHome(), 'usage-board') : trimmed(raw.dataDir),
  }
}

/**
 * 读取或首次生成页面令牌。
 * @param {string} dataDir
 * @returns {string} 32 位 hex
 */
export function loadOrCreateToken(dataDir) {
  const file = join(dataDir, TOKEN_FILE)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch {
    // 文件不存在（首次启动）或不可读 → 生成一枚
  }
  const token = randomBytes(16).toString('hex')
  mkdirSync(dataDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return token
}

/** @param {unknown} error @returns {string} */
export function classifyRefreshError(error) {
  return classifyError(error)
}

/**
 * 失败载荷：不带任何旧数据。`code` 是面板唯一依赖的分类字段。
 * @param {unknown} error
 * @param {{ id: string, kind: string, name: string } | null} provider
 * @param {number} [generatedAt]
 */
export function buildFailurePayload(error, provider = null, generatedAt = Date.now()) {
  const code = classifyError(error)
  return {
    ok: false,
    provider: provider === null ? null : { id: provider.id, kind: provider.kind, name: provider.name },
    code,
    error: error instanceof Error ? error.message : String(error),
    needsSetup: SETUP_CODES.includes(code),
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
 * 读 JSON 请求体：必须是有上限的对象型 JSON。超限时读完丢弃，保证客户端收到 413。
 * @param {import('node:http').IncomingMessage} req
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
 * 路由分发：`/summary` 快照、`/stream` SSE、`/source` 选择与测试，共用进程令牌。
 * @param {{
 *   token: string,
 *   loadSummary: (request?: { force?: boolean }) => Promise<any>,
 *   readCache?: () => unknown,
 *   stream?: ReturnType<typeof createStreamHub> | null,
 *   describeSource: () => Promise<any>,
 *   switchProvider: (body: Record<string, unknown>) => Promise<any>,
 *   testProvider: (body: Record<string, unknown>) => Promise<any>,
 * }} input
 */
export function createRouter({ token, loadSummary, readCache = () => null, stream = null, describeSource, switchProvider, testProvider }) {
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
        sendJson(res, 403, TOKEN_MISMATCH_BODY)
        return
      }
      if (stream === null) {
        sendJson(res, 503, { ok: false, error: 'stream-unavailable' })
        return
      }
      // 先回当前快照让面板立刻有数，再异步刷新一次（有缓存时命中 TTL）。
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
        sendJson(res, 403, TOKEN_MISMATCH_BODY)
        return
      }
      readJsonBody(req)
        .then((body) => testProvider(body))
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendRouteError(res, error))
      return
    }

    if (path === SOURCE_PATH) {
      if (method !== 'GET' && method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!authorize(req, token)) {
        sendJson(res, 403, TOKEN_MISMATCH_BODY)
        return
      }
      if (method === 'POST') {
        readJsonBody(req)
          .then((body) => switchProvider(body))
          .then((payload) => sendJson(res, 200, payload))
          .catch((error) => sendRouteError(res, error))
        return
      }
      describeSource().then(
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
      sendJson(res, 403, TOKEN_MISMATCH_BODY)
      return
    }
    const force = url.searchParams.get('force') === '1'
    loadSummary({ force }).then(
      (payload) => sendJson(res, payload?.ok === false ? 502 : 200, payload),
      (error) => sendJson(res, 500, buildFailurePayload(error)),
    )
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const token = loadOrCreateToken(options.dataDir)
  const store = createSourceStore(options.dataDir)

  /** @type {any} */
  let credentials = null
  ctx.inject(['credentials'], (scoped) => {
    credentials = scoped.credentials
  })

  /**
   * 密钥只从 DSH 凭据服务解析；服务没注入就明确报缺失，不去翻明文文件。
   * @param {string} ref @returns {Promise<string>}
   */
  async function resolveRef(ref) {
    if (ref === '') return ''
    if (credentials === null) {
      throw new RequestError('凭据服务尚未就绪，稍后重试', 'missing_credentials')
    }
    const resolved = await credentials.resolve(ref)
    const value = resolved !== null && typeof resolved === 'object' ? resolved.value : undefined
    return typeof value === 'string' ? value : ''
  }

  /** @param {string} ref @returns {Promise<'configured' | 'missing'>} */
  async function credentialStatus(ref) {
    if (ref === '') return 'missing'
    if (credentials === null) return 'missing'
    try {
      const info = await credentials.describe(ref)
      return info !== null && typeof info === 'object' && info.configured === true ? 'configured' : 'missing'
    } catch {
      return 'missing'
    }
  }

  function selectedProvider() {
    return resolveSelection(options.providers, store.provider, options.defaultProvider)
  }

  /** @type {Map<string, number>} */
  const userIdCache = new Map()

  /**
   * 以显式错误收口「凭据不全」，而不是让请求随机失败。
   * @param {ReturnType<typeof normalizeConfig>['providers'][number]} provider
   * @param {{ apiKey: string, accessToken: string }} secrets
   */
  function assertCredentials(provider, secrets) {
    if (provider.kind === NEWAPI_KIND) {
      if (secrets.accessToken === '') {
        throw new RequestError(
          `供应商「${provider.name}」缺少系统访问令牌（凭据 ${provider.accessTokenRef || '未配置'}）`,
          'missing_credentials',
        )
      }
      if (provider.userId === null && secrets.apiKey === '') {
        throw new RequestError(
          `供应商「${provider.name}」需要 sk- 密钥来确定 New-Api-User，或在配置里显式给 userId`,
          'missing_credentials',
        )
      }
      return
    }
    if (secrets.apiKey === '') {
      throw new RequestError(`供应商「${provider.name}」缺少密钥（凭据 ${provider.keyRef}）`, 'missing_credentials')
    }
  }

  /**
   * @param {ReturnType<typeof normalizeConfig>['providers'][number]} provider
   * @param {{ apiKey: string }} secrets
   */
  async function ensureUserId(provider, secrets) {
    if (provider.kind !== NEWAPI_KIND) return null
    if (provider.userId !== null) return provider.userId
    const cached = userIdCache.get(provider.id)
    if (cached !== undefined) return cached
    const detected = await detectUserId({ baseUrl: provider.baseUrl, apiKey: secrets.apiKey })
    if (detected === null) {
      throw new RequestError(
        `无法从日志识别 user_id（供应商「${provider.name}」），请在配置里显式给 userId`,
        'invalid_credentials',
      )
    }
    userIdCache.set(provider.id, detected)
    return detected
  }

  /** 一次取数：选中供应商 → 适配器 → 归一化快照。 */
  async function refreshSnapshot() {
    const provider = selectedProvider()
    const secrets = {
      apiKey: await resolveRef(provider.keyRef),
      accessToken: provider.kind === NEWAPI_KIND ? await resolveRef(provider.accessTokenRef) : '',
    }
    assertCredentials(provider, secrets)
    const userId = await ensureUserId(provider, secrets)
    const adapter = getAdapter(provider.kind)
    const instance = adapter.createProvider({
      provider,
      secrets,
      userId,
      timeZone: options.timeZone,
    })
    const snapshot = await instance.fetchSnapshot({ now: Date.now() })
    return { ...snapshot, site: { baseUrl: provider.baseUrl }, refreshMs: options.refreshMs }
  }

  /** @type {{ at: number, providerId: string | null, payload: any } | null} */
  let cache = null
  /** @type {Promise<any> | null} */
  let inflight = null

  /**
   * 失败载荷只压一小会儿：断网/代理换节点通常是几十秒的自愈，
   * 按 refreshMs（默认 5 分钟）缓存失败会让面板在最需要它的时候一直停在「失效」。
   */
  function cacheTtl() {
    return cache !== null && cache.payload !== null && typeof cache.payload === 'object' && cache.payload.ok === false
      ? Math.min(options.refreshMs, FAILURE_TTL_MS)
      : options.refreshMs
  }

  const hub = createStreamHub({
    heartbeatMs: 25_000,
    retryMs: 5_000,
    onAttach: () => startTicks(),
    onDetach: () => {
      if (hub.size === 0) stopTicks()
    },
  })

  /**
   * 刷新一次：成功推快照，失败推失败载荷；两者都覆盖缓存（不留旧数据）。
   * @param {{ force?: boolean }} [request]
   */
  async function loadSummary(request = {}) {
    const force = request.force === true
    const provider = selectedProvider()
    if (!force && cache !== null && cache.providerId === provider.id && Date.now() - cache.at < cacheTtl()) {
      return cache.payload
    }
    if (inflight !== null) return inflight
    inflight = (async () => {
      let payload
      try {
        payload = await refreshSnapshot()
      } catch (error) {
        payload = buildFailurePayload(error, provider)
      }
      cache = { at: Date.now(), providerId: provider.id, payload }
      hub.publish(payload)
      return payload
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  /**
   * 只在有面板订阅时刷新；唤醒时间按缓存年龄对齐，避免多打供应商。
   */
  let tick = null
  function scheduleTick() {
    const now = Date.now()
    const age = cache === null ? options.refreshMs : now - cache.at
    const wait = Math.max(5_000, cacheTtl() - age)
    tick = setTimeout(() => {
      tick = null
      if (hub.size === 0) return
      loadSummary({}).finally(() => {
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

  /** GET /source */
  async function describeSource() {
    const current = selectedProvider()
    const providers = []
    for (const provider of options.providers) {
      const keyStatus = await credentialStatus(provider.keyRef)
      const tokenRef = provider.kind === NEWAPI_KIND ? provider.accessTokenRef : ''
      const tokenStatus = tokenRef === '' ? 'not_required' : await credentialStatus(tokenRef)
      let tokenTail = null
      if (tokenStatus === 'configured') {
        const value = await resolveRef(tokenRef)
        tokenTail = value === '' ? null : `…${value.slice(-4)}`
      }
      providers.push(providerView({ provider, selected: provider.id === current.id, keyStatus, tokenStatus, tokenTail }))
    }
    return { ok: true, providers, selected: current.id, refreshMs: options.refreshMs, timeZone: options.timeZone }
  }

  /** POST /source：切换供应商（可选写入/清除访问令牌），成功后立即刷新。 */
  async function switchProvider(body = {}) {
    const id = typeof body.provider === 'string' ? body.provider : ''
    const target = options.providers.find((provider) => provider.id === id)
    if (target === undefined) {
      throw new SourceError('unsupported_provider', `未知供应商「${id}」`, 400)
    }
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : ''
    const clearToken = body.clearAccessToken === true
    if (accessToken !== '' || clearToken) {
      if (target.kind !== NEWAPI_KIND) {
        throw new SourceError('unsupported_provider', `供应商「${target.name}」不需要访问令牌`, 400)
      }
      if (credentials === null) {
        throw new SourceError('unsupported_provider', '凭据服务不可用，无法保存访问令牌', 503)
      }
      if (accessToken !== '') await credentials.set(target.accessTokenRef, accessToken)
      if (clearToken && typeof credentials.unset === 'function') await credentials.unset(target.accessTokenRef)
    }

    store.save(target.id)
    userIdCache.clear()
    cache = null
    const snapshot = await loadSummary({ force: true })
    const described = await describeSource()
    return {
      ok: true,
      selected: described.selected,
      providers: described.providers,
      snapshot,
    }
  }

  /** POST /source/test：只探测，不切换、不落盘。 */
  async function testProvider(body = {}) {
    const id = typeof body.provider === 'string' && body.provider !== '' ? body.provider : selectedProvider().id
    const provider = options.providers.find((item) => item.id === id)
    if (provider === undefined) {
      throw new SourceError('unsupported_provider', `未知供应商「${id}」`, 400)
    }
    const override = typeof body.accessToken === 'string' ? body.accessToken.trim() : ''
    const secrets = {
      apiKey: await resolveRef(provider.keyRef),
      accessToken: provider.kind === NEWAPI_KIND
        ? (override !== '' ? override : await resolveRef(provider.accessTokenRef))
        : '',
    }
    try {
      assertCredentials(provider, secrets)
      const userId = await ensureUserId(provider, secrets)
      const instance = getAdapter(provider.kind).createProvider({
        provider,
        secrets,
        userId,
        timeZone: options.timeZone,
      })
      const result = await instance.probe()
      return { ok: true, provider: provider.id, caps: result.caps }
    } catch (error) {
      return {
        ok: false,
        provider: provider.id,
        code: classifyError(error),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const handler = createRouter({
    token,
    loadSummary,
    readCache: () => cache?.payload ?? null,
    stream: hub,
    describeSource,
    switchProvider,
    testProvider,
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
