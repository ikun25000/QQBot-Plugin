const WINDOW_MS = 5 * 60 * 1000

export function wsPrivateRecipient (event, separator = ':') {
  const raw = event?.raw || {}
  const candidate = raw.author?.user_openid || raw.user_openid || raw.sender?.user_id || event?.user_id || ''
  return normalizeWsRecipient(candidate, event?.self_id, separator)
}

export function normalizeWsRecipient (value, id, separator = ':') {
  let result = String(value || '')
  for (const sep of new Set([separator, ':', ''])) {
    const prefix = `${id}${sep}`
    if (result.startsWith(prefix)) { result = result.slice(prefix.length); break }
  }
  return result && !result.includes(':') && !result.includes('') && !/^unknown$/i.test(result) && !result.startsWith('qg_') ? result : ''
}

export function isWsC2cPrivate (event) {
  return event?.message_type === 'private' && !event.group_id && !event.guild_id &&
    !event.raw?.guild_id && !event.raw?.src_guild_id && !event.raw?.src_channel_id &&
    !String(event.user_id || '').startsWith('qg_') && !!event.user_id && !/^(?:.*:)?unknown$/i.test(String(event.user_id)) &&
    (!event.raw?._qqbotRawEvent || event.raw._qqbotRawEvent === 'C2C_MESSAGE_CREATE')
}

