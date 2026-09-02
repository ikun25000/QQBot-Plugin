import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const LEVEL_DATA_DIR = join(pluginPath, 'db', 'active')
const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotActive')
const KNOWN_USER_CACHE_LIMIT = 20000

function encodeKeyPart (value) {
  return encodeURIComponent(String(value || ''))
}

class ActiveStore {
  constructor () {
    this.type = 'level'
    this._db = null
    this._ready = false
    this._stats = new Map()
    this._knownUsers = new Set()
    this._json = { users: {}, stats: {} }
    this._queues = new Map()
    this._versions = new Map()
    this._writeQueue = Promise.resolve()
    this._saveTimer = null
    this._writeSeq = 0
  }

  _groupKey (selfId, groupOpenid) {
    return `${encodeKeyPart(selfId)}:${encodeKeyPart(groupOpenid)}`
  }

  _userKey (groupKey, type, userOpenid) {
    return `user:${groupKey}:${type}:${encodeKeyPart(userOpenid)}`
  }

  _statsKey (groupKey) {
    return `stats:${groupKey}`
  }

  _emptyStats () {
    return { user: 0, activeat: 0, activenoat: 0 }
  }

  async init () {
    if (this._ready) return
    this.type = 'level'
    this._stats.clear()
    this._knownUsers.clear()
    this._versions.clear()
    this._json = { users: {}, stats: {} }
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open({ cleanup: false })
      for await (const [key, value] of this._db.db.iterator({ gte: 'stats:', lt: 'stats:\uffff' })) {
        this._stats.set(String(key).slice(6), this._normalizeStats(value))
      }
    } catch (err) {
      logger.error('[QQBot-Plugin] activeStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { await this._db.close() } catch {}; this._db = null }
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        const value = JSON.parse(fs.readFileSync(this._jsonPath(), 'utf8'))
        this._json = {
          users: value?.users && typeof value.users === 'object' ? value.users : {},
          stats: value?.stats && typeof value.stats === 'object' ? value.stats : {}
        }
        for (const [key, stats] of Object.entries(this._json.stats)) this._stats.set(key, this._normalizeStats(stats))
        for (const key of Object.keys(this._json.users)) this._knownUsers.add(key.startsWith('user:') ? key.slice(5) : key)
      } catch {}
    }
    this._ready = true
  }

  _jsonPath () {
    return join(JSON_DATA_DIR, 'active.json')
  }

  _normalizeStats (value) {
    return {
      user: Math.max(0, Number(value?.user) || 0),
      activeat: Math.max(0, Number(value?.activeat) || 0),
      activenoat: Math.max(0, Number(value?.activenoat) || 0)
    }
  }

  async _hasUserKey (key) {
    const knownKey = String(key).startsWith('user:') ? String(key).slice(5) : String(key)
    if (this._knownUsers.has(knownKey)) return true
    if (this.type === 'level' && this._db) {
      try {
        const exists = await this._db.get(key)
        if (exists === true) this._rememberKnownUser(knownKey)
        return exists === true
      } catch (err) {
        if (err?.notFound || err?.code === 'LEVEL_NOT_FOUND') return false
        throw err
      }
    }
    return this._json.users[key] === true || this._json.users[knownKey] === true
  }

  _rememberKnownUser (key) {
    this._knownUsers.delete(key)
    this._knownUsers.add(key)
    while (this._knownUsers.size > KNOWN_USER_CACHE_LIMIT) this._knownUsers.delete(this._knownUsers.keys().next().value)
  }

  async _persist (groupKey, stats, newKeys, deletedKeys = []) {
    if (this.type === 'level' && this._db) {
      await this._db.db.batch([
        ...newKeys.map(key => ({ type: 'put', key, value: true })),
        ...deletedKeys.map(key => ({ type: 'del', key })),
        { type: 'put', key: this._statsKey(groupKey), value: stats }
      ])
      for (const key of deletedKeys) this._knownUsers.delete(key.slice(5))
      return
    }
    for (const key of newKeys) this._json.users[key] = true
    for (const key of deletedKeys) delete this._json.users[key]
    this._json.stats[groupKey] = stats
    this._scheduleSave()
  }

  _scheduleSave () {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      const snapshot = JSON.stringify(this._json, null, 2)
      this._writeQueue = this._writeQueue.catch(() => {}).then(async () => {
        const file = this._jsonPath()
        const tmp = `${file}.${process.pid}.${Date.now()}.${++this._writeSeq}.tmp`
        try {
          await fs.promises.writeFile(tmp, snapshot, 'utf8')
          await fs.promises.rename(tmp, file)
        } catch (err) {
          try { await fs.promises.unlink(tmp) } catch {}
          logger.error('[QQBot-Plugin] activeStore JSON save error:', err.message)
        }
      })
    }, 1000)
  }

  async _getStats (groupKey) {
    if (this._stats.has(groupKey)) return this._normalizeStats(this._stats.get(groupKey))
    let value = null
    if (this.type === 'level' && this._db) value = await this._db.get(this._statsKey(groupKey))
    else value = this._json.stats[groupKey]
    const stats = this._normalizeStats(value)
    this._stats.set(groupKey, stats)
    return { ...stats }
  }

  _record (selfId = '', groupOpenid = '', userOpenid = '', type = 'activeat', detailed = false) {
    if (!selfId || !groupOpenid || !userOpenid || !['activeat', 'activenoat'].includes(type)) return Promise.resolve(null)
    const groupKey = this._groupKey(selfId, groupOpenid)
    const previous = this._queues.get(groupKey) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const stats = await this._getStats(groupKey)
      const allKey = this._userKey(groupKey, 'all', userOpenid)
      const typeKey = this._userKey(groupKey, type, userOpenid)
      const token = (this._versions.get(typeKey) || 0) + 1
      this._versions.set(typeKey, token)
      const [hasAll, hasType] = await Promise.all([this._hasUserKey(allKey), this._hasUserKey(typeKey)])
      const newKeys = []
      if (!hasAll) {
        stats.user++
        newKeys.push(allKey)
      }
      if (!hasType) {
        stats[type]++
        newKeys.push(typeKey)
      }
      if (newKeys.length) await this._persist(groupKey, stats, newKeys)
      for (const key of newKeys) this._rememberKnownUser(key.slice(5))
      this._stats.set(groupKey, stats)
      return detailed ? { stats: { ...stats }, token, addedType: !hasType } : { ...stats }
    })
    this._queues.set(groupKey, pending)
    pending.finally(() => {
      if (this._queues.get(groupKey) === pending) this._queues.delete(groupKey)
    }).catch(() => {})
    return pending
  }

  record (selfId = '', groupOpenid = '', userOpenid = '', type = 'activeat') {
    return this._record(selfId, groupOpenid, userOpenid, type, false)
  }

  recordDetailed (selfId = '', groupOpenid = '', userOpenid = '', type = 'activeat') {
    return this._record(selfId, groupOpenid, userOpenid, type, true)
  }

  rollback (selfId = '', groupOpenid = '', userOpenid = '', type = 'activenoat', token = 0) {
    if (!selfId || !groupOpenid || !userOpenid || !['activeat', 'activenoat'].includes(type) || !token) return Promise.resolve(null)
    const groupKey = this._groupKey(selfId, groupOpenid)
    const previous = this._queues.get(groupKey) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const typeKey = this._userKey(groupKey, type, userOpenid)
      const activeAtKey = this._userKey(groupKey, 'activeat', userOpenid)
      if (this._versions.get(typeKey) !== token || !await this._hasUserKey(typeKey) || !await this._hasUserKey(activeAtKey)) return { ...await this._getStats(groupKey) }
      const stats = await this._getStats(groupKey)
      stats[type] = Math.max(0, stats[type] - 1)
      await this._persist(groupKey, stats, [], [typeKey])
      this._knownUsers.delete(typeKey.slice(5))
      this._stats.set(groupKey, stats)
      this._versions.set(typeKey, token + 1)
      return { ...stats }
    })
    this._queues.set(groupKey, pending)
    pending.finally(() => {
      if (this._queues.get(groupKey) === pending) this._queues.delete(groupKey)
    }).catch(() => {})
    return pending
  }

  async get (selfId = '', groupOpenid = '') {
    if (!selfId || !groupOpenid) return this._emptyStats()
    return { ...await this._getStats(this._groupKey(selfId, groupOpenid)) }
  }

  async close () {
    await Promise.allSettled([...this._queues.values()])
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = null
    if (this._db) {
      try { await this._db.close() } catch {}
      this._db = null
    }
    this._ready = false
  }

  peek (selfId = '', groupOpenid = '') {
    if (!selfId || !groupOpenid) return this._emptyStats()
    return this._normalizeStats(this._stats.get(this._groupKey(selfId, groupOpenid)))
  }
}

export default new ActiveStore()
