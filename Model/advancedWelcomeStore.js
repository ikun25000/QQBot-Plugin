import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotAdvancedWelcome')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'advancedWelcome')

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
    this._data = { groups: {}, pendingComplaints: {}, messageIds: {} }
    this._db = null
    this._ready = false
    this._saveTimer = null
    this._writeQueue = Promise.resolve()
    this._writeSeq = 0
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'advancedWelcome.json') }

  async init () {
    if (this._ready) return
    this._data = { groups: {}, pendingComplaints: {}, messageIds: {} }
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open()
      for await (const [key, value] of this._db.db.iterator()) this._setByKey(key, value)
    } catch (err) {
      logger.error('[QQBot-Plugin] advancedWelcomeStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { this._db.close() } catch {}; this._db = null }
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        this._data = { groups: {}, pendingComplaints: {}, messageIds: {}, ...JSON.parse(fs.readFileSync(this._jsonPath(), 'utf-8')) }
      } catch {
        this._data = { groups: {}, pendingComplaints: {}, messageIds: {} }
      }
    }
    this._ready = true
  }

  _setByKey (key, value) {
    if (String(key).startsWith('group:')) this._data.groups[String(key).slice(6)] = value
    else if (String(key).startsWith('pending:')) this._data.pendingComplaints[String(key).slice(8)] = value
    else if (String(key).startsWith('msg:')) this._data.messageIds[String(key).slice(4)] = value
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
    item.full_message_active = fullMessageCreate === true
    if (fullMessageCreate) item.full_message_create_count = (Number(item.full_message_create_count) || 0) + 1
    if (messageId) {
      if (item.recent_message_ids.includes(messageId)) return false
      item.recent_message_ids.push(messageId)
      if (item.recent_message_ids.length > 200) item.recent_message_ids.splice(0, item.recent_message_ids.length - 200)
    }
    if (fullMessageCreate) item.speech_since_sent = (Number(item.speech_since_sent) || 0) + 1
    else item.speech_since_sent = 0
    await this.saveGroup(item)
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
    const key = this._pendingKey(selfId, groupOpenid, userOpenid)
    const item = { self_id: selfId, group_openid: groupOpenid, user_openid: userOpenid, code, expire_at: Date.now() + 60000, created_at: nowIso() }
    this._data.pendingComplaints[key] = item
    await this._save(`pending:${key}`, item)
    return item
  }

  getPendingComplaint (selfId = '', groupOpenid = '', userOpenid = '') {
    const key = this._pendingKey(selfId, groupOpenid, userOpenid)
    const item = this._data.pendingComplaints[key]
    if (!item || Number(item.expire_at) < Date.now()) return null
    return item
  }

  findPendingComplaintByCode (selfId = '', groupOpenid = '', code = '') {
    const target = String(code || '')
    if (!target) return null
    for (const item of Object.values(this._data.pendingComplaints)) {
      if (item?.self_id === selfId && item?.group_openid === groupOpenid && item?.code === target && Number(item.expire_at) >= Date.now()) return item
    }
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
    const item = { ...record, time: record.time || nowIso() }
    this._data.messageIds[record.message_id] = item
    await this._save(`msg:${record.message_id}`, item)
    for (const alias of Array.isArray(record.aliases) ? record.aliases : []) {
      if (!alias || alias === record.message_id) continue
      const aliasItem = { ...item, message_id: alias, actual_message_id: record.message_id }
      this._data.messageIds[alias] = aliasItem
      await this._save(`msg:${alias}`, aliasItem)
      if (record.self_id && record.target_id && record.type) {
        const scopedAlias = this._messageAliasKey(record.self_id, record.type, record.target_id, alias)
        const oldScoped = this._data.messageIds[scopedAlias]
        const oldActualId = oldScoped?.actual_message_id || oldScoped?.message_id || ''
        const scopedItem = oldActualId && oldActualId !== record.message_id
          ? {
              ...aliasItem,
              ambiguous: true,
              actual_message_ids: [...new Set([...(oldScoped.actual_message_ids || [oldActualId]), record.message_id].filter(Boolean))]
            }
          : aliasItem
        this._data.messageIds[scopedAlias] = scopedItem
        await this._save(`msg:${scopedAlias}`, scopedItem)
      }
    }
    return true
  }

  _messageAliasKey (selfId = '', type = '', targetId = '', alias = '') {
    return `alias:${selfId}:${type}:${targetId}:${alias}`
  }

  getMessageIndex (messageId = '', context = {}) {
    if (!messageId) return null
    if (context.selfId && context.type && context.targetId) {
      const scoped = this._data.messageIds[this._messageAliasKey(context.selfId, context.type, context.targetId, messageId)]
      if (scoped) return scoped.ambiguous ? null : scoped
    }
    const item = this._data.messageIds[messageId] || null
    if (!item) return null
    if (context.selfId && item.self_id !== context.selfId) return null
    if (context.type && item.type !== context.type) return null
    if (context.targetId && item.target_id !== context.targetId) return null
    return item
  }

  findRecallCandidatesByContent (selfId = '', targetId = '', content = '', options = {}) {
    const text = String(content || '').replace(/\s+/g, ' ').trim()
    if (!selfId || !targetId || !text) return { items: [], total: 0, truncated: false }
    const beforeTime = Number(options.beforeTime) || Date.now()
    const beforeSeq = Number(options.beforeSeq) || 0
    const limitMs = Math.max(1, Number(options.limitMs) || 10 * 60 * 1000)
    const limit = Math.max(1, Number(options.limit) || 20)
    const excludedIds = new Set((options.excludeMessageIds || []).filter(Boolean).map(String))
    const candidates = Object.values(this._data.messageIds)
      .filter(item => {
        if (!item || item.actual_message_id || item.self_id !== selfId || item.target_id !== targetId || item.type !== 'group') return false
        if (excludedIds.has(String(item.message_id || ''))) return false
        if (!/^ROBOT\d+\.\d+_/i.test(String(item.message_id || ''))) return false
        if (item.bot === true || item.member_role !== 'member') return false
        if (String(item.content_fingerprint || '').replace(/\s+/g, ' ').trim() !== text) return false
        const itemTime = Date.parse(item.time || '') || Number(item.time) || 0
        if (!(itemTime > 0 && itemTime <= beforeTime && beforeTime - itemTime <= limitMs)) return false
        const itemSeq = Number(item.seq) || 0
        return !(beforeSeq && itemSeq && itemSeq >= beforeSeq)
      })
      .sort((a, b) => (Date.parse(b.time || '') || Number(b.time) || 0) - (Date.parse(a.time || '') || Number(a.time) || 0))
    return {
      items: candidates.slice(0, limit),
      total: candidates.length,
      truncated: candidates.length > limit
    }
  }

  findRecentMessageByContent (selfId = '', targetId = '', content = '', options = {}) {
    const text = String(content || '').trim()
    if (!selfId || !targetId || !text) return null
    const limitMs = Number(options.limitMs) || 10 * 60 * 1000
    const authorBot = options.bot
    const now = Date.now()
    const items = Object.values(this._data.messageIds)
      .filter(item => {
        if (!item || item.actual_message_id) return false
        if (item.self_id !== selfId || item.target_id !== targetId || item.type !== 'group') return false
        if (item.content_fingerprint !== text) return false
        if (authorBot !== undefined && item.bot !== authorBot) return false
        const time = Date.parse(item.time || '')
        return !Number.isFinite(time) || now - time <= limitMs
      })
      .sort((a, b) => Date.parse(b.time || '') - Date.parse(a.time || ''))
    return items[0] || null
  }
}

const store = new AdvancedWelcomeStore()
export default store
