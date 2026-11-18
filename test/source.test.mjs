import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SOURCE_FILE,
  collectCandidates,
  createSourceService,
  createSourceStore,
  gatewayHost,
  normalizeGatewayBase,
  sameGatewayHost,
  selectSource,
} from '../lib/source.js'

const GATEWAY = 'https://ai-api.qzsyzn.com'

/** 造一组假的 llm/settings/credentials，形状对齐 DSH 真实服务。 */
function fakeServices({ providers = [], sections = [], credentialState = {} } = {}) {
  const calls = { describeOptions: [], describedRefs: [] }
  const byNs = new Map()
  for (const section of sections) {
    if (!byNs.has(section.ns)) byNs.set(section.ns, { ns: section.ns, value: {} })
    mergeDeep(byNs.get(section.ns).value, section.value)
  }
  return {
    calls,
    llm: {
      listConfigurableProviders() {
        return providers
      },
    },
    settings: {
      describe(options) {
        calls.describeOptions.push(options)
        return [...byNs.values()]
      },
    },
    credentials: {
      async describe(ref) {
        calls.describedRefs.push(ref)
        const state = credentialState[ref]
        if (state === 'throw') throw new Error('credentials down')
        return { configured: state === true, writable: true }
      },
    },
  }
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] ?? {}, value)
    } else {
      target[key] = value
    }
  }
  return target
}

/** 一条 configurable provider + 对应的 settings 段。 */
function provider({ id, name = id, baseURL, apiKeyEnv = null, ns = 'llm-pi-ai' }) {
  const entry = { provider: id, displayName: name, settingsNs: ns, settingsPath: ['providers', id] }
  const profile = {}
  if (baseURL !== undefined) profile.baseURL = baseURL
  if (apiKeyEnv !== null) profile.apiKeyEnv = apiKeyEnv
  const section = { ns, value: { providers: { [id]: profile } } }
  return { entry, section }
}

test('normalizeGatewayBase：去掉末尾 /v1、/v1beta 与多余斜杠', () => {
  assert.equal(normalizeGatewayBase('https://ai-api.qzsyzn.com/v1'), GATEWAY)
  assert.equal(normalizeGatewayBase('https://ai-api.qzsyzn.com/v1beta/'), GATEWAY)
  assert.equal(normalizeGatewayBase('https://ai-api.qzsyzn.com/v1/'), GATEWAY)
  assert.equal(normalizeGatewayBase('https://ai-api.qzsyzn.com/api/v1/'), 'https://ai-api.qzsyzn.com/api')
  assert.equal(normalizeGatewayBase('https://ai-api.qzsyzn.com/'), GATEWAY)
  assert.equal(normalizeGatewayBase('https://ai-api.qzsyzn.com:8443/openai/v1'), 'https://ai-api.qzsyzn.com:8443/openai')
  assert.equal(normalizeGatewayBase(''), null)
  assert.equal(normalizeGatewayBase('not a url'), null)
  assert.equal(normalizeGatewayBase('ftp://ai-api.qzsyzn.com'), null)
})

test('网关匹配只比 host+port，忽略 path 与版本后缀', () => {
  assert.equal(gatewayHost('https://ai-api.qzsyzn.com:8443/v1'), 'ai-api.qzsyzn.com:8443')
  assert.equal(sameGatewayHost('https://ai-api.qzsyzn.com/v1', GATEWAY), true)
  assert.equal(sameGatewayHost('https://ai-api.qzsyzn.com/v1beta/', `${GATEWAY}/`), true)
  assert.equal(sameGatewayHost('https://ai-api.qzsyzn.com:8443', GATEWAY), false)
  assert.equal(sameGatewayHost('https://other.example.com', GATEWAY), false)
  assert.equal(sameGatewayHost('not a url', GATEWAY), false)
})

test('collectCandidates：只收 host 匹配的供应商，/v1 可匹配，按 providerId 去重', async () => {
  const gateway = provider({ id: 'gateway', name: '公司网关', baseURL: `${GATEWAY}/v1`, apiKeyEnv: 'GATEWAY_KEY' })
  const duplicate = { entry: { ...gateway.entry, displayName: '重复条目' }, section: gateway.section }
  const other = provider({ id: 'other', name: '别家网关', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'OTHER_KEY' })
  const services = fakeServices({
    providers: [gateway.entry, duplicate.entry, other.entry],
    sections: [gateway.section, duplicate.section, other.section],
    credentialState: { GATEWAY_KEY: true, OTHER_KEY: false },
  })

  const collected = await collectCandidates(services, { baseUrl: GATEWAY })
  assert.equal(collected.readable, true)
  assert.equal(collected.candidates.length, 1, 'other 与重复 gateway 都不应进候选')
  const [candidate] = collected.candidates
  assert.equal(candidate.providerId, 'gateway')
  assert.equal(candidate.name, '公司网关')
  assert.equal(candidate.baseUrl, `${GATEWAY}/v1`, 'baseUrl 保留原始值')
  assert.equal(candidate.usageBaseUrl, GATEWAY)
  assert.equal(candidate.keyStatus, 'configured')
  assert.equal(candidate.keyRef, 'GATEWAY_KEY')
  assert.deepEqual(services.calls.describeOptions, [{ redactSecrets: true }])
  assert.deepEqual(services.calls.describedRefs, ['GATEWAY_KEY'])
})

