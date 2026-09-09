import { OpCode, SessionEvents, WebsocketCloseReason } from 'qq-official-bot/lib/constans.js'
import { toObject } from 'qq-official-bot/lib/utils.js'

// Install before the first start/listen. isCurrent belongs to the plugin runtime.
export function installSessionLifecycle (sm, { isCurrent, onError = error => sm.bot.logger.error(error) }) {
  let abort = new AbortController()
  let generation = 0
  let disposed = false
  let startPromise
  let listening
  let readySocket = null
  const isActive = () => !disposed && !abort.signal.aborted && !sm.userClose && isCurrent()

  function closeSocket (socket) {
    if (!socket) return
    if (listening?.socket === socket) listening.cleanup()
    if (sm.bot.ws === socket) sm.bot.ws = undefined
    if (socket.readyState === 3) return
    // Closing a CONNECTING ws emits an error after its managed listeners are gone.
    const ignoreError = () => {}
    socket.on('error', ignoreError)
    socket.once('close', () => socket.off('error', ignoreError))
    socket.close()
  }

  function stop () {
    const socket = listening?.socket || sm.bot.ws
    generation++
    sm.userClose = true
    sm.alive = false
    readySocket = null
    startPromise = undefined
    abort.abort()
    closeSocket(socket)
  }

  const controller = {
    stop,
    dispose () { disposed = true; stop() },
    isActive,
    get signal () { return abort.signal },
    get generation () { return generation },
    get readySocket () { return isActive() && readySocket === sm.bot.ws ? readySocket : null }
  }
  sm.stop = stop
  sm.start = function () {
    if (startPromise) return startPromise
    if (!disposed && isCurrent()) {
      if (abort.signal.aborted) abort = new AbortController()
      sm.userClose = false
    }
    const attempt = abort
    const version = generation
    const valid = () => attempt === abort && version === generation && isActive()
    const check = () => {
      if (!valid()) throw new DOMException('Session start cancelled', 'AbortError')
    }
    // Defer work so even synchronous failures return an observed, shared promise.
    const promise = Promise.resolve().then(async () => {
      check()
      const token = listening?.token ?? sm.access_token
      const url = listening?.url ?? sm.wsUrl
      await sm.getAccessToken()
      check()
      await sm.getWsUrl()
      check()
      const socket = sm.bot.ws
      if (socket && [0, 1].includes(socket.readyState) && !listening?.failed &&
          token === sm.access_token && url === sm.wsUrl) {
        sm.startListen()
        return
      }
      if (listening && listening.socket !== socket) closeSocket(listening.socket)
      closeSocket(socket)
      check()
      sm.connect()
      const connected = sm.bot.ws
      if (!valid()) {
        closeSocket(connected)
        check()
      }
      sm.startListen()
    }).finally(() => {
      if (startPromise === promise) startPromise = undefined
    })
    startPromise = promise
    // SDK reconnects ignore the return value; explicit sdk.start() still rejects.
    promise.catch(async error => {
      try { if (valid()) await onError(error) } catch {}
    })
    return promise
  }

  sm.startListen = function () {
    const socket = sm.bot.ws
    if (!isActive() || !socket || listening?.socket === socket) return
    listening?.cleanup()
    const attempt = abort
    const version = generation
    let timer
    let interval
    const state = { socket, token: sm.access_token, url: sm.wsUrl, failed: false, cleanup }
    const belongs = () => attempt === abort && version === generation && isActive() && sm.bot.ws === socket
    const current = () => listening === state && belongs()
    const send = message => {
      if (current() && !state.failed && socket.readyState === 1) sm.sendWs(message)
    }
    function cleanup () {
      clearTimeout(timer)
      socket.off('message', message)
      socket.off('close', close)
      socket.off('error', error)
      if (listening === state) {
        listening = undefined
        readySocket = null
        sm.alive = false
      }
    }
    function close (code) {
      clearTimeout(timer)
      if (!current()) return
      const eventMsg = sm.sessionRecord
      cleanup()
      // Fatal-error handlers must run before the SDK's synchronous reconnect.
      if (code) sm.emit(SessionEvents.ERROR, code, WebsocketCloseReason.find(item => item.code === code)?.reason || 'Unknown WebSocket close code')
      if (belongs()) sm.emit(SessionEvents.EVENT_WS, { eventType: SessionEvents.DISCONNECT, code, eventMsg })
    }
    function error () {
      clearTimeout(timer)
      if (!current()) return
      state.failed = true
      readySocket = null
      sm.alive = false
      // The SDK uses CLOSED here, never EventEmitter's special lowercase error.
      sm.emit(SessionEvents.CLOSED, { eventType: SessionEvents.CLOSED })
    }
    function message (data) {
      if (!current() || state.failed) return
      let payload
      try { payload = toObject(data) } catch { return }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
      const { op, t, d, s } = payload
      if (t === SessionEvents.READY && (!d || typeof d !== 'object' || Array.isArray(d))) return
      if ((op === OpCode.DISPATCH || t === SessionEvents.READY) && Number.isFinite(s)) {
        sm.sessionRecord.seq = sm.heartbeatParam.d = s
      }
      if (op === OpCode.HELLO) {
        if (!Number.isFinite(d?.heartbeat_interval) || d.heartbeat_interval <= 0) return
        interval = sm.heartbeatInterval = d.heartbeat_interval
        const resume = sm.isReconnect
        send({
          op: resume ? OpCode.RESUME : OpCode.IDENTIFY,
          d: resume
            ? { token: `QQBot ${sm.access_token}`, session_id: sm.sessionRecord.sessionID, seq: sm.sessionRecord.seq }
            : { token: `QQBot ${sm.access_token}`, intents: sm.getValidIntends(), shard: [0, 1] }
        })
        return
      }
      if (t === SessionEvents.READY) {
        const user = d.user || {}
        sm.bot.self_id = user.id
        sm.bot.nickname = user.username
        sm.bot.status = user.status || 0
        if (d.session_id) sm.sessionRecord.sessionID = d.session_id
        sm.isReconnect = false
        readySocket = socket
        sm.emit(SessionEvents.READY, { eventType: SessionEvents.READY, msg: d })
        send(sm.heartbeatParam)
        return
      }
      if (op === OpCode.HEARTBEAT_ACK || t === SessionEvents.RESUMED) {
        readySocket = socket
        if (!sm.alive) {
          sm.alive = true
          sm.emit(SessionEvents.EVENT_WS, { eventType: SessionEvents.READY })
        }
        if (!current() || state.failed) return
        clearTimeout(timer)
        if (interval) timer = setTimeout(() => send(sm.heartbeatParam), interval)
      }
      if (op === OpCode.RECONNECT) {
        sm.emit(SessionEvents.EVENT_WS, { eventType: SessionEvents.RECONNECT })
      }
      if (current() && !state.failed && op === OpCode.DISPATCH) sm.bot.dispatchEvent(t, payload)
    }
    listening = state
    readySocket = null
    sm.alive = false
    socket.on('close', close)
    socket.on('error', error)
    socket.on('message', message)
  }
  return controller
}
