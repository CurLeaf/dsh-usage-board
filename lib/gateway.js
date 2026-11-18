/**
 * 网关只读客户端。只碰三个不需要管理员权限的路由：
 * - `GET /api/usage/token/`：本密钥的累计额度（`sk-` 密钥即可）
 * - `GET /api/log/token`：最近 1000 条请求明细（同密钥）
 * - `GET /api/status`：站点配置（货币换算、quota_per_unit、price）
 *
 * `/api/log/self`、`/api/user/self` 需要「系统访问令牌」，本插件不用。
 *
 * 错误一律抛 {@link GatewayError}：上层据此给面板稳定的 `code`，而不是解析中文文案。
 */

/** 面板与设置弹窗共用的错误分类。 */
export const GATEWAY_ERROR_CODES = Object.freeze([
  'missing_credentials',
  'invalid_credentials',
  'forbidden',
  'rate_limited',
  'network',
  'unsupported_provider',
])

/**
 * New API 响应里 `success:false` 的文案没有稳定结构，只能按语义归类。
 * 先判权限（scope/permission），其余按默认的凭据无效处理。
 */
const FORBIDDEN_MESSAGE = /scope|permission|forbidden|权限|无权限/i

/** @param {number} status */
export function codeFromStatus(status) {
  if (status === 401) return 'invalid_credentials'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'network'
  return null
}

/** @param {string} message @returns {'invalid_credentials'|'forbidden'} */
export function codeFromMessage(message) {
  const text = String(message ?? '')
  if (FORBIDDEN_MESSAGE.test(text)) return 'forbidden'
  // 网关的 `success:false` 绝大多数就是凭据/登录态问题；认不出来的按默认归类。
  return 'invalid_credentials'
}

