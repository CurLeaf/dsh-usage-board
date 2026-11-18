/**
 * 宿主侧的 SSE 扇出：一条只读事件流，所有打开的面板共享。
 *
 * 设计取舍（与网关限流直接相关）：
 * - 连接本身不触发取数；数据由「缓存刷新」驱动，刷新完成才 `publish`，
 *   所以 N 个标签页永远只打网关一次。
 * - 只保留**最新快照**，不做事件回放：晚到的客户端立刻拿到当前值，
 *   断线重连不需要 `Last-Event-ID` 补数（快照天然是幂等的）。
 * - 慢消费者直接丢帧（下一帧很快会覆盖），不让一个卡住的标签页
 *   把宿主内存顶起来；心跳顺便给半开连接判死刑。
 *
 * 帧格式按 text/event-stream 规范：字段 `id:` / `event:` / `data:` / `retry:`，
 * 空行结束一个事件；注释行 `: ping` 用于保活。
 */

/** SSE 响应的固定头；`no-transform` 阻止中间层再压缩/改写。 */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * 拼一个 SSE 帧。
 * @param {{ id?: string|number, event?: string, data?: unknown, retry?: number, comment?: string }} frame
 * @returns {string}
 */
export function formatSseFrame(frame = {}) {
  let out = ''
  if (frame.comment !== undefined) out += `: ${frame.comment}\n`
  if (frame.id !== undefined) out += `id: ${frame.id}\n`
  if (frame.event !== undefined) out += `event: ${frame.event}\n`
  if (frame.retry !== undefined) out += `retry: ${frame.retry}\n`
  if (frame.data !== undefined) {
    const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)
    // 规范要求一个事件可有多行 data，按行拆开写；JSON 本身不含裸换行，这里只是保险
    for (const line of text.split(/\r\n|\r|\n/)) out += `data: ${line}\n`
  }
  return `${out}\n`
}

/**
 * @param {{
 *   heartbeatMs?: number,
 *   retryMs?: number,
 *   maxClients?: number,
 *   maxQueuedBytes?: number,
 *   onAttach?: (client: { id: number }) => void,
 *   onDetach?: (client: { id: number }) => void,
 * }} [options]
 */
export function createStreamHub(options = {}) {
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : 25_000
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 5_000
  const maxClients = Number.isFinite(options.maxClients) ? options.maxClients : 64
  const maxQueuedBytes = Number.isFinite(options.maxQueuedBytes) ? options.maxQueuedBytes : 1 << 20

  /** @type {Set<{ id: number, res: import('node:http').ServerResponse, closed: boolean }>} */
  const clients = new Set()
  /** 客户端编号与事件序号分开：连接本身不占事件 id，重连不该让快照序号跳号。 */
  let clientSeq = 0
  let eventSeq = 0
  /** @type {{ id: number, payload: unknown } | null} */
  let latest = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let heartbeat = null
  let closed = false

  function stopHeartbeat() {
    if (heartbeat === null) return
    clearInterval(heartbeat)
    heartbeat = null
  }

  function startHeartbeat() {
    if (heartbeat !== null || heartbeatMs <= 0) return
    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (client.res.writableLength > maxQueuedBytes) {
          drop(client, 'slow')
          continue
        }
        if (client.res.writableEnded || client.res.destroyed) {
          drop(client, 'gone')
          continue
        }
        write(client, formatSseFrame({ comment: 'ping' }))
      }
    }, heartbeatMs)
    // 心跳不该把宿主进程钉在事件循环里
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
  }

  /**
   * @param {{ id: number, res: import('node:http').ServerResponse, closed: boolean }} client
   * @param {string} chunk
   */
  function write(client, chunk) {
    if (client.closed) return false
    try {
      client.res.write(chunk)
      return true
    } catch {
      drop(client, 'write-failed')
      return false
    }
  }

  /**
   * @param {{ id: number, res: import('node:http').ServerResponse, closed: boolean }} client
   * @param {string} reason
   */
  function drop(client, reason) {
    if (client.closed) return
    client.closed = true
    clients.delete(client)
    try {
      client.res.end()
    } catch {
      // 连接已经没了，忽略
    }
    if (clients.size === 0) stopHeartbeat()
    if (typeof options.onDetach === 'function') options.onDetach({ id: client.id, reason })
  }

  /**
   * 接一个客户端。返回 null 表示拒绝（已关闭 / 超过上限）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ payload?: unknown }} [initial]
   * @returns {{ id: number } | null}
   */
  function attach(req, res, initial = {}) {
    if (closed) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'stream-closed' }))
      return null
    }
    if (clients.size >= maxClients) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '5',
      })
      res.end(JSON.stringify({ ok: false, error: 'stream-busy' }))
      return null
    }

    res.writeHead(200, SSE_HEADERS)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const client = { id: ++clientSeq, res, closed: false }
    clients.add(client)

    const onClose = () => drop(client, 'client-close')
    req.on('close', onClose)
    res.on('close', onClose)
    res.on('error', onClose)

    write(client, formatSseFrame({ retry: retryMs }))
    const snapshot = latest !== null ? latest.payload : initial.payload
    if (snapshot !== undefined && snapshot !== null) {
      write(client, formatSseFrame({ id: latest !== null ? latest.id : 0, event: 'summary', data: snapshot }))
    }

    startHeartbeat()
    if (typeof options.onAttach === 'function') options.onAttach({ id: client.id })
    return { id: client.id }
  }

  /**
   * 广播一份快照。没有订阅者时只记住它，供下一个连接立即拿到。
   * @param {unknown} payload
   * @returns {number} 实际写出的连接数
   */
  function publish(payload) {
    if (closed || payload === undefined) return 0
    latest = { id: ++eventSeq, payload }
    if (clients.size === 0) return 0
    const frame = formatSseFrame({ id: latest.id, event: 'summary', data: payload })
    let sent = 0
    for (const client of clients) {
      // 慢消费者：丢掉这一帧，下一次快照会覆盖它；心跳负责最终清理
      if (client.res.writableLength > maxQueuedBytes) continue
      if (write(client, frame)) sent += 1
    }
    return sent
  }

  function close() {
    if (closed) return
    closed = true
    stopHeartbeat()
    for (const client of [...clients]) drop(client, 'shutdown')
  }

  return {
    attach,
    publish,
    close,
    /** 当前订阅者数量。 */
    get size() {
      return clients.size
    },
    /** 最近一次快照的序号；没有快照时为 0。 */
    get lastId() {
      return latest === null ? 0 : latest.id
    },
  }
}
