import fs from 'node:fs'
import { join } from 'node:path'
import { pluginPath } from './common.js'

const LEVEL_DATA_DIR = join(pluginPath, 'db', 'userManage')
const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotUserManage')
const HISTORY_LIMIT = 500

function nowIso () { return new Date().toISOString() }
function safeText (value = '', max = 200) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '')
  return max > 0 ? text.slice(0, max) : text
}
function safeClone (value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, val) => {
      if (key === 'bot' || key === 'sdk' || key === 'adapter') return undefined
      if (typeof val === 'bigint') return String(val)
      if (typeof val === 'function') return undefined
      return val
    }))
  } catch {
    return null
  }
}
function pageSlice (list = [], page = 1, size = 10) {
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
      histories: {},
      historySeqs: {}
    }
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'userManage.json') }
  _key (selfId, id) { return `${selfId}:${id}` }
  _historyKey (selfId, targetOpenid, type = 'group') { return type === 'user' ? `user:${selfId}:${targetOpenid}` : `${selfId}:${targetOpenid}` }

  async init () {
    if (this._ready) return
    this._data = this._empty()
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open()
      for await (const [key, value] of this._db.db.iterator()) this._setByKey(key, value)
    } catch (err) {
      logger.error('[QQBot-Plugin] userManageStore LevelDB init failed, fallback to json:', err.message)
      this.type = 'json'
      if (this._db) { try { this._db.close() } catch {}; this._db = null }
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try { this._data = { ...this._empty(), ...JSON.parse(fs.readFileSync(this._jsonPath(), 'utf-8')) } } catch { this._data = this._empty() }
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
    else if (key.startsWith('history:')) this._data.histories[key.slice(8)] = value
  }

  _scheduleSave () {
    if (this.type === 'level' && this._db) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(async () => {
      const file = this._jsonPath()
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(this._data, null, 2), 'utf-8')
        await fs.promises.rename(tmp, file)
      } catch (err) {
        try { await fs.promises.unlink(tmp) } catch {}
        logger.error('[QQBot-Plugin] userManageStore JSON save error:', err.message)
      }
      this._saveTimer = null
    }, 1000)
  }

  async _save (prefix, key, value) {
    if (this.type === 'level' && this._db) await this._db.set(`${prefix}:${key}`, value, 0)
    else this._scheduleSave()
  }

  async _del (prefix, key) {
    if (this.type === 'level' && this._db) { try { await this._db.db.del(`${prefix}:${key}`) } catch {} } else this._scheduleSave()
  }

  async recordUser (selfId = '', userOpenid = '', info = {}) {
    if (!selfId || !userOpenid || String(userOpenid).startsWith('qg_')) return null
    const key = this._key(selfId, userOpenid)
    const old = this._data.users[key] || {}
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
    this._data.users[key] = item
    await this._save('user', key, item)
    return item
  }

  async recordGroup (selfId = '', groupOpenid = '', info = {}) {
    if (!selfId || !groupOpenid || String(groupOpenid).startsWith('qg')) return null
    const key = this._key(selfId, groupOpenid)
    const old = this._data.groups[key] || {}
    const item = { ...old, self_id: selfId, openid: groupOpenid, first_seen_at: old.first_seen_at || nowIso(), last_seen_at: nowIso() }
    if (info.name) item.name = safeText(info.name, 120)
    this._data.groups[key] = item
    await this._save('group', key, item)
    return item
  }

  async recordHistory (selfId = '', targetOpenid = '', msg = {}) {
    if (!selfId || !targetOpenid || String(targetOpenid).startsWith('qg')) return false
    const key = this._historyKey(selfId, targetOpenid, msg.type || 'group')
    const list = Array.isArray(this._data.histories[key]) ? this._data.histories[key] : []
    const listSeq = list.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
    const lastSeq = Math.max(Number(this._data.historySeqs[key]) || 0, listSeq)
    const seq = Number(msg.seq) || lastSeq + 1
    list.push({
      seq,
      message_id: msg.message_id || '',
      aliases: Array.isArray(msg.aliases) ? [...new Set(msg.aliases.filter(Boolean).map(String))] : [],
      user_openid: msg.user_openid || '',
      nickname: safeText(msg.nickname || '', 80),
      bot: msg.bot === true,
      raw_message: safeText(msg.raw_message || '', 0),
      raw: safeClone(msg.raw),
      time: msg.time || nowIso()
    })
    while (list.length > HISTORY_LIMIT) list.shift()
    this._data.histories[key] = list
    this._data.historySeqs[key] = Math.max(lastSeq, seq)
    await this._save('historySeq', key, this._data.historySeqs[key])
    await this._save('history', key, list)
    return seq
  }

  getHistory (selfId = '', targetOpenid = '', seq = 0, count = 20, type = 'group') {
    const list = Array.isArray(this._data.histories[this._historyKey(selfId, targetOpenid, type)]) ? this._data.histories[this._historyKey(selfId, targetOpenid, type)] : []
    const n = Math.max(0, Number(count) || 0)
    if (n <= 0) return []
    const targetSeq = Number(seq) || 0
    if (targetSeq <= 0) return []
    return list.filter(item => Number(item.seq) <= targetSeq).slice(-n).reverse()
  }

  getRecentHistory (selfId = '', targetOpenid = '', count = 20, type = 'group') {
    const list = Array.isArray(this._data.histories[this._historyKey(selfId, targetOpenid, type)]) ? this._data.histories[this._historyKey(selfId, targetOpenid, type)] : []
    const n = Math.max(0, Number(count) || 0)
    if (n <= 0) return []
    return list.slice(-n).reverse()
  }

  getRecentHistoryPage (selfId = '', targetOpenid = '', page = 1, size = 20, type = 'group') {
    const list = Array.isArray(this._data.histories[this._historyKey(selfId, targetOpenid, type)]) ? this._data.histories[this._historyKey(selfId, targetOpenid, type)] : []
    return pageSlice([...list].reverse(), page, size)
  }

  listRecentGroupHistories (selfId = '', page = 1, size = 20) {
    const rows = []
    for (const [key, list] of Object.entries(this._data.histories)) {
      if (key.startsWith('user:') || !key.startsWith(`${selfId}:`) || !Array.isArray(list)) continue
      const groupOpenid = key.slice(String(selfId).length + 1)
      for (const item of list) rows.push({ ...item, group_openid: groupOpenid })
    }
    rows.sort((a, b) => {
      const ta = Date.parse(a.time || '') || Number(a.time) || 0
      const tb = Date.parse(b.time || '') || Number(b.time) || 0
      return tb - ta || String(b.group_openid || '').localeCompare(String(a.group_openid || '')) || (Number(b.seq) || 0) - (Number(a.seq) || 0)
    })
    return pageSlice(rows, page, size)
  }

  async deleteRecentHistory (selfId = '', targetOpenid = '', count = 20, type = 'group') {
    const key = this._historyKey(selfId, targetOpenid, type)
    const list = Array.isArray(this._data.histories[key]) ? this._data.histories[key] : []
    if (!list.length) return 0
    const n = String(count) === '全部' ? list.length : Math.max(0, Number(count) || 0)
    if (n <= 0) return 0
    const maxSeq = list.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
    this._data.historySeqs[key] = Math.max(Number(this._data.historySeqs[key]) || 0, maxSeq)
    await this._save('historySeq', key, this._data.historySeqs[key])
    const deleted = Math.min(n, list.length)
    list.splice(Math.max(0, list.length - deleted), deleted)
    this._data.histories[key] = list
    await this._save('history', key, list)
    return deleted
  }

  async clearGroupHistories (selfId = '') {
    let messageCount = 0
    let groupCount = 0
    for (const key of Object.keys(this._data.histories)) {
      if (key.startsWith('user:')) continue
      if (!key.startsWith(`${selfId}:`)) continue
      const list = Array.isArray(this._data.histories[key]) ? this._data.histories[key] : []
      if (!list.length) continue
      const maxSeq = list.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
      this._data.historySeqs[key] = Math.max(Number(this._data.historySeqs[key]) || 0, maxSeq)
      await this._save('historySeq', key, this._data.historySeqs[key])
      messageCount += list.length
      groupCount++
      this._data.histories[key] = []
      await this._save('history', key, [])
    }
    return { messageCount, groupCount }
  }

  findHistoryByMessageId (selfId = '', targetOpenid = '', messageId = '', type = 'group') {
    if (!messageId) return null
    const list = Array.isArray(this._data.histories[this._historyKey(selfId, targetOpenid, type)]) ? this._data.histories[this._historyKey(selfId, targetOpenid, type)] : []
    const id = String(messageId)
    return list.find(item => item.message_id === id || item.aliases?.includes?.(id)) || null
  }

  findHistoryByAnyId (selfId = '', targetOpenid = '', ids = [], type = 'group') {
    for (const id of ids.filter(Boolean).map(String)) {
      const item = this.findHistoryByMessageId(selfId, targetOpenid, id, type)
      if (item) return item
    }
    return null
  }

  findRecentHistoryByContent (selfId = '', targetOpenid = '', content = '', bot, type = 'group') {
    const text = safeText(String(content || '').replace(/\s+/g, ' ').trim(), 0)
    if (!text) return null
    const list = Array.isArray(this._data.histories[this._historyKey(selfId, targetOpenid, type)]) ? this._data.histories[this._historyKey(selfId, targetOpenid, type)] : []
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (typeof bot === 'boolean' && item.bot !== bot) continue
      if (safeText(String(item.raw_message || '').replace(/\s+/g, ' ').trim(), 0) === text) return item
    }
    return null
  }

  findHistoryBySeq (selfId = '', targetOpenid = '', seq = 0, type = 'group') {
    const targetSeq = Number(String(seq).replace(/^#/, '')) || 0
    if (!targetSeq) return null
    const list = Array.isArray(this._data.histories[this._historyKey(selfId, targetOpenid, type)]) ? this._data.histories[this._historyKey(selfId, targetOpenid, type)] : []
    return list.find(item => Number(item.seq) === targetSeq) || null
  }

  listUsers (selfId = '', page = 1, size = 10) { return pageSlice(Object.values(this._data.users).filter(i => i.self_id === selfId), page, size) }
  listGroups (selfId = '', page = 1, size = 10) { return pageSlice(Object.values(this._data.groups).filter(i => i.self_id === selfId), page, size) }
  searchUsers (selfId = '', keyword = '') {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return []
    return Object.values(this._data.users).filter(i => {
      if (i.self_id !== selfId) return false
      const haystack = [i.openid, i.nickname, ...Object.keys(i.groups || {})].filter(Boolean).join('\n').toLowerCase()
      return haystack.includes(kw)
    })
  }
  searchUsersPage (selfId = '', keyword = '', page = 1, size = 50) { return pageSlice(this.searchUsers(selfId, keyword), page, size) }
  searchUsersByNicknamePage (selfId = '', keyword = '', page = 1, size = 50) {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return pageSlice([], page, size)
    const list = Object.values(this._data.users).filter(i => i.self_id === selfId && String(i.nickname || '').toLowerCase().includes(kw))
    return pageSlice(list, page, size)
  }
  getUser (selfId = '', openid = '') { return this._data.users[this._key(selfId, openid)] || null }
  getGroup (selfId = '', openid = '') { return this._data.groups[this._key(selfId, openid)] || null }
  getGroupMembers (selfId = '', groupOpenid = '', page = 1, size = 10) { return pageSlice(Object.values(this._data.users).filter(i => i.self_id === selfId && i.groups?.[groupOpenid]), page, size) }

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
    const key = this._key(selfId, openid)
    const item = { self_id: selfId, openid, code, expire_at: Date.now() + 60000, time: nowIso() }
    this._data.pendingCancels[key] = item
    await this._save('pendingCancel', key, item)
    return item
  }

  getPendingCancel (selfId = '', openid = '') {
    const item = this._data.pendingCancels[this._key(selfId, openid)]
    if (!item || Number(item.expire_at) < Date.now()) return null
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
