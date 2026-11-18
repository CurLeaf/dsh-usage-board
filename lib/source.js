/**
 * 用量来源发现：从「设置 → 模型」已配置的模型供应商里，挑出指向**同一个
 * New API 网关**的那一个，复用它的 `apiKeyEnv` 凭据引用。
 *
 * 产品范围刻意收窄：不做通用适配层，只认我们这套网关。
 * - 供应商只从 `ctx.llm.listConfigurableProviders()` 的目录里来；
 * - 端点从 `ctx.settings.describe({ redactSecrets: true })` 的 profile 里取；
 * - 只比较 host+port（忽略 path，并容忍 profile 末尾的 `/v1`、`/v1beta`）；
 * - 只持久化 `{ providerId }`，绝不把 key 复制进 state 文件。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGateway, GatewayError, GATEWAY_ERROR_CODES } from './gateway.js'

/** 已选来源的持久化文件名，仅含 `{ providerId }`。 */
export const SOURCE_FILE = 'source.json'

const ERROR_CODES = new Set(GATEWAY_ERROR_CODES)

/** 路由层错误（400/413/503）；带 `code` 供面板直接展示。 */
export class SourceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    this.status = status
  }
}

/** @param {unknown} value */
function parseGatewayUrl(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url
}

/**
 * 归一化供应商 profile 里的网关地址：保留协议与 path 前缀，去掉末尾 `/v1`、
 * `/v1beta` 和多余斜杠。解析失败返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeGatewayBase(value) {
  const url = parseGatewayUrl(value)
  if (url === null) return null
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/(?:v1|v1beta)$/i, '')
  path = path.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/**
 * 取 `host[:port]`；host 大小写不敏感。解析失败返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function gatewayHost(value) {
  const url = parseGatewayUrl(value)
  return url === null ? null : url.host.toLowerCase()
}

/**
 * 是否指向同一网关：按契约只比较 host+port，忽略 path。
 * @param {unknown} left
 * @param {unknown} right
 */
export function sameGatewayHost(left, right) {
  const a = gatewayHost(left)
  const b = gatewayHost(right)
  return a !== null && a === b
}

/** @param {unknown} value @returns {string | null} */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** @param {unknown} value @param {unknown} path */
function walkProfile(value, path) {
  let current = value
  const keys = Array.isArray(path) ? path : []
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return null
    current = current[key]
  }
  return current !== null && typeof current === 'object' && !Array.isArray(current) ? current : null
}

/** @param {any} credentials @param {string | null} ref */
async function describeKeyStatus(credentials, ref) {
  if (ref === null) return 'missing'
  try {
    const info = await credentials.describe(ref)
    return info !== null && typeof info === 'object' && info.configured === true ? 'configured' : 'missing'
  } catch {
    // 凭据服务异常按未配置处理，不阻塞供应商列表
    return 'missing'
  }
}

/**
 * 列出指向 `baseUrl` 那个网关的可配置供应商。
 * 三个服务任一缺失时返回 `{ readable:false, candidates:[] }`，不抛错。
 *
 * @param {{ llm?: any, settings?: any, credentials?: any } | null} services
 * @param {{ baseUrl: string }} options
 * @returns {Promise<{readable: boolean, candidates: Array<Record<string, any>>}>}
 */
