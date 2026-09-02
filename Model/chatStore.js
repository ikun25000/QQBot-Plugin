import fs from 'node:fs'
import { join } from 'node:path'
import { getTime, pluginPath } from './common.js'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotChat')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'chat')
const RECORD_TTL_MS = 31 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const LEVEL_CACHE_MAX = 20000
const STATS_CACHE_MAX = 5000
const STATS_CACHE_TTL_MS = 60 * 1000
const DELETE_BATCH_SIZE = 1000
const UPDATE_LANE_COUNT = 256

function dayKey (offset = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}

function parseTimestamp (value) {
  if (!value) return new Date()
  const numeric = Number(value)
  if (Number.isFinite(numeric) && String(value).trim()) {
    return new Date(numeric > 10000000000 ? numeric : numeric * 1000)
  }
  return new Date(value)
}

function periodDays (period) {
  const size = period === 'month' ? 30 : period === 'week' ? 7 : 1
  const start = period === 'yesterday' ? 1 : 0
  return Array.from({ length: size }, (_, index) => dayKey(-(index + start)))
}

class ChatStore {
  constructor () {
    this.type = 'level'
    this._data = {}
    this._db = null
    this._saveTimer = null
    this._writeQueue = Promise.resolve()
    this._writeSeq = 0
    this._ready = false
    this._userRecords = new Map()
    this._cacheOrder = new Map()
    this._statsCache = new Map()
    this._statsCacheByUser = new Map()
    this._updateLanes = Array.from({ length: UPDATE_LANE_COUNT }, () => Promise.resolve())
    this._lastCleanup = 0
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'chat.json') }

  async init () {
    if (this._ready) return
    this.type = 'level'
    this._data = {}
    this._userRecords = new Map()
    this._cacheOrder = new Map()
    this._statsCache = new Map()
    this._statsCacheByUser = new Map()
    this._updateLanes = Array.from({ length: UPDATE_LANE_COUNT }, () => Promise.resolve())
    this._lastCleanup = Date.now()
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.db.open()
    } catch (err) {
      logger.error('[QQBot-Plugin] chatStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { await this._db.close() } catch {} this._db = null }
      this._data = {}
      this._userRecords.clear()
      this._cacheOrder.clear()
      this._statsCache.clear()
      this._statsCacheByUser.clear()
      this._updateLanes = Array.from({ length: UPDATE_LANE_COUNT }, () => Promise.resolve())
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        const data = JSON.parse(fs.readFileSync(this._jsonPath(), 'utf-8')) || {}
        for (const [key, value] of Object.entries(data)) {
          if (this._isExpired(value)) continue
          this._data[key] = value
          this._indexUserRecord(key, value)
        }
        if (Object.keys(data).length !== Object.keys(this._data).length) this._scheduleSave()
      } catch {
        this._data = {}
        this._userRecords.clear()
      }
    }
    this._ready = true
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
          logger.error('[QQBot-Plugin] chatStore JSON save error:', err)
        }
      })
      this._saveTimer = null
    }, 1000)
  }

  _makeKey (selfId, userOpenid, scope, targetOpenid, day) {
    return `${selfId}:${userOpenid}:${scope}:${targetOpenid || '-'}:${day}`
  }

  _makeRankKey (selfId, groupOpenid, userOpenid, day) {
    return `rank:${selfId}:${groupOpenid}:${userOpenid}:${day}`
  }

  _makeLeftMemberKey (selfId, groupOpenid, userOpenid) {
    return `left:${selfId}:${groupOpenid}:${userOpenid}`
  }

  _userIndexKey (selfId, userOpenid) {
    return `${selfId}:${userOpenid}`
  }

  _prefixRange (prefix) {
    const last = prefix.charCodeAt(prefix.length - 1)
    return { gte: prefix, lt: `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}` }
  }

  _indexUserRecord (key, item) {
    if (!item?.self_id || !item?.user_openid || !['group', 'private'].includes(item.scope)) return
    const indexKey = this._userIndexKey(item.self_id, item.user_openid)
    let records = this._userRecords.get(indexKey)
    if (!records) {
      records = new Set()
      this._userRecords.set(indexKey, records)
    }
    records.add(key)
  }

  _unindexUserRecord (key, item) {
    if (!item?.self_id || !item?.user_openid || !['group', 'private'].includes(item.scope)) return
    const indexKey = this._userIndexKey(item.self_id, item.user_openid)
    const records = this._userRecords.get(indexKey)
    if (!records) return
    records.delete(key)
    if (!records.size) this._userRecords.delete(indexKey)
  }

  _cacheRecord (key, item) {
    const previous = this._data[key]
    if (previous) this._unindexUserRecord(key, previous)
    this._data[key] = item
    this._indexUserRecord(key, item)
    if (this.type !== 'level') return item

    this._cacheOrder.delete(key)
    this._cacheOrder.set(key, true)
    while (this._cacheOrder.size > LEVEL_CACHE_MAX) {
      const oldestKey = this._cacheOrder.keys().next().value
      this._removeRecord(oldestKey)
    }
    return item
  }

  async _getRecord (key) {
    let item = this._data[key]
    if (item) {
      if (this._isExpired(item)) {
        this._removeRecord(key)
        await this._persistDeletes([key])
        return null
      }
      if (this.type === 'level') {
        this._cacheOrder.delete(key)
        this._cacheOrder.set(key, true)
      }
      return item
    }
    if (this.type !== 'level' || !this._db) return null

    try {
      item = await this._db.db.get(key)
    } catch (err) {
      if (err.notFound || err.code === 'LEVEL_NOT_FOUND') return null
      throw err
    }
    if (item?.expiredTime) {
      item = { ...item }
      delete item.expiredTime
    }
    if (this._isExpired(item)) {
      await this._persistDeletes([key])
      return null
    }
    return this._cacheRecord(key, item)
  }

  async _updateRecord (key, create, update, persist = true) {
    let lane = 0
    for (let index = 0; index < key.length; index++) lane = (lane * 31 + key.charCodeAt(index)) % UPDATE_LANE_COUNT
    const pending = this._updateLanes[lane].catch(() => {}).then(async () => {
      const item = await this._getRecord(key) || create()
      update(item)
      this._cacheRecord(key, item)
      if (persist) await this._persistRecords([[key, item]])
      return item
    })
    this._updateLanes[lane] = pending.then(() => undefined, () => undefined)
    return pending
  }

  async _persistRecords (records = []) {
    const unique = new Map()
    for (const [key, item] of records) if (key && item) unique.set(String(key), item)
    if (!unique.size) return
    if (this.type === 'level' && this._db) {
      const expiredTime = getTime(30)
      await this._db.db.batch([...unique.entries()].map(([key, item]) => ({
        type: 'put',
        key,
        value: { ...item, expiredTime }
      })))
    } else {
      this._scheduleSave()
    }
  }

  _statsCacheKey (selfId, userOpenid, scope, targetOpenid) {
    return JSON.stringify([dayKey(), selfId, userOpenid, scope, targetOpenid || ''])
  }

  _copyStats (stats) {
    return {
      ...stats,
      total: { ...stats.total },
      breakdown: Object.fromEntries(Object.entries(stats.breakdown).map(([period, value]) => [period, { ...value }]))
    }
  }

  _deleteStatsCache (key, entry) {
    this._statsCache.delete(key)
    const keys = this._statsCacheByUser.get(entry.userIndexKey)
    if (!keys) return
    keys.delete(key)
    if (!keys.size) this._statsCacheByUser.delete(entry.userIndexKey)
  }

  _getCachedStats (key, now = Date.now()) {
    const entry = this._statsCache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now) {
      this._deleteStatsCache(key, entry)
      return null
    }
    this._statsCache.delete(key)
    this._statsCache.set(key, entry)
    return this._copyStats(entry.value)
  }

  _setCachedStats (key, userIndexKey, scope, targetOpenid, value, now = Date.now()) {
    const previous = this._statsCache.get(key)
    if (previous) this._deleteStatsCache(key, previous)
    const entry = { userIndexKey, scope, targetOpenid: targetOpenid || '', value: this._copyStats(value), expiresAt: now + STATS_CACHE_TTL_MS }
    this._statsCache.set(key, entry)
    let keys = this._statsCacheByUser.get(userIndexKey)
    if (!keys) {
      keys = new Set()
      this._statsCacheByUser.set(userIndexKey, keys)
    }
    keys.add(key)
    while (this._statsCache.size > STATS_CACHE_MAX) {
      const oldestKey = this._statsCache.keys().next().value
      this._deleteStatsCache(oldestKey, this._statsCache.get(oldestKey))
    }
  }

  _incrementCachedStats (item) {
    const userIndexKey = this._userIndexKey(item.self_id, item.user_openid)
    const keys = this._statsCacheByUser.get(userIndexKey)
    if (!keys) return
    const now = Date.now()
    const periods = ['today', 'yesterday', 'week', 'month']
    const matchingPeriods = periods.filter(period => periodDays(period).includes(item.day))

    for (const key of [...keys]) {
      const entry = this._statsCache.get(key)
      if (!entry || entry.expiresAt <= now) {
        if (entry) this._deleteStatsCache(key, entry)
        else keys.delete(key)
        continue
      }
      for (const period of matchingPeriods) {
        entry.value.total[period] += 1
        entry.value.breakdown[period][item.scope] += 1
        if (entry.scope && entry.scope === item.scope && (entry.scope !== 'group' || !entry.targetOpenid || entry.targetOpenid === item.target_openid)) {
          entry.value[period] += 1
        }
      }
      entry.expiresAt = now + STATS_CACHE_TTL_MS
    }
    if (!keys.size) this._statsCacheByUser.delete(userIndexKey)
  }

  async _forEachLevelPrefix (prefix, visit) {
    const cached = new Map()
    for (const key of this._cacheOrder.keys()) {
      if (key.startsWith(prefix) && this._data[key]) cached.set(key, this._data[key])
    }

    let deletes = []
    const inspect = async (key, item) => {
      if (this._isExpired(item)) {
        this._removeRecord(key)
        deletes.push(key)
        if (deletes.length >= DELETE_BATCH_SIZE) {
          await this._persistDeletes(deletes)
          deletes = []
        }
        return
      }
      visit(key, item)
    }

    for await (const [key, persisted] of this._db.db.iterator(this._prefixRange(prefix))) {
      const item = cached.get(key) || persisted
      cached.delete(key)
      await inspect(key, item)
    }
    for (const [key, item] of cached) await inspect(key, item)
    await this._persistDeletes(deletes)
  }

  _recordTime (item) {
    if (item?.day) return Date.parse(`${item.day}T00:00:00.000Z`) || 0
    return Date.parse(item?.updated_at || item?.last_time || '') || 0
  }

  _isExpired (item, now = Date.now()) {
    const time = this._recordTime(item)
    return !time || now - time > RECORD_TTL_MS
  }

  _removeRecord (key) {
    const item = this._data[key]
    if (!item) return
    this._unindexUserRecord(key, item)
    delete this._data[key]
    this._cacheOrder.delete(key)
  }

  _removeExpired (now = Date.now()) {
    const deletes = []
    for (const [key, item] of Object.entries(this._data)) {
      if (!this._isExpired(item, now)) continue
      this._removeRecord(key)
      deletes.push(key)
    }
    return deletes
  }

  async _persistDeletes (keys) {
    if (!keys.length) return
    if (this.type === 'level' && this._db) await this._db.db.batch([...new Set(keys)].map(key => ({ type: 'del', key })))
    else this._scheduleSave()
  }

  _maybeCleanup () {
    const now = Date.now()
    if (now - this._lastCleanup < CLEANUP_INTERVAL_MS) return
    this._lastCleanup = now
    this._persistDeletes(this._removeExpired(now)).catch(err => logger.error('[QQBot-Plugin] chatStore cleanup error:', err))
  }

  async setGroupMemberLeft (selfId = '', groupOpenid = '', userOpenid = '', left = false) {
    if (!selfId || !groupOpenid || !userOpenid) return false
    this._maybeCleanup()
    const key = this._makeLeftMemberKey(selfId, groupOpenid, userOpenid)
    if (left) {
      const item = { self_id: selfId, group_openid: groupOpenid, user_openid: userOpenid, left: true, updated_at: new Date().toISOString() }
      this._cacheRecord(key, item)
      if (this.type === 'level' && this._db) await this._db.set(key, { ...item }, 31)
      else this._scheduleSave()
    } else {
      if (!this._data[key]) return false
      this._removeRecord(key)
      if (this.type === 'level' && this._db) { try { await this._db.db.del(key) } catch {} } else this._scheduleSave()
    }
    return true
  }

  async isGroupMemberLeft (selfId = '', groupOpenid = '', userOpenid = '') {
    this._maybeCleanup()
    const key = this._makeLeftMemberKey(selfId, groupOpenid, userOpenid)
    const item = await this._getRecord(key)
    return !!item?.left
  }

  async recordUserMessage (selfId = '', userOpenid = '', scope = '', targetOpenid = '', timestamp = '', extra = {}) {
    if (!selfId || !userOpenid || !['group', 'private'].includes(scope)) return null
    this._maybeCleanup()
    let date = parseTimestamp(timestamp)
    if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now() + 24 * 60 * 60 * 1000) date = new Date()
    const day = Number.isNaN(date.getTime()) ? dayKey() : date.toISOString().slice(0, 10)
    if (this._isExpired({ day })) return this.getUserStats(selfId, userOpenid, scope, targetOpenid)
    const key = this._makeKey(selfId, userOpenid, scope, targetOpenid, day)
    const now = new Date().toISOString()
    const pendingRecords = []
    const item = await this._updateRecord(
      key,
      () => ({ self_id: selfId, user_openid: userOpenid, scope, target_openid: targetOpenid || '', day, count: 0, first_time: '', last_time: '' }),
      item => {
        item.count = Number(item.count) + 1
        if (!item.first_time) item.first_time = now
        item.last_time = now
      }, false
    )
    pendingRecords.push([key, item])
    this._incrementCachedStats(item)

    if (scope === 'group' && targetOpenid) {
      const rankKey = this._makeRankKey(selfId, targetOpenid, userOpenid, day)
      const rankItem = await this._updateRecord(
        rankKey,
        () => ({ self_id: selfId, group_openid: targetOpenid, user_openid: userOpenid, day, count: 0, nickname: '', bot: false }),
        rankItem => {
          rankItem.count = Number(rankItem.count) + 1
          rankItem.nickname = extra.nickname || rankItem.nickname || ''
          rankItem.bot = extra.bot === true || rankItem.bot === true
          rankItem.updated_at = now
        }, false
      )
      pendingRecords.push([rankKey, rankItem])
    }
    await this._persistRecords(pendingRecords)
    return this.getUserStats(selfId, userOpenid, scope, targetOpenid)
  }

  async recordGroupRank (selfId = '', groupOpenid = '', userOpenid = '', timestamp = '', extra = {}) {
    if (!selfId || !groupOpenid || !userOpenid) return false
    this._maybeCleanup()
    let date = parseTimestamp(timestamp)
    if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now() + 24 * 60 * 60 * 1000) date = new Date()
    const day = Number.isNaN(date.getTime()) ? dayKey() : date.toISOString().slice(0, 10)
    if (this._isExpired({ day })) return false
    await this.setGroupMemberLeft(selfId, groupOpenid, userOpenid, false)
    const now = new Date().toISOString()
    const rankKey = this._makeRankKey(selfId, groupOpenid, userOpenid, day)
    const rankItem = await this._updateRecord(
      rankKey,
      () => ({ self_id: selfId, group_openid: groupOpenid, user_openid: userOpenid, day, count: 0, nickname: '', bot: false }),
      rankItem => {
        rankItem.count = Number(rankItem.count) + 1
        rankItem.nickname = extra.nickname || rankItem.nickname || ''
        rankItem.bot = extra.bot === true || rankItem.bot === true
        rankItem.updated_at = now
      }, false
    )
    await this._persistRecords([[rankKey, rankItem]])
    return true
  }

  async getUserStats (selfId = '', userOpenid = '', scope = '', targetOpenid = '') {
    if (!selfId || !userOpenid) return null
    this._maybeCleanup()
    const cacheKey = this._statsCacheKey(selfId, userOpenid, scope, targetOpenid)
    const cachedStats = this._getCachedStats(cacheKey)
    if (cachedStats) return cachedStats

    const periods = ['today', 'yesterday', 'week', 'month']
    const periodSets = Object.fromEntries(periods.map(period => [period, new Set(periodDays(period))]))
    const stats = Object.fromEntries(periods.map(period => [period, { total: 0, group: 0, private: 0, current: 0 }]))
    const userIndexKey = this._userIndexKey(selfId, userOpenid)
    const add = (key, item) => {
      if (!item || !['group', 'private'].includes(item.scope)) return
      const count = Number(item.count) || 0
      if (!count) return

      for (const period of periods) {
        if (!periodSets[period].has(item.day)) continue
        stats[period].total += count
        stats[period][item.scope] += count
        if (scope && item.scope === scope && (scope !== 'group' || !targetOpenid || item.target_openid === targetOpenid)) {
          stats[period].current += count
        }
      }
    }

    if (this.type === 'level' && this._db) {
      await this._forEachLevelPrefix(`${userIndexKey}:`, add)
    } else {
      const recordKeys = this._userRecords.get(userIndexKey) || []
      for (const key of [...recordKeys]) {
        const item = this._data[key]
        if (!item || !['group', 'private'].includes(item.scope)) {
          recordKeys.delete?.(key)
          continue
        }
        add(key, item)
      }
      if (recordKeys instanceof Set && !recordKeys.size) this._userRecords.delete(userIndexKey)
    }

    const result = {
      user_openid: userOpenid,
      scope,
      target_openid: targetOpenid || '',
      today: stats.today.current,
      yesterday: stats.yesterday.current,
      week: stats.week.current,
      month: stats.month.current,
      total: {
        today: stats.today.total,
        yesterday: stats.yesterday.total,
        week: stats.week.total,
        month: stats.month.total
      },
      breakdown: {
        today: { group: stats.today.group, private: stats.today.private },
        yesterday: { group: stats.yesterday.group, private: stats.yesterday.private },
        week: { group: stats.week.group, private: stats.week.private },
        month: { group: stats.month.group, private: stats.month.private }
      }
    }
    this._setCachedStats(cacheKey, userIndexKey, scope, targetOpenid, result)
    return result
  }

  async getGroupRank (selfId = '', groupOpenid = '', includeBot = false, excludeOpenid = '') {
    if (!selfId || !groupOpenid) return undefined
    this._maybeCleanup()
    const periods = ['today', 'yesterday', 'week', 'month']
    const periodSets = Object.fromEntries(periods.map(period => [period, new Set(periodDays(period))]))
    const rankMaps = Object.fromEntries(periods.map(period => [period, new Map()]))
    const add = (key, item) => {
      if (!item || item.self_id !== selfId || item.group_openid !== groupOpenid) return
      if (!includeBot && item.bot === true) return
      if (excludeOpenid && item.user_openid === excludeOpenid) return
      for (const period of periods) {
        if (!periodSets[period].has(item.day)) continue
        const map = rankMaps[period]
        const current = map.get(item.user_openid) || { ...item, count: 0 }
        current.count = (Number(current.count) || 0) + (Number(item.count) || 0)
        current.nickname = item.nickname || current.nickname || ''
        current.bot = item.bot === true || current.bot === true
        map.set(item.user_openid, current)
      }
    }
    if (this.type === 'level' && this._db) {
      await this._forEachLevelPrefix(`rank:${selfId}:${groupOpenid}:`, add)
    } else {
      for (const [key, item] of Object.entries(this._data)) add(key, item)
    }

    const leftMembers = new Set()
    const addLeft = (key, item) => {
      if (item?.left && item.self_id === selfId && item.group_openid === groupOpenid) leftMembers.add(item.user_openid)
    }
    if (this.type === 'level' && this._db) {
      await this._forEachLevelPrefix(`left:${selfId}:${groupOpenid}:`, addLeft)
    } else {
      for (const [key, item] of Object.entries(this._data)) addLeft(key, item)
    }

    const build = days => {
      return [...rankMaps[days].values()]
        .filter(item => !leftMembers.has(item.user_openid))
        .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
        .slice(0, 10)
        .map(item => ({
        openid: item.user_openid,
        user_id: item.user_openid,
        nickname: item.nickname || item.user_openid,
        count: Number(item.count) || 0,
        bot: item.bot === true
        }))
    }
    return {
      today: build('today'),
      yesterday: build('yesterday'),
      week: build('week'),
      month: build('month')
    }
  }

  async close () {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null }
    if (this.type === 'json' && this._ready) {
      const snapshot = JSON.stringify(this._data, null, 2)
      this._writeQueue = this._writeQueue.catch(() => {}).then(async () => {
        const file = this._jsonPath()
        const tmp = `${file}.${process.pid}.${Date.now()}.${++this._writeSeq}.tmp`
        await fs.promises.writeFile(tmp, snapshot, 'utf-8')
        await fs.promises.rename(tmp, file)
      })
      await this._writeQueue.catch(() => {})
    }
    if (this._db) { try { await this._db.close() } catch {}; this._db = null }
    this._userRecords.clear()
    this._cacheOrder.clear()
    this._statsCache.clear()
    this._statsCacheByUser.clear()
    this._updateLanes = Array.from({ length: UPDATE_LANE_COUNT }, () => Promise.resolve())
    this._data = {}
    this._ready = false
  }
}

const store = new ChatStore()
export default store
