import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeConfig } from '../index.js'

const BASE = {
  providers: [
    { id: 'qzsy', kind: 'newapi', baseUrl: 'https://ai-api.qzsyzn.com' },
    { id: 'wandapi', kind: 'wandapi', baseUrl: 'https://api.wandapi.com/' },
  ],
}

test('两个供应商各自套用默认值', () => {
  const config = normalizeConfig(BASE)
  const [qzsy, wandapi] = config.providers
  assert.equal(qzsy.keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(qzsy.accessTokenRef, 'QZSY_ACCESS_TOKEN')
  assert.equal(qzsy.quotaPerUnit, 500_000)
  assert.equal(wandapi.keyRef, 'WANDAPI_API_KEY')
  assert.equal(wandapi.accessTokenRef, '')
  // baseUrl 末尾斜杠被去掉
  assert.equal(wandapi.baseUrl, 'https://api.wandapi.com')
  assert.equal(config.defaultProvider, 'qzsy')
  assert.equal(config.refreshMs, 300_000)
  assert.equal(config.timeZone, 'Asia/Shanghai')
})

test('可以显式指定 defaultProvider 与刷新间隔', () => {
  const config = normalizeConfig({ ...BASE, defaultProvider: 'wandapi', refreshMs: 90_000, timeZone: 'UTC' })
  assert.equal(config.defaultProvider, 'wandapi')
  assert.equal(config.refreshMs, 90_000)
  assert.equal(config.timeZone, 'UTC')
})

test('刷新间隔不低于 60 秒（两个供应商都计入 RPM）', () => {
  assert.equal(normalizeConfig({ ...BASE, refreshMs: 5_000 }).refreshMs, 60_000)
  assert.equal(normalizeConfig({ ...BASE, refreshMs: -1 }).refreshMs, 300_000)
})

test('providers 为空 / 缺 id / 类型未知 / id 重复 都在加载期报错', () => {
  assert.throws(() => normalizeConfig({}), /至少要有一个供应商/)
  assert.throws(() => normalizeConfig({ providers: [{ id: '', kind: 'wandapi', baseUrl: 'https://a.test' }] }), /id 不能为空/)
  assert.throws(() => normalizeConfig({ providers: [{ id: 'a', kind: 'openai', baseUrl: 'https://a.test' }] }), /未知供应商类型/)
  assert.throws(
    () => normalizeConfig({
      providers: [
        { id: 'a', kind: 'wandapi', baseUrl: 'https://a.test' },
        { id: 'a', kind: 'newapi', baseUrl: 'https://b.test' },
      ],
    }),
    /id 重复/,
  )
  assert.throws(() => normalizeConfig({ providers: [{ id: 'a', kind: 'wandapi', baseUrl: '' }] }), /缺少 baseUrl/)
})

test('defaultProvider 不在 providers 里要报错', () => {
  assert.throws(() => normalizeConfig({ ...BASE, defaultProvider: 'nope' }), /不在 providers 里/)
})

test('显式 userId / quotaPerUnit / price 会被保留', () => {
  const config = normalizeConfig({
    providers: [{ id: 'qzsy', kind: 'newapi', baseUrl: 'https://a.test', userId: 6, quotaPerUnit: 1, price: 7.3 }],
  })
  assert.equal(config.providers[0].userId, 6)
  assert.equal(config.providers[0].quotaPerUnit, 1)
  assert.equal(config.providers[0].price, 7.3)
})
