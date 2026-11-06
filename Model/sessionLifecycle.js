import { OpCode, SessionEvents, WebsocketCloseReason } from 'qq-official-bot/lib/constans.js'
import { toObject } from 'qq-official-bot/lib/utils.js'
import { createSessionProgress } from './sessionProgress.js'

const fatalCodes = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915, 4925])
const abortError = () => new DOMException('Session cancelled', 'AbortError')

// Own every recovery path here. Never emit DISCONNECT to the SDK's anonymous
// EVENT_WS listener: it reconnects immediately and only resumes code 4009.
export function installSessionLifecycle (sm, {
  isCurrent,
  onError = error => sm.bot.logger.error(error),
  getHeartbeatTimeout = () => 60000,
  shouldReconnect = () => true,
  beforeConnect = async () => {},
  beforeIdentify = () => {},
  onHeartbeatTimeout = () => {},
  onReconnect = () => {},
  onReady = () => {},
  onSession = () => {},
  onSessionInvalidated = () => {},
  onIdentify = () => {},
  onStop = () => {}
}) {
  let abort = new AbortController()
  let generation = 0
  let disposed = false
  let terminal = false
  let attemptPromise
  let readyPromise
  let resolveReady
  let rejectReady
  let retryTimer
  let recovery
  let failures = 0
  let readySince = null
  let listening
  let readySocket = null
  let identity
  let expectedRecovery
  let sessionEpoch = 0
  const dispatchErrors = new Map()
  const deliveries = new Map()
  const progress = createSessionProgress(seq => {
    sm.sessionRecord.seq = seq
    for (const key of deliveries.keys()) if (key <= seq) deliveries.delete(key)
    saveSession()
  })
  progress.reset(sm.sessionRecord.seq)
  const health = { state: 'idle', lastFrameAt: 0, lastAckAt: 0, lastDispatchAt: 0, lastHeartbeatAt: 0, nextRetryAt: 0, attempts: 0 }
  const isActive = () => !disposed && !abort.signal.aborted && !sm.userClose && isCurrent()
  const log = (level, message) => sm.bot.logger[level](message)
  const report = error => { Promise.resolve().then(() => { if (!disposed && isCurrent()) return onError(error) }).catch(() => {}) }
  const notify = (callback, detail) => {
    const version = generation
    Promise.resolve().then(() => {
      if (!disposed && isCurrent() && version === generation) return callback(detail)
    }).catch(report)
  }
  const hasSession = () => !!sm.sessionRecord.sessionID && Number.isSafeInteger(sm.sessionRecord.seq) && sm.sessionRecord.seq >= 0

  function clearExpectedRecovery () {
    clearTimeout(expectedRecovery?.timer)
    expectedRecovery = undefined
  }

  function watchExpectedRecovery (reason) {
    if (expectedRecovery) return
    const episode = expectedRecovery = { reason }
    episode.timer = setTimeout(() => {
      if (expectedRecovery !== episode || !isActive()) return
      expectedRecovery = undefined
      notify(onReconnect, { reason: `${reason}后60秒仍未恢复`, attempt: failures, expected: false })
    }, 60000)
    episode.timer.unref?.()
  }

  function reportDispatchError (error, event, seq) {
    // Never include the gateway payload or credentials in dispatch diagnostics.
    const redact = value => {
      let text = String(value || '')
      for (const secret of [sm.access_token, sm.bot.config.secret, sm.sessionRecord.sessionID]) {
        if (secret) text = text.split(String(secret)).join('[redacted]')
      }
      // Also cover labeled old/foreign credentials accidentally included in an
      // exception, not just the currently active token and Session.
      return text
        .replace(/((?:access[_-]?token|client[_-]?secret|app[_-]?secret|session[_-]?id|authorization|token|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1"[redacted]"')
        .replace(/((?:access[_-]?token|client[_-]?secret|app[_-]?secret|session[_-]?id|authorization|token|secret)["']?\s*[:=]\s*)(?:QQBot\s+|Bearer\s+)?[^\s,;}\])"']+/gi, '$1[redacted]')
    }
    const eventName = String(event || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 100)
    const detail = redact(error?.message || error || '未知异常').replace(/[\r\n]/g, ' ').slice(0, 500)
    const at = Date.now()
    health.lastDispatchError = { event: eventName, seq: Number.isSafeInteger(seq) ? seq : null, message: detail, at }
    const key = `${eventName}:${detail}`
    const previous = dispatchErrors.get(key)
    if (previous && at - previous.at < 60000) { previous.suppressed++; return }
    if (!previous && dispatchErrors.size >= 64) dispatchErrors.delete(dispatchErrors.keys().next().value)
    dispatchErrors.set(key, { at, suppressed: 0 })
    const diagnostic = new Error(`网关事件分发失败 event=${eventName} seq=${Number.isSafeInteger(seq) ? seq : 'unknown'}：${detail}${previous?.suppressed ? `（期间抑制重复${previous.suppressed}次）` : ''}`)
    diagnostic.stage = 'dispatch'
    const frames = redact(error?.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 8).map(line => line.slice(0, 500))
    diagnostic.stack = `${diagnostic.name}: ${diagnostic.message}${frames.length ? `\n${frames.join('\n')}` : ''}`
    report(diagnostic)
  }

  function forgetSession () {
    sessionEpoch++
    deliveries.clear()
    progress.reset(0)
    sm.sessionRecord = { sessionID: '', seq: 0 }
    sm.heartbeatParam.d = null
    sm.isReconnect = false
    try { Promise.resolve(onSessionInvalidated()).catch(report) } catch (error) { report(error) }
  }

  function saveSession (immediate = false) {
    if (disposed || !isCurrent()) return
    try { Promise.resolve(onSession({ ...sm.sessionRecord, user: identity }, { immediate })).catch(report) } catch (error) { report(error) }
  }

  function waitReady () {
    if (!readyPromise) {
      readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      // Internal recovery has no caller awaiting readiness.
      readyPromise.catch(() => {})
    }
    return readyPromise
  }

  function settleReady (error) {
    const settle = error ? rejectReady : resolveReady
    readyPromise = resolveReady = rejectReady = undefined
    settle?.(error)
  }

  function closeSocket (socket) {
    if (!socket) return
    if (listening?.socket === socket) listening.cleanup()
    if (sm.bot.ws === socket) sm.bot.ws = undefined
    if (socket.readyState === 3) return
    const ignoreError = () => {}
    socket.on('error', ignoreError)
    socket.once('close', () => socket.off('error', ignoreError))
    // terminate also handles a half-open connection without waiting for a
    // closing handshake. CONNECTING sockets need close() instead.
    try {
      if (socket.readyState === 1 && socket.terminate) socket.terminate()
      else socket.close()
    } catch (error) { report(error) }
  }

  function stop (error = abortError()) {
    try { Promise.resolve(onStop()).catch(report) } catch (err) { report(err) }
    generation++
    sm.userClose = true
    sm.alive = false
    abort.abort()
    clearExpectedRecovery()
    clearTimeout(retryTimer)
    retryTimer = recovery = undefined
    attemptPromise = undefined
    health.nextRetryAt = 0
    health.state = terminal ? 'terminal' : 'stopped'
    closeSocket(listening?.socket || sm.bot.ws)
    readySocket = null
    readySince = null
    settleReady(error)
  }

  function halt (error) {
    terminal = true
    report(error)
    stop(error)
    notify(onReconnect, { reason: error.message, terminal: true, expected: false })
    sm.emit(SessionEvents.DEAD, { eventType: SessionEvents.ERROR, msg: error.message })
  }

  function schedule () {
    if (!recovery || retryTimer || attemptPromise || !isActive()) return
    const { reason, expected } = recovery
    const configured = sm.bot.config.maxRetry
    const maxRetries = configured === Infinity || configured === '.inf' ? Infinity
      : Number.isFinite(configured) && configured >= 0 ? configured : 10
    if (failures >= maxRetries) {
      halt(new Error(`WebSocket 重连失败已达上限 (${maxRetries})`))
      return
    }
    const delayMs = Math.min(60000, 5000 * (2 ** Math.min(failures, 4)))
    failures++
    health.attempts = failures
    health.state = 'retry-wait'
    health.nextRetryAt = Date.now() + delayMs
    log(expected ? 'info' : 'warn', `[WS] ${reason}，${delayMs / 1000}秒后重连 (第 ${failures} 次，${hasSession() ? 'Resume' : 'Identify'})`)
    notify(onReconnect, { reason, delayMs, attempt: failures, expected })
    const version = generation
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      health.nextRetryAt = 0
      if (!isActive() || version !== generation) return
      if (!shouldReconnect()) { void reconnect('连接恢复尚未完成'); return }
      recovery = undefined
      beginAttempt()
    }, delayMs)
  }

  function reconnect (reason = '连接已断开', { code, clearSession = false, expected = false } = {}) {
    if (!isActive() || terminal) return Promise.resolve(false)
    if (clearSession) forgetSession()
    if (code) health.lastCloseCode = code
    const promise = waitReady()
    // A briefly successful READY must not turn a flapping connection into an
    // endless series of five-second Identify attempts.
    if (readySince !== null) {
      if (Date.now() - readySince >= 60000) failures = 0
      readySince = null
    }
    // Close first: transport failure must never leave an OPEN but unmonitored ws.
    closeSocket(listening?.socket || sm.bot.ws)
    if (!shouldReconnect()) {
      log('warn', `[WS] ${reason}，自动重连已关闭`)
      stop(new Error(`${reason}，自动重连已关闭`))
      notify(onReconnect, { reason, disabled: true, expected: false })
      return promise
    }
    if (expected) watchExpectedRecovery(reason)
    else clearExpectedRecovery()
    if (recovery?.expected && !expected) {
      recovery = { reason, expected }
      // A real failure must not inherit an already-scheduled quiet OpCode 7.
      notify(onReconnect, { reason, attempt: failures, expected: false })
    } else recovery ||= { reason, expected }
    schedule()
    return promise
  }

  function beginAttempt () {
    if (attemptPromise || !isActive()) return
    const signal = abort.signal
    const version = generation
    const valid = () => signal === abort.signal && version === generation && isActive()
    const check = () => { if (!valid()) throw abortError() }
    health.state = 'starting'
    const promise = Promise.resolve().then(async () => {
      check()
      await sm.getAccessToken()
      check()
      await sm.getWsUrl()
      check()
      health.state = 'quota-check'
      await beforeConnect({ signal, resume: hasSession(), refresh: () => sm.getWsUrl() })
      check()
      if (failures > 0 && !shouldReconnect()) { void reconnect('连接恢复尚未完成'); return }
      closeSocket(listening?.socket || sm.bot.ws)
      sm.isReconnect = hasSession()
      health.state = 'connecting'
      sm.connect()
      if (!valid()) { closeSocket(sm.bot.ws); check() }
      sm.startListen()
    }).catch(error => {
      if (!valid()) return
      health.lastError = error?.message || String(error)
      if (error.fatal) { halt(error); return }
      report(error)
      void reconnect('连接建立失败')
    }).finally(() => {
      if (attemptPromise !== promise) return
      attemptPromise = undefined
      if (valid()) schedule()
    })
    attemptPromise = promise
  }

  const controller = {
    stop,
    reconnect,
    refreshPolicy () {
      if (!shouldReconnect() && failures > 0 && !readySocket) void reconnect('连接恢复尚未完成')
      else if (shouldReconnect() && !isActive() && !terminal && !disposed && isCurrent()) void sm.start().catch(report)
    },
    health,
    get sessionSnapshot () { return { ...sm.sessionRecord, user: identity } },
    dispose () { disposed = true; stop() },
    isActive,
    get terminal () { return terminal },
    get busy () { return !!(attemptPromise || retryTimer || recovery) || health.state === 'connecting' },
    get signal () { return abort.signal },
    get generation () { return generation },
    get readySocket () { return isActive() && readySocket === sm.bot.ws ? readySocket : null }
  }
  sm.stop = stop
  sm.start = function () {
    if (disposed || !isCurrent()) return Promise.reject(abortError())
    if (abort.signal.aborted) { abort = new AbortController(); failures = 0 }
    if (terminal) failures = 0
    terminal = false
    if (!identity && sm.bot.self_id) identity = { id: sm.bot.self_id, username: sm.bot.nickname, status: sm.bot.status || 0 }
    sm.userClose = false
    if (controller.readySocket && sm.bot.ws?.readyState === 1) return Promise.resolve()
    const promise = waitReady()
    if (!retryTimer && !recovery && !listening) beginAttempt()
    return promise
  }

  sm.startListen = function () {
    const socket = sm.bot.ws
    if (!isActive() || !socket || listening?.socket === socket) return
    listening?.cleanup()
    const version = generation
    let timer
    let ackTimer
    let handshakeTimer
    let pendingHeartbeat = false
    let interval
    let authenticated = false
    let authSent = false
    let helloReceived = false
    const socketAbort = new AbortController()
    const state = { socket, cleanup }
    const current = () => listening === state && version === generation && isActive() && sm.bot.ws === socket
    const send = payload => {
      if (!current() || socket.readyState !== 1) return
      if (payload.op === OpCode.HEARTBEAT && !pendingHeartbeat) {
        pendingHeartbeat = true
        health.lastHeartbeatAt = Date.now()
        const configured = Number(getHeartbeatTimeout())
        const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 60000
        ackTimer = setTimeout(() => {
          if (!current() || !pendingHeartbeat) return
          log('warn', `[WS] 心跳超时 (${timeoutMs / 1000}s 无 ACK)，判定为掉线`)
          notify(onHeartbeatTimeout, { socket, timeoutMs })
          void reconnect('心跳 ACK 超时')
        }, timeoutMs)
      }
      try {
        socket.send(JSON.stringify(payload), error => {
          if (error && current()) { report(error); void reconnect('WebSocket 发送失败') }
        })
      } catch (error) { report(error); void reconnect('WebSocket 发送失败') }
    }
    function clearHeartbeat () {
      clearTimeout(timer)
      clearTimeout(ackTimer)
      timer = ackTimer = undefined
      pendingHeartbeat = false
    }
    function cleanup () {
      socketAbort.abort()
      clearHeartbeat()
      clearTimeout(handshakeTimer)
      socket.off('message', message)
      socket.off('close', close)
      socket.off('error', error)
      if (listening === state) {
        listening = undefined
        readySocket = null
        sm.alive = false
      }
    }
    function close (code, reason) {
      if (!current()) return
      const detail = code === 4925 ? '官方 websocket 不可用，请解绑元器'
        : WebsocketCloseReason.find(item => item.code === code)?.reason || '网关关闭连接'
      // Log metadata only, never credentials or full gateway payloads.
      log('warn', `[WS] 连接关闭 code=${code} ${detail} ${String(reason || '').slice(0, 200)}`)
      health.lastCloseCode = code
      if (fatalCodes.has(code)) { halt(new Error(`WebSocket ${code}: ${detail}`)); return }
      const clearSession = [4006, 4007].includes(code) || (code >= 4900 && code <= 4913)
      void reconnect(code === 4903 ? '网关返回 4903，重新核查 Session 配额（不判定为回收）' : `连接关闭 (${code})`, { code, clearSession })
    }
    function error (err) {
      if (!current()) return
      health.lastError = err?.message || String(err)
      report(err || new Error('WebSocket transport error'))
      void reconnect('WebSocket 传输错误')
    }
    function markReady (resumed) {
      clearTimeout(handshakeTimer)
      clearExpectedRecovery()
      authenticated = true
      sm.isReconnect = false
      sm.alive = true
      sm.retry = 0
      readySince = Date.now()
      health.state = 'ready'
      health.attempts = 0
      health.nextRetryAt = 0
      readySocket = socket
      log('info', `[WS] ${resumed ? 'Session 恢复成功 (RESUMED)' : '鉴权成功 (READY)'}`)
      sm.emit(SessionEvents.EVENT_WS, { eventType: SessionEvents.READY })
      notify(onReady, socket)
      settleReady()
    }
    function message (data) {
      if (!current()) return
      health.lastFrameAt = Date.now()
      let payload
      try { payload = toObject(data) } catch (err) {
        report(new Error(`WebSocket 帧解析失败: ${err.message}`))
        void reconnect('网关消息解析失败')
        return
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
      const { op, t, d, s } = payload
      if (op === OpCode.HELLO) {
        if (helloReceived || !Number.isFinite(d?.heartbeat_interval) || d.heartbeat_interval <= 0) return
        helloReceived = true
        interval = sm.heartbeatInterval = d.heartbeat_interval
        const resume = sm.isReconnect && hasSession()
        const authenticate = () => {
          if (!current()) return
          authSent = true
          log('info', `[WS] 发送 ${resume ? 'Resume' : 'Identify'}`)
          send({
            op: resume ? OpCode.RESUME : OpCode.IDENTIFY,
            d: resume
              ? { token: `QQBot ${sm.access_token}`, session_id: sm.sessionRecord.sessionID, seq: sm.sessionRecord.seq }
              : { token: `QQBot ${sm.access_token}`, intents: sm.getValidIntends(), shard: [0, 1] }
          })
          if (!resume && current()) {
            try { Promise.resolve(onIdentify()).catch(report) } catch (error) { report(error) }
          }
        }
        try {
          const permit = !resume && beforeIdentify({ signal: socketAbort.signal })
          if (permit?.then) permit.then(authenticate).catch(err => {
            if (current()) { report(err); void reconnect('Identify 限速检查失败') }
          })
          else authenticate()
        } catch (err) { report(err); void reconnect('Identify 限速检查失败') }
        return
      }
      if (op === OpCode.RECONNECT) { void reconnect('服务端要求重连 (OpCode 7)', { expected: true }); return }
      if (op === OpCode.INVALID_SESSION) {
        void reconnect('Session 无效 (OpCode 9)，回退 Identify', { clearSession: true })
        return
      }
      if (op === OpCode.HEARTBEAT) { send(sm.heartbeatParam); return }
      if (op === OpCode.DISPATCH && t === SessionEvents.READY) {
        if (!authSent || !d || typeof d !== 'object' || !d.session_id || !Number.isSafeInteger(s) || s < 0) return
        clearHeartbeat()
        const user = d.user || {}
        identity = { id: user.id, username: user.username, status: user.status || 0 }
        sm.bot.self_id = user.id
        sm.bot.nickname = user.username
        sm.bot.status = user.status || 0
        sm.sessionRecord.sessionID = d.session_id
        sm.sessionRecord.seq = sm.heartbeatParam.d = s
        sessionEpoch++
        progress.reset(s)
        deliveries.clear()
        saveSession(true)
        markReady(false)
        sm.emit(SessionEvents.READY, { eventType: SessionEvents.READY, msg: d })
        send(sm.heartbeatParam)
        return
      }
      if (op === OpCode.DISPATCH && t === SessionEvents.RESUMED) {
        if (!hasSession() || !authSent) return
        if (Number.isSafeInteger(s) && s >= sm.sessionRecord.seq) {
          sm.heartbeatParam.d = s
          progress.add(s)()
        }
        clearHeartbeat()
        markReady(true)
        send(sm.heartbeatParam)
        return
      }
      if (op === OpCode.HEARTBEAT_ACK) {
        if (!authenticated || !pendingHeartbeat) return
        health.lastAckAt = Date.now()
        clearHeartbeat()
        timer = setTimeout(() => send(sm.heartbeatParam), interval)
        return
      }
      if (op === OpCode.DISPATCH && authSent) {
        if (Number.isSafeInteger(s) && s <= sm.sessionRecord.seq) return
        const previous = deliveries.get(s)
        // Replay must not acknowledge a still-running copy (or feed it into
        // message-id filtering, which would incorrectly mark it completed).
        if (previous && previous.status !== 'failed') return
        const delivery = { status: 'pending' }
        if (deliveries.size < 4097 || previous) deliveries.set(s, delivery)
        const complete = progress.add(s)
        const epoch = sessionEpoch
        let settled = false
        const done = error => {
          if (settled || epoch !== sessionEpoch) return
          settled = true
          delivery.status = error ? 'failed' : 'done'
          complete(error)
          if (error) reportDispatchError(error, t, s)
        }
        // Heartbeats acknowledge receipt, not successful application processing.
        if (Number.isSafeInteger(s) && s >= (sm.heartbeatParam.d || 0)) sm.heartbeatParam.d = s
        health.lastDispatchAt = Date.now()
        try {
          const work = sm.bot.dispatchEvent(t, payload, { retryFailed: previous?.status === 'failed' })
          if (work?.then) work.then(() => done(), error => done(error || new Error('事件处理Promise被拒绝')))
          else done()
        } catch (err) { done(err || new Error('事件处理失败')) }
      }
    }
    listening = state
    readySocket = null
    sm.alive = false
    socket.on('close', close)
    socket.on('error', error)
    socket.on('message', message)
    handshakeTimer = setTimeout(() => {
      if (!current() || authenticated) return
      void reconnect('WebSocket READY/RESUMED 握手超时 (60s)', { clearSession: sm.isReconnect })
    }, 60000)
  }
  return controller
}
