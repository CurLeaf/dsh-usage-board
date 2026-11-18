import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SSE_HEADERS, createStreamHub, formatSseFrame } from '../lib/stream.js'

/** 够用的 ServerResponse 替身：只关心 head/write/end。 */
function fakeRes({ buffered = 0 } = {}) {
  const chunks = []
  return {
    chunks,
    status: 0,
    headers: null,
    writableLength: buffered,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(chunk)
      return true
    },
    end() {
      this.writableEnded = true
    },
    on() {},
    off() {},
  }
}

const fakeReq = { on() {}, off() {} }

test('formatSseFrame 按规范拼字段，多行 data 拆行', () => {
  assert.equal(formatSseFrame({ comment: 'ping' }), ': ping\n\n')
  assert.equal(formatSseFrame({ retry: 5_000 }), 'retry: 5000\n\n')
  assert.equal(
    formatSseFrame({ id: 3, event: 'summary', data: { ok: true } }),
    'id: 3\nevent: summary\ndata: {"ok":true}\n\n',
  )
  assert.equal(
    formatSseFrame({ data: 'a\nb' }),
    'data: a\ndata: b\n\n',
  )
})

test('attach 先发 retry 和当前快照，头是 event-stream', () => {
  const hub = createStreamHub({ heartbeatMs: 0 })
  const res = fakeRes()
  hub.attach(fakeReq, res, { payload: { ok: true, today: { cny: 1 } } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], SSE_HEADERS['content-type'])
  assert.equal(res.headers['cache-control'], 'no-store, no-transform')
  assert.equal(hub.size, 1)
  assert.ok(res.chunks[0].startsWith('retry: 5000\n\n'), '首帧应是 retry 提示')
  assert.ok(res.chunks[1].includes('event: summary'), '随后应立刻给一份快照')
  assert.ok(res.chunks[1].includes('"today"'))
})

test('publish 广播给所有订阅者，没有订阅者也记住最新快照', () => {
  const hub = createStreamHub({ heartbeatMs: 0 })
  assert.equal(hub.publish({ ok: true, n: 1 }), 0, '无人订阅时只记快照')

  const a = fakeRes()
  const b = fakeRes()
  hub.attach(fakeReq, a)
  hub.attach(fakeReq, b)
  assert.ok(a.chunks.join('').includes('"n":1'), '晚到的客户端应立刻拿到最新快照')

  assert.equal(hub.publish({ ok: true, n: 2 }), 2)
  assert.ok(a.chunks.at(-1).includes('"n":2'))
  assert.ok(b.chunks.at(-1).includes('"n":2'))
  assert.equal(hub.lastId, 2, '事件序号只随快照递增，连接不占号')
})

test('慢消费者被跳过，心跳负责清理半开连接', () => {
  const hub = createStreamHub({ heartbeatMs: 0 })
  const fast = fakeRes()
  const slow = fakeRes({ buffered: 4 << 20 })
  hub.attach(fakeReq, fast)
  hub.attach(fakeReq, slow)
  const before = slow.chunks.length
  hub.publish({ ok: true, tick: 1 })
  assert.ok(fast.chunks.at(-1).includes('"tick":1'))
  assert.equal(slow.chunks.length, before, '积压超阈值的连接不写，等下一次快照')
  hub.close()
  assert.equal(hub.size, 0)
})

test('close 结束所有连接并拒绝新连接', () => {
  const hub = createStreamHub({ heartbeatMs: 0 })
  const res = fakeRes()
  hub.attach(fakeReq, res)
  hub.close()
  assert.equal(res.writableEnded, true)

  const late = fakeRes()
  assert.equal(hub.attach(fakeReq, late), null)
  assert.equal(late.status, 503)
})

test('超过 maxClients 时拒绝新连接', () => {
  const hub = createStreamHub({ heartbeatMs: 0, maxClients: 1 })
  assert.notEqual(hub.attach(fakeReq, fakeRes()), null)
  const extra = fakeRes()
  assert.equal(hub.attach(fakeReq, extra), null)
  assert.equal(extra.status, 503)
})

test('心跳按 heartbeatMs 发注释帧，最后一个订阅者离开后停表', async () => {
  const hub = createStreamHub({ heartbeatMs: 20 })
  const res = fakeRes()
  hub.attach(fakeReq, res)
  await new Promise((resolve) => setTimeout(resolve, 70))
  const pings = res.chunks.filter((chunk) => chunk === ': ping\n\n').length
  assert.ok(pings >= 2, `应至少收到两次心跳，实际 ${pings}`)
  hub.close()
})