export function createWsNotifications ({ store, id, environment, isCurrent, sendMaster, sendPrivate, separator = ':', log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let previous
  let drops = []
  let identifies = []
  let pending = Promise.resolve()
  let disposed = false
  let offline = false
  let offlineDelivered = false
  let offlineMessage
  let retryTimer
  const retries = new Map()
  let delivered = {}

  function retryLater (type) {
    const count = (retries.get(type)?.count || 0) + 1
    retries.set(type, { count, at: now() + Math.min(300000, 30000 * 2 ** Math.min(count - 1, 4)) })
    armRetry()
  }

  function armRetry () {
    clearTimer(retryTimer)
    retryTimer = undefined
    if (!active() || !retries.size) return
    const next = Math.min(...[...retries.values()].map(value => value.at))
    retryTimer = setTimer(() => { retryTimer = undefined; void enqueue(evaluate) }, Math.max(1000, next - now()))
    retryTimer.unref?.()
  }

  async function deliver (type, message, success) {
    if (!enabled(type)) { retries.delete(type); return false }
    if (now() < (retries.get(type)?.at || 0)) return false
    try {
      if (!await send(message, type)) return false
      retries.delete(type)
      await success()
      return true
    } catch (error) { retryLater(type); throw error }
  }

  const active = () => !disposed && isCurrent()
  const settings = () => store.settings(id).notifications
  const enabled = type => settings().enabled && settings()[type]
  const enqueue = task => {
    pending = pending.catch(() => {}).then(async () => { if (active()) await task() })
    pending.catch(error => log('error', `WS通知失败：${error.message}`))
    return pending
  }

  async function send (message, type) {
    if (!active() || !enabled(type)) return false
    const options = settings()
    let timer
    try {
      const delivery = options.method === '本号'
        ? (() => {
            const recipient = normalizeWsRecipient(options.recipient, id, separator)
            if (!recipient) throw new Error('本号通知尚未绑定有效C2C接收人，请重新私聊设置')
            return sendPrivate(recipient, message)
          })()
        : sendMaster(message)
      const result = await Promise.race([delivery, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('通知发送超时，不影响重连')), 5000)
        timer.unref?.()
      })])
      if (result === false || result?.error?.length) throw new Error('通知接口返回发送失败')
      return true
    } finally { clearTimeout(timer) }
  }

  async function mark (change) {
    await store.update(id, record => {
      record.alerts ||= {}
      record.alerts[environment] ||= {}
      change(record.alerts[environment])
    })
  }

  async function evaluate () {
    const at = now()
    drops = drops.filter(item => at - item.from < WINDOW_MS)
    identifies = identifies.filter(time => at - time < WINDOW_MS)
    const record = await store.loadAccount(id)
    const stored = record.alerts?.[environment]
    // Older releases marked before delivery; do not trust those success flags.
    const state = { ...(stored?.deliveryVersion === 2 ? stored : {}), ...delivered }
    const errors = []
    if (Object.keys(delivered).length) await mark(value => Object.assign(value, delivered))
    if (previous?.remaining > 0 && state.zeroNotified) {
      delivered.zeroNotified = false
      retries.delete('zero')
      await mark(value => { value.zeroNotified = false })
    }
    if (previous?.remaining === 0 && enabled('zero') && (!state.zeroNotified || Math.abs(previous.resetAt - (state.zeroResetAt || previous.resetAt)) > 5000)) {
      const resetAt = previous.resetAt
      try {
        await deliver('zero', `[${id}] WS可用连接次数为0，暂停新连接；约${Math.max(0, Math.ceil((resetAt - now()) / 1000))}秒后复核。已在线连接不会因此断开。`, async () => {
          Object.assign(delivered, { deliveryVersion: 2, zeroNotified: true, zeroResetAt: resetAt })
          await mark(value => Object.assign(value, delivered))
        })
      } catch (error) { errors.push(error) }
    }
    // Official decrease is authoritative. Local Identify count is a lower-bound
    // fallback while the API catches up, never added again to the same decrease.
    const official = drops.reduce((sum, value) => sum + value.count, 0)
    const count = Math.max(official, identifies.length)
    if (count >= 10 && enabled('consumption') && (state.consumptionAt == null || at - state.consumptionAt >= WINDOW_MS)) {
      try {
        await deliver('consumption', `[${id}] WS大量消耗警告：最近5分钟${official >= identifies.length ? '官方配额减少' : '本地发送Identify至少'}${count}次，请检查反复断线或其他进程共用AppID。`, async () => {
          delivered.consumptionAt = now()
          delivered.deliveryVersion = 2
          await mark(value => Object.assign(value, delivered))
        })
      } catch (error) { errors.push(error) }
    }
    if (offline && !offlineDelivered && offlineMessage) {
      try { await deliver('offline', offlineMessage, async () => { offlineDelivered = true }) } catch (error) { errors.push(error) }
    }
    for (const type of retries.keys()) {
      if (!enabled(type) || (type === 'zero' && previous?.remaining !== 0) ||
          (type === 'zero' && delivered.zeroNotified && delivered.zeroResetAt === previous?.resetAt) ||
          (type === 'consumption' && (count < 10 || delivered.consumptionAt === at)) ||
          (type === 'offline' && (!offline || offlineDelivered))) retries.delete(type)
    }
    armRetry()
    if (errors.length) throw errors[0]
  }

  function observe (value) {
    if (!active() || !value || !Number.isSafeInteger(value.remaining) || value.remaining < 0) return
    const at = now()
    const sample = { remaining: value.remaining, total: value.total, resetAt: value.resetAt ?? at + value.reset_after, at }
    const reset = previous && (sample.total !== previous.total || sample.remaining > previous.remaining || Math.abs(sample.resetAt - previous.resetAt) > 5000)
    if (reset) { drops = []; identifies = [] }
    if (previous && !reset && at - previous.at < WINDOW_MS && sample.remaining < previous.remaining) {
      drops.push({ at, from: previous.at, count: previous.remaining - sample.remaining })
    }
    previous = sample
    void enqueue(evaluate)
  }

  return {
    observe,
    identify () { if (active()) { identifies.push(now()); void enqueue(evaluate) } },
    refresh () { return enqueue(evaluate) },
    offline (reason, disabled = false, { terminal = false } = {}) {
      if (offline) return
      offline = true
      offlineMessage = `[${id}] 账号下线：${reason}，${terminal ? '自动重连已停止' : disabled ? '自动重连已关闭' : '正在自动重连'}`
      // Capture the episode even when READY arrives before queued work runs.
      void enqueue(async () => {
        await deliver('offline', offlineMessage, async () => { offlineDelivered = true })
      })
    },
    ready () {
      if (!offline) return
      offline = false
      retries.delete('offline')
      armRetry()
      void enqueue(async () => {
        if (offlineDelivered) await send(`[${id}] 账号重连成功！`, 'offline')
        offlineDelivered = false
      })
    },
    // Probe once per minute only if quota alerts are actually opted into.
    shouldProbe () { const value = settings(); return value.enabled && (value.zero || value.consumption) },
    dispose () { disposed = true; clearTimer(retryTimer); retries.clear() },
    settled () { return pending }
  }
}
