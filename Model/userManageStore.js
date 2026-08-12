import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const LEVEL_DATA_DIR = join(pluginPath, 'db', 'userManage')
const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotUserManage')
const HISTORY_LIMIT = 500
const HISTORY_CACHE_LIMIT = 20
const RECENT_GROUP_LIMIT = 10000
const RECENT_GROUP_WINDOW_PAGES = 500
const RECENT_GROUP_MAX_PAGES = 5000
const RECENT_GROUP_SNAPSHOT_TTL = 2 * 60 * 1000
const RAW_TEXT_LIMIT = 4000
const RAW_SNAPSHOT_LIMIT = 12000
const USER_CACHE_LIMIT = 10000
const GROUP_CACHE_LIMIT = 5000
const INDEX_VERSION = 2
const INDEX_VERSION_KEY = 'meta:recentIndexVersion'

function nowIso () { return new Date().toISOString() }
function safeText (value = '', max = 200) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '')
  return max > 0 ? text.slice(0, max) : text
}
function safeClone (value) {
  if (!value || typeof value !== 'object') return null
  const source = {}
  const keys = [
    'id', 'event_id', 'message_id', 'group_id', 'group_openid', 'user_id',
    'timestamp', 'time', 'raw_message', 'content', 'author', 'sender',
    'mentions', '_mentions', 'message', 'msg_elements', 'message_scene',
    'reply_id', 'ref_msg_idx', '_qqbotRawEvent', '_qqbotFullMessageCreate', '_rawTimestamp'
  ]
  for (const key of keys) {
    if (typeof value[key] !== 'undefined') source[key] = value[key]
  }
  try {
    const text = JSON.stringify(source, (key, val) => {
      if (key === 'bot' || key === 'sdk' || key === 'adapter' || key === 'raw' || key === '_qqbotOriginalEvent') return undefined
      if (typeof val === 'bigint') return String(val)
      if (typeof val === 'function') return undefined
      if (typeof val === 'string' && val.length > RAW_TEXT_LIMIT) return val.slice(0, RAW_TEXT_LIMIT)
      return val
    })
    if (text.length <= RAW_SNAPSHOT_LIMIT) return JSON.parse(text)
    const author = source.author || {}
    const sender = source.sender || {}
    return {
      id: source.id || '',
      event_id: source.event_id || '',
      message_id: source.message_id || '',
      group_id: source.group_id || '',
      group_openid: source.group_openid || '',
      author: { id: author.id || author.member_openid || '', username: safeText(author.username || '', 80), bot: author.bot === true, member_role: author.member_role || '' },
      sender: { user_id: sender.user_id || '', nickname: safeText(sender.nickname || sender.user_name || '', 80) },
      raw_message: safeText(source.raw_message || source.content || '', RAW_TEXT_LIMIT),
      timestamp: source.timestamp || source.time || source._rawTimestamp || ''
    }
  } catch {
    return null
  }
}
function pageSlice (list = [], page = 1, size = 10) {
  size = Math.min(100, Math.max(1, Number.isFinite(Number(size)) ? Math.floor(Number(size)) : 10))
  const total = list.length
  const pageCount = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, Number(page) || 1), pageCount)
  return { list: list.slice((current - 1) * size, current * size), page: current, pageCount, total }
}

class UserManageStore {
  constructor () {
    this.type = 'level'
    this._db = null
    this._ready = false
    this._data = this._empty()
    this._saveTimer = null
    this._historyCache = new Map()
    this._recentGroupIndexes = new Map()
    this._recentUserIndexes = new Map()
    this._jsonHistories = {}
    this._historyKeys = new Set()
    this._historyWriteQueues = new Map()
    this._entityCaches = { user: new Map(), group: new Map() }
    this._entityWriteQueues = new Map()
    this._jsonWriteQueue = Promise.resolve()
    this._writeSeq = 0
    this._recentSnapshots = new Map()
  }