export async function collectCandidates(services, { baseUrl } = {}) {
  const unavailable = { readable: false, candidates: [] }
  if (services === null || typeof services !== 'object') return unavailable
  const { llm, settings, credentials } = services
  if (!llm || !settings || !credentials) return unavailable
  const targetHost = gatewayHost(baseUrl)
  if (targetHost === null) return unavailable

  let providers
  try {
    providers = llm.listConfigurableProviders()
  } catch {
    return unavailable
  }
  if (!Array.isArray(providers)) return unavailable

  let descriptors
  try {
    descriptors = settings.describe({ redactSecrets: true })
  } catch {
    return unavailable
  }
  if (!Array.isArray(descriptors)) return unavailable

  /** @type {Map<string, any>} */
  const sections = new Map()
  for (const descriptor of descriptors) {
    if (descriptor === null || typeof descriptor !== 'object') continue
    if (typeof descriptor.ns !== 'string') continue
    sections.set(descriptor.ns, descriptor)
  }

  const seen = new Set()
  const candidates = []
  for (const entry of providers) {
    if (entry === null || typeof entry !== 'object') continue
    const providerId = firstString(entry.provider)
    if (providerId === null || seen.has(providerId)) continue
    const settingsNs = firstString(entry.settingsNs)
    if (settingsNs === null) continue
    const descriptor = sections.get(settingsNs)
    if (descriptor === undefined) continue
    const profile = walkProfile(descriptor.value, entry.settingsPath)
    if (profile === null) continue
    const rawBaseUrl = firstString(profile.baseUrl, profile.baseURL)
    if (rawBaseUrl === null) continue
    const usageBaseUrl = normalizeGatewayBase(rawBaseUrl)
    if (usageBaseUrl === null || gatewayHost(usageBaseUrl) !== targetHost) continue
    const keyRef = firstString(profile.apiKeyEnv)
    seen.add(providerId)
    candidates.push({
      providerId,
      name: firstString(entry.displayName) ?? providerId,
      baseUrl: rawBaseUrl,
      usageBaseUrl,
      keyStatus: await describeKeyStatus(credentials, keyRef),
      keyRef,
    })
  }
  return { readable: true, candidates }
}

/**
 * 选择规则：存过且仍在候选里 → 它；否则候选恰好 1 个 → 自动选它；
 * 多个且没存 → null。纯函数，方便单测。
 * @param {Array<Record<string, any>>} candidates
 * @param {string | null} [storedProviderId]
 */
export function selectSource(candidates, storedProviderId = null) {
  const list = Array.isArray(candidates) ? candidates : []
  if (typeof storedProviderId === 'string' && storedProviderId !== '') {
    const hit = list.find((candidate) => candidate.providerId === storedProviderId)
    if (hit !== undefined) return hit
  }
  return list.length === 1 ? list[0] : null
}

/** @param {Record<string, any> | null} candidate */
function selectedView(candidate) {
  if (candidate === null) return null
  return {
    providerId: candidate.providerId,
    name: candidate.name,
    usageBaseUrl: candidate.usageBaseUrl,
    keyStatus: candidate.keyStatus,
  }
}

/** @param {Record<string, any>} candidate @param {string | null} selectedId */
function candidateView(candidate, selectedId) {
  return {
    providerId: candidate.providerId,
    name: candidate.name,
    baseUrl: candidate.baseUrl,
    usageBaseUrl: candidate.usageBaseUrl,
    keyStatus: candidate.keyStatus,
    selected: candidate.providerId === selectedId,
  }
}

/** @param {string} file @returns {string | null} */
function readProviderId(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return typeof parsed.providerId === 'string' && parsed.providerId !== '' ? parsed.providerId : null
  } catch {
    return null
  }
}

/**
 * `<dataDir>/source.json`：只存 `{providerId}`，原子写、0600。
 * @param {string} dataDir
 */
export function createSourceStore(dataDir) {
  const file = join(dataDir, SOURCE_FILE)
  let providerId = readProviderId(file)
  return {
    get providerId() {
      return providerId
    },
    get path() {
      return file
    },
    /** @param {string} nextProviderId */
    save(nextProviderId) {
      if (typeof nextProviderId !== 'string' || nextProviderId === '') {
        throw new SourceError('unsupported_provider', '缺少要保存的供应商', 400)
      }
      mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ providerId: nextProviderId }), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
      providerId = nextProviderId
      return providerId
    },
  }
}

/** @param {unknown} code */
function normalizeCode(code) {
  return typeof code === 'string' && ERROR_CODES.has(code) ? code : 'network'
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} error */
function probeFailure(error) {
  const code = error instanceof GatewayError ? normalizeCode(error.code) : normalizeCode(error?.code)
  return { ok: false, code, error: errorMessage(error) }
}

