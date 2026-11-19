/**
 * 供应商选择：把「当前看哪个供应商」落盘，并给出设置视图用的凭据状态。
 *
 * 只存一个 id（`source.json` = `{ "provider": "wandapi" }`），不存任何密钥：
 * 密钥仍然由 DSH 凭据服务按 ref 解析，换 key 后下次刷新自动跟随。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOURCE_FILE = 'source.json'

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

/** @param {string} file @returns {string | null} */
function readProviderId(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return typeof parsed.provider === 'string' && parsed.provider !== '' ? parsed.provider : null
  } catch {
    return null
  }
}

/**
 * `<dataDir>/source.json`：只存 `{ provider }`，原子写、0600。
 * @param {string} dataDir
 */
export function createSourceStore(dataDir) {
  const file = join(dataDir, SOURCE_FILE)
  let provider = readProviderId(file)
  return {
    get provider() {
      return provider
    },
    get path() {
      return file
    },
    /** @param {string} next */
    save(next) {
      if (typeof next !== 'string' || next === '') {
        throw new SourceError('unsupported_provider', '缺少要保存的供应商 id', 400)
      }
      mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ provider: next }), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
      provider = next
      return provider
    },
  }
}

/**
 * 选中项：存过且仍在配置里 → 它；否则用 `defaultProvider`。
 * 配置在归一化阶段已保证 `defaultProvider` 合法，所以这里不会返回空。
 * @param {Array<{ id: string }>} providers
 * @param {string | null} stored
 * @param {string | null} defaultProvider
 */
export function resolveSelection(providers, stored, defaultProvider) {
  if (typeof stored === 'string' && stored !== '') {
    const hit = providers.find((provider) => provider.id === stored)
    if (hit !== undefined) return hit
  }
  const fallback = providers.find((provider) => provider.id === defaultProvider)
  return fallback ?? providers[0]
}

/**
 * 设置视图里一个供应商的样子：只给状态，不回传密钥。
 * @param {{
 *   provider: { id: string, kind: string, name: string, baseUrl: string },
 *   selected: boolean,
 *   keyStatus: 'configured' | 'missing',
 *   tokenStatus: 'configured' | 'missing' | 'not_required',
 *   tokenTail: string | null,
 * }} input
 */
export function providerView({ provider, selected, keyStatus, tokenStatus, tokenTail }) {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    selected,
    credentials: {
      key: keyStatus,
      token: tokenStatus,
      tokenTail,
    },
  }
}
