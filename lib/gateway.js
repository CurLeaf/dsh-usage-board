/**
 * 网关只读客户端。只碰三个不需要管理员权限的路由：
 * - `GET /api/usage/token/`：本密钥的累计额度（`sk-` 密钥即可）
 * - `GET /api/log/token`：最近 1000 条请求明细（同密钥）
 * - `GET /api/status`：站点配置（货币换算、quota_per_unit、price）
 *
 * `/api/log/self`、`/api/user/self` 需要「系统访问令牌」，本插件不用。
 */

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
    return { ...base, authorization: `Bearer ${apiKey}` }
  }

  /** @param {string} path @param {'key'|'user'} [mode] */
  async function getJson(path, mode = 'key') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${root}${path}`, {
        method: 'GET',
        headers: headers(mode),
        signal: controller.signal,
      })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`网关 ${path} 返回非 JSON（HTTP ${response.status}）`)
      }
      if (response.status === 401) throw new Error('网关拒绝该密钥（401）')
      if (response.status === 429) throw new Error('网关限流（429），稍后自动重试')
      if (response.status >= 500) throw new Error(`网关异常（HTTP ${response.status}）`)
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
