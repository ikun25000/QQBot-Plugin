import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotChat')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'chat')

function dayKey (offset = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
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
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'chat.json') }

  async init () {
    if (this._ready) return
    this.type = 'level'
    this._data = {}
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open()
      for await (const [key, value] of this._db.db.iterator()) this._data[key] = value
    } catch (err) {
      logger.error('[QQBot-Plugin] chatStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { this._db.close() } catch {} this._db = null }
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        this._data = JSON.parse(fs.readFileSync(this._jsonPath(), 'utf-8')) || {}
      } catch {
        this._data = {}
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

  async recordUserMessage (selfId = '', userOpenid = '', scope = '', targetOpenid = '', timestamp = '') {
    if (!selfId || !userOpenid || !['group', 'private'].includes(scope)) return null
    const date = timestamp ? new Date(timestamp) : new Date()
    const day = Number.isNaN(date.getTime()) ? dayKey() : date.toISOString().slice(0, 10)
    const key = this._makeKey(selfId, userOpenid, scope, targetOpenid, day)
    const item = this._data[key] || { self_id: selfId, user_openid: userOpenid, scope, target_openid: targetOpenid || '', day, count: 0, first_time: '', last_time: '' }
    const now = new Date().toISOString()
    item.count = Number(item.count) + 1
    if (!item.first_time) item.first_time = now
    item.last_time = now
    this._data[key] = item
    if (this.type === 'level' && this._db) await this._db.set(key, item, 31)
    else this._scheduleSave()
    return this.getUserStats(selfId, userOpenid, scope, targetOpenid)
  }

  _sum (selfId, userOpenid, days, scope = '', targetOpenid = '') {
    let total = 0
    for (const item of Object.values(this._data)) {
      if (item.self_id !== selfId || item.user_openid !== userOpenid || !days.includes(item.day)) continue
      if (scope && item.scope !== scope) continue
      if (targetOpenid && item.target_openid !== targetOpenid) continue
      total += Number(item.count) || 0
    }
    return total
  }

  getUserStats (selfId = '', userOpenid = '', scope = '', targetOpenid = '') {
    if (!selfId || !userOpenid) return null
    const build = period => {
      const days = periodDays(period)
      return {
        total: this._sum(selfId, userOpenid, days),
        group: this._sum(selfId, userOpenid, days, 'group'),
        private: this._sum(selfId, userOpenid, days, 'private'),
        current: scope ? this._sum(selfId, userOpenid, days, scope, scope === 'group' ? targetOpenid : '') : 0
      }
    }

    const currentForPeriod = period => build(period).current
    return {
      user_openid: userOpenid,
      scope,
      target_openid: targetOpenid || '',
      today: currentForPeriod('today'),
      yesterday: currentForPeriod('yesterday'),
      week: currentForPeriod('week'),
      month: currentForPeriod('month'),
      total: {
        today: build('today').total,
        yesterday: build('yesterday').total,
        week: build('week').total,
        month: build('month').total
      },
      breakdown: {
        today: { group: build('today').group, private: build('today').private },
        yesterday: { group: build('yesterday').group, private: build('yesterday').private },
        week: { group: build('week').group, private: build('week').private },
        month: { group: build('month').group, private: build('month').private }
      }
    }
  }

  async close () {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null }
    if (this.type === 'json' && this._ready) {
      this._scheduleSave()
      await this._writeQueue.catch(() => {})
    }
    if (this._db) { try { this._db.close() } catch {}; this._db = null }
    this._ready = false
  }
}

const store = new ChatStore()
export default store
