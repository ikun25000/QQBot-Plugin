import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotAdvancedWelcome')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'advancedWelcome')
const MESSAGE_INDEX_TTL_MS = 24 * 60 * 60 * 1000
const MESSAGE_INDEX_MAX_PER_BOT = 50000
const LOCAL_MESSAGE_INDEX_MAX_PER_BOT = 20000
const PENDING_COMPLAINT_MAX_PER_BOT = 1000
const ACTUAL_MESSAGE_IDS_MAX = 100
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const LEVEL_INDEX_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const INDEX_MEMORY_CACHE_MAX = 2000
const INDEX_DELETE_BATCH_SIZE = 1000

function nowIso () { return new Date().toISOString() }
function dayKey (date = new Date()) { return date.toISOString().slice(0, 10) }
function weekKey (date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

class AdvancedWelcomeStore {
  constructor () {
    this.type = 'level'
    this._data = { groups: {}, pendingComplaints: {}, complaintBlacklist: {}, messageIds: {}, localMessageIds: {} }
    this._db = null
    this._ready = false
    this._saveTimer = null
    this._writeQueue = Promise.resolve()
    this._writeSeq = 0
    this._indexCounts = { messageIds: new Map(), localMessageIds: new Map() }
    this._lastCleanup = 0
    this._indexCacheOrder = { messageIds: new Map(), localMessageIds: new Map() }
    this._levelIndexCleanupPromise = null
    this._levelIndexCleanupTimer = null
    this._levelIndexCleanupRequested = false
    this._lastLevelIndexCleanup = 0
    this._pendingGroupSaves = new Set()
    this._groupSaveTimer = null
    this._groupSavePromise = null
    this._groupSaveWaiters = []
    this._pendingIndexPuts = new Map()
    this._pendingIndexDeletes = new Set()
    this._indexWriteWaiters = []
    this._indexWriteTimer = null
    this._indexWritePromise = null
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'advancedWelcome.json') }

  async init () {
    if (this._ready) return
    this.type = 'level'
    this._data = { groups: {}, pendingComplaints: {}, complaintBlacklist: {}, messageIds: {}, localMessageIds: {} }
    this._indexCounts = { messageIds: new Map(), localMessageIds: new Map() }
    this._lastCleanup = Date.now()
    this._indexCacheOrder.messageIds.clear()
    this._indexCacheOrder.localMessageIds.clear()
    this._levelIndexCleanupPromise = null
    this._levelIndexCleanupRequested = false
    this._lastLevelIndexCleanup = 0
    if (this._levelIndexCleanupTimer) clearTimeout(this._levelIndexCleanupTimer)
    this._levelIndexCleanupTimer = null
    this._pendingGroupSaves.clear()
    if (this._groupSaveTimer) clearTimeout(this._groupSaveTimer)
    this._groupSaveTimer = null
    this._groupSavePromise = null
    this._groupSaveWaiters = []
    this._pendingIndexPuts.clear()
    this._pendingIndexDeletes.clear()
    this._indexWriteWaiters = []
    if (this._indexWriteTimer) clearTimeout(this._indexWriteTimer)
    this._indexWriteTimer = null
    this._indexWritePromise = null
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open({ cleanup: false })
      const deletes = []
      for (const prefix of ['group:', 'pending:', 'complaintBlack:']) {
        for await (const [key, value] of this._db.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
          if (this._isStoredRecordExpired(key, value)) deletes.push(String(key))
          else this._setByKey(key, value)
        }
      }
      for (const selfId of new Set(Object.values(this._data.pendingComplaints).map(item => item?.self_id || ''))) deletes.push(...this._prunePendingComplaints(selfId))
      deletes.push(...this._pruneIndexStore('messageIds', MESSAGE_INDEX_MAX_PER_BOT), ...this._pruneIndexStore('localMessageIds', LOCAL_MESSAGE_INDEX_MAX_PER_BOT))
      await this._persistDeletes(deletes)
    } catch (err) {
      logger.error('[QQBot-Plugin] advancedWelcomeStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { await this._db.close() } catch {}; this._db = null }
      this._data = { groups: {}, pendingComplaints: {}, complaintBlacklist: {}, messageIds: {}, localMessageIds: {} }
      this._indexCounts = { messageIds: new Map(), localMessageIds: new Map() }
      this._indexCacheOrder.messageIds.clear()
      this._indexCacheOrder.localMessageIds.clear()
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        const data = { groups: {}, pendingComplaints: {}, complaintBlacklist: {}, messageIds: {}, localMessageIds: {}, ...JSON.parse(fs.readFileSync(this._jsonPath(), 'utf-8')) }
        this._data.groups = data.groups || {}
        this._data.complaintBlacklist = data.complaintBlacklist || {}
        for (const [key, value] of Object.entries(data.pendingComplaints || {})) {
          if (!this._isPendingExpired(value)) this._data.pendingComplaints[key] = value
        }
        for (const [key, value] of Object.entries(data.messageIds || {})) {
          if (!this._isMessageIndexExpired(value)) this._setIndexItem('messageIds', key, value)
        }
        for (const [key, value] of Object.entries(data.localMessageIds || {})) {
          if (!this._isMessageIndexExpired(value)) this._setIndexItem('localMessageIds', key, value)
        }
        const deletes = []
        for (const selfId of new Set(Object.values(this._data.pendingComplaints).map(item => item?.self_id || ''))) deletes.push(...this._prunePendingComplaints(selfId))
        deletes.push(...this._pruneIndexStore('messageIds', MESSAGE_INDEX_MAX_PER_BOT), ...this._pruneIndexStore('localMessageIds', LOCAL_MESSAGE_INDEX_MAX_PER_BOT))
        if (deletes.length || Object.keys(data.pendingComplaints || {}).length !== Object.keys(this._data.pendingComplaints).length || Object.keys(data.messageIds || {}).length !== Object.keys(this._data.messageIds).length || Object.keys(data.localMessageIds || {}).length !== Object.keys(this._data.localMessageIds).length) this._scheduleSave()
      } catch {
        this._data = { groups: {}, pendingComplaints: {}, complaintBlacklist: {}, messageIds: {}, localMessageIds: {} }
        this._indexCounts = { messageIds: new Map(), localMessageIds: new Map() }
      }
    }
    this._ready = true
    this._scheduleLevelIndexCleanup(30000)
  }

  _setByKey (key, value) {
    if (String(key).startsWith('group:')) {
      if (Array.isArray(value?.recent_message_ids) && value.recent_message_ids.length > 20) value.recent_message_ids = value.recent_message_ids.slice(-20)
      this._data.groups[String(key).slice(6)] = value
    }
    else if (String(key).startsWith('pending:')) this._data.pendingComplaints[String(key).slice(8)] = value
    else if (String(key).startsWith('complaintBlack:')) this._data.complaintBlacklist[String(key).slice(15)] = value
    else if (String(key).startsWith('localmsg:')) this._setIndexItem('localMessageIds', String(key).slice(9), value)
    else if (String(key).startsWith('msg:')) this._setIndexItem('messageIds', String(key).slice(4), value)
  }

  _indexTime (item) {
    const expires = Number(item?.expire_at)
    if (Number.isFinite(expires) && expires > 0) return expires - MESSAGE_INDEX_TTL_MS
    const numeric = Number(item?.time)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10000000000 ? numeric * 1000 : numeric
    return Date.parse(item?.time || '') || 0
  }

  _isMessageIndexExpired (item, now = Date.now()) {
    const expires = Number(item?.expire_at)
    if (Number.isFinite(expires) && expires > 0) return expires <= now
    const time = this._indexTime(item)
    return time > 0 && now - time >= MESSAGE_INDEX_TTL_MS
  }

  _isPendingExpired (item, now = Date.now()) {
    const expires = Number(item?.expire_at)
    return Number.isFinite(expires) && expires > 0 && expires <= now
  }

  _isStoredRecordExpired (key, value, now = Date.now()) {
    const storedKey = String(key)
    if (storedKey.startsWith('pending:')) return this._isPendingExpired(value, now)
    if (storedKey.startsWith('msg:') || storedKey.startsWith('localmsg:')) return this._isMessageIndexExpired(value, now)
    return false
  }

  _setIndexItem (store, key, item) {
    const old = this._data[store][key]
    const oldBot = String(old?.self_id || '')
    const bot = String(item?.self_id || '')
    if (this.type !== 'level' && (!old || oldBot !== bot)) {
      if (old) {
        const oldCount = Math.max(0, (this._indexCounts[store].get(oldBot) || 1) - 1)
        if (oldCount) this._indexCounts[store].set(oldBot, oldCount)
        else this._indexCounts[store].delete(oldBot)
      }
      this._indexCounts[store].set(bot, (this._indexCounts[store].get(bot) || 0) + 1)
    }
    this._data[store][key] = item
    if (this.type === 'level') {
      const order = this._indexCacheOrder[store]
      order.delete(key)
      order.set(key, true)
      while (order.size > INDEX_MEMORY_CACHE_MAX) {
        const oldest = order.keys().next().value
        order.delete(oldest)
        delete this._data[store][oldest]
      }
    }
  }

  _deleteIndexItem (store, key) {
    const item = this._data[store][key]
    if (!item) return
    const bot = String(item.self_id || '')
    if (this.type !== 'level') {
      const count = Math.max(0, (this._indexCounts[store].get(bot) || 1) - 1)
      if (count) this._indexCounts[store].set(bot, count)
      else this._indexCounts[store].delete(bot)
    }
    delete this._data[store][key]
    this._indexCacheOrder[store]?.delete(key)
  }

  _pruneIndexStore (store, max, selfId = '') {
    if (this.type === 'level') return []
    const prefix = store === 'messageIds' ? 'msg:' : 'localmsg:'
    const bots = selfId ? [String(selfId)] : [...this._indexCounts[store].keys()]
    const deletes = []
    for (const bot of bots) {
      if ((this._indexCounts[store].get(bot) || 0) <= max) continue
      const items = Object.entries(this._data[store])
        .filter(([, item]) => String(item?.self_id || '') === bot)
        .sort((a, b) => this._indexTime(a[1]) - this._indexTime(b[1]))
      for (const [key] of items.slice(0, Math.max(0, items.length - Math.floor(max * 0.9)))) {
        this._deleteIndexItem(store, key)
        deletes.push(`${prefix}${key}`)
      }
    }
    return deletes
  }

  _removeExpired (now = Date.now()) {
    const deletes = []
    for (const [key, item] of Object.entries(this._data.pendingComplaints)) {
      if (!this._isPendingExpired(item, now)) continue
      delete this._data.pendingComplaints[key]
      deletes.push(`pending:${key}`)
    }
    for (const [store, prefix] of [['messageIds', 'msg:'], ['localMessageIds', 'localmsg:']]) {
      for (const [key, item] of Object.entries(this._data[store])) {
        if (!this._isMessageIndexExpired(item, now)) continue
        this._deleteIndexItem(store, key)
        deletes.push(`${prefix}${key}`)
      }
    }
    return deletes
  }

  _prunePendingComplaints (selfId = '') {
    const items = Object.entries(this._data.pendingComplaints)
      .filter(([, item]) => item?.self_id === selfId)
      .sort((a, b) => (Date.parse(b[1]?.created_at || '') || 0) - (Date.parse(a[1]?.created_at || '') || 0))
    const deletes = []
    for (const [key] of items.slice(PENDING_COMPLAINT_MAX_PER_BOT)) {
      delete this._data.pendingComplaints[key]
      deletes.push(`pending:${key}`)
    }
    return deletes
  }

  async _persistDeletes (keys) {
    const unique = [...new Set(keys)]
    if (!unique.length) return
    if (this.type === 'level' && this._db) await this._db.db.batch(unique.map(key => ({ type: 'del', key })))
    else this._scheduleSave()
  }

  async _cleanupLevelIndexes (now = Date.now()) {
    if (this.type !== 'level' || !this._db) return
    if (this._levelIndexCleanupPromise) return this._levelIndexCleanupPromise
    this._lastLevelIndexCleanup = now
    this._levelIndexCleanupRequested = false
    this._levelIndexCleanupPromise = (async () => {
      for (const [prefix, max] of [['msg:', MESSAGE_INDEX_MAX_PER_BOT], ['localmsg:', LOCAL_MESSAGE_INDEX_MAX_PER_BOT]]) {
        let expiredDeletes = []
        const flushExpiredDeletes = async () => {
          if (!expiredDeletes.length) return
          await this._deleteExpiredIndexKeys(expiredDeletes)
          expiredDeletes = []
        }
        const counts = new Map()
        for await (const [key, value] of this._db.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
          if (this._isStoredRecordExpired(key, value, now)) {
            expiredDeletes.push(String(key))
          } else {
            const bot = String(value?.self_id || '')
            if (bot) counts.set(bot, (counts.get(bot) || 0) + 1)
          }
          if (expiredDeletes.length >= INDEX_DELETE_BATCH_SIZE) await flushExpiredDeletes()
        }
        await flushExpiredDeletes()

        const overflowBots = new Set([...counts].filter(([, count]) => count > max).map(([bot]) => bot))
        if (!overflowBots.size) continue

        const isOlder = (a, b) => a.time < b.time || (a.time === b.time && a.key < b.key)
        const pushHeap = (heap, item) => {
          heap.push(item)
          let index = heap.length - 1
          while (index > 0) {
            const parent = Math.floor((index - 1) / 2)
            if (!isOlder(heap[index], heap[parent])) break
            ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
            index = parent
          }
        }
        const popHeap = heap => {
          const first = heap[0]
          const last = heap.pop()
          if (heap.length && last) {
            heap[0] = last
            let index = 0
            while (true) {
              const left = index * 2 + 1
              const right = left + 1
              let smallest = index
              if (left < heap.length && isOlder(heap[left], heap[smallest])) smallest = left
              if (right < heap.length && isOlder(heap[right], heap[smallest])) smallest = right
              if (smallest === index) break
              ;[heap[index], heap[smallest]] = [heap[smallest], heap[index]]
              index = smallest
            }
          }
          return first
        }
        let overflowDeletes = []
        const flushOverflowDeletes = async () => {
          if (!overflowDeletes.length) return
          await this._deleteIndexKeys(overflowDeletes)
          overflowDeletes = []
        }
        const keep = Math.floor(max * 0.9)
        const heaps = new Map([...overflowBots].map(bot => [bot, []]))
        for await (const [key, value] of this._db.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
          const bot = String(value?.self_id || '')
          if (this._isStoredRecordExpired(key, value, now) || !overflowBots.has(bot)) continue
          const heap = heaps.get(bot)
          pushHeap(heap, { key: String(key), time: this._indexTime(value), expireAt: Number(value?.expire_at) || 0, selfId: bot })
          if (heap.length > keep) overflowDeletes.push(popHeap(heap))
          if (overflowDeletes.length >= INDEX_DELETE_BATCH_SIZE) {
            await flushOverflowDeletes()
          }
        }
        await flushExpiredDeletes()
        await flushOverflowDeletes()
      }
    })().finally(() => { this._levelIndexCleanupPromise = null })
    return this._levelIndexCleanupPromise
  }

  _scheduleLevelIndexCleanup (delay = 6 * 60 * 60 * 1000) {
    if (this._ready !== true || this.type !== 'level' || !this._db) return
    if (this._levelIndexCleanupTimer) {
      if (!this._levelIndexCleanupRequested || delay >= LEVEL_INDEX_CLEANUP_INTERVAL_MS) return
      clearTimeout(this._levelIndexCleanupTimer)
      this._levelIndexCleanupTimer = null
    }
    this._levelIndexCleanupTimer = setTimeout(() => {
      this._levelIndexCleanupTimer = null
      this._cleanupLevelIndexes()
        .catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore index cleanup error:', err))
        .finally(() => {
          if (this._ready && this.type === 'level' && this._db) this._scheduleLevelIndexCleanup(LEVEL_INDEX_CLEANUP_INTERVAL_MS)
        })
    }, delay)
    this._levelIndexCleanupTimer.unref?.()
  }

  async _deleteIndexKeys (items = []) {
    if (this.type !== 'level' || !this._db || !items.length) return
    const operations = []
    for (const item of items) {
      const key = String(item?.key || item)
      let current = null
      try { current = await this._db.get(key) } catch {}
      if (!current) continue
      if (item?.selfId && String(current.self_id || '') !== String(item.selfId)) continue
      if (Number.isFinite(item?.time) && this._indexTime(current) !== item.time) continue
      if (Number.isFinite(item?.expireAt) && Number(current.expire_at || 0) !== item.expireAt) continue
      operations.push({ type: 'del', key })
    }
    if (operations.length) {
      await this._db.db.batch(operations)
      for (const operation of operations) {
        const key = String(operation.key)
        if (key.startsWith('msg:')) this._deleteIndexItem('messageIds', key.slice(4))
        else if (key.startsWith('localmsg:')) this._deleteIndexItem('localMessageIds', key.slice(9))
      }
    }
  }

  async _deleteExpiredIndexKeys (keys = [], now = Date.now()) {
    if (this.type !== 'level' || !this._db || !keys.length) return
    const operations = []
    for (const key of new Set(keys.map(String))) {
      let current = null
      try { current = await this._db.get(key) } catch {}
      if (this._isStoredRecordExpired(key, current, now)) operations.push({ type: 'del', key })
    }
    if (operations.length) {
      await this._db.db.batch(operations)
      for (const key of operations.map(operation => String(operation.key))) {
        if (key.startsWith('msg:')) this._deleteIndexItem('messageIds', key.slice(4))
        else if (key.startsWith('localmsg:')) this._deleteIndexItem('localMessageIds', key.slice(9))
      }
    }
  }

  async _persistIndexBatch (puts = [], deletes = []) {
    if (this.type !== 'level' || !this._db) {
      if (puts.length || deletes.length) this._scheduleSave()
      return
    }
    for (const item of puts) {
      const key = String(item.key)
      this._pendingIndexPuts.set(key, { key, value: item.value })
      this._pendingIndexDeletes.delete(key)
    }
    for (const key of new Set(deletes.map(String))) {
      if (this._pendingIndexPuts.has(key)) this._pendingIndexPuts.delete(key)
      this._pendingIndexDeletes.add(key)
    }
    const promise = new Promise((resolve, reject) => this._indexWriteWaiters.push({ resolve, reject }))
    if (this._indexWriteTimer || this._indexWritePromise) return promise
    this._indexWriteTimer = setTimeout(() => {
      this._indexWriteTimer = null
      this._flushIndexWrites().catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore index save error:', err))
    }, 0)
    return promise
  }

  async _readIndexItem (store, key) {
    const cached = this._data[store][key]
    if (cached) return cached
    if (this.type !== 'level' || !this._db) return null
    const prefix = store === 'messageIds' ? 'msg:' : 'localmsg:'
    const item = await this._db.get(`${prefix}${key}`)
    if (!item) return null
    if (this._isMessageIndexExpired(item)) {
      this._queueDeletes([`${prefix}${key}`])
      return null
    }
    this._setIndexItem(store, key, item)
    return item
  }

  async _forEachMessageIndex (visit) {
    if (this.type === 'level' && this._db) {
      let deletes = []
      for await (const [key, item] of this._db.db.iterator({ gte: 'msg:', lt: 'msg:\uffff' })) {
        if (this._isMessageIndexExpired(item)) {
          deletes.push(String(key))
          if (deletes.length >= INDEX_DELETE_BATCH_SIZE) {
            await this._deleteExpiredIndexKeys(deletes)
            deletes = []
          }
          continue
        }
        await visit(item)
      }
      if (deletes.length) await this._deleteExpiredIndexKeys(deletes)
      return
    }
    for (const item of Object.values(this._data.messageIds)) await visit(item)
  }

  async _flushIndexWrites () {
    if (this._indexWritePromise) return this._indexWritePromise
    if (!this._pendingIndexPuts.size && !this._pendingIndexDeletes.size) return
    const puts = [...this._pendingIndexPuts.values()]
    const deletes = [...this._pendingIndexDeletes]
    const waiters = this._indexWriteWaiters.splice(0)
    this._pendingIndexPuts.clear()
    this._pendingIndexDeletes.clear()
    const putKeys = new Set(puts.map(item => item.key))
    this._indexWritePromise = this._db.db.batch([
      ...puts.map(item => ({ type: 'put', key: item.key, value: item.value })),
      ...deletes.filter(key => !putKeys.has(key)).map(key => ({ type: 'del', key }))
    ]).then(() => {
      for (const waiter of waiters) waiter.resolve()
      this._levelIndexCleanupRequested = true
      this._scheduleLevelIndexCleanup(30000)
    }).catch(err => {
      for (const item of puts) this._pendingIndexPuts.set(item.key, item)
      for (const key of deletes) this._pendingIndexDeletes.add(key)
      for (const waiter of waiters) waiter.reject(err)
      throw err
    }).finally(() => {
      this._indexWritePromise = null
      if (this._pendingIndexPuts.size || this._pendingIndexDeletes.size) {
        this._indexWriteTimer = setTimeout(() => {
          this._indexWriteTimer = null
          this._flushIndexWrites().catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore index save error:', err))
        }, 0)
      }
    })
    return this._indexWritePromise
  }

  _queueDeletes (keys) {
    this._persistDeletes(keys).catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore cleanup error:', err))
  }

  _maybeCleanup () {
    const now = Date.now()
    if (now - this._lastCleanup < CLEANUP_INTERVAL_MS) return
    this._lastCleanup = now
    this._queueDeletes(this._removeExpired(now))
    if (now - this._lastLevelIndexCleanup >= LEVEL_INDEX_CLEANUP_INTERVAL_MS) {
      this._cleanupLevelIndexes(now).catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore index cleanup error:', err))
    }
  }

  _scheduleSave () {
    if (this.type === 'level' && this._db) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._writeQueue = this._writeQueue.catch(() => {}).then(async () => {
        const file = this._jsonPath()
        const tmp = `${file}.${process.pid}.${Date.now()}.${++this._writeSeq}.tmp`
        try {
          await fs.promises.writeFile(tmp, JSON.stringify(this._data, null, 2), 'utf-8')
          await fs.promises.rename(tmp, file)
        } catch (err) {
          try { await fs.promises.unlink(tmp) } catch {}
          logger.error('[QQBot-Plugin] advancedWelcomeStore JSON save error:', err)
        }
      })
      this._saveTimer = null
    }, 1000)
  }

  async _save (key, value) {
    if (this.type === 'level' && this._db) await this._db.set(key, value, 0)
    else this._scheduleSave()
  }

  _groupKey (selfId, groupOpenid) { return `${selfId}:${groupOpenid}` }

  _defaultGroup (selfId, groupOpenid) {
    return {
      self_id: selfId,
      group_openid: groupOpenid,
      created_at: nowIso(),
      updated_at: nowIso(),
      disabled: false,
      join_count: 0,
      leave_count: 0,
      sent_count: 0,
      failed_count: 0,
      consecutive_failed_count: 0,
      last_failed_at: '',
      last_failed_reason: '',
      last_sent_at: '',
      last_sent_event_id: '',
      speech_since_sent: 0,
      full_message_active: false,
      full_message_create_count: 0,
      recent_message_ids: [],
      sent_times: [],
      joins: {},
      leaves: {},
      complaints: {},
      withdrawn_complaints: {}
    }
  }

  getGroup (selfId = '', groupOpenid = '', create = false) {
    if (!selfId || !groupOpenid) return null
    const key = this._groupKey(selfId, groupOpenid)
    let item = this._data.groups[key]
    if (!item && create) {
      item = this._defaultGroup(selfId, groupOpenid)
      this._data.groups[key] = item
    }
    return item || null
  }

  getGroups (selfId = '') {
    return Object.values(this._data.groups).filter(item => !selfId || item.self_id === selfId)
  }

  async saveGroup (item) {
    if (!item?.self_id || !item?.group_openid) return false
    item.updated_at = nowIso()
    const key = this._groupKey(item.self_id, item.group_openid)
    this._data.groups[key] = item
    await this._save(`group:${key}`, item)
    return true
  }

  _scheduleGroupSave (key) {
    if (this.type !== 'level' || !this._db) {
      this._scheduleSave()
      return Promise.resolve()
    }
    if (key) this._pendingGroupSaves.add(key)
    const promise = new Promise((resolve, reject) => this._groupSaveWaiters.push({ resolve, reject }))
    if (this._groupSaveTimer) return promise
    this._groupSaveTimer = setTimeout(() => {
      this._groupSaveTimer = null
      this._flushGroupSaves().catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore batch group save error:', err))
    }, 0)
    return promise
  }

  async _flushGroupSaves () {
    if (this._groupSavePromise) return this._groupSavePromise
    if (!this._pendingGroupSaves.size) return
    const keys = [...this._pendingGroupSaves]
    const waiters = this._groupSaveWaiters.splice(0)
    this._pendingGroupSaves.clear()
    this._groupSavePromise = (async () => {
      const operations = keys
        .map(key => ({ key: `group:${key}`, value: this._data.groups[key] }))
        .filter(item => item.value)
        .map(item => ({ type: 'put', key: item.key, value: item.value }))
      if (operations.length) await this._db.db.batch(operations)
    })().then(() => {
      for (const waiter of waiters) waiter.resolve()
    }).catch(err => {
      for (const key of keys) this._pendingGroupSaves.add(key)
      for (const waiter of waiters) waiter.reject(err)
      throw err
    }).finally(() => {
      this._groupSavePromise = null
      if (this._pendingGroupSaves.size && !this._groupSaveTimer) {
        this._groupSaveTimer = setTimeout(() => {
          this._groupSaveTimer = null
          this._flushGroupSaves().catch(err => logger.error('[QQBot-Plugin] advancedWelcomeStore batch group save error:', err))
        }, 0)
      }
    })
    return this._groupSavePromise
  }

  async setGroupDisabled (selfId = '', groupOpenid = '', disabled = false, source = '') {
    const item = this.getGroup(selfId, groupOpenid, true)
    item.disabled = !!disabled
    item.switch_time = nowIso()
    if (source) item.switch_source = source
    await this.saveGroup(item)
    return item
  }

  _bumpWindow (bucket, date, amount = 1) {
    bucket.total = (Number(bucket.total) || 0) + amount
    bucket[dayKey(date)] = (Number(bucket[dayKey(date)]) || 0) + amount
    bucket[weekKey(date)] = (Number(bucket[weekKey(date)]) || 0) + amount
  }

  async recordMemberEvent (selfId = '', groupOpenid = '', type = 'join', timestamp = '') {
    const item = this.getGroup(selfId, groupOpenid, true)
    const date = timestamp ? new Date(timestamp) : new Date()
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date
    if (type === 'leave') {
      item.leave_count = (Number(item.leave_count) || 0) + 1
      this._bumpWindow(item.leaves, safeDate)
    } else {
      item.join_count = (Number(item.join_count) || 0) + 1
      this._bumpWindow(item.joins, safeDate)
    }
    await this.saveGroup(item)
    return item
  }

  async recordSpeech (selfId = '', groupOpenid = '', messageId = '', fullMessageCreate = false) {
    if (!selfId || !groupOpenid) return false
    const item = this.getGroup(selfId, groupOpenid, true)
    if (messageId && item.recent_message_ids.includes(messageId)) return false
    item.full_message_active = fullMessageCreate === true
    if (fullMessageCreate) item.full_message_create_count = (Number(item.full_message_create_count) || 0) + 1
    if (messageId) {
      item.recent_message_ids.push(messageId)
      if (item.recent_message_ids.length > 20) item.recent_message_ids.splice(0, item.recent_message_ids.length - 20)
    }
    if (fullMessageCreate) item.speech_since_sent = (Number(item.speech_since_sent) || 0) + 1
    else item.speech_since_sent = 0
    await this._scheduleGroupSave(this._groupKey(selfId, groupOpenid))
    return true
  }

  getSentWindowCounts (selfId = '', groupOpenid = '', now = Date.now()) {
    const item = this.getGroup(selfId, groupOpenid) || this._defaultGroup(selfId, groupOpenid)
    const times = Array.isArray(item.sent_times) ? item.sent_times.map(Number).filter(Number.isFinite) : []
    const countSince = ms => times.filter(time => now - time < ms).length
    const date = new Date(now)
    return {
      total: Number(item.sent_count) || 0,
      day: times.filter(time => dayKey(new Date(time)) === dayKey(date)).length,
      week: times.filter(time => weekKey(new Date(time)) === weekKey(date)).length,
      hour5: countSince(5 * 60 * 60 * 1000),
      hour1: countSince(60 * 60 * 1000),
      min5: countSince(5 * 60 * 1000),
      min1: countSince(60 * 1000)
    }
  }

  async recordSendSuccess (selfId = '', groupOpenid = '', eventId = '') {
    const item = this.getGroup(selfId, groupOpenid, true)
    const now = Date.now()
    item.sent_count = (Number(item.sent_count) || 0) + 1
    item.consecutive_failed_count = 0
    item.last_sent_at = nowIso()
    item.last_sent_event_id = eventId || ''
    item.speech_since_sent = 0
    item.sent_times = (Array.isArray(item.sent_times) ? item.sent_times : []).filter(time => now - Number(time) < 31 * 24 * 60 * 60 * 1000)
    item.sent_times.push(now)
    await this.saveGroup(item)
    return item
  }

  async recordSendFailure (selfId = '', groupOpenid = '', reason = '', count = true) {
    const item = this.getGroup(selfId, groupOpenid, true)
    if (count) {
      item.failed_count = (Number(item.failed_count) || 0) + 1
      item.consecutive_failed_count = (Number(item.consecutive_failed_count) || 0) + 1
    }
    item.last_failed_at = nowIso()
    item.last_failed_reason = String(reason || '发送失败').slice(0, 300)
    await this.saveGroup(item)
    return item
  }

  async autoDisableGroup (selfId = '', groupOpenid = '', reason = '') {
    const item = this.getGroup(selfId, groupOpenid, true)
    if (item.disabled) return item
    item.disabled = true
    item.switch_time = nowIso()
    item.switch_source = 'system'
    item.auto_disabled_reason = String(reason || '自动关闭').slice(0, 300)
    await this.saveGroup(item)
    return item
  }

  _pendingKey (selfId, groupOpenid, userOpenid) { return `${selfId}:${groupOpenid}:${userOpenid}` }

  async setPendingComplaint (selfId = '', groupOpenid = '', userOpenid = '', code = '') {
    const deletes = this._removeExpired()
    const key = this._pendingKey(selfId, groupOpenid, userOpenid)
    const item = { self_id: selfId, group_openid: groupOpenid, user_openid: userOpenid, code, expire_at: Date.now() + 60000, created_at: nowIso() }
    this._data.pendingComplaints[key] = item
    await this._save(`pending:${key}`, item)
    deletes.push(...this._prunePendingComplaints(selfId))
    const currentKey = `pending:${key}`
    for (let i = deletes.length - 1; i >= 0; i--) if (deletes[i] === currentKey) deletes.splice(i, 1)
    await this._persistDeletes(deletes)
    return item
  }

  getPendingComplaint (selfId = '', groupOpenid = '', userOpenid = '') {
    const key = this._pendingKey(selfId, groupOpenid, userOpenid)
    const item = this._data.pendingComplaints[key]
    if (!item) return null
    if (this._isPendingExpired(item)) {
      delete this._data.pendingComplaints[key]
      this._queueDeletes([`pending:${key}`])
      return null
    }
    return item
  }

  findPendingComplaintByCode (selfId = '', groupOpenid = '', code = '') {
    const target = String(code || '')
    if (!target) return null
    const deletes = []
    for (const [key, item] of Object.entries(this._data.pendingComplaints)) {
      if (this._isPendingExpired(item)) {
        delete this._data.pendingComplaints[key]
        deletes.push(`pending:${key}`)
        continue
      }
      if (item?.self_id === selfId && item?.group_openid === groupOpenid && item?.code === target) {
        this._queueDeletes(deletes)
        return item
      }
    }
    this._queueDeletes(deletes)
    return null
  }

  async clearPendingComplaint (selfId = '', groupOpenid = '', userOpenid = '') {
    const key = this._pendingKey(selfId, groupOpenid, userOpenid)
    delete this._data.pendingComplaints[key]
    if (this.type === 'level' && this._db) { try { await this._db.db.del(`pending:${key}`) } catch {} } else this._scheduleSave()
  }

  async addComplaint (selfId = '', groupOpenid = '', userOpenid = '') {
    const item = this.getGroup(selfId, groupOpenid, true)
    if (!item.complaints || typeof item.complaints !== 'object') item.complaints = {}
    if (!item.withdrawn_complaints || typeof item.withdrawn_complaints !== 'object') item.withdrawn_complaints = {}
    if (item.complaints[userOpenid]) return { added: false, item }
    item.complaints[userOpenid] = { user_openid: userOpenid, time: nowIso() }
    delete item.withdrawn_complaints[userOpenid]
    await this.saveGroup(item)
    await this.clearPendingComplaint(selfId, groupOpenid, userOpenid)
    return { added: true, item }
  }

  async withdrawComplaint (selfId = '', groupOpenid = '', userOpenid = '') {
    const item = this.getGroup(selfId, groupOpenid, true)
    if (!item.complaints?.[userOpenid]) return { withdrawn: false, item }
    if (!item.withdrawn_complaints || typeof item.withdrawn_complaints !== 'object') item.withdrawn_complaints = {}
    item.withdrawn_complaints[userOpenid] = { ...item.complaints[userOpenid], withdrawn_at: nowIso() }
    delete item.complaints[userOpenid]
    await this.saveGroup(item)
    return { withdrawn: true, item }
  }

  _complaintBlackKey (selfId = '', groupOpenid = '') {
    return `${selfId}:${groupOpenid}`
  }

  isComplaintBlacklisted (selfId = '', groupOpenid = '') {
    return Boolean(this._data.complaintBlacklist[this._complaintBlackKey(selfId, groupOpenid)])
  }

  async setComplaintBlacklisted (selfId = '', groupOpenid = '', enabled = true, operator = '') {
    if (!selfId || !groupOpenid) return false
    const key = this._complaintBlackKey(selfId, groupOpenid)
    if (enabled) {
      const item = { self_id: selfId, group_openid: groupOpenid, operator, time: nowIso() }
      this._data.complaintBlacklist[key] = item
      await this._save(`complaintBlack:${key}`, item)
    } else {
      delete this._data.complaintBlacklist[key]
      if (this.type === 'level' && this._db) {
        try { await this._db.db.del(`complaintBlack:${key}`) } catch {}
      } else this._scheduleSave()
    }
    return true
  }

  listComplaintBlacklist (selfId = '', page = 1, size = 10) {
    const list = Object.values(this._data.complaintBlacklist)
      .filter(item => item.self_id === selfId)
      .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
    const total = list.length
    const pageCount = Math.max(1, Math.ceil(total / size))
    const current = Math.min(pageCount, Math.max(1, Number(page) || 1))
    return { list: list.slice((current - 1) * size, current * size), total, page: current, pageCount }
  }

  getSummary (selfId = '') {
    const groups = this.getGroups(selfId)
    const recordTotal = groups.length
    const disabledTotal = groups.filter(item => item.disabled).length
    const complaintGroups = groups.filter(item => Object.keys(item.complaints || {}).length || Object.keys(item.withdrawn_complaints || {}).length).length
    return {
      recordTotal,
      disabledTotal,
      enabledCandidates: Math.max(0, recordTotal - disabledTotal),
      closeRate: recordTotal ? disabledTotal / recordTotal : 0,
      sentTotal: groups.reduce((sum, item) => sum + (Number(item.sent_count) || 0), 0),
      joinTotal: groups.reduce((sum, item) => sum + (Number(item.join_count) || 0), 0),
      leaveTotal: groups.reduce((sum, item) => sum + (Number(item.leave_count) || 0), 0),
      complaintGroups
    }
  }

  async recordMessageIndex (record = {}) {
    if (!record.message_id) return false
    this._maybeCleanup()
    const storedItem = await this._readIndexItem('messageIds', record.message_id)
    const oldItem = storedItem && !this._isMessageIndexExpired(storedItem) ? storedItem : null
    const sameContext = oldItem?.self_id === record.self_id && oldItem?.target_id === record.target_id && oldItem?.type === record.type
    const item = {
      ...record,
      local_bot: record.local_bot === true || (sameContext && oldItem.local_bot === true),
      time: record.time || nowIso(),
      expire_at: Date.now() + MESSAGE_INDEX_TTL_MS
    }
    const puts = []
    const put = (key, value) => puts.push({ key: `msg:${key}`, value })
    this._setIndexItem('messageIds', record.message_id, item)
    put(record.message_id, item)
    for (const alias of new Set(Array.isArray(record.aliases) ? record.aliases : [])) {
      if (!alias || alias === record.message_id) continue
      const aliasItem = { ...item, message_id: alias, actual_message_id: record.message_id }
      this._setIndexItem('messageIds', alias, aliasItem)
      put(alias, aliasItem)
      if (record.self_id && record.target_id && record.type) {
        const scopedAlias = this._messageAliasKey(record.self_id, record.type, record.target_id, alias)
        const storedScoped = await this._readIndexItem('messageIds', scopedAlias)
        const oldScoped = storedScoped && !this._isMessageIndexExpired(storedScoped) ? storedScoped : null
        const oldActualId = oldScoped?.actual_message_id || oldScoped?.message_id || ''
        const actualMessageIds = [...new Set([...(oldScoped?.actual_message_ids || [oldActualId]), record.message_id].filter(Boolean))].slice(-ACTUAL_MESSAGE_IDS_MAX)
        const scopedItem = {
          ...aliasItem,
          ambiguous: actualMessageIds.length > 1,
          actual_message_ids: actualMessageIds
        }
        this._setIndexItem('messageIds', scopedAlias, scopedItem)
        put(scopedAlias, scopedItem)
      }
    }
    await this._persistIndexBatch(puts, this._pruneIndexStore('messageIds', MESSAGE_INDEX_MAX_PER_BOT, record.self_id))
    return true
  }

  _messageAliasKey (selfId = '', type = '', targetId = '', alias = '') {
    return `alias:${selfId}:${type}:${targetId}:${alias}`
  }

  _localMessageKey (selfId = '', type = '', targetId = '', alias = '') {
    return `${selfId}:${type}:${targetId}:${alias}`
  }

  async recordLocalMessageResponse (record = {}) {
    if (!record.message_id || !record.self_id || !record.type || !record.target_id) return false
    this._maybeCleanup()
    const aliases = [...new Set([record.message_id, ...(record.aliases || [])].filter(Boolean).map(String))]
    const puts = []
    for (const alias of aliases) {
      const key = this._localMessageKey(record.self_id, record.type, record.target_id, alias)
      const stored = await this._readIndexItem('localMessageIds', key)
      const old = stored && !this._isMessageIndexExpired(stored) ? stored : null
      const actualMessageIds = [...new Set([
        ...(old?.actual_message_ids || []),
        old?.actual_message_id,
        record.message_id
      ].filter(Boolean).map(String))].slice(-ACTUAL_MESSAGE_IDS_MAX)
      const item = {
        ...record,
        alias,
        actual_message_id: record.message_id,
        actual_message_ids: actualMessageIds,
        local_bot: true,
        time: record.time || nowIso(),
        expire_at: Date.now() + MESSAGE_INDEX_TTL_MS
      }
      this._setIndexItem('localMessageIds', key, item)
      puts.push({ key: `localmsg:${key}`, value: item })
    }
    await this._persistIndexBatch(puts, this._pruneIndexStore('localMessageIds', LOCAL_MESSAGE_INDEX_MAX_PER_BOT, record.self_id))
    return true
  }

  async getLocalMessageResponse (messageId = '', context = {}) {
    if (!messageId || !context.selfId || !context.type || !context.targetId) return null
    this._maybeCleanup()
    const key = this._localMessageKey(context.selfId, context.type, context.targetId, messageId)
    const item = await this._readIndexItem('localMessageIds', key)
    if (item && this._isMessageIndexExpired(item)) {
      this._deleteIndexItem('localMessageIds', key)
      this._queueDeletes([`localmsg:${key}`])
      return null
    }
    return item
  }

  async getMessageIndex (messageId = '', context = {}) {
    if (!messageId) return null
    this._maybeCleanup()
    if (context.selfId && context.type && context.targetId) {
      const scopedKey = this._messageAliasKey(context.selfId, context.type, context.targetId, messageId)
      const scoped = await this._readIndexItem('messageIds', scopedKey)
      if (scoped && this._isMessageIndexExpired(scoped)) {
        this._deleteIndexItem('messageIds', scopedKey)
        this._queueDeletes([`msg:${scopedKey}`])
      } else if (scoped) return scoped.ambiguous ? null : scoped
    }
    const item = await this._readIndexItem('messageIds', messageId)
    if (!item) return null
    if (this._isMessageIndexExpired(item)) {
      this._deleteIndexItem('messageIds', messageId)
      this._queueDeletes([`msg:${messageId}`])
      return null
    }
    if (context.selfId && item.self_id !== context.selfId) return null
    if (context.type && item.type !== context.type) return null
    if (context.targetId && item.target_id !== context.targetId) return null
    return item
  }

  async findRecallCandidatesByContent (selfId = '', targetId = '', content = '', options = {}) {
    this._maybeCleanup()
    const text = String(content || '').replace(/\s+/g, ' ').trim()
    if (!selfId || !targetId || !text) return { items: [], total: 0, truncated: false }
    const beforeTime = Number(options.beforeTime) || Date.now()
    const beforeSeq = Number(options.beforeSeq) || 0
    const limitMs = Math.max(1, Number(options.limitMs) || 10 * 60 * 1000)
    const limit = Math.max(1, Number(options.limit) || 20)
    const excludedIds = new Set((options.excludeMessageIds || []).filter(Boolean).map(String))
    let total = 0
    const candidates = []
    await this._forEachMessageIndex(async item => {
        if (!item || item.actual_message_id || item.self_id !== selfId || item.target_id !== targetId || item.type !== 'group') return
        if (excludedIds.has(String(item.message_id || ''))) return
        if (!/^ROBOT\d+\.\d+_/i.test(String(item.message_id || ''))) return
        const localBot = item.local_bot === true
        if (!localBot && (item.bot === true || item.member_role !== 'member')) return
        if (String(item.content_fingerprint || '').replace(/\s+/g, ' ').trim() !== text) return
        const itemTime = Date.parse(item.time || '') || Number(item.time) || 0
        if (!(itemTime > 0 && itemTime <= beforeTime && beforeTime - itemTime <= limitMs)) return
        const itemSeq = Number(item.seq) || 0
        if (beforeSeq && itemSeq && itemSeq >= beforeSeq) return
        total++
        candidates.push(item)
        if (candidates.length > limit) {
          candidates.sort((a, b) => (Date.parse(b.time || '') || Number(b.time) || 0) - (Date.parse(a.time || '') || Number(a.time) || 0))
          candidates.pop()
        }
      })
    candidates.sort((a, b) => (Date.parse(b.time || '') || Number(b.time) || 0) - (Date.parse(a.time || '') || Number(a.time) || 0))
    return {
      items: candidates,
      total,
      truncated: total > limit
    }
  }

  async findRecentMessageByContent (selfId = '', targetId = '', content = '', options = {}) {
    this._maybeCleanup()
    const text = String(content || '').trim()
    if (!selfId || !targetId || !text) return null
    const limitMs = Number(options.limitMs) || 10 * 60 * 1000
    const authorBot = options.bot
    const now = Date.now()
    let latest = null
    let latestTime = -Infinity
    await this._forEachMessageIndex(async item => {
        if (!item || item.actual_message_id) return
        if (item.self_id !== selfId || item.target_id !== targetId || item.type !== 'group') return
        if (item.content_fingerprint !== text) return
        if (authorBot !== undefined && item.bot !== authorBot) return
        const time = Date.parse(item.time || '')
        if (!Number.isFinite(time) || now - time <= limitMs) {
          const comparableTime = Number.isFinite(time) ? time : 0
          if (!latest || comparableTime >= latestTime) {
            latest = item
            latestTime = comparableTime
          }
        }
      })
    return latest
  }

  async close () {
    this._ready = false
    if (this._levelIndexCleanupTimer) {
      clearTimeout(this._levelIndexCleanupTimer)
      this._levelIndexCleanupTimer = null
    }
    await this._levelIndexCleanupPromise?.catch?.(() => {})
    if (this._levelIndexCleanupTimer) {
      clearTimeout(this._levelIndexCleanupTimer)
      this._levelIndexCleanupTimer = null
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this._groupSaveTimer) {
      clearTimeout(this._groupSaveTimer)
      this._groupSaveTimer = null
    }
    await this._flushGroupSaves().catch(() => {})
    if (this._indexWriteTimer) {
      clearTimeout(this._indexWriteTimer)
      this._indexWriteTimer = null
    }
    await this._flushIndexWrites().catch(() => {})
    await this._groupSavePromise?.catch?.(() => {})
    await this._indexWritePromise?.catch?.(() => {})
    if (this.type === 'json') {
      this._scheduleSave()
      await this._writeQueue.catch(() => {})
    }
    if (this._db) {
      try { await this._db.close() } catch {}
      this._db = null
    }
  }
}

const store = new AdvancedWelcomeStore()
export default store
