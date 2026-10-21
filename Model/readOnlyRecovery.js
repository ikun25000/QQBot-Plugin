// A business API failure is not evidence that the gateway forbids this account.
// Only a valid gateway response may clear a gateway/session restriction.
export function createReadOnlyRecovery (runtime, {
  isCurrent,
  probe,
  log,
  timeoutMs = 5000,
  retryMs = 60000
}) {
  let pending
  let revision = 0
  let lastProbeAt = -Infinity
  let lastSkipAt = -Infinity
  let lastBusinessErrorAt = -Infinity

  function enter (detail, source = 'gateway') {
    if (!isCurrent()) return
    const message = String(detail?.message || detail?.msg || detail || '').slice(0, 300)
    revision++
    runtime.readOnlyMode = true
    runtime.readOnlyState = {
      source,
      code: Number(detail?.code || detail?.err_code) || 11300,
      message,
      since: Date.now(),
      generation: runtime.connectionGeneration
    }
    log('error', '当前机器人为只读模式，只接收消息，不处理任何指令', runtime.readOnlyState)
  }

  function clear (expectedRevision) {
    if (!isCurrent() || !runtime.readOnlyMode || revision !== expectedRevision) return
    runtime.readOnlyMode = false
    delete runtime.readOnlyState
    lastProbeAt = -Infinity
    log('info', '网关权限复核成功，已解除只读模式并恢复命令处理')
  }

  function recover (trigger = 'message') {
    if (!isCurrent() || !runtime.readOnlyMode) return Promise.resolve(false)
    if (pending) return pending
    if (Date.now() - lastProbeAt < retryMs) return Promise.resolve(false)
    lastProbeAt = Date.now()
    const expectedRevision = revision
    const generation = runtime.connectionGeneration
    const abort = new AbortController()
    let timer
    const attempt = Promise.race([
      Promise.resolve().then(() => probe(abort.signal)),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(new Error('只读权限复核超时'))
        }, timeoutMs)
      })
    ]).then(response => {
      if (!isCurrent() || runtime.connectionGeneration !== generation || revision !== expectedRevision) return false
      let url
      try { url = new URL(response?.data?.url) } catch { throw new Error('网关复核响应缺少有效 WebSocket 地址') }
      if (response.status !== 200 || !['ws:', 'wss:'].includes(url.protocol) || !url.hostname) throw new Error('网关复核响应无效')
      clear(expectedRevision)
      return true
    }).catch(error => {
      if (isCurrent() && runtime.connectionGeneration === generation) {
        log('warn', '只读权限复核未通过，暂时保持只读，稍后重试', { trigger, message: error?.message || String(error) })
      }
      return false
    }).finally(() => {
      clearTimeout(timer)
      if (pending === attempt) pending = undefined
    })
    pending = attempt
    return attempt
  }

  function skipMessage () {
    if (Date.now() - lastSkipAt >= retryMs) {
      lastSkipAt = Date.now()
      log('warn', '消息已收到，但当前账号处于只读模式，跳过命令处理', runtime.readOnlyState)
    }
    void recover('message')
  }

  function businessError (url, detail) {
    if (!isCurrent() || Date.now() - lastBusinessErrorAt < retryMs) return
    lastBusinessErrorAt = Date.now()
    log('warn', '业务接口返回 11300，本次请求失败，账号继续处理入站命令', {
      url: String(url || '').split('?')[0],
      message: String(detail?.message || detail?.msg || detail || '').slice(0, 300)
    })
  }

  return { enter, recover, skipMessage, businessError }
}
