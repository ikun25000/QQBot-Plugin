import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotFullMessage')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'fullMessage')
const MEMBER_NICKNAME_LIMIT = 20000
const RECORD_CACHE_LIMIT = 20000
const RECORD_PAGE_LIMIT = 500

class FullMessageStore {
  constructor () {
    this.type = 'json'
    this.records = {}
    this.meta = {
      recordStartTime: '',
      recordStartTimes: {},
      botNicknames: {},
      memberNicknames: {},
      blackGroups: {}
    }
    this._db = null
    this._saveTimer = null
    this._metaSaveTimer = null
    this._jsonWriteQueue = Promise.resolve()
    this._metaWriteQueue = Promise.resolve()
    this._writeSeq = 0
    this._ready = false
    this._memberNicknameOrder = new Map()
    this._recordKeys = new Set()
    this._recordCacheOrder = new Map()
  }

  async init (type = 'json') {
    if (this._ready && this.type === type) return
    if (this._ready) await this.close()

    this.type = type
    this.records = {}
    this.meta = {
      recordStartTime: '',
      recordStartTimes: {},
      botNicknames: {},
      memberNicknames: {},
      blackGroups: {}
    }
    this._memberNicknameOrder.clear()
    this._recordKeys.clear()
    this._recordCacheOrder.clear()

    if (type === 'level') {
      try {
        const { default: Level } = await import('./level.js')
        fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
        this._db = new Level(LEVEL_DATA_DIR)
        await this._db.open({ cleanup: false })
        for await (const entry of this._db.db.iterator({ keys: true, values: false })) {
          const key = String(Array.isArray(entry) ? entry[0] : entry?.key ?? entry)
          if (!key.startsWith('__meta__')) this._recordKeys.add(key)
        }
        this.meta = await this._db.get('__meta__') || this.meta
        if (this._rebuildMemberNicknameOrder()) this._scheduleMetaSave()
      } catch (err) {
        logger.error('[QQBot-Plugin] fullMessageStore LevelDB init failed, fallback to json:', err.message)
        this.type = 'json'
        if (this._db) { try { await this._db.close() } catch {} this._db = null }
      }
    }

    if (this.type === 'json') {
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      this._loadJson()
      this._loadMetaJson()
      this._recordKeys = new Set(Object.keys(this.records))
      if (this._rebuildMemberNicknameOrder()) this._scheduleMetaSave()
    }

    this._ready = true
  }

  _jsonPath () {
    return join(JSON_DATA_DIR, 'records.json')
  }

  _metaJsonPath () {
    return join(JSON_DATA_DIR, 'meta.json')
  }

  _loadJson () {
    try {
      const data = fs.readFileSync(this._jsonPath(), 'utf-8')
      this.records = JSON.parse(data)
    } catch {
      this.records = {}
    }
  }

  _loadMetaJson () {
    try {
      const data = fs.readFileSync(this._metaJsonPath(), 'utf-8')
      this.meta = {
        recordStartTime: '',
        recordStartTimes: {},
        botNicknames: {},
        memberNicknames: {},
        blackGroups: {},
        ...JSON.parse(data)
      }
    } catch {
      this.meta = {
        recordStartTime: '',
        recordStartTimes: {},
        botNicknames: {},
        memberNicknames: {},
        blackGroups: {}
      }
    }
  }

  _rebuildMemberNicknameOrder () {
    let changed = false
    this._memberNicknameOrder = new Map(Object.keys(this.meta.memberNicknames || {}).map(key => [key, true]))
    while (this._memberNicknameOrder.size > MEMBER_NICKNAME_LIMIT) {
      const oldest = this._memberNicknameOrder.keys().next().value
      this._memberNicknameOrder.delete(oldest)
      delete this.meta.memberNicknames[oldest]
      changed = true
    }
    return changed
  }

