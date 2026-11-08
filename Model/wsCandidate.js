import { isBusinessEvent } from './wsBusinessConfig.js'

// An isolated transport, not an SDK client: no parser, message queue, emitter,
// contact updates or Session persistence runs until the socket is adopted.
export function createWsCandidate ({ openSocket, beforeIdentify, onIdentify = () => {}, onFrame = () => false,
  expectedUserId, signal, validate = () => {}, timeoutMs = 60000, heartbeatTimeout = 60000,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let socket, record, interval, receipt = 0, evidence, previousSeq = 0
  let readyAt = 0, acked = false, pendingAck = false, authSent = false, hello = false, retired = false
  let timer, ackTimer, deadline, failure
  let resolveReady, rejectReady, resolveEvidence, rejectEvidence
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const proof = new Promise((resolve, reject) => { resolveEvidence = resolve; rejectEvidence = reject })
  ready.catch(() => {}); proof.catch(() => {})
  const local = new AbortController()
  const check = () => { signal?.throwIfAborted(); local.signal.throwIfAborted(); validate() }
  const settleProof = () => { if (record && acked && evidence) resolveEvidence(evidence) }

  function cleanup () {
    clearTimer(timer); clearTimer(ackTimer); clearTimer(deadline)
    signal?.removeEventListener('abort', abort)
    socket?.off('message', message); socket?.off('close', closed); socket?.off('error', errored)
  }
  function closeSocket () {
    if (!socket || socket.readyState === 3) return
    const ignore = () => {}
    socket.on('error', ignore)
    socket.once('close', () => socket.off('error', ignore))
    try { if (socket.readyState === 1 && socket.terminate) socket.terminate(); else socket.close() } catch {}
  }
  function stop (error = new Error('临时连接已停止')) {
    if (retired) return
    retired = true; failure = error
    local.abort(error)
    cleanup(); closeSocket()
    rejectReady(error); rejectEvidence(error)
  }
  function abort () { stop(signal.reason || new Error('检测已取消')) }
  function closed (code) { stop(new Error(`临时连接关闭 code=${Number(code) || 0}`)) }
  function errored (error) { stop(new Error(`临时连接传输失败 code=${String(error?.code || 'unknown').replace(/[^\w.-]/g, '').slice(0, 60)}`)) }
  function send (payload) {
    if (retired || socket?.readyState !== 1) return
    try { socket.send(JSON.stringify(payload), error => { if (error) errored(error) }) } catch (error) { errored(error) }
  }
  function heartbeat () {
    if (retired || pendingAck) return
    clearTimer(timer)
    pendingAck = true
    ackTimer = setTimer(() => stop(new Error('临时连接心跳ACK超时')), heartbeatTimeout)
    send({ op: 1, d: receipt })
  }
  function message (data) {
    if (retired) return
    let frame
    try { frame = JSON.parse(String(data)) } catch { stop(new Error('临时连接收到非法JSON')); return }
    if (!frame || typeof frame !== 'object') return
    if (frame.op === 10 && !hello) {
      if (!Number.isFinite(frame.d?.heartbeat_interval) || frame.d.heartbeat_interval <= 0) return
      hello = true; interval = frame.d.heartbeat_interval
      Promise.resolve().then(async () => {
        await beforeIdentify({ signal: local.signal })
        check()
        if (retired || socket.readyState !== 1) return
        authSent = true
        send({ op: 2, d: { token: `QQBot ${transport.token}`, intents: transport.intents, shard: [0, 1] } })
        onIdentify()
      }).catch(() => stop(new Error('临时Identify检查失败或已取消')))
      return
    }
    if (frame.op === 7 || frame.op === 9) { stop(new Error(`临时连接鉴权/连接不可用 op=${frame.op}`)); return }
    if (frame.op === 1 && record) { heartbeat(); return }
    if (frame.op === 11 && record && pendingAck) {
      clearTimer(ackTimer); pendingAck = false; acked = true
      timer = setTimer(heartbeat, interval)
      settleProof()
      return
    }
    if (frame.op !== 0 || !authSent || !Number.isSafeInteger(frame.s) || frame.s < 0) return
    if (frame.t === 'READY') {
      if (record) return
      if (!frame.d?.session_id || !frame.d.user?.id || frame.d.user.id !== expectedUserId) { stop(new Error('临时连接READY身份不匹配')); return }
      record = { sessionID: frame.d.session_id, seq: frame.s, user: { id: frame.d.user.id, username: frame.d.user.username || '', status: frame.d.user.status || 0 } }
      receipt = frame.s; readyAt = now()
      resolveReady(candidate)
      heartbeat()
      return
    }
    if (!record || frame.s <= receipt) return
    previousSeq = receipt; receipt = frame.s
    let observation
    try { observation = onFrame(frame) } catch { stop(new Error('临时连接事件观察失败')); return }
    const rawTime = frame.d?.timestamp || frame.d?.time
    const number = Number(rawTime)
    const at = Number.isFinite(number) && number > 0 ? (number > 1e12 ? number : number * 1000) : Date.parse(rawTime)
    const fresh = Number.isFinite(at) && at >= readyAt - 1000 && at <= now() + 30000
    if (isBusinessEvent(frame) && observation !== null && (observation === true || fresh)) {
      // Keep only the most recent proof frame, not a second business queue.
      evidence = { frame, previousSeq, internal: observation === true }
      settleProof()
    }
  }

  let transport
  const candidate = {
    ready, proof,
    get acknowledged () { return acked && !retired },
    get evidence () { return evidence },
    get error () { return failure },
    get closed () { return retired },
    stop,
    take () {
      check()
      if (retired || !record || !acked || !evidence || socket?.readyState !== 1) throw new Error('临时连接尚未验证，不能接管')
      retired = true
      cleanup()
      return { socket, record: { ...record, seq: evidence.internal ? evidence.frame.s : evidence.previousSeq }, heartbeatInterval: interval,
        receivedSeq: receipt, frame: evidence.internal ? undefined : evidence.frame }
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  deadline = setTimer(() => stop(new Error('临时连接观察超时，未确认业务事件可用')), timeoutMs)
  deadline.unref?.()
  Promise.resolve().then(async () => {
    check()
    transport = await openSocket(local.signal)
    socket = transport.socket
    if (retired || signal?.aborted) { closeSocket(); return }
    socket.on('message', message); socket.on('close', closed); socket.on('error', errored)
  }).catch(() => stop(new Error('临时连接建立失败或已取消')))
  return candidate
}