  _empty () {
    return {
      users: {},
      groups: {},
      blacklistUsers: {},
      blacklistGroups: {},
      cancellations: {},
      pendingCancels: {},
      fullBindings: {},
      fullGroupEvents: {},
      historySeqs: {}
    }
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'userManage.json') }
  _key (selfId, id) { return `${selfId}:${id}` }
  _historyKey (selfId, targetOpenid, type = 'group') { return type === 'user' ? `user:${selfId}:${targetOpenid}` : `${selfId}:${targetOpenid}` }

  async init () {
    if (this._ready) return
    this._data = this._empty()
    this._historyCache.clear()
    this._recentGroupIndexes.clear()
    this._recentUserIndexes.clear()
    this._recentSnapshots.clear()
    this._jsonHistories = {}
    this._historyKeys.clear()
    this._historyWriteQueues.clear()
    this._entityCaches.user.clear()
    this._entityCaches.group.clear()
    this._entityWriteQueues.clear()
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open({ cleanup: false })
      const legacyRecent = new Map()
      const legacyUserRecent = new Map()
      for await (const [key, value] of this._db.db.iterator({ gte: 'recentGroup:', lt: 'recentGroup:\uffff' })) {
        this._addRecentGroupIndex(value, String(key))
      }
      for await (const [key, value] of this._db.db.iterator({ gte: 'recentUser:', lt: 'recentUser:\uffff' })) {
        this._addRecentUserIndex(value, String(key))
      }
      for (const prefix of ['blackUser:', 'blackGroup:', 'cancel:', 'pendingCancel:', 'fullBinding:', 'fullGroupEvent:']) {
        for await (const [key, value] of this._db.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) this._setByKey(String(key), value)
      }
      const indexVersion = Number(await this._db.get(INDEX_VERSION_KEY)) || 0
      if (indexVersion < INDEX_VERSION) {
        for await (const [key, value] of this._db.db.iterator({ gte: 'history:', lt: 'history:\uffff' })) {
          const historyKey = String(key).slice(8)
          this._historyKeys.add(historyKey)
          if (historyKey.startsWith('user:')) this._collectLegacyUserRecent(legacyUserRecent, historyKey, value)
          else this._collectLegacyRecent(legacyRecent, historyKey, value)
        }
        for await (const [key, value] of this._db.db.iterator({ gte: 'historyItem:', lt: 'historyItem:\uffff' })) {
          const itemKey = String(key).slice(12)
          const split = itemKey.lastIndexOf(':')
          if (split <= 0) continue
          const historyKey = itemKey.slice(0, split)
          this._historyKeys.add(historyKey)
          if (historyKey.startsWith('user:')) this._collectLegacyUserRecentItem(legacyUserRecent, historyKey, value)
          else this._collectLegacyRecentItem(legacyRecent, historyKey, value)
        }
      }
      for (const [selfId, items] of legacyRecent) {
        if ((this._recentGroupIndexes.get(selfId) || []).length) continue
        const recent = items.sort((a, b) => a.time_ms - b.time_ms || a.seq - b.seq).slice(-RECENT_GROUP_LIMIT)
          .map(item => ({ ...item, key: this._recentIndexKey(item) }))
        this._recentGroupIndexes.set(selfId, recent)
        if (recent.length) await this._db.db.batch(recent.map(item => ({ type: 'put', key: item.key, value: item })))
      }
      for (const [selfId, items] of legacyUserRecent) {
        if ((this._recentUserIndexes.get(selfId) || []).length) continue
        const recent = items.sort((a, b) => a.time_ms - b.time_ms || a.seq - b.seq).slice(-RECENT_GROUP_LIMIT)
          .map(item => ({ ...item, key: this._recentUserIndexKey(item) }))
        this._recentUserIndexes.set(selfId, recent)
        if (recent.length) await this._db.db.batch(recent.map(item => ({ type: 'put', key: item.key, value: item })))
      }
      if (indexVersion < INDEX_VERSION) await this._db.set(INDEX_VERSION_KEY, INDEX_VERSION, 0)
    } catch (err) {
      logger.error('[QQBot-Plugin] userManageStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { this._db.close() } catch {}; this._db = null }
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        const stored = { ...this._empty(), ...JSON.parse(fs.readFileSync(this._jsonPath(), 'utf-8')) }
        for (const [key, list] of Object.entries(stored.histories || {})) {
          this._historyKeys.add(key)
          this._jsonHistories[key] = Array.isArray(list) ? list : []
          this._setHistoryCache(key, Array.isArray(list) ? list : [])
          if (key.startsWith('user:')) this._collectLegacyUserRecent(this._recentUserIndexes, key, list, true)
          else this._collectLegacyRecent(this._recentGroupIndexes, key, list, true)
        }
        delete stored.histories
        this._data = stored
      } catch { this._data = this._empty() }
    }
    this._ready = true
  }

  _setByKey (key, value) {
    key = String(key)
    if (key.startsWith('user:')) this._data.users[key.slice(5)] = value
    else if (key.startsWith('group:')) this._data.groups[key.slice(6)] = value
    else if (key.startsWith('blackUser:')) this._data.blacklistUsers[key.slice(10)] = value
    else if (key.startsWith('blackGroup:')) this._data.blacklistGroups[key.slice(11)] = value
    else if (key.startsWith('cancel:')) this._data.cancellations[key.slice(7)] = value
    else if (key.startsWith('pendingCancel:')) this._data.pendingCancels[key.slice(14)] = value
    else if (key.startsWith('fullBinding:')) this._data.fullBindings[key.slice(12)] = value
    else if (key.startsWith('fullGroupEvent:')) this._data.fullGroupEvents[key.slice(15)] = value
    else if (key.startsWith('historySeq:')) this._data.historySeqs[key.slice(11)] = Number(value) || 0
  }

  _cacheEntity (type, key, value) {
    const cache = this._entityCaches[type]
    cache.delete(key)
    cache.set(key, value)
    const limit = type === 'user' ? USER_CACHE_LIMIT : GROUP_CACHE_LIMIT
    while (cache.size > limit) cache.delete(cache.keys().next().value)
    return value
  }

  async _getEntity (type, key) {
    const cache = this._entityCaches[type]
    if (cache.has(key)) return this._cacheEntity(type, key, cache.get(key))
    let value
    if (this.type === 'level' && this._db) value = await this._db.get(`${type}:${key}`)
    else value = this._data[type === 'user' ? 'users' : 'groups'][key]
    return value ? this._cacheEntity(type, key, value) : null
  }

  async _pageLevelPrefix (prefix, page = 1, size = 10, filter = null) {
    const requested = Math.max(1, Number(page) || 1)
    const pageSize = Math.max(1, Number(size) || 10)
    const start = (requested - 1) * pageSize
    const list = []
    let total = 0
    for await (const [, value] of this._db.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
      if (filter && !filter(value)) continue
      if (total >= start && list.length < pageSize) list.push(value)
      total++
    }
    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    if (requested > pageCount && total) return this._pageLevelPrefix(prefix, pageCount, pageSize, filter)
    return { list, page: Math.min(requested, pageCount), pageCount, total }
  }

  _historyTimeMs (value) {
    const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value || '')) ? Number(value) : 0
    const parsed = numeric > 0 ? (numeric < 100000000000 ? numeric * 1000 : numeric) : Date.parse(value || '') || 0
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
  }

  _historyItemKey (historyKey, seq) {
    return `historyItem:${historyKey}:${String(Number(seq) || 0).padStart(12, '0')}`
  }

  _historyItemRange (historyKey) {
    const prefix = `historyItem:${historyKey}:`
    return { prefix, gte: prefix, lt: `${prefix}\uffff` }
  }

  _recentIndexKey (item) {
    return `recentGroup:${item.self_id}:${String(item.time_ms).padStart(13, '0')}:${item.group_openid}:${String(item.seq).padStart(12, '0')}`
  }

  _recentUserIndexKey (item) {
    return `recentUser:${item.self_id}:${String(item.time_ms).padStart(13, '0')}:${item.user_openid}:${String(item.seq).padStart(12, '0')}`
  }

  _collectLegacyRecent (target, historyKey, list, direct = false) {
    if (historyKey.startsWith('user:') || !Array.isArray(list)) return
    const split = historyKey.indexOf(':')
    if (split <= 0) return
    const selfId = historyKey.slice(0, split)
    const groupOpenid = historyKey.slice(split + 1)
    const items = list.slice(-HISTORY_LIMIT).map(item => ({
      self_id: selfId,
      group_openid: groupOpenid,
      seq: Number(item?.seq) || 0,
      time_ms: this._historyTimeMs(item?.time)
    })).filter(item => item.seq)
    if (direct) {
      for (const item of items) this._addRecentGroupIndex(item)
      return
    }
    const current = [...(target.get(selfId) || []), ...items]
      .sort((a, b) => a.time_ms - b.time_ms || a.seq - b.seq)
      .slice(-RECENT_GROUP_LIMIT)
    target.set(selfId, current)
  }

  _collectLegacyRecentItem (target, historyKey, item) {
    const split = historyKey.indexOf(':')
    if (split <= 0 || !item?.seq) return
    const selfId = historyKey.slice(0, split)
    const list = target.get(selfId) || []
    this._insertRecentGroupIndex(list, {
      self_id: selfId,
      group_openid: historyKey.slice(split + 1),
      seq: Number(item.seq) || 0,
      time_ms: this._historyTimeMs(item.time)
    })
    target.set(selfId, list)
  }

  _collectLegacyUserRecent (target, historyKey, list, direct = false) {
    if (!historyKey.startsWith('user:') || !Array.isArray(list)) return
    const parts = historyKey.split(':')
    const selfId = parts[1] || ''
    const userOpenid = parts.slice(2).join(':')
    if (!selfId || !userOpenid) return
    const items = list.slice(-HISTORY_LIMIT).map(item => ({
      self_id: selfId,
      user_openid: userOpenid,
      seq: Number(item?.seq) || 0,
      time_ms: this._historyTimeMs(item?.time)
    })).filter(item => item.seq)
    if (direct) {
      for (const item of items) this._addRecentUserIndex(item)
      return
    }
    const current = [...(target.get(selfId) || []), ...items]
      .sort((a, b) => a.time_ms - b.time_ms || a.seq - b.seq)
      .slice(-RECENT_GROUP_LIMIT)
    target.set(selfId, current)
  }

  _collectLegacyUserRecentItem (target, historyKey, item) {
    if (!historyKey.startsWith('user:') || !item?.seq) return
    const parts = historyKey.split(':')
    const selfId = parts[1] || ''
    const userOpenid = parts.slice(2).join(':')
    if (!selfId || !userOpenid) return
    const list = target.get(selfId) || []
    this._insertRecentGroupIndex(list, {
      self_id: selfId,
      user_openid: userOpenid,
      seq: Number(item.seq) || 0,
      time_ms: this._historyTimeMs(item.time)
    })
    target.set(selfId, list)
  }

  _insertRecentGroupIndex (list, item) {
    const last = list.at(-1)
    if (!last || last.time_ms < item.time_ms || (last.time_ms === item.time_ms && last.seq <= item.seq)) {
      list.push(item)
    } else {
      let low = 0
      let high = list.length
      while (low < high) {
        const mid = (low + high) >> 1
        const current = list[mid]
        if (current.time_ms < item.time_ms || (current.time_ms === item.time_ms && current.seq <= item.seq)) low = mid + 1
        else high = mid
      }
      list.splice(low, 0, item)
    }
    return list.length > RECENT_GROUP_LIMIT ? list.shift() : null
  }

  _addRecentGroupIndex (item, key = '') {
    if (!item?.self_id || !item?.group_openid || !item?.seq) return
    const normalized = {
      self_id: String(item.self_id),
      group_openid: String(item.group_openid),
      seq: Number(item.seq) || 0,
      time_ms: this._historyTimeMs(item.time_ms || item.time),
      key: key || item.key || ''
    }
    const list = this._recentGroupIndexes.get(normalized.self_id) || []
    this._insertRecentGroupIndex(list, normalized)
    this._recentGroupIndexes.set(normalized.self_id, list)
  }

  _addRecentUserIndex (item, key = '') {
    if (!item?.self_id || !item?.user_openid || !item?.seq) return
    const normalized = {
      self_id: String(item.self_id),
      user_openid: String(item.user_openid),
      seq: Number(item.seq) || 0,
      time_ms: this._historyTimeMs(item.time_ms || item.time),
      key: key || item.key || ''
    }
    const list = this._recentUserIndexes.get(normalized.self_id) || []
    this._insertRecentGroupIndex(list, normalized)
    this._recentUserIndexes.set(normalized.self_id, list)
  }

  async _saveRecentGroupIndex (item) {
    const normalized = { ...item, key: this._recentIndexKey(item) }
    const list = this._recentGroupIndexes.get(item.self_id) || []
    const removed = this._insertRecentGroupIndex(list, normalized)
    this._recentGroupIndexes.set(item.self_id, list)
    if (this.type === 'level' && this._db) {
      await this._db.set(normalized.key, normalized, 0)
      if (removed?.key) { try { await this._db.db.del(removed.key) } catch {} }
    }
  }

  async _saveRecentUserIndex (item) {
    const normalized = { ...item, key: this._recentUserIndexKey(item) }
    const list = this._recentUserIndexes.get(item.self_id) || []
    const removed = this._insertRecentGroupIndex(list, normalized)
    this._recentUserIndexes.set(item.self_id, list)
    if (this.type === 'level' && this._db) {
      await this._db.set(normalized.key, normalized, 0)
      if (removed?.key) { try { await this._db.db.del(removed.key) } catch {} }
    }
  }

  async _removeRecentGroupIndexes (selfId = '', groupOpenid = '', keepSeqs = null) {
    const id = String(selfId)
    const list = this._recentGroupIndexes.get(id) || []
    const keep = []
    const removed = []
    for (const item of list) {
      const remove = (!groupOpenid || item.group_openid === groupOpenid) && (!keepSeqs || !keepSeqs.has(Number(item.seq) || 0))
      if (remove) removed.push(item)
      else keep.push(item)
    }
    this._recentGroupIndexes.set(id, keep)
    if (this.type === 'level' && this._db) {
      for (const item of removed) {
        if (item.key) { try { await this._db.db.del(item.key) } catch {} }
      }
    }
  }

  async _removeRecentGroupSeqs (selfId = '', groupOpenid = '', seqs = []) {
    const targets = new Set(seqs.map(Number).filter(Boolean))
    if (!targets.size) return
    const id = String(selfId)
    const list = this._recentGroupIndexes.get(id) || []
    const removed = list.filter(item => item.group_openid === groupOpenid && targets.has(Number(item.seq) || 0))
    if (!removed.length) return
    this._recentGroupIndexes.set(id, list.filter(item => !removed.includes(item)))
    if (this.type === 'level' && this._db) {
      await this._db.db.batch(removed.filter(item => item.key).map(item => ({ type: 'del', key: item.key })))
    }
  }

  async _removeRecentUserSeqs (selfId = '', userOpenid = '', seqs = []) {
    const targets = new Set(seqs.map(Number).filter(Boolean))
    if (!targets.size) return
    const id = String(selfId)
    const list = this._recentUserIndexes.get(id) || []
    const removed = list.filter(item => item.user_openid === userOpenid && targets.has(Number(item.seq) || 0))
    if (!removed.length) return
    this._recentUserIndexes.set(id, list.filter(item => !removed.includes(item)))
    if (this.type === 'level' && this._db) {
      await this._db.db.batch(removed.filter(item => item.key).map(item => ({ type: 'del', key: item.key })))
    }
  }

  async _removeRecentUserIndexes (selfId = '', userOpenid = '', keepSeqs = null) {
    const id = String(selfId)
    const list = this._recentUserIndexes.get(id) || []
    const keep = []
    const removed = []
    for (const item of list) {
      const remove = item.user_openid === userOpenid && (!keepSeqs || !keepSeqs.has(Number(item.seq) || 0))
      if (remove) removed.push(item)
      else keep.push(item)
    }
    this._recentUserIndexes.set(id, keep)
    if (this.type === 'level' && this._db && removed.length) {
      await this._db.db.batch(removed.filter(item => item.key).map(item => ({ type: 'del', key: item.key })))
    }
  }

  _setHistoryCache (key, list) {
    this._historyCache.delete(key)
    this._historyCache.set(key, list)
    if (this.type === 'level') {
      while (this._historyCache.size > HISTORY_CACHE_LIMIT) this._historyCache.delete(this._historyCache.keys().next().value)
    }
    return list
  }

  _getCachedHistory (key) {
    const list = this._historyCache.get(key)
    if (!list) return []
    this._setHistoryCache(key, list)
    return list
  }

  async _loadHistory (key) {
    if (this._historyCache.has(key)) return this._getCachedHistory(key)
    let list = []
    if (this.type === 'level' && this._db) {
      const range = this._historyItemRange(key)
      for await (const [, item] of this._db.db.iterator({ gte: range.gte, lt: range.lt, reverse: true, limit: HISTORY_LIMIT })) list.push(item)
      list.reverse()
      if (!list.length) {
        const legacy = await this._db.get(`history:${key}`) || []
        if (Array.isArray(legacy) && legacy.length) {
          list = legacy.slice(-HISTORY_LIMIT).map(item => ({
            ...item,
            aliases: Array.isArray(item.aliases) ? item.aliases.slice(0, 20) : [],
            raw_message: safeText(item.raw_message || '', RAW_TEXT_LIMIT),
            raw: safeClone(item.raw)
          }))
          await this._db.db.batch([
            ...list.map(item => ({ type: 'put', key: this._historyItemKey(key, item.seq), value: item })),
            { type: 'del', key: `history:${key}` }
          ])
        }
      }
    } else list = this._jsonHistories[key] || []
    return this._setHistoryCache(key, Array.isArray(list) ? list : [])
  }

  async _saveHistoryEntry (key, item, removed = []) {
    if (this.type === 'level' && this._db) {
      await this._db.db.batch([
        { type: 'put', key: this._historyItemKey(key, item.seq), value: item },
        ...removed.filter(Boolean).map(old => ({ type: 'del', key: this._historyItemKey(key, old.seq) }))
      ])
    } else {
      this._jsonHistories[key] = this._getCachedHistory(key)
      this._scheduleSave()
    }
  }

  async _deleteHistoryEntries (key, items = []) {
    if (!items.length) return
    if (this.type === 'level' && this._db) {
      await this._db.db.batch(items.map(item => ({ type: 'del', key: this._historyItemKey(key, item.seq) })))
    } else {
      this._jsonHistories[key] = this._getCachedHistory(key)
      this._scheduleSave()
    }
  }

  _scheduleSave () {
    if (this.type === 'level' && this._db) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      const snapshot = JSON.stringify({ ...this._data, histories: this._jsonHistories }, null, 2)
      this._jsonWriteQueue = this._jsonWriteQueue.catch(() => {}).then(async () => {
        const file = this._jsonPath()
        const tmp = `${file}.${process.pid}.${Date.now()}.${++this._writeSeq}.tmp`
        try {
          await fs.promises.writeFile(tmp, snapshot, 'utf-8')
          await fs.promises.rename(tmp, file)
        } catch (err) {
          try { await fs.promises.unlink(tmp) } catch {}
          logger.error('[QQBot-Plugin] userManageStore JSON save error:', err.message)
        }
      })
    }, 1000)
  }

  async _save (prefix, key, value) {
    if (this.type === 'level' && this._db) await this._db.set(`${prefix}:${key}`, value, 0)
    else this._scheduleSave()
  }

  async _del (prefix, key) {
    if (this.type === 'level' && this._db) { try { await this._db.db.del(`${prefix}:${key}`) } catch {} } else this._scheduleSave()
  }

  _queueEntityWrite (type, key, write) {
    const queueKey = `${type}:${key}`
    const previous = this._entityWriteQueues.get(queueKey) || Promise.resolve()
    const pending = previous.catch(() => {}).then(write)
    this._entityWriteQueues.set(queueKey, pending)
    pending.finally(() => {
      if (this._entityWriteQueues.get(queueKey) === pending) this._entityWriteQueues.delete(queueKey)
    }).catch(() => {})
    return pending
  }

  recordUser (selfId = '', userOpenid = '', info = {}) {
    if (!selfId || !userOpenid || String(userOpenid).startsWith('qg_')) return null
    const key = this._key(selfId, userOpenid)
    return this._queueEntityWrite('user', key, () => this._recordUser(selfId, userOpenid, info, key))
  }

  async _recordUser (selfId, userOpenid, info, key) {
    const old = await this._getEntity('user', key) || {}
    const item = {
      ...old,
      self_id: selfId,
      openid: userOpenid,
      nickname: safeText(info.nickname || old.nickname || ''),
      groups: { ...(old.groups || {}) },
      first_seen_at: old.first_seen_at || nowIso(),
      last_seen_at: nowIso()
    }
    if (info.group_openid) item.groups[info.group_openid] = { group_openid: info.group_openid, nickname: item.nickname, last_seen_at: nowIso() }
    if (this.type === 'level') this._cacheEntity('user', key, item)
    else this._data.users[key] = item
    await this._save('user', key, item)
    return item
  }

  recordGroup (selfId = '', groupOpenid = '', info = {}) {
    if (!selfId || !groupOpenid || String(groupOpenid).startsWith('qg')) return null
    const key = this._key(selfId, groupOpenid)
    return this._queueEntityWrite('group', key, () => this._recordGroup(selfId, groupOpenid, info, key))
  }

  async _recordGroup (selfId, groupOpenid, info, key) {
    const old = await this._getEntity('group', key) || {}
    const item = { ...old, self_id: selfId, openid: groupOpenid, first_seen_at: old.first_seen_at || nowIso(), last_seen_at: nowIso() }
    if (info.name) item.name = safeText(info.name, 120)
    for (const field of ['group_finger_memo', 'group_class_text']) if (info[field]) item[field] = safeText(info[field], 500)
    if (Array.isArray(info.group_tags)) item.group_tags = info.group_tags.map(item => safeText(item, 80))
    if (Number(info.group_member_num) > 0) item.group_member_num = Number(info.group_member_num)
    if (this.type === 'level') this._cacheEntity('group', key, item)
    else this._data.groups[key] = item
    await this._save('group', key, item)
    return item
  }

  _queueHistoryWrite (key, write) {
    const previous = this._historyWriteQueues.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(write)
    this._historyWriteQueues.set(key, pending)
    pending.finally(() => {
      if (this._historyWriteQueues.get(key) === pending) this._historyWriteQueues.delete(key)
    }).catch(() => {})
    return pending
  }

  recordHistory (selfId = '', targetOpenid = '', msg = {}) {
    const key = this._historyKey(selfId, targetOpenid, msg.type || 'group')
    return this._queueHistoryWrite(key, () => this._recordHistory(selfId, targetOpenid, msg))
  }

  async _recordHistory (selfId = '', targetOpenid = '', msg = {}) {
    if (!selfId || !targetOpenid || String(targetOpenid).startsWith('qg')) return false
    const key = this._historyKey(selfId, targetOpenid, msg.type || 'group')
    const list = await this._loadHistory(key)
    if (typeof this._data.historySeqs[key] === 'undefined' && this.type === 'level' && this._db) {
      this._data.historySeqs[key] = Number(await this._db.get(`historySeq:${key}`)) || 0
    }
    const listSeq = list.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
    const lastSeq = Math.max(Number(this._data.historySeqs[key]) || 0, listSeq)
    const seq = Number(msg.seq) || lastSeq + 1
    const item = {
      seq,
      message_id: msg.message_id || '',
      aliases: Array.isArray(msg.aliases) ? [...new Set(msg.aliases.filter(Boolean).map(String))] : [],
      user_openid: msg.user_openid || '',
      nickname: safeText(msg.nickname || '', 80),
      bot: msg.bot === true,
      local_bot: msg.local_bot === true,
      raw_message: safeText(msg.raw_message || '', RAW_TEXT_LIMIT),
      raw: safeClone(msg.raw),
      time: msg.time || nowIso()
    }
    list.push(item)
    const expiredItems = []
    while (list.length > HISTORY_LIMIT) expiredItems.push(list.shift())
    this._historyKeys.add(key)
    this._setHistoryCache(key, list)
    this._data.historySeqs[key] = Math.max(lastSeq, seq)
    await this._save('historySeq', key, this._data.historySeqs[key])
    await this._saveHistoryEntry(key, item, expiredItems)
    if ((msg.type || 'group') === 'group') {
      await this._removeRecentGroupSeqs(selfId, targetOpenid, expiredItems.map(item => item.seq))
      await this._saveRecentGroupIndex({ self_id: String(selfId), group_openid: String(targetOpenid), seq, time_ms: this._historyTimeMs(msg.time) })
    } else {
      await this._removeRecentUserSeqs(selfId, targetOpenid, expiredItems.map(item => item.seq))
      await this._saveRecentUserIndex({ self_id: String(selfId), user_openid: String(targetOpenid), seq, time_ms: this._historyTimeMs(msg.time) })
    }
    return seq
  }

  async getHistory (selfId = '', targetOpenid = '', seq = 0, count = 20, type = 'group') {
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    const n = Math.max(0, Number(count) || 0)
    if (n <= 0) return []
    const targetSeq = Number(seq) || 0
    if (targetSeq <= 0) return []
    return list.filter(item => Number(item.seq) <= targetSeq).slice(-n).reverse()
  }

  async getRecentHistory (selfId = '', targetOpenid = '', count = 20, type = 'group') {
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    const n = Math.max(0, Number(count) || 0)
    if (n <= 0) return []
    return list.slice(-n).reverse()
  }

  async getRecentHistoryPage (selfId = '', targetOpenid = '', page = 1, size = 20, type = 'group') {
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    return pageSlice([...list].reverse(), page, size)
  }

  async listRecentGroupHistories (selfId = '', page = 1, size = 20) {
    const requested = Math.max(1, Number(page) || 1)
    const windowNo = Math.floor((requested - 1) / RECENT_GROUP_WINDOW_PAGES)
    if (requested > RECENT_GROUP_MAX_PAGES) return { list: [], page: requested, pageCount: requested, total: 0, historyLimit: true }
    const cacheKey = `${String(selfId)}:${windowNo}`
    let snapshot = this._recentSnapshots.get(cacheKey)
    if (!snapshot || snapshot.expires_at <= Date.now()) {
      snapshot = { list: await this._loadRecentGroupWindow(selfId, windowNo, size), created_at: Date.now(), expires_at: Date.now() + RECENT_GROUP_SNAPSHOT_TTL }
      this._recentSnapshots.set(cacheKey, snapshot)
    }
    const localPage = requested - windowNo * RECENT_GROUP_WINDOW_PAGES
    const list = snapshot.list.slice((localPage - 1) * size, localPage * size)
    const knownPages = windowNo * RECENT_GROUP_WINDOW_PAGES + Math.ceil(snapshot.list.length / size)
    const hasMore = snapshot.list.length === RECENT_GROUP_WINDOW_PAGES * size
    return { list, page: requested, pageCount: Math.max(requested, knownPages, hasMore && requested % RECENT_GROUP_WINDOW_PAGES === 0 ? requested + 1 : 0), total: windowNo * RECENT_GROUP_WINDOW_PAGES * size + snapshot.list.length, hasMore, snapshot_at: snapshot.created_at }
  }

  async _loadRecentGroupWindow (selfId, windowNo, size) {
    const source = new Map()
    for (const index of this._recentGroupIndexes.get(String(selfId)) || []) source.set(`${index.group_openid}:${index.seq}`, index)
    if (windowNo > 0 && this.type === 'level' && this._db) {
      for await (const [key, item] of this._db.db.iterator({ gte: `historyItem:${selfId}:`, lt: `historyItem:${selfId}:\uffff` })) {
        const suffix = String(key).slice(12)
        const split = suffix.lastIndexOf(':')
        if (split <= 0) continue
        const historyKey = suffix.slice(0, split)
        const groupOpenid = historyKey.slice(String(selfId).length + 1)
        const seq = Number(item?.seq) || Number(suffix.slice(split + 1)) || 0
        if (groupOpenid && seq) source.set(`${groupOpenid}:${seq}`, { self_id: String(selfId), group_openid: groupOpenid, seq, time_ms: this._historyTimeMs(item?.time), item })
        if (source.size >= RECENT_GROUP_MAX_PAGES * size) break
      }
    } else if (windowNo > 0) {
      for (const [historyKey, list] of Object.entries(this._jsonHistories)) {
        if (!historyKey.startsWith(`${String(selfId)}:`) || !Array.isArray(list)) continue
        const groupOpenid = historyKey.slice(String(selfId).length + 1)
        for (const item of list) source.set(`${groupOpenid}:${item.seq}`, { self_id: String(selfId), group_openid: groupOpenid, seq: Number(item.seq) || 0, time_ms: this._historyTimeMs(item.time), item })
      }
    }
    const start = windowNo * RECENT_GROUP_WINDOW_PAGES * size
    const ordered = [...source.values()].sort((a, b) => (b.time_ms || 0) - (a.time_ms || 0) || (b.seq || 0) - (a.seq || 0)).slice(start, start + RECENT_GROUP_WINDOW_PAGES * size)
    const rows = []
    for (const index of ordered) {
      const item = index.item || await this.findHistoryBySeq(selfId, index.group_openid, index.seq)
      if (item) rows.push({ ...item, group_openid: index.group_openid })
    }
    return rows
  }

  _invalidateRecentSnapshots (selfId = '') {
    const prefix = `${String(selfId)}:`
    for (const key of this._recentSnapshots.keys()) if (key.startsWith(prefix)) this._recentSnapshots.delete(key)
  }

  async listRecentUserHistories (selfId = '', page = 1, size = 20) {
    const indexes = [...(this._recentUserIndexes.get(String(selfId)) || [])].reverse()
    const indexPage = pageSlice(indexes, Math.min(500, Math.max(1, Number(page) || 1)), size)
    const rows = []
    for (const index of indexPage.list) {
      const item = await this.findHistoryBySeq(selfId, index.user_openid, index.seq, 'user')
      if (item) rows.push({ ...item, target_user_openid: index.user_openid })
    }
    return { ...indexPage, list: rows, pageCount: Math.min(500, indexPage.pageCount), total: Math.min(RECENT_GROUP_LIMIT, indexPage.total) }
  }

  deleteRecentHistory (selfId = '', targetOpenid = '', count = 20, type = 'group') {
    const key = this._historyKey(selfId, targetOpenid, type)
    return this._queueHistoryWrite(key, () => this._deleteRecentHistory(selfId, targetOpenid, count, type, key))
  }

  async _deleteRecentHistory (selfId, targetOpenid, count, type, key) {
    this._invalidateRecentSnapshots(selfId)
    const list = await this._loadHistory(key)
    if (!list.length) return 0
    const n = String(count) === '全部' ? list.length : Math.max(0, Number(count) || 0)
    if (n <= 0) return 0
    const maxSeq = list.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
    this._data.historySeqs[key] = Math.max(Number(this._data.historySeqs[key]) || 0, maxSeq)
    await this._save('historySeq', key, this._data.historySeqs[key])
    const deleted = Math.min(n, list.length)
    const removed = list.splice(Math.max(0, list.length - deleted), deleted)
    this._setHistoryCache(key, list)
    await this._deleteHistoryEntries(key, removed)
    if (type === 'group') await this._removeRecentGroupIndexes(selfId, targetOpenid, new Set(list.map(item => Number(item.seq) || 0)))
    else await this._removeRecentUserIndexes(selfId, targetOpenid, new Set(list.map(item => Number(item.seq) || 0)))
    return deleted
  }

  async clearGroupHistories (selfId = '') {
    this._invalidateRecentSnapshots(selfId)
    let messageCount = 0
    let groupCount = 0
    if (this.type === 'level' && this._db) {
      const prefix = `historySeq:${selfId}:`
      for await (const [key, value] of this._db.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
        const historyKey = String(key).slice(11)
        this._historyKeys.add(historyKey)
        this._data.historySeqs[historyKey] = Number(value?.__originalValue ?? value) || 0
      }
    }
    for (const key of this._historyKeys) {
      if (key.startsWith('user:')) continue
      if (!key.startsWith(`${selfId}:`)) continue
      const result = await this._queueHistoryWrite(key, async () => {
        const list = await this._loadHistory(key)
        if (!list.length) return 0
        const maxSeq = list.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
        this._data.historySeqs[key] = Math.max(Number(this._data.historySeqs[key]) || 0, maxSeq)
        await this._save('historySeq', key, this._data.historySeqs[key])
        const removed = [...list]
        this._setHistoryCache(key, [])
        await this._deleteHistoryEntries(key, removed)
        await this._removeRecentGroupIndexes(selfId, key.slice(String(selfId).length + 1), new Set())
        return removed.length
      })
      if (!result) continue
      messageCount += result
      groupCount++
    }
    return { messageCount, groupCount }
  }

  async findHistoryByMessageId (selfId = '', targetOpenid = '', messageId = '', type = 'group') {
    if (!messageId) return null
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    const id = String(messageId)
    return list.find(item => item.message_id === id || item.aliases?.includes?.(id)) || null
  }

  async findUniqueHistoryByMessageId (selfId = '', targetOpenid = '', messageId = '', type = 'group') {
    if (!messageId) return null
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    const id = String(messageId)
    const matches = list.filter(item => item.message_id === id || item.aliases?.includes?.(id))
    if (new Set(matches.map(item => item.message_id).filter(Boolean)).size !== 1) return null
    const latest = matches.at(-1)
    const localBot = matches.some(item => item.local_bot === true)
    return localBot ? { ...latest, local_bot: true, user_openid: selfId } : latest
  }

  async findHistoryByAnyId (selfId = '', targetOpenid = '', ids = [], type = 'group') {
    for (const id of ids.filter(Boolean).map(String)) {
      const item = await this.findHistoryByMessageId(selfId, targetOpenid, id, type)
      if (item) return item
    }
    return null
  }

  async findRecentHistoryByContent (selfId = '', targetOpenid = '', content = '', bot, type = 'group') {
    const text = safeText(String(content || '').replace(/\s+/g, ' ').trim(), 0)
    if (!text) return null
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (typeof bot === 'boolean' && item.bot !== bot) continue
      if (safeText(String(item.raw_message || '').replace(/\s+/g, ' ').trim(), 0) === text) return item
    }
    return null
  }

  async findHistoryBySeq (selfId = '', targetOpenid = '', seq = 0, type = 'group') {
    const targetSeq = Number(String(seq).replace(/^#/, '')) || 0
    if (!targetSeq) return null
    const list = await this._loadHistory(this._historyKey(selfId, targetOpenid, type))
    return list.find(item => Number(item.seq) === targetSeq) || null
  }

  async listUsers (selfId = '', page = 1, size = 10) {
    if (this.type === 'level' && this._db) return this._pageLevelPrefix(`user:${selfId}:`, page, size)
    return pageSlice(Object.values(this._data.users).filter(i => i.self_id === selfId), page, size)
  }

  async listGroups (selfId = '', page = 1, size = 10) {
    if (this.type === 'level' && this._db) return this._pageLevelPrefix(`group:${selfId}:`, page, size)
    return pageSlice(Object.values(this._data.groups).filter(i => i.self_id === selfId), page, size)
  }

  async searchUsers (selfId = '', keyword = '') {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return []
    if (this.type === 'level' && this._db) {
      const rows = []
      for await (const [, item] of this._db.db.iterator({ gte: `user:${selfId}:`, lt: `user:${selfId}:\uffff` })) {
        const haystack = [item.openid, item.nickname, ...Object.keys(item.groups || {})].filter(Boolean).join('\n').toLowerCase()
        if (haystack.includes(kw)) rows.push(item)
      }
      return rows
    }
    return Object.values(this._data.users).filter(i => {
      if (i.self_id !== selfId) return false
      const haystack = [i.openid, i.nickname, ...Object.keys(i.groups || {})].filter(Boolean).join('\n').toLowerCase()
      return haystack.includes(kw)
    })
  }
  async searchUsersPage (selfId = '', keyword = '', page = 1, size = 50) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return pageSlice([], page, size)
    if (this.type === 'level' && this._db) {
      return this._pageLevelPrefix(`user:${selfId}:`, page, size, item => {
        const haystack = [item.openid, item.nickname, ...Object.keys(item.groups || {})].filter(Boolean).join('\n').toLowerCase()
        return haystack.includes(kw)
      })
    }
    return pageSlice(await this.searchUsers(selfId, keyword), page, size)
  }

  async searchGroupsPage (selfId = '', keyword = '', page = 1, size = 50) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return pageSlice([], page, size)
    const match = item => [item.openid, item.name, item.remark_name, item.real_group_id, item.group_finger_memo, item.group_class_text, ...(item.group_tags || [])].filter(Boolean).join('\n').toLowerCase().includes(kw)
    if (this.type === 'level' && this._db) return this._pageLevelPrefix(`group:${selfId}:`, page, size, match)
    return pageSlice(Object.values(this._data.groups).filter(item => item.self_id === selfId && match(item)), page, size)
  }

  async searchUsersByNicknamePage (selfId = '', keyword = '', page = 1, size = 50) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return pageSlice([], page, size)
    if (this.type === 'level' && this._db) return this._pageLevelPrefix(`user:${selfId}:`, page, size, item => String(item.nickname || '').toLowerCase().includes(kw))
    const list = Object.values(this._data.users).filter(i => i.self_id === selfId && String(i.nickname || '').toLowerCase().includes(kw))
    return pageSlice(list, page, size)
  }
  getUser (selfId = '', openid = '') { return this._getEntity('user', this._key(selfId, openid)) }
  getGroup (selfId = '', openid = '') { return this._getEntity('group', this._key(selfId, openid)) }
  async getGroupMembers (selfId = '', groupOpenid = '', page = 1, size = 10) {
    if (this.type === 'level' && this._db) return this._pageLevelPrefix(`user:${selfId}:`, page, size, item => Boolean(item.groups?.[groupOpenid]))
    return pageSlice(Object.values(this._data.users).filter(i => i.self_id === selfId && i.groups?.[groupOpenid]), page, size)
  }

  async setGroupRemark (selfId = '', groupOpenid = '', key = '', value = '') {
    const item = await this.recordGroup(selfId, groupOpenid)
    if (!item) return null
    item[key] = safeText(value, 120)
    await this._save('group', this._key(selfId, groupOpenid), item)
    return item
  }

  async setBlackUser (selfId = '', openid = '', operator = '', enabled = true, reason = '') {
    const key = this._key(selfId, openid)
    if (enabled) this._data.blacklistUsers[key] = { self_id: selfId, openid, operator, reason: safeText(reason || '', 200), time: nowIso() }
    else delete this._data.blacklistUsers[key]
    enabled ? await this._save('blackUser', key, this._data.blacklistUsers[key]) : await this._del('blackUser', key)
  }

  async setBlackGroup (selfId = '', openid = '', operator = '', enabled = true, reason = '') {
    const key = this._key(selfId, openid)
    if (enabled) this._data.blacklistGroups[key] = { self_id: selfId, openid, operator, reason: safeText(reason || '', 200), time: nowIso() }
    else delete this._data.blacklistGroups[key]
    enabled ? await this._save('blackGroup', key, this._data.blacklistGroups[key]) : await this._del('blackGroup', key)
  }

  isBlackUser (selfId = '', openid = '') { return !!this._data.blacklistUsers[this._key(selfId, openid)] }
  isBlackGroup (selfId = '', openid = '') { return !!this._data.blacklistGroups[this._key(selfId, openid)] }
  getBlackUser (selfId = '', openid = '') { return this._data.blacklistUsers[this._key(selfId, openid)] || null }
  getBlackGroup (selfId = '', openid = '') { return this._data.blacklistGroups[this._key(selfId, openid)] || null }
  listBlackUsers (selfId = '', page = 1, size = 10) { return pageSlice(Object.values(this._data.blacklistUsers).filter(i => i.self_id === selfId), page, size) }
  listBlackGroups (selfId = '', page = 1, size = 10) { return pageSlice(Object.values(this._data.blacklistGroups).filter(i => i.self_id === selfId), page, size) }

  async setPendingCancel (selfId = '', openid = '', code = '') {
    const now = Date.now()
    const entries = Object.entries(this._data.pendingCancels)
      .filter(([, item]) => item?.self_id === selfId)
      .sort((a, b) => Number(a[1]?.expire_at) - Number(b[1]?.expire_at))
    let excess = Math.max(0, entries.length - 999)
    for (const [oldKey, item] of entries) {
      if (Number(item?.expire_at) > now && excess <= 0) continue
      delete this._data.pendingCancels[oldKey]
      await this._del('pendingCancel', oldKey)
      if (Number(item?.expire_at) > now) excess--
    }
    const key = this._key(selfId, openid)
    const item = { self_id: selfId, openid, code, expire_at: Date.now() + 60000, time: nowIso() }
    this._data.pendingCancels[key] = item
    await this._save('pendingCancel', key, item)
    return item
  }

  getPendingCancel (selfId = '', openid = '') {
    const key = this._key(selfId, openid)
    const item = this._data.pendingCancels[key]
    if (!item) return null
    if (Number(item.expire_at) < Date.now()) {
      delete this._data.pendingCancels[key]
      this._del('pendingCancel', key).catch(() => {})
      return null
    }
    return item
  }

  async clearPendingCancel (selfId = '', openid = '') {
    const key = this._key(selfId, openid)
    delete this._data.pendingCancels[key]
    await this._del('pendingCancel', key)
  }

  async startCancel (selfId = '', openid = '', days = 7, blockDays = 3650, extra = {}) {
    const key = this._key(selfId, openid)
    const item = { self_id: selfId, openid, requested_at: nowIso(), cancel_at: Date.now() + days * 86400000, block_until: Date.now() + (days + blockDays) * 86400000, days, blockDays, withdrawn: false, forced: extra.forced === true, operator: extra.operator || '', reason: safeText(extra.reason || '', 200) }
    this._data.cancellations[key] = item
    await this._save('cancel', key, item)
    return item
  }

  getCancel (selfId = '', openid = '') {
    const item = this._data.cancellations[this._key(selfId, openid)]
    if (!item || item.withdrawn) return null
    return item
  }

  listCancels (selfId = '', page = 1, size = 10) { return pageSlice(Object.values(this._data.cancellations).filter(i => i.self_id === selfId && !i.withdrawn), page, size) }

  async withdrawCancel (selfId = '', openid = '', operator = '') {
    const key = this._key(selfId, openid)
    const item = this._data.cancellations[key]
    if (!item || item.withdrawn) return false
    item.withdrawn = true
    item.withdrawn_at = nowIso()
    item.withdrawn_by = operator
    await this._save('cancel', key, item)
    return true
  }

  _fullBindingKey (selfId, userOpenid, groupOpenid) { return `${selfId}:${userOpenid}:${groupOpenid}` }
  _fullGroupEventKey (selfId, groupOpenid) { return `${selfId}:${groupOpenid}` }

  async recordFullBinding (selfId = '', userOpenid = '', groupOpenid = '', info = {}) {
    if (!selfId || !userOpenid || !groupOpenid) return null
    const key = this._fullBindingKey(selfId, userOpenid, groupOpenid)
    const old = this._data.fullBindings[key] || {}
    const item = {
      ...old,
      self_id: selfId,
      user_openid: userOpenid,
      group_openid: groupOpenid,
      troop_uin: safeText(old.troop_uin || info.troop_uin || '', 20),
      nickname: safeText(info.nickname || old.nickname || '', 80),
      updated_at: nowIso(),
      created_at: old.created_at || nowIso()
    }
    this._data.fullBindings[key] = item
    await this._save('fullBinding', key, item)
    return item
  }

  listFullBindings (selfId = '', page = 1, size = 10) {
    return pageSlice(Object.values(this._data.fullBindings)
      .filter(i => i.self_id === selfId)
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0)), page, size)
  }

  async recordFullGroupEvent (selfId = '', groupOpenid = '') {
    if (!selfId || !groupOpenid) return null
    const key = this._fullGroupEventKey(selfId, groupOpenid)
    const old = this._data.fullGroupEvents[key] || {}
    const item = { ...old, self_id: selfId, group_openid: groupOpenid, first_seen_at: old.first_seen_at || nowIso(), last_seen_at: nowIso() }
    this._data.fullGroupEvents[key] = item
    await this._save('fullGroupEvent', key, item)
    return item
  }

  isFullGroupEventSeen (selfId = '', groupOpenid = '') {
    return Boolean(this._data.fullGroupEvents[this._fullGroupEventKey(selfId, groupOpenid)])
  }

  async clearFullBindings (selfId = '') {
    let count = 0
    for (const [key, value] of Object.entries(this._data.fullBindings)) {
      if (value?.self_id !== selfId) continue
      delete this._data.fullBindings[key]
      await this._del('fullBinding', key)
      count++
    }
    return count
  }
}

export default new UserManageStore()