  _scheduleJsonSave () {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._writeJsonAtomic(this._jsonPath(), this.records, '_jsonWriteQueue')
      this._saveTimer = null
    }, 1000)
  }

  _scheduleMetaSave () {
    if (this._metaSaveTimer) return
    this._metaSaveTimer = setTimeout(async () => {
      this._metaSaveTimer = null
      if (this.type === 'level' && this._db) {
        try { await this._db.set('__meta__', this.meta, 0) } catch (err) { logger.error('[QQBot-Plugin] fullMessageStore meta save error:', err) }
      } else {
        this._writeJsonAtomic(this._metaJsonPath(), this.meta, '_metaWriteQueue')
      }
    }, 1000)
  }

  _scheduleMemberNicknameFlush () {
    return this._scheduleMetaSave()
  }

  _writeJsonAtomic (file, data, queueKey) {
    this[queueKey] = this[queueKey]
      .catch(() => {})
      .then(async () => {
        const tmp = `${file}.${process.pid}.${Date.now()}.${++this._writeSeq}.tmp`
        const lock = `${file}.lock`
        let lockHandle = null
        try {
          lockHandle = await this._acquireFileLock(lock)
          await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
          await fs.promises.rename(tmp, file)
        } catch (err) {
          try { await fs.promises.unlink(tmp) } catch {}
          logger.error('[QQBot-Plugin] fullMessageStore JSON atomic save error:', err)
        } finally {
          if (lockHandle) {
            try { await lockHandle.close() } catch {}
            try { await fs.promises.unlink(lock) } catch {}
          }
        }
      })
  }

  async _acquireFileLock (lockFile, retry = 50, delayMs = 100) {
    for (let i = 0; i < retry; i++) {
      try {
        return await fs.promises.open(lockFile, 'wx')
      } catch (err) {
        if (err.code !== 'EEXIST' || i === retry - 1) throw err
        try {
          const stat = await fs.promises.stat(lockFile)
          if (Date.now() - stat.mtimeMs > 30000) {
            await fs.promises.unlink(lockFile)
            continue
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }

  async saveMeta () {
    this._scheduleMetaSave()
  }

  async setRecord (key, value) {
    key = String(key)
    this._cacheRecord(key, value)
    this._recordKeys.add(key)
    if (this.type === 'level' && this._db) {
      await this._db.set(key, value, 0)
    } else {
      this._scheduleJsonSave()
    }
  }

  getRecord (key) {
    if (this.records[key]) return this.records[key]
    key = String(key)
    if (!this._recordKeys.has(key)) return null
    const split = key.indexOf(':')
    return { self_id: split > 0 ? key.slice(0, split) : '', group_openid: split > 0 ? key.slice(split + 1) : '', _lazy: true }
  }

  _cacheRecord (key, value) {
    if (!value) return null
    delete this.records[key]
    this.records[key] = value
    if (this.type !== 'level') return value
    this._recordCacheOrder.delete(key)
    this._recordCacheOrder.set(key, true)
    while (this._recordCacheOrder.size > RECORD_CACHE_LIMIT) {
      const oldest = this._recordCacheOrder.keys().next().value
      this._recordCacheOrder.delete(oldest)
      delete this.records[oldest]
    }
    return value
  }

  async getRecordAsync (key) {
    key = String(key)
    const cached = this.records[key]
    if (cached) return cached
    if (this.type !== 'level' || !this._db) return null
    try {
      const value = await this._db.get(key)
      if (value) this._cacheRecord(key, value)
      return value || null
    } catch {
      return null
    }
  }

  hasRecord (key) {
    return this._recordKeys.has(String(key))
  }

  async getAnyRecord (selfId = '') {
    const prefix = selfId ? `${selfId}:` : ''
    if (this.type !== 'level' || !this._db) {
      return Object.values(this.records).find(item => !selfId || item.self_id === selfId) || null
    }
    for (const key of this._recordKeys) {
      if (!key.startsWith(prefix)) continue
      const value = await this.getRecordAsync(key)
      if (value) return value
    }
    return null
  }

  async getRecordsPage (selfId = '', page = 1, pageSize = 20) {
    const size = Math.max(1, Number(pageSize) || 20)
    const requestedPage = Math.max(1, Number(page) || 1)
    const scanPage = this.type === 'level' && this._db ? Math.min(RECORD_PAGE_LIMIT, requestedPage) : requestedPage
    const wanted = scanPage * size
    const records = []
    const compare = (a, b) => String(b.last_time || '').localeCompare(String(a.last_time || ''))
    const add = value => {
      if (!value || (selfId && value.self_id !== selfId)) return
      records.push(value)
      records.sort(compare)
      if (this.type === 'level' && records.length > wanted) records.pop()
    }
    if (this.type === 'level' && this._db) {
      for await (const [key, value] of this._db.db.iterator()) {
        if (String(key).startsWith('__meta__')) continue
        add(value)
      }
    } else {
      for (const value of Object.values(this.records)) add(value)
    }
    const total = this.type === 'level' && this._db ? this._countRecordKeys(selfId) : records.length
    const pageCount = Math.max(1, Math.ceil(total / size))
    const current = Math.min(pageCount, scanPage)
    return { list: records.slice((current - 1) * size, current * size), total, page: current, pageCount }
  }

  async getAllRecords () {
    if (this.type !== 'level' || !this._db) return { ...this.records }
    const records = {}
    for await (const [key, value] of this._db.db.iterator()) {
      if (!String(key).startsWith('__meta__')) records[String(key)] = value
    }
    return records
  }

  getRecords () {
    return this.records
  }

  _countRecordKeys (selfId = '') {
    if (!selfId) return this._recordKeys.size
    const prefix = `${selfId}:`
    let count = 0
    for (const key of this._recordKeys) if (key.startsWith(prefix)) count++
    return count
  }

  getRecordCount (selfId = '') {
    if (this.type === 'level') {
      return this._countRecordKeys(selfId)
    }
    if (!selfId) return Object.keys(this.records).length
    return Object.values(this.records).filter(item => item.self_id === selfId).length
  }

  getStartTime (selfId = '') {
    return selfId ? this.meta.recordStartTimes?.[selfId] || this.meta.recordStartTime || '' : this.meta.recordStartTime || ''
  }

  getMeta () {
    return {
      recordStartTime: this.meta.recordStartTime || '',
      recordStartTimes: { ...(this.meta.recordStartTimes || {}) },
      botNicknames: { ...(this.meta.botNicknames || {}) },
      memberNicknames: { ...(this.meta.memberNicknames || {}) },
      blackGroups: { ...(this.meta.blackGroups || {}) }
    }
  }

  getBotNickname (selfId = '') {
    return selfId ? this.meta.botNicknames?.[selfId] || '' : ''
  }

  async setBotNickname (selfId = '', nickname = '') {
    if (!selfId || !nickname) return false
    if (!this.meta.botNicknames || typeof this.meta.botNicknames !== 'object') this.meta.botNicknames = {}
    if (this.meta.botNicknames[selfId] === nickname) return false
    this.meta.botNicknames[selfId] = nickname
    await this.saveMeta()
    return true
  }

  getMemberNickname (selfId = '', memberOpenid = '') {
    if (!selfId || !memberOpenid) return ''
    return this.meta.memberNicknames?.[`${selfId}:${memberOpenid}`]?.nickname || ''
  }

  async setMemberNickname (selfId = '', memberOpenid = '', nickname = '', extra = {}) {
    if (!selfId || !memberOpenid || !nickname) return false
    if (!this.meta.memberNicknames || typeof this.meta.memberNicknames !== 'object') this.meta.memberNicknames = {}
    const key = `${selfId}:${memberOpenid}`
    const current = this.meta.memberNicknames[key]
    if (current?.nickname === nickname && current?.role === extra.role && current?.group_openid === extra.group_openid) return false
    if (current) {
      delete this.meta.memberNicknames[key]
      this._memberNicknameOrder.delete(key)
    }
    this.meta.memberNicknames[key] = {
      nickname,
      role: extra.role || current?.role || '',
      group_openid: extra.group_openid || current?.group_openid || '',
      updated_at: new Date().toISOString()
    }
    this._memberNicknameOrder.set(key, true)
    while (this._memberNicknameOrder.size > MEMBER_NICKNAME_LIMIT) {
      const oldest = this._memberNicknameOrder.keys().next().value
      this._memberNicknameOrder.delete(oldest)
      delete this.meta.memberNicknames[oldest]
    }
    this._scheduleMetaSave()
    return true
  }

  getBlackGroups (selfId = '') {
    if (!this.meta.blackGroups || typeof this.meta.blackGroups !== 'object') this.meta.blackGroups = {}
    return Object.entries(this.meta.blackGroups)
      .filter(([key]) => !selfId || key.startsWith(`${selfId}:`))
      .map(([key, value]) => ({
        self_id: value.self_id || key.split(':')[0],
        group_openid: value.group_openid || key.slice(String(value.self_id || key.split(':')[0]).length + 1),
        time: value.time || ''
      }))
  }

  isBlackGroup (selfId = '', groupOpenid = '') {
    if (!selfId || !groupOpenid) return false
    return Boolean(this.meta.blackGroups?.[`${selfId}:${groupOpenid}`])
  }

  async addBlackGroup (selfId = '', groupOpenid = '') {
    if (!selfId || !groupOpenid) return false
    if (!this.meta.blackGroups || typeof this.meta.blackGroups !== 'object') this.meta.blackGroups = {}
    const key = `${selfId}:${groupOpenid}`
    if (this.meta.blackGroups[key]) return false
    this.meta.blackGroups[key] = { self_id: selfId, group_openid: groupOpenid, time: new Date().toISOString() }
    await this.saveMeta()
    return true
  }

  async removeBlackGroup (selfId = '', groupOpenid = '') {
    if (!selfId || !groupOpenid || !this.meta.blackGroups?.[`${selfId}:${groupOpenid}`]) return false
    delete this.meta.blackGroups[`${selfId}:${groupOpenid}`]
    await this.saveMeta()
    return true
  }

  async ensureStartTime (selfId = '') {
    if (selfId) {
      if (this.meta.recordStartTimes?.[selfId]) return false
      if (!this.meta.recordStartTimes || typeof this.meta.recordStartTimes !== 'object') this.meta.recordStartTimes = {}
      this.meta.recordStartTimes[selfId] = new Date().toISOString()
      await this.saveMeta()
      return true
    }

    if (this.meta.recordStartTime) return false
    this.meta.recordStartTime = new Date().toISOString()
    await this.saveMeta()
    return true
  }

  async clearStartTime (selfId = '') {
    if (selfId) {
      if (!this.meta.recordStartTimes?.[selfId]) return false
      delete this.meta.recordStartTimes[selfId]
    } else {
      this.meta.recordStartTime = ''
      this.meta.recordStartTimes = {}
    }
    await this.saveMeta()
    return true
  }

  async clearRecords (selfId = '') {
    if (this.type === 'level' && this._db) {
      const prefix = selfId ? `${selfId}:` : ''
      const keys = []
      let count = 0
      const flush = async () => {
        if (!keys.length) return
        await this._db.db.batch(keys.splice(0).map(key => ({ type: 'del', key })))
      }
      for await (const [rawKey] of this._db.db.iterator()) {
        const key = String(rawKey)
        if (key.startsWith('__meta__') || (prefix && !key.startsWith(prefix))) continue
        count++
        this._recordKeys.delete(key)
        this._recordCacheOrder.delete(key)
        delete this.records[key]
        keys.push(key)
        if (keys.length >= 500) await flush()
      }
      await flush()
      return count
    }

    const entries = Object.entries(this.records)
    const toDelete = selfId ? entries.filter(([, item]) => item.self_id === selfId) : entries
    for (const [key] of toDelete) delete this.records[key]
    this._recordKeys = new Set(Object.keys(this.records))
    this._recordCacheOrder.clear()
    this._scheduleJsonSave()
    return toDelete.length
  }

  async migrateFromConfig (records) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) return 0
    const entries = Object.entries(records)
    if (!entries.length) return 0

    for (const [key, value] of entries) {
      this._cacheRecord(key, value)
      this._recordKeys.add(String(key))
    }

    if (this.type === 'level' && this._db) {
      for (const [key, value] of entries) {
        await this._db.set(key, value, 0)
      }
    } else {
      this._scheduleJsonSave()
    }

    return entries.length
  }

  async migrateMetaFromConfig (fullMessage = {}) {
    let changed = false
    if (typeof fullMessage.recordStartTime === 'string' && fullMessage.recordStartTime && !this.meta.recordStartTime) {
      this.meta.recordStartTime = fullMessage.recordStartTime
      changed = true
    }
    if (fullMessage.recordStartTimes && typeof fullMessage.recordStartTimes === 'object' && !Array.isArray(fullMessage.recordStartTimes)) {
      if (!this.meta.recordStartTimes || typeof this.meta.recordStartTimes !== 'object') this.meta.recordStartTimes = {}
      for (const [key, value] of Object.entries(fullMessage.recordStartTimes)) {
        if (!this.meta.recordStartTimes[key]) {
          this.meta.recordStartTimes[key] = value
          changed = true
        }
      }
    }
    if (fullMessage.botNicknames && typeof fullMessage.botNicknames === 'object' && !Array.isArray(fullMessage.botNicknames)) {
      if (!this.meta.botNicknames || typeof this.meta.botNicknames !== 'object') this.meta.botNicknames = {}
      for (const [key, value] of Object.entries(fullMessage.botNicknames)) {
        if (!this.meta.botNicknames[key] && value) {
          this.meta.botNicknames[key] = value
          changed = true
        }
      }
    }
    if (fullMessage.memberNicknames && typeof fullMessage.memberNicknames === 'object' && !Array.isArray(fullMessage.memberNicknames)) {
      if (!this.meta.memberNicknames || typeof this.meta.memberNicknames !== 'object') this.meta.memberNicknames = {}
      for (const [key, value] of Object.entries(fullMessage.memberNicknames)) {
        if (!this.meta.memberNicknames[key] && value) {
          this.meta.memberNicknames[key] = value
          changed = true
        }
      }
    }
    if (fullMessage.blackGroups && typeof fullMessage.blackGroups === 'object' && !Array.isArray(fullMessage.blackGroups)) {
      if (!this.meta.blackGroups || typeof this.meta.blackGroups !== 'object') this.meta.blackGroups = {}
      for (const [key, value] of Object.entries(fullMessage.blackGroups)) {
        if (!this.meta.blackGroups[key] && value) {
          this.meta.blackGroups[key] = value
          changed = true
        }
      }
    }
    if (changed) await this.saveMeta()
    if (changed) this._rebuildMemberNicknameOrder()
    return changed
  }

  async close () {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this._metaSaveTimer) {
      clearTimeout(this._metaSaveTimer)
      this._metaSaveTimer = null
    }
    if (this.type === 'level' && this._db) {
      try { await this._db.set('__meta__', this.meta, 0) } catch {}
    }
    if (this.type === 'json' && this._ready) {
      this._writeJsonAtomic(this._jsonPath(), this.records, '_jsonWriteQueue')
      this._writeJsonAtomic(this._metaJsonPath(), this.meta, '_metaWriteQueue')
      await Promise.allSettled([this._jsonWriteQueue, this._metaWriteQueue])
    }
    if (this._db) {
      try { await this._db.close() } catch {}
      this._db = null
    }
    this.records = {}
    this._recordKeys.clear()
    this._recordCacheOrder.clear()
    this._ready = false
  }
}

const store = new FullMessageStore()

export default store