test('collectCandidates：keyStatus 缺省/describe 抛错都按 missing', async () => {
  const noKey = provider({ id: 'no-key', baseURL: GATEWAY })
  const broken = provider({ id: 'broken', baseURL: GATEWAY, apiKeyEnv: 'BROKEN_KEY' })
  const missing = provider({ id: 'missing', baseURL: GATEWAY, apiKeyEnv: 'MISSING_KEY' })
  const services = fakeServices({
    providers: [noKey.entry, broken.entry, missing.entry],
    sections: [noKey.section, broken.section, missing.section],
    credentialState: { BROKEN_KEY: 'throw', MISSING_KEY: false },
  })

  const collected = await collectCandidates(services, { baseUrl: GATEWAY })
  assert.deepEqual(
    collected.candidates.map((candidate) => [candidate.providerId, candidate.keyStatus]),
    [
      ['no-key', 'missing'],
      ['broken', 'missing'],
      ['missing', 'missing'],
    ],
  )
})

test('collectCandidates：兼容小写 baseUrl 与空 settingsPath（整个 section 就是 profile）', async () => {
  const services = fakeServices({
    providers: [{ provider: 'lower', displayName: '小写字段', settingsNs: 'custom-gateway', settingsPath: [] }],
    sections: [{ ns: 'custom-gateway', value: { baseUrl: `${GATEWAY}/v1beta/`, apiKeyEnv: 'LOWER_KEY' } }],
    credentialState: { LOWER_KEY: true },
  })
  const collected = await collectCandidates(services, { baseUrl: `${GATEWAY}/v1` })
  assert.equal(collected.readable, true)
  assert.deepEqual(
    collected.candidates.map((candidate) => ({
      providerId: candidate.providerId,
      baseUrl: candidate.baseUrl,
      usageBaseUrl: candidate.usageBaseUrl,
      keyRef: candidate.keyRef,
    })),
    [{
      providerId: 'lower',
      baseUrl: `${GATEWAY}/v1beta/`,
      usageBaseUrl: GATEWAY,
      keyRef: 'LOWER_KEY',
    }],
  )
})

test('collectCandidates：服务缺失或不可读时返回 readable:false 且不抛错', async () => {
  const onlyLlm = { llm: { listConfigurableProviders: () => [] } }
  assert.deepEqual(await collectCandidates(null, { baseUrl: GATEWAY }), { readable: false, candidates: [] })
  assert.deepEqual(await collectCandidates(onlyLlm, { baseUrl: GATEWAY }), { readable: false, candidates: [] })

  const services = fakeServices({ providers: [], sections: [] })
  services.settings.describe = () => {
    throw new Error('settings down')
  }
  assert.deepEqual(await collectCandidates(services, { baseUrl: GATEWAY }), { readable: false, candidates: [] })
})

test('selectSource：存过且仍在候选里优先，否则单候选自动选，多候选为 null', () => {
  const a = { providerId: 'a', name: 'A' }
  const b = { providerId: 'b', name: 'B' }
  assert.equal(selectSource([a], null), a, '单候选自动选')
  assert.equal(selectSource([a, b], 'b'), b, '存过的优先')
  assert.equal(selectSource([a, b], 'gone'), null, '存过但已不在候选里')
  assert.equal(selectSource([a], 'gone'), a, '存过失效时仍可自动选唯一候选')
})

test('source store：只写 {providerId}，原子替换且权限 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-source-'))
  try {
    const store = createSourceStore(dir)
    assert.equal(store.providerId, null)
    store.save('gateway')
    const file = join(dir, SOURCE_FILE)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { providerId: 'gateway' })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(store.providerId, 'gateway')
    assert.equal(createSourceStore(dir).providerId, 'gateway', '重新加载能读到')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createSourceService：单候选自动选中、多候选未持久化时为 null、持久化后生效', async () => {
  const single = provider({ id: 'gateway', name: '公司网关', baseURL: `${GATEWAY}/v1`, apiKeyEnv: 'GATEWAY_KEY' })
  const dir = mkdtempSync(join(tmpdir(), 'usage-board-source-'))
  try {
    const services = fakeServices({
      providers: [single.entry],
      sections: [single.section],
      credentialState: { GATEWAY_KEY: true },
    })
    const store = createSourceStore(dir)
    const service = createSourceService({
      options: { baseUrl: GATEWAY, apiKeyRef: 'DEFAULT_KEY', accessTokenRef: 'ACCESS_TOKEN' },
      store,
      services,
      resolveAccessToken: async () => 'access-token-abcd',
    })

    const described = await service.describe()
    assert.equal(described.ok, true)
    assert.equal(described.readable, true)
    assert.equal(described.gateway.baseUrl, GATEWAY)
    assert.equal(described.candidates.length, 1)
    assert.equal(described.candidates[0].selected, true)
    assert.deepEqual(described.selected, {
      providerId: 'gateway',
      name: '公司网关',
      usageBaseUrl: GATEWAY,
      keyStatus: 'configured',
    })
    assert.deepEqual(described.token, { configured: true, tail: '…abcd' })
    assert.equal(described.candidates[0].keyRef, undefined, '候选投影不应泄露内部 keyRef 字段')

    const second = provider({ id: 'gateway-2', name: '备用网关', baseURL: GATEWAY, apiKeyEnv: 'SECOND_KEY' })
    const multi = fakeServices({
      providers: [single.entry, second.entry],
      sections: [single.section, second.section],
      credentialState: { GATEWAY_KEY: true, SECOND_KEY: true },
    })
    const multiService = createSourceService({
      options: { baseUrl: GATEWAY, apiKeyRef: 'DEFAULT_KEY', accessTokenRef: 'ACCESS_TOKEN' },
      store,
      services: multi,
      resolveAccessToken: async () => '',
    })
    const unselected = await multiService.describe()
    assert.equal(unselected.candidates.length, 2)
    assert.equal(unselected.selected, null, '多候选且没存过时不为任何项自动选中')

    store.save('gateway-2')
    const selected = await multiService.describe()
    assert.equal(selected.selected.providerId, 'gateway-2')
    assert.deepEqual(
      selected.candidates.map((candidate) => candidate.selected),
      [false, true],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
