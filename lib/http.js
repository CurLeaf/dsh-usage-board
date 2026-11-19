/**
 * 只读 HTTP 客户端与错误分类。
 *
 * 两个供应商的错误信封不一样：
 * - New API：HTTP 200 也可能 `{success:false,message}`；
 * - wandapi：标准 `{error:{type,message}}`，HTTP 状态即语义（401/402/403/429）。
 *
 * 上层只认 `code`，不解析文案，所以这里把两者归一成同一组 code。
 */

/** 面板与设置视图共用的错误分类。 */
export const ERROR_CODES = Object.freeze([
  'missing_credentials',
  'invalid_credentials',
  'forbidden',
  'payment_required',
  'rate_limited',
  'not_found',
  'invalid_response',
  'network',
])

/** 这些错误要用户去改配置/密钥，面板应直接进「失效」视图。 */
export const SETUP_CODES = Object.freeze([
  'missing_credentials',
  'invalid_credentials',
  'forbidden',
  'payment_required',
])

/** @param {number} status @returns {string | null} */
export function codeFromStatus(status) {
  if (status === 401) return 'invalid_credentials'
  if (status === 402) return 'payment_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'network'
  return null
}

/** @param {number} status */
function statusMessage(status) {
  if (status === 401) return '供应商拒绝该密钥（401）'
  if (status === 402) return '余额不足（402），请先充值'
  if (status === 403) return '密钥被禁用或权限不足（403）'
  if (status === 429) return '供应商限流（429），稍后自动重试'
  if (status >= 500) return `供应商异常（HTTP ${status}）`
  return `供应商请求失败（HTTP ${status}）`
}

/** 带稳定 `code` 的请求错误；`status` 是 HTTP 状态，网络层失败为 0。 */
export class RequestError extends Error {
  /**
   * @param {string} message
   * @param {typeof ERROR_CODES[number]} code
   * @param {number} [status]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code = 'network', status = 0, options = undefined) {
    super(message, options)
    this.name = 'RequestError'
    this.code = code
    this.status = status
  }
}

/** 从两家不同的错误信封里抠出人话；抠不到就给状态码文案。 */
function errorMessage(body, status) {
  if (body !== null && typeof body === 'object') {
    const nested = body.error
    if (nested !== null && typeof nested === 'object' && typeof nested.message === 'string' && nested.message.trim() !== '') {
      return nested.message.trim()
    }
    if (typeof nested === 'string' && nested.trim() !== '') return nested.trim()
    if (typeof body.message === 'string' && body.message.trim() !== '') return body.message.trim()
    if (typeof body.error_description === 'string' && body.error_description.trim() !== '') return body.error_description.trim()
  }
  return statusMessage(status)
}

/**
 * 发一个 GET 并解析 JSON。
 *
 * @param {string} url 完整地址
 * @param {{
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  try {
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...(options.headers ?? {}) },
        signal: controller.signal,
      })
    } catch (error) {
      const name = error !== null && typeof error === 'object' ? error.name : ''
      const message = name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : `网络错误：${describe(error)}`
      throw new RequestError(message, 'network', 0, { cause: error })
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new RequestError(`读取响应失败：${describe(error)}`, 'network', response.status, { cause: error })
    }

    let body = null
    let parsed = false
    try {
      body = text === '' ? null : JSON.parse(text)
      parsed = true
    } catch {
      parsed = false
    }

    const byStatus = codeFromStatus(response.status)
    if (byStatus !== null) {
      throw new RequestError(errorMessage(body, response.status), byStatus, response.status)
    }
    if (!parsed) {
      throw new RequestError(`返回非 JSON（HTTP ${response.status}）`, 'invalid_response', response.status)
    }
    // New API 的业务信封：HTTP 200 也可能 success:false。
    if (body !== null && typeof body === 'object' && body.success === false) {
      throw new RequestError(errorMessage(body, response.status), 'invalid_credentials', response.status)
    }
    if (body === null || typeof body !== 'object') {
      throw new RequestError('返回内容不是 JSON 对象', 'invalid_response', response.status)
    }
    return body
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** @param {unknown} error */
function describe(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 把任意异常归类到 `code`，供失败载荷使用。 */
export function classifyError(error) {
  if (error instanceof RequestError) return error.code
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && ERROR_CODES.includes(error.code)) {
    return error.code
  }
  return 'network'
}
