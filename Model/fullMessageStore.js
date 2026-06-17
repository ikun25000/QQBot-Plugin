import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotFullMessage')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'fullMessage')

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

    if (type === 'level') {
      try {
        const { default: Level } = await import('./level.js')
        fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
        this._db = new Level(LEVEL_DATA_DIR)
        await this._db.open()
        for await (const [key, value] of this._db.db.iterator()) {
          if (String(key).startsWith('__meta__')) continue
          this.records[key] = value
        }
        this.meta = await this._db.get('__meta__') || this.meta
      } catch (err) {
        logger.error('[QQBot-Plugin] fullMessageStore LevelDB init failed, fallback to json:', err.message)
        this.type = 'json'
        if (this._db) { try { this._db.close() } catch {} this._db = null }
      }
    }

    if (this.type === 'json') {
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      this._loadJson()
      this._loadMetaJson()
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

  _scheduleJsonSave () {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._writeJsonAtomic(this._jsonPath(), this.records, '_jsonWriteQueue')
      this._saveTimer = null
    }, 1000)
  }

  _scheduleMetaSave () {
    if (this._metaSaveTimer) clearTimeout(this._metaSaveTimer)
    this._metaSaveTimer = setTimeout(() => {
      this._writeJsonAtomic(this._metaJsonPath(), this.meta, '_metaWriteQueue')
      this._metaSaveTimer = null
    }, 1000)
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
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }

  async saveMeta () {
    if (this.type === 'level' && this._db) {
      await this._db.set('__meta__', this.meta, 0)
    } else {
      this._scheduleMetaSave()
    }
  }

  async setRecord (key, value) {
    this.records[key] = value
    if (this.type === 'level' && this._db) {
      await this._db.set(key, value, 0)
    } else {
      this._scheduleJsonSave()
    }
  }

  getRecord (key) {
    return this.records[key] || null
  }

  getRecords () {
    return this.records
  }

  getRecordCount (selfId = '') {
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
    this.meta.memberNicknames[key] = {
      nickname,
      role: extra.role || current?.role || '',
      group_openid: extra.group_openid || current?.group_openid || '',
      updated_at: new Date().toISOString()
    }
    await this.saveMeta()
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
    const entries = Object.entries(this.records)
    let count
    if (!selfId) {
      count = entries.length
      this.records = {}
    } else {
      const toDelete = entries.filter(([, item]) => item.self_id === selfId)
      count = toDelete.length
      for (const [key] of toDelete) {
        delete this.records[key]
      }
    }

    if (this.type === 'level' && this._db) {
      const keysToDelete = !selfId
        ? entries.map(([k]) => k)
        : entries.filter(([, item]) => item.self_id === selfId).map(([k]) => k)
      for (const key of keysToDelete) {
        try { await this._db.db.del(key) } catch {}
      }
    } else {
      this._scheduleJsonSave()
    }

    return count
  }

  async migrateFromConfig (records) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) return 0
    const entries = Object.entries(records)
    if (!entries.length) return 0

    for (const [key, value] of entries) {
      this.records[key] = value
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
    if (this.type === 'json' && this._ready) {
      this._writeJsonAtomic(this._jsonPath(), this.records, '_jsonWriteQueue')
      this._writeJsonAtomic(this._metaJsonPath(), this.meta, '_metaWriteQueue')
      await Promise.allSettled([this._jsonWriteQueue, this._metaWriteQueue])
    }
    if (this._db) {
      try { this._db.close() } catch {}
      this._db = null
    }
    this._ready = false
  }
}

const store = new FullMessageStore()

export default store
