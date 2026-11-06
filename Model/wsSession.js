// Version 2 stores only acknowledged application progress, never just received
// frames. Old snapshots used an unsafe cursor and must not be resumed.
export function createWsSession ({ store, id, appid, environment, signature, isCurrent, onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const key = `${id}:${appid}:${environment}`
  let pending
  let timer
  let writing
  let failures = 0
  let disposed = false

  function schedule (ms) {
    if (timer || disposed || !isCurrent()) return
    timer = setTimer(() => { timer = undefined; void flush().catch(() => {}) }, ms)
    timer.unref?.()
  }

  function flush () {
    clearTimer(timer)
    timer = undefined
    if (writing) return writing.then(() => pending ? flush() : undefined)
    if (disposed || !isCurrent() || !pending) return Promise.resolve()
    const operation = pending
    const promise = Promise.resolve().then(async () => {
      if (disposed || !isCurrent()) return
      if (operation.value && !store.settings(id).sessionSave) {
        if (pending === operation) pending = undefined
        return
      }
      await store.saveSession(key, operation.value)
      if (pending === operation) pending = undefined
      failures = 0
    }).catch(error => {
      failures++
      onError(error)
      // Keep the newest snapshot or deletion until a successful write.
      schedule(Math.min(60000, 5000 * 2 ** Math.min(failures - 1, 4)))
      throw error
    }).finally(() => { if (writing === promise) writing = undefined })
    writing = promise
    promise.catch(() => {})
    return promise.then(() => pending ? flush() : undefined)
  }

  function update (record, { immediate = false } = {}) {
    if (disposed || !isCurrent() || !store.settings(id).sessionSave) return
    if (!record?.sessionID || !Number.isSafeInteger(record.seq) || record.seq < 0) return
    const user = record.user ? { id: record.user.id, username: record.user.username, status: record.user.status || 0 } : undefined
    pending = { value: { version: 2, sessionID: record.sessionID, seq: record.seq, user, signature, updatedAt: now() } }
    if (immediate) void flush().catch(() => {})
    else schedule(2000)
  }

  function clear ({ force = false } = {}) {
    if (!force && !store.settings(id).sessionSave) { pending = undefined; return writing || Promise.resolve() }
    pending = { value: null }
    return flush()
  }

  async function restore () {
    if (!store.settings(id).sessionSave) return null
    const value = await store.loadSession(key)
    if (disposed || !isCurrent()) return null
    if (value?.version === 2 && value.signature === signature && typeof value.sessionID === 'string' && value.sessionID &&
        Number.isSafeInteger(value.seq) && value.seq >= 0 && Number.isFinite(value.updatedAt)) return value
    if (value) await clear()
    return null
  }

  return { restore, update, clear, flush, async dispose () {
    try { await flush() } finally { disposed = true; clearTimer(timer); timer = undefined }
  } }
}
export function restoreWsIdentity (sm, saved) {
  if (!saved?.user?.id || typeof saved.user.id !== 'string') return false
  sm.bot.self_id = saved.user.id
  sm.bot.nickname = saved.user.username || ''
  sm.bot.status = saved.user.status || 0
  sm.sessionRecord = { sessionID: saved.sessionID, seq: saved.seq }
  sm.heartbeatParam.d = saved.seq
  return true
}
