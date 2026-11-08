import { setTimeout as delay } from 'node:timers/promises'

// Shared by runtimes for the same AppID, including an account being replaced.
const connectionWindows = new Map()
const integer = value => Number.isSafeInteger(value) && value >= 0

export function createSessionQuota ({ key, log = () => {}, onWait = () => {}, onObserve = () => {}, now = Date.now, sleep = delay }) {
  let limit
  let waiting = null
  let refreshRequired = false

  function observe (data) {
    const value = data?.session_start_limit
    if (!value || !integer(value.total) || !integer(value.remaining) ||
        !integer(value.reset_after) || !integer(value.max_concurrency) || value.max_concurrency < 1 ||
        value.remaining > value.total) {
      // A fallback URL is not evidence of an available Session budget.
      refreshRequired = true
      return
    }
    limit = { ...value, observedAt: now(), resetAt: now() + value.reset_after }
    refreshRequired = false
    onObserve(snapshot())
    log('info', `Session 可用连接次数 ${value.remaining}/${value.total}，${Math.ceil(value.reset_after / 1000)}秒后重置，每5秒最多 ${value.max_concurrency} 次`)
  }

  async function acquire ({ signal, refresh, resume = false, probeReserve }) {
    try {
      for (;;) {
        signal.throwIfAborted()
        const exhausted = limit?.remaining === 0
        const unknown = !limit || refreshRequired || now() - limit.observedAt > 60000
        if (probeReserve !== undefined && (unknown || exhausted || limit.remaining <= probeReserve)) {
          throw new Error('配额未知或不足预留次数，未建立临时连接')
        }
        if (exhausted || unknown) {
          const waitMs = exhausted && limit.resetAt > now() ? limit.resetAt - now() + 1000 : 60000
          waiting = { reason: exhausted ? 'quota' : 'quota-unknown', until: now() + waitMs }
          log('warn', exhausted
            ? `Session 可用连接次数为 0，暂停连接，${Math.ceil(waitMs / 1000)}秒后复核配额`
            : 'Session 可用连接次数未知，暂停连接，60秒后重新查询')
          onWait({ ...waiting, limit: snapshot() })
          await sleep(Math.min(waitMs, 2147483647), undefined, { signal })
          signal.throwIfAborted()
          await refresh()
          continue
        }
        // Conservative single-flight pacing also respects max_concurrency > 1.
        const last = connectionWindows.get(key)?.connectionAt
        const waitMs = last == null ? 0 : Math.max(0, last + 5000 - now())
        if (waitMs) {
          waiting = { reason: 'concurrency', until: now() + waitMs }
          await sleep(waitMs, undefined, { signal })
          continue
        }
        connectionWindows.set(key, { ...connectionWindows.get(key), connectionAt: now() })
        // Reserve a new Session before creating the socket, not after READY.
        if (!resume) limit.remaining--
        return
      }
    } finally {
      waiting = null
    }
  }

  function snapshot () {
    return limit ? { ...limit, reset_after: Math.max(0, limit.resetAt - now()), known: !refreshRequired } : null
  }

  async function beforeIdentify ({ signal }) {
    // Pace the actual Identify too: two sockets may receive HELLO at different
    // times, even when their creation was correctly spaced five seconds apart.
    for (;;) {
      signal.throwIfAborted()
      const last = connectionWindows.get(key)?.identifyAt
      const waitMs = last == null ? 0 : Math.max(0, last + 5000 - now())
      if (!waitMs) {
        connectionWindows.set(key, { ...connectionWindows.get(key), identifyAt: now() })
        return
      }
      await sleep(waitMs, undefined, { signal })
    }
  }

  return { observe, acquire, beforeIdentify, snapshot, get waiting () { return waiting } }
}