/**
 * 来源服务：GET /source、POST /source、POST /source/test 的宿主实现。
 *
 * @param {{
 *   options: { baseUrl: string, apiKeyRef: string, apiKey?: string, accessTokenRef: string, userId?: number | null },
 *   store: ReturnType<typeof createSourceStore>,
 *   services?: { llm?: any, settings?: any, credentials?: any } | null,
 *   resolveAccessToken?: () => Promise<string>,
 *   resolveKey?: (ref: string) => Promise<string>,
 *   onSourceChanged?: (() => Promise<any>) | null,
 * }} input
 */
export function createSourceService({
  options,
  store,
  services = null,
  resolveAccessToken = async () => '',
  resolveKey = async () => '',
  onSourceChanged = null,
}) {
  if (options === undefined || options === null) throw new Error('usage-board: source 缺少 options')
  if (store === undefined || store === null) throw new Error('usage-board: source 缺少 store')
  const baseUrl = String(options.baseUrl ?? '')
  /** @type {{ llm?: any, settings?: any, credentials?: any } | null} */
  let bound = services

  /** @param {{ llm?: any, settings?: any, credentials?: any } | null} next */
  function attach(next) {
    if (next === null || typeof next !== 'object') {
      bound = null
      return
    }
    bound = { llm: next.llm, settings: next.settings, credentials: next.credentials }
  }

  async function discover() {
    const collected = await collectCandidates(bound, { baseUrl })
    const selected = collected.readable ? selectSource(collected.candidates, store.providerId) : null
    return { ...collected, selected }
  }

  async function tokenInfo() {
    let value = ''
    try {
      const resolved = await resolveAccessToken()
      if (typeof resolved === 'string') value = resolved
    } catch {
      value = ''
    }
    if (value === '') return { configured: false, tail: null }
    return { configured: true, tail: `…${value.slice(-4)}` }
  }

  /** GET /source */
  async function describe() {
    const state = await discover()
    const selected = selectedView(state.selected)
    const selectedId = state.selected === null ? null : state.selected.providerId
    return {
      ok: true,
      gateway: { baseUrl },
      readable: state.readable,
      candidates: state.candidates.map((candidate) => candidateView(candidate, selectedId)),
      selected,
      token: await tokenInfo(),
    }
  }

  /** @param {any} state @param {unknown} providerId @returns {any} */
  function chooseProvider(state, providerId) {
    if (!state.readable) {
      throw new SourceError('unsupported_provider', '设置 → 模型 的供应商列表不可读，请确认 DSH 版本与插件配置', 400)
    }
    if (typeof providerId === 'string' && providerId !== '') {
      const hit = state.candidates.find((candidate) => candidate.providerId === providerId)
      if (hit === undefined) {
        throw new SourceError('unsupported_provider', `供应商 ${providerId} 不在指向该网关的候选里`, 400)
      }
      return hit
    }
    if (state.candidates.length === 0) {
      throw new SourceError('unsupported_provider', '未发现指向该网关的模型供应商，请先在「设置 → 模型」里配置', 400)
    }
    if (state.candidates.length > 1) {
      throw new SourceError('provider_required', '存在多个指向该网关的供应商，请指定 providerId', 400)
    }
    return state.candidates[0]
  }

  /** @param {any} candidate @returns {Promise<string>} */
  async function resolveCandidateKey(candidate) {
    const ref = candidate.keyRef ?? options.apiKeyRef
    try {
      const value = await resolveKey(ref)
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  /** POST /source */
  async function save(body = {}) {
    const state = await discover()
    const candidate = chooseProvider(state, body?.providerId)
    const token = typeof body?.accessToken === 'string' ? body.accessToken : ''
    const clearToken = body?.clearAccessToken === true

    if (token !== '' || clearToken) {
      const credentials = bound?.credentials
      if (!credentials) {
        throw new SourceError('unsupported_provider', '凭据服务不可用，无法保存访问令牌', 503)
      }
      if (token !== '') {
        if (typeof credentials.set !== 'function') {
          throw new SourceError('unsupported_provider', '凭据服务不支持写入访问令牌', 503)
        }
        await credentials.set(options.accessTokenRef, token)
      }
      if (clearToken) {
        if (typeof credentials.unset !== 'function') {
          throw new SourceError('unsupported_provider', '凭据服务不支持清除访问令牌', 503)
        }
        await credentials.unset(options.accessTokenRef)
      }
    }

    store.save(candidate.providerId)

    let refresh = null
    if (typeof onSourceChanged === 'function') {
      try {
        const payload = await onSourceChanged()
        if (payload !== null && payload !== undefined && payload.ok === false) {
          refresh = { ok: false, code: normalizeCode(payload.code), error: String(payload.error ?? '刷新失败') }
        }
      } catch (error) {
        refresh = { ok: false, code: normalizeCode(error?.code), error: errorMessage(error) }
      }
    }

    const next = await discover()
    // 保存已经成功；即使随后发现服务短暂不可读，也要把刚保存的来源带回去。
    const selectedCandidate = next.selected ?? (next.readable === false ? candidate : null)
    const response = {
      ok: true,
      selected: selectedView(selectedCandidate),
      token: await tokenInfo(),
    }
    if (refresh !== null) response.refresh = refresh
    return response
  }

  /** @param {() => Promise<any>} run */
  async function settle(run) {
    try {
      return { ok: true, value: await run() }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** POST /source/test：不保存，只探测当前凭据能走哪条口径。 */
  async function test(body = {}) {
    const state = await discover()
    const candidate = chooseProvider(state, body?.providerId)
    const apiKey = await resolveCandidateKey(candidate)
    const override = typeof body?.accessToken === 'string' && body.accessToken.trim() !== '' ? body.accessToken : ''
    let accessToken = override
    if (accessToken === '') {
      try {
        const resolved = await resolveAccessToken()
        if (typeof resolved === 'string') accessToken = resolved
      } catch {
        accessToken = ''
      }
    }
    if (apiKey === '' && accessToken === '') {
      return { ok: false, code: 'missing_credentials', error: '缺少可用的 API key 或系统访问令牌' }
    }

    let gateway
    try {
      gateway = createGateway({
        // 探测必须打 summary 真正会用的那个网关地址（config.baseUrl），
        // usageBaseUrl 只用于展示候选来源。
        baseUrl,
        apiKey,
        accessToken,
        userId: options.userId ?? undefined,
        timeoutMs: 15_000,
      })
    } catch (error) {
      return probeFailure(error)
    }

    const status = await settle(() => gateway.status())
    const usage = apiKey === '' ? { ok: false, skipped: true } : await settle(() => gateway.tokenUsage())
    const user = accessToken === '' ? { ok: false, skipped: true } : await settle(() => gateway.userSelf())

    if (!usage.ok && !user.ok) {
      // 优先报告真正用到的凭据的失败，其次才是 /api/status。
      const failure = usage.error ?? user.error ?? status.error
      return probeFailure(failure ?? new Error('网关探测失败'))
    }

    const account = user.ok
    const mode = account ? 'aggregate' : 'logs'
    return {
      ok: true,
      mode,
      capabilities: account
        // 系统访问令牌可用时，后台聚合口径（user/self + data/self + log/self）视为整体可用。
        ? { account: true, quotaData: true, logs: true }
        : { account: false, quotaData: usage.ok, logs: true },
    }
  }

  /** apply 的 resolveApiKey 用：当前选中供应商的 apiKeyEnv ref（没有则 null）。 */
  async function keyRef() {
    const state = await discover()
    return state.selected === null ? null : state.selected.keyRef
  }

  return { attach, discover, describe, save, test, keyRef }
}