/** 带稳定 `code` 的网关错误；`status` 是 HTTP 状态（网络层失败为 0）。 */
export class GatewayError extends Error {
  /**
   * @param {string} message
   * @param {typeof GATEWAY_ERROR_CODES[number]} code
   * @param {number} [status]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code = 'invalid_credentials', status = 0, options = undefined) {
    super(message, options)
    this.name = 'GatewayError'
    this.code = code
    this.status = status
  }
}

/** @param {number} status */
function statusMessage(status) {
  if (status === 401) return '网关拒绝该密钥（401）'
  if (status === 403) return '网关拒绝访问（403，权限不足）'
  if (status === 429) return '网关限流（429），稍后自动重试'
  if (status >= 500) return `网关异常（HTTP ${status}）`
  return `网关请求失败（HTTP ${status}）`
}

/** @param {unknown} error @param {string} path */
function networkMessage(error, path) {
  const name = error !== null && typeof error === 'object' ? error.name : ''
  if (name === 'AbortError') return `网关 ${path} 请求超时`
  const detail = error instanceof Error && error.message !== '' ? `：${error.message}` : ''
  return `网关 ${path} 网络错误${detail}`
}

/** @param {{ baseUrl: string, apiKey?: string, accessToken?: string, userId?: number|string, timeoutMs?: number }} options */
export function createGateway(options) {
  const root = String(options.baseUrl ?? '').replace(/\/+$/, '')
  const apiKey = String(options.apiKey ?? '')
  const accessToken = String(options.accessToken ?? '')
  const userId = options.userId === undefined || options.userId === null ? '' : String(options.userId)
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20_000

  if (root === '') throw new Error('usage-board: baseUrl 未配置')
  if (apiKey === '' && accessToken === '') throw new Error('usage-board: 缺少网关密钥')

  /** 系统访问令牌走 `Authorization` + `New-Api-User`；sk- 密钥只带 Authorization。 */
  function headers(mode) {
    const base = { accept: 'application/json' }
    if (mode === 'user') {
      const withUser = { ...base, authorization: `Bearer ${accessToken}` }
      if (userId !== '') withUser['new-api-user'] = userId
      return withUser
    }
    // 只有系统访问令牌、没有 sk- 密钥时（例如 /source/test 的 token-only 探测），
    // 不要发一个空的 `Bearer `。
    if (apiKey === '') return base
    return { ...base, authorization: `Bearer ${apiKey}` }
  }

  /** @param {string} path @param {'key'|'user'} [mode] */
  async function getJson(path, mode = 'key') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response
      try {
        response = await fetch(`${root}${path}`, {
          method: 'GET',
          headers: headers(mode),
          signal: controller.signal,
        })
      } catch (error) {
        throw new GatewayError(networkMessage(error, path), 'network', 0, { cause: error })
      }

      let text
      try {
        text = await response.text()
      } catch (error) {
        throw new GatewayError(networkMessage(error, path), 'network', response.status, { cause: error })
      }

      let body
      try {
        body = JSON.parse(text)
      } catch {
        // 401/403/429/5xx 即使回 HTML 或空 body，也优先按 HTTP 语义分类，
        // 否则用户会看到「网络错误」而被误导。
        const byStatus = codeFromStatus(response.status)
        if (byStatus !== null) {
          throw new GatewayError(statusMessage(response.status), byStatus, response.status)
        }
        throw new GatewayError(`网关 ${path} 返回非 JSON（HTTP ${response.status}）`, 'network', response.status)
      }

      const byStatus = codeFromStatus(response.status)
      if (byStatus !== null) {
        const message = typeof body?.message === 'string' && body.message.trim() !== ''
          ? body.message.trim()
          : statusMessage(response.status)
        throw new GatewayError(message, byStatus, response.status)
      }

      // New API 的业务信封：HTTP 200 也可能 success:false。
      // `/api/usage/token/` 没有 success 字段，缺失时视为成功，不能误判。
      if (body !== null && typeof body === 'object' && body.success === false) {
        const message = typeof body.message === 'string' && body.message.trim() !== ''
          ? body.message.trim()
          : `网关拒绝请求（HTTP ${response.status}）`
        throw new GatewayError(message, codeFromMessage(message), response.status)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  const userMode = accessToken !== ''

  return {
    baseUrl: root,
    hasAccessToken: userMode,
    tokenUsage: () => getJson('/api/usage/token/'),
    logs: () => getJson('/api/log/token'),
    status: () => getJson('/api/status'),
    /** 登录态：当前用户（余额/已用/请求数）。 */
    userSelf: () => getJson('/api/user/self', 'user'),
    /**
     * 登录态：按小时聚合的额度/请求数/ token（后台「用量概览」的数据源）。
     * @param {number} start 秒
     * @param {number} end 秒
     */
    quotaData: (start, end) => getJson(`/api/data/self?start_timestamp=${start}&end_timestamp=${end}`, 'user'),
    /**
     * 登录态：分页日志，支持 type / 时间范围过滤。
     * @param {{ page?: number, pageSize?: number, type?: number, start?: number, end?: number }} query
     */
    userLogs: (query = {}) => {
      const page = Number(query.page) > 0 ? Number(query.page) : 1
      const pageSize = Number(query.pageSize) > 0 ? Number(query.pageSize) : 20
      let path = `/api/log/self?p=${page}&page_size=${pageSize}`
      if (query.type !== undefined) path += `&type=${query.type}`
      if (query.start !== undefined) path += `&start_timestamp=${query.start}`
      if (query.end !== undefined) path += `&end_timestamp=${query.end}`
      return getJson(path, 'user')
    },
  }
}

/**
 * 从两份网关响应里取出日志行与密钥累计额度；出错时抛出带中文说明的错误。
 * @param {Record<string, unknown>} logsBody `/api/log/token` 响应
 * @param {Record<string, unknown>} usageBody `/api/usage/token/` 响应
 */
export function readGatewayBodies(logsBody, usageBody) {
  const rows = Array.isArray(logsBody?.data) ? logsBody.data : null
  if (rows === null) {
    const message = typeof logsBody?.message === 'string' && logsBody.message !== ''
      ? logsBody.message
      : '日志接口未返回 data 数组'
    throw new Error(message)
  }
  const usageData = usageBody?.data
  if (usageData === null || typeof usageData !== 'object') {
    throw new Error('额度接口未返回 data 对象')
  }
  return { rows, usage: { data: usageData } }
}
