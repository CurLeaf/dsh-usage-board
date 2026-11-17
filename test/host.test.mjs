import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { authorize, normalizeConfig, readKeyFromDisk } from '../index.js'

test('normalizeConfig 有默认值并夹紧异常输入', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.baseUrl, 'https://ai-api.qzsyzn.com')
  assert.equal(defaults.apiKeyRef, 'DEEPSEEK_API_KEY')
  assert.equal(defaults.quotaPerUnit, 500_000)
  assert.equal(defaults.price, 1)
  assert.equal(defaults.refreshMs, 300_000)

  const custom = normalizeConfig({
    baseUrl: 'https://gw.example.com///',
    quotaPerUnit: 0,
    price: -1,
    refreshMs: 1000,
    dataDir: '/tmp/usage-board',
  })
  assert.equal(custom.baseUrl, 'https://gw.example.com')
  assert.equal(custom.quotaPerUnit, 500_000)
  assert.equal(custom.price, 1)
  assert.equal(custom.refreshMs, 60_000, '刷新间隔不短于 60s')
  assert.equal(custom.dataDir, '/tmp/usage-board')
})

test('readKeyFromDisk 只认 refs 段并去掉引号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-home-'))
  const previous = process.env.DSH_HOME
  try {
    writeFileSync(join(dir, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  some/record:',
      '    kind: grant',
      'refs:',
      '  DEEPSEEK_API_KEY: sk-abc123',
      '  QUOTED: "sk-quoted"',
      '',
    ].join('\n'), 'utf8')
    process.env.DSH_HOME = dir

    assert.equal(readKeyFromDisk('DEEPSEEK_API_KEY'), 'sk-abc123')
    assert.equal(readKeyFromDisk('QUOTED'), 'sk-quoted')
    assert.equal(readKeyFromDisk('MISSING'), '')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authorize 只接受等长的进程令牌', () => {
  assert.equal(authorize({ headers: { 'x-usage-board': 'abcdef' } }, 'abcdef'), true)
  assert.equal(authorize({ headers: { 'x-usage-board': 'abcdeg' } }, 'abcdef'), false)
  assert.equal(authorize({ headers: { 'x-usage-board': 'abc' } }, 'abcdef'), false)
  assert.equal(authorize({ headers: {} }, 'abcdef'), false)
})
