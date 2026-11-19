/**
 * WandAPI 供应商适配器（`api.wandapi.com`）。
 *
 * 数据面只有一个接口，密钥鉴权即可：
 *
 *   GET /v1/usage
 *   Authorization: Bearer sk-...
 *   → { periods: { today, last7d, last30d }, remaining, used, total, unit, timezone }
 *
 * 计费口径与 New API 完全不同：金额是 Credits 浮点原值（平台按 1 Credit ≈ 1 USD 结算），
 * 面板按 ¥ 展示、不做汇率换算；周期是现成的 today / 7 天 / 30 天，没有按小时、没有
 * 逐请求明细，控制台接口（`/api/iam/usage/*`）只认登录会话，这里不碰。
 *
 * 所以这个适配器只声明 periods + models 两项能力：没有的东西不编，客户端也不渲染。
 */

import { getJson, RequestError } from '../http.js'

export const KIND = 'wandapi'

export const CAPS = Object.freeze(['periods', 'models'])

/** 展示单位：接口给的是 Credits 原值，面板按 ¥ 呈现（不做汇率换算）。 */
export const UNIT = 'CNY'

/** 周期键 → 中文标签；顺序即界面顺序。 */
const PERIODS = [
  ['today', '今日'],
  ['last7d', '近 7 天'],
  ['last30d', '近 30 天'],
]

/** @param {unknown} value */
function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * @param {{ key: string, label: string, raw: Record<string, unknown> }} input
 */
function toPeriod({ key, label, raw }) {
  const requests = numberOrZero(raw.requests)
  const failed = numberOrZero(raw.failedCount)
  const successRate = Number(raw.successRate)
  const errorRate = Number.isFinite(successRate) && successRate >= 0 && successRate <= 1
    ? 1 - successRate
    : (requests > 0 ? failed / requests : 0)
  return {
    key,
    label,
    from: typeof raw.from === 'string' ? raw.from : '',
    to: typeof raw.to === 'string' ? raw.to : '',
    days: numberOrZero(raw.days),
    cost: numberOrZero(raw.cost),
    requests,
    errors: failed,
    errorRate,
    tokens: numberOrZero(raw.totalTokens),
    tokensIn: numberOrZero(raw.promptTokens),
    tokensOut: numberOrZero(raw.completionTokens),
  }
}

/**
 * @param {{
 *   provider: { id: string, name: string, baseUrl: string },
 *   secrets: { apiKey: string },
 * }} input
 */
export function createProvider({ provider, secrets }) {
  const baseUrl = provider.baseUrl.replace(/\/+$/, '')
  const apiKey = secrets.apiKey

  async function load() {
    const body = await getJson(`${baseUrl}/v1/usage`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    const periods = body.periods
    if (periods === null || typeof periods !== 'object' || periods.today === null || typeof periods.today !== 'object') {
      throw new RequestError('v1/usage 未返回 periods.today', 'invalid_response', 200)
    }
    return body
  }

  async function probe() {
    await load()
    return { ok: true, caps: CAPS }
  }

  /**
   * @param {{ now: number }} input
   */
  async function fetchSnapshot({ now }) {
    const body = await load()
    const list = []
    for (const [key, label] of PERIODS) {
      const raw = body.periods[key]
      if (raw === null || typeof raw !== 'object') continue
      list.push(toPeriod({ key, label, raw }))
    }
    const today = list.find((item) => item.key === 'today') ?? null
    if (today === null) {
      throw new RequestError('v1/usage 未返回今日周期', 'invalid_response', 200)
    }

    const monthly = body.periods.last30d
    const topModels = monthly !== null && typeof monthly === 'object' && Array.isArray(monthly.topModels)
      ? monthly.topModels
      : []
    const models = topModels
      .map((item) => ({
        model: typeof item?.modelName === 'string' ? item.modelName : '',
        requests: numberOrZero(item?.requests),
        cost: numberOrZero(item?.cost),
        tokens: numberOrZero(item?.totalTokens),
      }))
      .filter((item) => item.model !== '')
      .sort((left, right) => right.requests - left.requests)

    return {
      ok: true,
      provider: { id: provider.id, kind: KIND, name: provider.name, baseUrl },
      unit: 'CNY',
      caps: CAPS,
      timeZone: typeof body.timezone === 'string' && body.timezone !== '' ? body.timezone : 'UTC',
      generatedAt: now,
      account: {
        remaining: numberOrZero(body.remaining),
        used: numberOrZero(body.used),
        total: numberOrZero(body.total),
        requestCount: null,
      },
      today: {
        date: today.from,
        cost: today.cost,
        requests: today.requests,
        errors: today.errors,
        errorRate: today.errorRate,
        tokens: today.tokens,
        tokensIn: today.tokensIn,
        tokensOut: today.tokensOut,
      },
      periods: list,
      models,
      notes: ['账户级口径（该账号所有密钥合并），金额为 Credits 原值，按 ¥ 显示'],
    }
  }

  return { kind: KIND, unit: UNIT, caps: CAPS, probe, fetchSnapshot }
}
