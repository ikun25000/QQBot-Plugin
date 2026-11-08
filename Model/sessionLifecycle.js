import { OpCode, SessionEvents, WebsocketCloseReason } from 'qq-official-bot/lib/constans.js'
import { toObject } from 'qq-official-bot/lib/utils.js'
import { createSessionProgress } from './sessionProgress.js'
import { redactWsText, wsSessionLabel, wsErrorDiagnostic } from './wsDiagnostics.js'

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
  onRawDispatch = () => false,
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
  let resumeRecovery
  let resumeClock
  let lastFilterLogAt = -Infinity
  let filteredSinceLog = 0
  const dispatchErrors = new Map()
  const connectionErrors = new Map()
  const deliveries = new Map()
  const progress = createSessionProgress(seq => {
    sm.sessionRecord.seq = seq
    for (const key of deliveries.keys()) if (key <= seq) deliveries.delete(key)
    saveSession()
  })
  progress.reset(sm.sessionRecord.seq)
  const health = { state: 'idle', eventState: 'unverified', lastFrameAt: 0, lastAckAt: 0, lastDispatchAt: 0, lastHeartbeatAt: 0, nextRetryAt: 0, attempts: 0,
    rawDispatchCount: 0, filteredDispatchCount: 0, pendingDispatchCount: 0, completedDispatchCount: 0, dispatchErrorCount: 0 }
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
  const secrets = () => [sm.access_token, sm.bot.config.secret, sm.sessionRecord.sessionID]
  const redact = value => redactWsText(value, secrets())

  function connectionError (error, stage) {
    const diagnostic = wsErrorDiagnostic(error, stage, secrets())
    health.lastError = diagnostic.message
    const key = diagnostic.message
    const previous = connectionErrors.get(key)
    if (previous && Date.now() - previous.at < 60000) { previous.suppressed++; return }
    if (connectionErrors.size >= 64) connectionErrors.delete(connectionErrors.keys().next().value)
    connectionErrors.set(key, { at: Date.now(), suppressed: 0 })
    if (previous?.suppressed) diagnostic.stack += `\n（期间抑制重复${previous.suppressed}次）`
    report(diagnostic)
  }

  function pauseResumeClock () {
    if (!resumeClock) return
    clearTimeout(resumeClock.timer)
    const elapsed = Date.now() - resumeClock.at
    resumeRecovery.idleMs += elapsed
    resumeRecovery.totalMs += elapsed
    resumeClock = undefined
  }

  function discardResume (reason) {
    log('warn', `[WS] ${reason}，丢弃当前Session ${wsSessionLabel(sm.sessionRecord.sessionID)} seq=${sm.sessionRecord.seq}；回退Identify（仍检查配额及限速）`)
    forgetSession()
  }

  function watchResume (madeProgress = false) {
    pauseResumeClock()
    if (madeProgress) { resumeRecovery.idleMs = 0; resumeRecovery.attempts = 0 }
    const clock = resumeClock = { at: Date.now() }
    clock.timer = setTimeout(() => {
      if (resumeClock !== clock || !isActive()) return
      pauseResumeClock()
      const reason = resumeRecovery.totalMs >= 300000 ? 'Resume补发累计超过5分钟' : 'Resume累计60秒无进展'
      void reconnect(reason, { clearSession: true })
    }, Math.max(0, Math.min(60000 - resumeRecovery.idleMs, 300000 - resumeRecovery.totalMs)))
    clock.timer.unref?.()
  }

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
    pauseResumeClock()
    resumeRecovery = undefined
    sessionEpoch++
    deliveries.clear()
    progress.reset(0)
    health.pendingDispatchCount = 0
    health.session = '无'
    health.eventState = 'unverified'
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
    } catch (error) { connectionError(error, 'close') }
  }

  function stop (error = abortError()) {
    try { Promise.resolve(onStop()).catch(report) } catch (err) { report(err) }
    generation++
    sm.userClose = true
    sm.alive = false
    abort.abort()
    pauseResumeClock()
    resumeRecovery = undefined
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

  function halt (error, stage = 'terminal') {
    terminal = true
    connectionError(error, stage)
    const reason = redact(error?.message).replace(/[\r\n]/g, ' ').slice(0, 500)
    stop(new Error(reason))
    notify(onReconnect, { reason, terminal: true, expected: false })
    sm.emit(SessionEvents.DEAD, { eventType: SessionEvents.ERROR, msg: reason })
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
    if (clearSession) discardResume(reason)
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
      pauseResumeClock()
      if (resumeRecovery && (resumeRecovery.attempts >= 3 || resumeRecovery.idleMs >= 60000 || resumeRecovery.totalMs >= 300000)) {
        discardResume('同一Session连续恢复无进展，停止重复Resume')
      }
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
      health.transportState = 'connecting'
      if (resumeRecovery) watchResume()
      health.state = 'connecting'
      sm.connect()
      if (!valid()) { closeSocket(sm.bot.ws); check() }
      sm.startListen()
    }).catch(error => {
      if (!valid()) return
      if (error?.fatal) { halt(error, 'connect'); return }
      connectionError(error, 'connect')
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
    adoptConnection ({ socket, record, heartbeatInterval, receivedSeq, frame, expectedSocket }) {
      if (!isActive() || terminal || !socket || socket.readyState !== 1 || sm.bot.ws !== expectedSocket || !readySocket ||
          !record?.sessionID || record.sessionID === sm.sessionRecord.sessionID || !Number.isSafeInteger(record.seq) || record.seq < 0 || !record.user?.id ||
          record.user.id !== sm.bot.self_id || !Number.isFinite(heartbeatInterval) || heartbeatInterval <= 0) return false
      // Keep the SDK/runtime and in-flight REST/business work. Only replace the
      // transport, fence old callbacks/checkpoints, and adopt the already READY
      // candidate. There is no second Identify or account logout here.
      generation++
      clearTimeout(retryTimer)
      retryTimer = recovery = undefined
      attemptPromise = undefined
      failures = 0
      forgetSession()
      closeSocket(listening?.socket || sm.bot.ws)
      identity = { ...record.user }
      sm.bot.nickname = identity.username || sm.bot.nickname
      sm.bot.status = identity.status || 0
      sm.sessionRecord = { sessionID: record.sessionID, seq: record.seq }
      sm.heartbeatParam.d = Math.max(record.seq, receivedSeq || 0)
      progress.reset(record.seq)
      sm.bot.ws = socket
      sm.startListen({ heartbeatInterval, frame })
      saveSession(true)
      return true
    },
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

  sm.startListen = function (adopted) {
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
    let authMode
    let requestedSeq
    let replayCount = 0
    let firstAck = false
    let businessVerified = false
    const socketAbort = new AbortController()
    const state = { socket, cleanup }
    const current = () => listening === state && version === generation && isActive() && sm.bot.ws === socket
    const send = payload => {
      if (!current() || socket.readyState !== 1) return
      if (payload.op === OpCode.HEARTBEAT) {
        clearTimeout(timer)
        timer = undefined
      }
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
          if (error && current()) { connectionError(error, 'send'); void reconnect('WebSocket 发送失败') }
        })
      } catch (error) { connectionError(error, 'send'); void reconnect('WebSocket 发送失败') }
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
        health.transportState = 'disconnected'
        health.eventState = 'unverified'
      }
    }
    function close (code, reason) {
      if (!current()) return
      const detail = code === 4925 ? '官方 websocket 不可用，请解绑元器'
        : WebsocketCloseReason.find(item => item.code === code)?.reason || '网关关闭连接'
      // Log metadata only, never credentials or full gateway payloads.
      log('warn', `[WS] 连接关闭 code=${code} stage=${authenticated ? 'ready' : authMode || 'hello'} ${detail} ${redact(reason).replace(/[\r\n]/g, ' ').slice(0, 200)}；收到=${health.rawDispatchCount} 过滤=${health.filteredDispatchCount} 完成=${health.completedDispatchCount} 失败=${health.dispatchErrorCount}`)
      health.lastCloseCode = code
      if (fatalCodes.has(code)) { halt(new Error(`WebSocket ${code}: ${detail}`)); return }
      const clearSession = [4006, 4007].includes(code) || (code >= 4900 && code <= 4913)
      void reconnect(code === 4903 ? '网关返回 4903，重新核查 Session 配额（不判定为回收）' : `连接关闭 (${code})`, { code, clearSession })
    }
    function error (err) {
      if (!current()) return
      connectionError(err || new Error('WebSocket transport error'), 'transport')
      void reconnect('WebSocket 传输错误')
    }
    function markReady (resumed) {
      clearTimeout(handshakeTimer)
      clearExpectedRecovery()
      pauseResumeClock()
      resumeRecovery = undefined
      authenticated = true
      sm.isReconnect = false
      sm.alive = true
      sm.retry = 0
      readySince = Date.now()
      health.state = 'ready'
      health.attempts = 0
      health.nextRetryAt = 0
      readySocket = socket
      health.protocolReadyAt = Date.now()
      health.eventState = 'unverified'
      health.session = wsSessionLabel(sm.sessionRecord.sessionID)
      log('info', `[WS] ${resumed ? 'Session 恢复成功 (RESUMED)' : '鉴权成功 (READY)'} SessionID=${health.session} 处理seq=${sm.sessionRecord.seq} 接收seq=${sm.heartbeatParam.d} 补发=${replayCount}；业务事件待验证`)
      sm.emit(SessionEvents.EVENT_WS, { eventType: SessionEvents.READY })
      notify(onReady, socket)
      settleReady()
    }
    function message (data) {
      if (!current()) return
      health.lastFrameAt = Date.now()
      if (health.transportState !== 'acknowledged') health.transportState = 'open'
      let payload
      try { payload = toObject(data) } catch (err) {
        // JSON.parse errors may include message text or credentials. Log only
        // the phase and safe stack locations, not the malformed frame fragment.
        connectionError({ message: 'WebSocket帧不是有效JSON', stack: err.stack }, 'frame')
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
          authMode = resume ? 'resume' : 'identify'
          requestedSeq = sm.sessionRecord.seq
          health.authMode = authMode
          health.resumeRequestedSeq = resume ? requestedSeq : null
          health.resumedSeq = null
          if (resume) {
            resumeRecovery ||= { attempts: 0, idleMs: 0, totalMs: 0, maxSeq: requestedSeq }
            resumeRecovery.maxSeq = Math.max(resumeRecovery.maxSeq, requestedSeq)
            resumeRecovery.attempts++
            clearTimeout(handshakeTimer)
            watchResume()
          }
          const intents = resume ? undefined : sm.getValidIntends()
          log('info', `[WS] 发送 ${resume ? `Resume SessionID=${wsSessionLabel(sm.sessionRecord.sessionID)} 请求seq=${requestedSeq}` : `Identify intents=${intents} shard=0/1`}`)
          send({
            op: resume ? OpCode.RESUME : OpCode.IDENTIFY,
            d: resume
              ? { token: `QQBot ${sm.access_token}`, session_id: sm.sessionRecord.sessionID, seq: requestedSeq }
              : { token: `QQBot ${sm.access_token}`, intents, shard: [0, 1] }
          })
          if (!resume && current()) {
            try { Promise.resolve(onIdentify()).catch(report) } catch (error) { report(error) }
          }
        }
        try {
          const permit = !resume && beforeIdentify({ signal: socketAbort.signal })
          if (permit?.then) permit.then(authenticate).catch(err => {
            if (current()) { connectionError(err, 'identify-permit'); void reconnect('Identify 限速检查失败') }
          })
          else authenticate()
        } catch (err) { connectionError(err, 'identify-permit'); void reconnect('Identify 限速检查失败') }
        return
      }
      if (op === OpCode.RECONNECT) { void reconnect('服务端要求重连 (OpCode 7)', { expected: true }); return }
      if (op === OpCode.INVALID_SESSION) {
        void reconnect('Session 无效 (OpCode 9)，回退 Identify', { clearSession: true })
        return
      }
      if (op === OpCode.HEARTBEAT) { if (authSent) send(sm.heartbeatParam); return }
      if (op === OpCode.DISPATCH && t === SessionEvents.READY) {
        if (authenticated || !authSent || !d || typeof d !== 'object' || !d.session_id || !Number.isSafeInteger(s) || s < 0) return
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
        health.pendingDispatchCount = 0
        saveSession(true)
        markReady(false)
        sm.emit(SessionEvents.READY, { eventType: SessionEvents.READY, msg: d })
        send(sm.heartbeatParam)
        return
      }
      if (op === OpCode.DISPATCH && t === SessionEvents.RESUMED) {
        if (!hasSession() || !authSent || authMode !== 'resume' || authenticated) return
        if (!Number.isSafeInteger(s) || s < requestedSeq) {
          void reconnect(`RESUMED序号异常：请求seq=${requestedSeq} 返回seq=${Number.isSafeInteger(s) ? s : 'invalid'}`, { clearSession: true })
          return
        }
        health.resumedSeq = s
        log('info', `[WS] 收到RESUMED 请求seq=${requestedSeq} 返回seq=${s} 补发事件=${replayCount}`)
        sm.heartbeatParam.d = Math.max(sm.heartbeatParam.d || 0, s)
        progress.add(s)()
        markReady(true)
        if (!firstAck && !pendingHeartbeat) send(sm.heartbeatParam)
        return
      }
      if (op === OpCode.HEARTBEAT_ACK) {
        if ((!authenticated && authMode !== 'resume') || !pendingHeartbeat) return
        health.lastAckAt = Date.now()
        health.transportState = 'acknowledged'
        if (!firstAck) {
          firstAck = true
          log('info', `[WS] 首次心跳ACK正常；${authenticated ? '协议已就绪' : '仍等待RESUMED'}，${businessVerified ? '业务事件已验证' : '业务事件待验证'}`)
        }
        clearHeartbeat()
        timer = setTimeout(() => send(sm.heartbeatParam), interval)
        return
      }
      if (op === OpCode.DISPATCH && authSent) {
        let internal = false
        try { internal = onRawDispatch(payload, { live: authenticated, newSeq: Number.isSafeInteger(s) && s > sm.sessionRecord.seq && !deliveries.has(s) }) === true } catch (error) { report(error) }
        health.lastRawDispatchAt = Date.now()
        health.rawDispatchCount++
        health.receivedSeq = Number.isSafeInteger(s) ? s : null
        if (!authenticated && authMode === 'resume') {
          replayCount++
          if (Number.isSafeInteger(s) && s > resumeRecovery.maxSeq) {
            resumeRecovery.maxSeq = s
            watchResume(true)
          }
        }
        const filtered = reason => {
          health.filteredDispatchCount++
          filteredSinceLog++
          if (Date.now() - lastFilterLogAt < 60000) return
          lastFilterLogAt = Date.now()
          log(authenticated && reason === '已确认seq' ? 'warn' : 'info', `[WS] 网关事件过滤：${reason} event=${String(t || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 100)} seq=${Number.isSafeInteger(s) ? s : 'invalid'} 处理seq=${sm.sessionRecord.seq} 本段过滤=${filteredSinceLog} 累计过滤=${health.filteredDispatchCount}`)
          filteredSinceLog = 0
        }
        if (!Number.isSafeInteger(s) || s < 0) { filtered('无效seq'); return }
        // Receipt and processing are independent, including duplicate frames.
        if (s >= (sm.heartbeatParam.d || 0)) sm.heartbeatParam.d = s
        // The first replay frame beyond the requested cursor proves the server
        // has accepted Resume. ACKs can then keep this socket alive even before
        // the replay ends; they do not mark the application connection ready.
        if (!authenticated && authMode === 'resume' && s > requestedSeq && !firstAck && !pendingHeartbeat) send(sm.heartbeatParam)
        if (s <= sm.sessionRecord.seq) { filtered('已确认seq'); return }
        const previous = deliveries.get(s)
        // Replay must not acknowledge a still-running copy (or feed it into
        // message-id filtering, which would incorrectly mark it completed).
        if (previous && previous.status !== 'failed') { filtered('已有处理中或已完成副本'); return }
        const delivery = { status: 'pending' }
        const liveEvent = !internal && authenticated && /(?:MESSAGE_CREATE$|^INTERACTION_CREATE$|^GROUP_(?:ADD_ROBOT|DEL_ROBOT|MEMBER_ADD|MEMBER_REMOVE|JOIN_REQUEST)$|^FRIEND_(?:ADD|DEL)$|^C2C_MSG_(?:RECEIVE|REJECT)$)/.test(t)
        health.pendingDispatchCount++
        if (deliveries.size < 4097 || previous) deliveries.set(s, delivery)
        const complete = progress.add(s)
        const epoch = sessionEpoch
        let settled = false
        const done = error => {
          if (settled || epoch !== sessionEpoch) return
          settled = true
          health.pendingDispatchCount--
          delivery.status = error ? 'failed' : 'done'
          complete(error)
          if (error) { health.dispatchErrorCount++; reportDispatchError(error, t, s) }
          else {
            health.completedDispatchCount++
            health.lastProcessedAt = Date.now()
            if (liveEvent && !businessVerified && current()) {
              businessVerified = true
              health.eventState = 'verified'
              log('info', `[WS] 首次业务事件处理完成 event=${String(t || '').replace(/[^\w.-]/g, '_').slice(0, 100)} seq=${s}；处理seq=${sm.sessionRecord.seq}`)
            }
          }
        }
        health.lastDispatchAt = Date.now()
        if (internal) { done(); return }
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
    health.eventState = 'unverified'
    socket.on('close', close)
    socket.on('error', error)
    socket.on('message', message)
    if (adopted) {
      interval = sm.heartbeatInterval = adopted.heartbeatInterval
      authSent = helloReceived = true
      authMode = 'identify'
      markReady(false)
      log('warn', '[WS] 旧路径不可靠，已由业务检测候选连接接管（未再次Identify）')
      send(sm.heartbeatParam)
      if (adopted.frame) message(JSON.stringify(adopted.frame))
      return
    }
    handshakeTimer = setTimeout(() => {
      if (!current() || authenticated) return
      void reconnect('WebSocket READY/RESUMED 握手超时 (60s)')
    }, 60000)
  }
  return controller
}
