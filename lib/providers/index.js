/**
 * 供应商注册表：kind → 适配器。
 *
 * 新增一个供应商只需要在这里登记，并在 `lib/providers/` 下实现同样的
 * `createProvider({ provider, secrets, userId, timeZone })` 与 `probe()`，
 * 宿主与客户端都不需要按 kind 分支。
 */

import * as newapi from './newapi.js'
import * as wandapi from './wandapi.js'

/** @type {Record<string, { KIND: string, CAPS: readonly string[], createProvider: Function }>} */
const REGISTRY = {
  [newapi.KIND]: newapi,
  [wandapi.KIND]: wandapi,
}

export const PROVIDER_KINDS = Object.freeze(Object.keys(REGISTRY))

/**
 * @param {string} kind
 * @returns {typeof newapi}
 */
export function getAdapter(kind) {
  const adapter = REGISTRY[kind]
  if (adapter === undefined) {
    throw new Error(`usage-board: 未知供应商类型「${kind}」（可选 ${PROVIDER_KINDS.join(' / ')}）`)
  }
  return adapter
}

/** @param {string} kind @returns {readonly string[]} */
export function capsFor(kind) {
  return getAdapter(kind).CAPS
}
