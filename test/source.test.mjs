import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSourceStore, providerView, resolveSelection, SourceError } from '../lib/source.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'usage-board-source-'))
}

test('source.json 只存 provider id，且是 0600', () => {
  const dir = tempDir()
  try {
    const store = createSourceStore(dir)
    assert.equal(store.provider, null)
    store.save('wandapi')
    assert.equal(store.provider, 'wandapi')
    const raw = JSON.parse(readFileSync(store.path, 'utf8'))
    assert.deepEqual(Object.keys(raw), ['provider'])
    assert.equal(raw.provider, 'wandapi')
    assert.equal(statSync(store.path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保存空 id 被拒绝', () => {
  const dir = tempDir()
  try {
    const store = createSourceStore(dir)
    assert.throws(() => store.save(''), SourceError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重新创建 store 会读回上次的选择', () => {
  const dir = tempDir()
  try {
    createSourceStore(dir).save('qzsy')
    assert.equal(createSourceStore(dir).provider, 'qzsy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏的 source.json 视为未选择', () => {
  const dir = tempDir()
  try {
    const store = createSourceStore(dir)
    store.save('qzsy')
    // 直接覆盖成非法 JSON
    writeFileSync(store.path, '{oops')
    assert.equal(createSourceStore(dir).provider, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSelection：存过的优先，失效回落默认', () => {
  const providers = [{ id: 'qzsy' }, { id: 'wandapi' }]
  assert.equal(resolveSelection(providers, 'wandapi', 'qzsy').id, 'wandapi')
  assert.equal(resolveSelection(providers, 'gone', 'wandapi').id, 'wandapi')
  assert.equal(resolveSelection(providers, null, 'qzsy').id, 'qzsy')
  // 默认值也失效时取第一个（归一化阶段已保证默认合法，这里只是兜住顺序）
  assert.equal(resolveSelection(providers, null, 'gone').id, 'qzsy')
})

test('providerView 只暴露状态，不含密钥', () => {
  const view = providerView({
    provider: { id: 'wandapi', kind: 'wandapi', name: 'WandAPI', baseUrl: 'https://api.wandapi.com' },
    selected: true,
    keyStatus: 'configured',
    tokenStatus: 'not_required',
    tokenTail: null,
  })
  assert.deepEqual(view, {
    id: 'wandapi',
    kind: 'wandapi',
    name: 'WandAPI',
    baseUrl: 'https://api.wandapi.com',
    selected: true,
    credentials: { key: 'configured', token: 'not_required', tokenTail: null },
  })
  assert.equal(JSON.stringify(view).includes('sk-'), false)
})
