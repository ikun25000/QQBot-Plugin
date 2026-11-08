// Version 2 stores only acknowledged application progress, never just received
// frames. Old snapshots used an unsafe cursor and must not be resumed.
export function createWsSession ({ store, id, appid, environment, signature, isCurrent, onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const key = `${id}:${appid}:${environment}`
  let pending
  let timer
  let writing
  let invalidation
  let failures = 0
  let disposed = false
  let lastSessionID
  const invalidated = new Set()
  const cancelPending = () => {
    pending = undefined
    failures = 0
    clearTimer(timer)
    timer = undefined
  }
  const unsubscribeClear = store.onSessionCacheClear?.(cancelPending)

  function schedule (ms) {
    if (timer || disposed || !isCurrent() || store.sessionCacheCleared) return
    timer = setTimer(() => { timer = undefined; void flush().catch(() => {}) }, ms)
    timer.unref?.()
  }

  function flush () {
    clearTimer(timer)
    timer = undefined
    if (store.sessionCacheCleared) pending = undefined
    if (invalidation) return invalidation.catch(() => {}).then(() => flush())
    if (writing) return writing.then(() => pending ? flush() : undefined)
    if (disposed || !isCurrent() || !pending) return Promise.resolve()
    const operation = pending
    const promise = Promise.resolve().then(async () => {
      if (disposed || !isCurrent() || store.sessionCacheCleared) return
      if (operation.value && invalidated.has(operation.value.sessionID)) {
        if (pending === operation) pending = undefined
        return
      }
      if (operation.value && !store.settings(id).sessionSave) {
        if (pending === operation) pending = undefined
        return
      }
      await store.saveSession(key, operation.value)
      if (pending === operation) pending = undefined
      failures = 0
    }).catch(error => {
      if (store.sessionCacheCleared) return
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
    if (disposed || !isCurrent() || store.sessionCacheCleared || !store.settings(id).sessionSave) return
    if (!record?.sessionID || !Number.isSafeInteger(record.seq) || record.seq < 0) return
    if (invalidated.has(record.sessionID)) return
    lastSessionID = record.sessionID
    const user = record.user ? { id: record.user.id, username: record.user.username, status: record.user.status || 0 } : undefined
    pending = { value: { version: 2, sessionID: record.sessionID, seq: record.seq, user, signature, updatedAt: now() } }
    if (immediate) void flush().catch(() => {})
    else schedule(2000)
  }

  function clear ({ force = false, invalidated: rejectOld = false } = {}) {
    if (rejectOld && lastSessionID) {
      invalidated.add(lastSessionID)
      if (invalidated.size > 64) invalidated.delete(invalidated.values().next().value)
    }
    if (store.sessionCacheCleared) { cancelPending(); return writing || Promise.resolve() }
    if (!force && !store.settings(id).sessionSave) { pending = undefined; return writing || Promise.resolve() }
    if (rejectOld) {
      pending = undefined
      clearTimer(timer); timer = undefined
      // Queue a durable tombstone now, not a coalescible pending value: a newer
      // READY must not overwrite this deletion while an old write is in flight.
      // If the new snapshot later fails, a restart must not revive the old one.
      const promise = store.saveSession(key, null).catch(error => {
        if (!store.sessionCacheCleared) {
          onError(error)
          pending ||= { value: null }
          schedule(5000)
        }
        throw error
      }).finally(() => { if (invalidation === promise) invalidation = undefined })
      invalidation = promise
      promise.catch(() => {})
      return promise
    }
    pending = { value: null }
    return flush()
  }

  async function restore () {
    if (store.sessionCacheCleared || !store.settings(id).sessionSave) return null
    const value = await store.loadSession(key)
    if (disposed || !isCurrent() || store.sessionCacheCleared) return null
    if (value?.version === 2 && value.signature === signature && typeof value.sessionID === 'string' && value.sessionID &&
        Number.isSafeInteger(value.seq) && value.seq >= 0 && Number.isFinite(value.updatedAt) && Math.abs(value.updatedAt) <= 8.64e15 && !invalidated.has(value.sessionID)) {
      lastSessionID = value.sessionID
      return value
    }
    if (value) await clear()
    return null
  }

  return { restore, update, clear, flush, async dispose () {
    try { await flush() } finally { disposed = true; clearTimer(timer); timer = undefined; unsubscribeClear?.() }
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
