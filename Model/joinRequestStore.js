import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotJoinRequest')
const pluginPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'joinRequest')
const JSON_VERSION = 1
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500

function nowIso () { return new Date().toISOString() }

function logError (...args) {
  if (globalThis.logger?.error) globalThis.logger.error(...args)
  else console.error(...args)
}

function clone (value) {
  if (value == null) return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function jsonObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  try { return JSON.parse(JSON.stringify(value)) }
  catch { return {} }
}

function mergeJsonObjects (...values) {
  const result = {}
  for (const value of values) {
    for (const [key, next] of Object.entries(jsonObject(value))) {
      const previous = result[key]
      result[key] = previous && typeof previous === 'object' && !Array.isArray(previous) && next && typeof next === 'object' && !Array.isArray(next)
        ? mergeJsonObjects(previous, next)
        : next
    }
  }
  return result
}

function toIso (value, fallback = '') {
  if (value == null || value === '') return fallback
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : NaN
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10000000000 ? numeric * 1000 : numeric)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

class JoinRequestStore {
  constructor () {
    this.type = 'level'
    this._records = new Map()
    this._db = null
    this._ready = false
    this._initPromise = null
    this._saveTimer = null
    this._writeQueue = Promise.resolve()
    this._mutationQueue = Promise.resolve()
    this._writeSeq = 0
    this._nextOrder = 1
    this._unreadBySelf = new Map()
    this._unreadByGroup = new Map()
  }

  _jsonPath () { return join(JSON_DATA_DIR, 'join_requests.json') }

  _recordKey (selfId, groupOpenid, requestId) {
    return JSON.stringify([String(selfId), String(groupOpenid), String(requestId)])
  }

  _levelKey (record) {
    return `request:${encodeURIComponent(record.self_id)}:${encodeURIComponent(record.group_openid)}:${encodeURIComponent(record.join_request_id)}`
  }

  _assertReady () {
    if (!this._ready) throw new Error('joinRequestStore is not initialized')
  }

  async init (type = 'level') {
    if (this._ready && this.type === type) return this
    if (this._initPromise) return this._initPromise
    if (this._ready) await this.close()

    this._initPromise = (async () => {
      this.type = type === 'json' ? 'json' : 'level'
      this._records = new Map()
      this._nextOrder = 1
      this._unreadBySelf.clear()
      this._unreadByGroup.clear()

      if (this.type === 'level') {
        try {
          const { default: Level } = await import('./level.js')
          fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
          this._db = new Level(LEVEL_DATA_DIR)
          await this._db.open({ cleanup: false })
          for await (const [key, value] of this._db.db.iterator({ gte: 'request:', lt: 'request;' })) {
            if (!String(key).startsWith('request:')) continue
            this._loadRecord(value)
          }
        } catch (err) {
          logError('[QQBot-Plugin] joinRequestStore LevelDB init failed, fallback to json:', err.message)
          await this._closeLevel()
          this.type = 'json'
          this._records = new Map()
          this._nextOrder = 1
        }
      }

      if (this.type === 'json') {
        fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
        this._loadJson()
      }

      this._ready = true
      return this
    })()

    try { return await this._initPromise }
    finally { this._initPromise = null }
  }

  _loadRecord (value) {
    if (!value?.self_id || !value?.group_openid || !value?.join_request_id) return
    const item = jsonObject(value)
    item.self_id = String(item.self_id)
    item.group_openid = String(item.group_openid)
    item.join_request_id = String(item.join_request_id)
    item.store_order = Number(item.store_order) || this._nextOrder
    this._nextOrder = Math.max(this._nextOrder, item.store_order + 1)
    this._records.set(this._recordKey(item.self_id, item.group_openid, item.join_request_id), item)
    if (item.unread === true) this._incrementUnread(item)
  }

  _unreadKey (selfId, groupOpenid = '') { return `${String(selfId)}:${String(groupOpenid)}` }

  _incrementUnread (item) {
    this._unreadBySelf.set(item.self_id, (this._unreadBySelf.get(item.self_id) || 0) + 1)
    const key = this._unreadKey(item.self_id, item.group_openid)
    this._unreadByGroup.set(key, (this._unreadByGroup.get(key) || 0) + 1)
  }

  _decrementUnread (item) {
    if (item?.unread !== true) return
    const selfCount = Math.max(0, (this._unreadBySelf.get(item.self_id) || 1) - 1)
    if (selfCount) this._unreadBySelf.set(item.self_id, selfCount)
    else this._unreadBySelf.delete(item.self_id)
    const key = this._unreadKey(item.self_id, item.group_openid)
    const groupCount = Math.max(0, (this._unreadByGroup.get(key) || 1) - 1)
    if (groupCount) this._unreadByGroup.set(key, groupCount)
    else this._unreadByGroup.delete(key)
  }

  _loadJson () {
    const file = this._jsonPath()
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      const records = Array.isArray(parsed) ? parsed : parsed?.records
      for (const item of Array.isArray(records) ? records : []) this._loadRecord(item)
    } catch (err) {
      if (err.code === 'ENOENT') return
      const backup = `${file}.corrupt.${Date.now()}`
      try { fs.renameSync(file, backup) } catch {}
      logError('[QQBot-Plugin] joinRequestStore JSON load failed; corrupt data was preserved:', err.message)
    }
  }

  async _closeLevel () {
    if (!this._db) return
    try { this._db.job?.cancel() } catch {}
    try { await this._db.db.close() } catch {}
    this._db = null
  }

  _enqueueMutation (task) {
    const result = this._mutationQueue.catch(() => {}).then(task)
    this._mutationQueue = result
    return result
  }

  _scheduleSave () {
    if (this.type === 'level' && this._db) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this._queueJsonWrite()
    }, 500)
  }

  _queueJsonWrite () {
    const payload = JSON.stringify({
      version: JSON_VERSION,
      records: [...this._records.values()]
    }, null, 2)
    const file = this._jsonPath()
    this._writeQueue = this._writeQueue.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.${Date.now()}.${++this._writeSeq}.tmp`
      const lock = `${file}.lock`
      let lockHandle = null
      try {
        lockHandle = await this._acquireFileLock(lock)
        await fs.promises.writeFile(tmp, payload, 'utf-8')
        await fs.promises.rename(tmp, file)
      } catch (err) {
        try { await fs.promises.unlink(tmp) } catch {}
        logError('[QQBot-Plugin] joinRequestStore JSON save error:', err)
      } finally {
        if (lockHandle) {
          try { await lockHandle.close() } catch {}
          try { await fs.promises.unlink(lock) } catch {}
        }
      }
    })
    return this._writeQueue
  }

  async _acquireFileLock (file, retries = 50) {
    for (let i = 0; i < retries; i++) {
      try { return await fs.promises.open(file, 'wx') }
      catch (err) {
        if (err.code !== 'EEXIST' || i === retries - 1) throw err
        try {
          const stat = await fs.promises.stat(file)
          if (Date.now() - stat.mtimeMs > 30000) {
            await fs.promises.unlink(file)
            continue
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }

  async _persist (puts = [], deletes = []) {
    if (this.type === 'level' && this._db) {
      const operations = [
        ...puts.map(item => ({ type: 'put', key: this._levelKey(item), value: item })),
        ...deletes.map(item => ({ type: 'del', key: this._levelKey(item) }))
      ]
      if (operations.length) await this._db.db.batch(operations)
    } else {
      this._scheduleSave()
    }
  }

  _identity (record = {}) {
    return {
      selfId: String(record.self_id ?? record.selfId ?? ''),
      groupOpenid: String(record.group_openid ?? record.groupOpenid ?? ''),
      requestId: String(record.join_request_id ?? record.joinRequestId ?? record.flag ?? '')
    }
  }

  _applicantOpenid (record = {}) {
    return String(record.applicant_openid ?? record.user_openid ?? record.member_openid ?? record.author?.member_openid ?? record.author?.user_openid ?? record.openid ?? '')
  }

  async record (record = {}, groupOrRecord = {}, maybeRecord = {}) {
    this._assertReady()
    let source
    if (record && typeof record === 'object') source = jsonObject(record)
    else if (groupOrRecord && typeof groupOrRecord === 'object') source = { ...jsonObject(groupOrRecord), self_id: record }
    else source = { ...jsonObject(maybeRecord), self_id: record, group_openid: groupOrRecord }
    const { selfId, groupOpenid, requestId } = this._identity(source)
    if (!selfId || !groupOpenid || !requestId) throw new TypeError('self_id, group_openid and join_request_id are required')

    return this._enqueueMutation(async () => {
      const key = this._recordKey(selfId, groupOpenid, requestId)
      const existing = this._records.get(key)
      const currentTime = nowIso()
      const applicationTime = toIso(source.application_time ?? source.request_time ?? source.timestamp ?? source.time, existing?.application_time || currentTime)
      const applicantOpenid = this._applicantOpenid(source) || existing?.applicant_openid || ''
      const item = {
        ...existing,
        ...source,
        // Preserve the unmodified official event/API object separately from local status fields.
        official_payload: mergeJsonObjects(existing?.official_payload, source.official_payload ?? source.officialPayload ?? source),
        self_id: selfId,
        group_openid: groupOpenid,
        join_request_id: requestId,
        applicant_openid: applicantOpenid,
        user_openid: String(source.user_openid ?? applicantOpenid),
        nickname: String(source.nickname ?? source.member_nick ?? source.author?.username ?? source.author?.nickname ?? existing?.nickname ?? ''),
        application_time: applicationTime,
        source: source.source ?? source.join_source ?? existing?.source ?? '',
        verification_info: source.verification_info ?? source.comment ?? source.message ?? source.answer ?? existing?.verification_info ?? '',
        risk: source.risk ?? source.risk_info ?? source.risk_warning ?? source.warning ?? existing?.risk ?? '',
        passive_received: existing?.passive_received === true || source.passive_received === true,
        status: existing?.status && existing.status !== 'pending' ? existing.status : String(source.status || existing?.status || 'pending'),
        unread: existing ? existing.unread === true : true,
        seen_at: existing?.seen_at || '',
        created_at: existing?.created_at || currentTime,
        updated_at: currentTime,
        store_order: existing?.store_order || this._nextOrder++
      }
      this._records.set(key, item)
      if (!existing && item.unread === true) this._incrementUnread(item)
      await this._persist([item])
      return clone(item)
    })
  }

  get (selfId, groupOpenid, requestId) {
    this._assertReady()
    if (selfId && typeof selfId === 'object') {
      const identity = this._identity(selfId)
      selfId = identity.selfId
      groupOpenid = identity.groupOpenid
      requestId = identity.requestId
    }
    if (!selfId || !groupOpenid || !requestId) return null
    return clone(this._records.get(this._recordKey(selfId, groupOpenid, requestId)) || null)
  }

  _listArgs (selfId, options) {
    if (selfId && typeof selfId === 'object') {
      options = selfId
      selfId = options.self_id ?? options.selfId ?? ''
    }
    return { selfId: String(selfId || ''), options: options && typeof options === 'object' ? options : {} }
  }

  _sortRecords (a, b) {
    return Number(b.store_order || 0) - Number(a.store_order || 0) || String(b.join_request_id).localeCompare(String(a.join_request_id))
  }

  _encodeCursor (item) {
    return Buffer.from(JSON.stringify({ order: item.store_order, key: this._recordKey(item.self_id, item.group_openid, item.join_request_id) })).toString('base64url')
  }

  _decodeCursor (cursor) {
    if (!cursor) return null
    try {
      const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf-8'))
      return Number.isFinite(Number(value.order)) && typeof value.key === 'string' ? value : null
    } catch { return null }
  }

  list (selfId = '', options = {}, groupOptions = {}) {
    this._assertReady()
    if (typeof options === 'string') options = { ...jsonObject(groupOptions), group_openid: options }
    const args = this._listArgs(selfId, options)
    const filter = args.options
    const groupOpenid = String(filter.group_openid ?? filter.groupOpenid ?? '')
    const applicantOpenid = String(filter.applicant_openid ?? filter.user_openid ?? filter.member_openid ?? '')
    const statuses = filter.status == null ? null : new Set((Array.isArray(filter.status) ? filter.status : [filter.status]).map(String))
    const unread = typeof filter.unread === 'boolean' ? filter.unread : null
    const markListedSeen = filter.mark_seen !== false && filter.markSeen !== false
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(filter.limit) || DEFAULT_PAGE_SIZE))
    const requestedPage = Math.max(1, Number(filter.page) || 1)
    const cursorValue = String(filter.cursor || '')
    const cursor = this._decodeCursor(cursorValue)
    const records = [...this._records.values()]
      .filter(item => !args.selfId || item.self_id === args.selfId)
      .filter(item => !groupOpenid || item.group_openid === groupOpenid)
      .filter(item => !applicantOpenid || item.applicant_openid === applicantOpenid || item.user_openid === applicantOpenid)
      .filter(item => !statuses || statuses.has(String(item.status)))
      .filter(item => unread == null || item.unread === unread)
      .sort((a, b) => this._sortRecords(a, b))
    const total = records.length
    const pageCount = Math.max(1, Math.ceil(total / limit))
    const currentPage = Math.min(requestedPage, pageCount)
    let start = cursor ? 0 : (currentPage - 1) * limit
    if (cursor) {
      const exact = records.findIndex(item => this._recordKey(item.self_id, item.group_openid, item.join_request_id) === cursor.key)
      start = exact >= 0 ? exact + 1 : records.findIndex(item => Number(item.store_order || 0) < Number(cursor.order))
      if (start < 0) start = records.length
    }
    const page = records.slice(start, start + limit)
    if (markListedSeen) {
      const time = nowIso()
      const changed = []
      for (const item of page) {
        if (item.unread !== true) continue
        this._decrementUnread(item)
        item.unread = false
        item.seen_at = time
        item.updated_at = time
        changed.push(item)
      }
      if (changed.length) this._enqueueMutation(() => this._persist(changed)).catch(err => logError('[QQBot-Plugin] joinRequestStore list seen save error:', err))
    }
    const hasMore = start + page.length < total
    const nextCursor = hasMore && page.length ? this._encodeCursor(page[page.length - 1]) : null
    return {
      list: page.map(item => clone(item)),
      total,
      count: page.length,
      limit,
      page: cursor ? Math.floor(start / limit) + 1 : currentPage,
      pageCount,
      cursor: cursorValue || null,
      next_cursor: nextCursor,
      nextCursor,
      has_more: hasMore,
      hasMore
    }
  }

  async markSeen (selfId, groupOpenid = '', requestId = '') {
    this._assertReady()
    if (selfId && typeof selfId === 'object') {
      const input = selfId
      groupOpenid = input.group_openid ?? input.groupOpenid ?? ''
      requestId = input.join_request_id ?? input.joinRequestId ?? input.request_id ?? ''
      selfId = input.self_id ?? input.selfId ?? ''
    }
    selfId = String(selfId || '')
    groupOpenid = String(groupOpenid || '')
    requestId = String(requestId || '')
    if (!selfId) return 0
    return this._enqueueMutation(async () => {
      const changed = []
      const time = nowIso()
      for (const item of this._records.values()) {
        if (item.self_id !== selfId || (groupOpenid && item.group_openid !== groupOpenid) || (requestId && item.join_request_id !== requestId) || item.unread !== true) continue
        this._decrementUnread(item)
        item.unread = false
        item.seen_at = time
        item.updated_at = time
        changed.push(item)
      }
      if (changed.length) await this._persist(changed)
      return changed.length
    })
  }

  hasUnread (selfId, groupOpenid = '') {
    this._assertReady()
    if (selfId && typeof selfId === 'object') {
      groupOpenid = selfId.group_openid ?? selfId.groupOpenid ?? ''
      selfId = selfId.self_id ?? selfId.selfId ?? ''
    }
    selfId = String(selfId || '')
    groupOpenid = String(groupOpenid || '')
    if (!selfId) return false
    return groupOpenid
      ? (this._unreadByGroup.get(this._unreadKey(selfId, groupOpenid)) || 0) > 0
      : (this._unreadBySelf.get(selfId) || 0) > 0
  }

  async clear (selfId = '') {
    this._assertReady()
    selfId = String(selfId || '')
    if (!selfId) return 0
    return this._enqueueMutation(async () => {
      const removed = [...this._records.values()].filter(item => item.self_id === selfId)
      for (const item of removed) {
        this._decrementUnread(item)
        this._records.delete(this._recordKey(item.self_id, item.group_openid, item.join_request_id))
      }
      if (removed.length) await this._persist([], removed)
      return removed.length
    })
  }

  _resolutionStatus (value) {
    if (value === true || value === 1) return 'approved'
    if (value === false || value === 0) return 'declined'
    const normalized = String(value || '').toLowerCase()
    if (['approve', 'approved', 'yes', 'true', '1'].includes(normalized)) return 'approved'
    if (['decline', 'declined', 'reject', 'rejected', 'no', 'false', '0'].includes(normalized)) return 'declined'
    return normalized || 'resolved'
  }

  async resolve (selfId, groupOpenid, requestId, resolution = 'resolved', details = {}) {
    this._assertReady()
    if (selfId && typeof selfId === 'object') {
      const input = selfId
      const identity = this._identity(input)
      selfId = identity.selfId
      groupOpenid = identity.groupOpenid
      requestId = identity.requestId
      resolution = input.status ?? input.resolution ?? input.approve ?? resolution
      details = input.details ?? input
    }
    selfId = String(selfId || '')
    groupOpenid = String(groupOpenid || '')
    requestId = String(requestId || '')
    if (!selfId || !groupOpenid || !requestId) return null

    return this._enqueueMutation(async () => {
      const key = this._recordKey(selfId, groupOpenid, requestId)
      const item = this._records.get(key)
      if (!item) return null
      const wasUnread = item.unread === true
      const status = this._resolutionStatus(resolution)
      const time = nowIso()
      const safeDetails = jsonObject(typeof resolution === 'object' ? resolution : details)
      const resolvedStatus = typeof resolution === 'object'
        ? this._resolutionStatus(resolution.status ?? resolution.resolution ?? resolution.approve)
        : status
      item.status = resolvedStatus
      item.resolution = resolvedStatus
      item.resolved_at = toIso(safeDetails.resolved_at, time)
      item.reason = safeDetails.reason ?? item.reason ?? ''
      item.block = safeDetails.block === true || safeDetails.block === 1 || ['1', 'yes', 'true'].includes(String(safeDetails.block || '').toLowerCase())
      if (wasUnread) this._decrementUnread(item)
      item.unread = false
      item.seen_at = item.seen_at || time
      item.updated_at = time
      const changed = [item]

      if (resolvedStatus === 'approved' && item.applicant_openid) {
        for (const other of this._records.values()) {
          if (other === item || other.self_id !== selfId || other.group_openid !== groupOpenid) continue
          if (other.applicant_openid !== item.applicant_openid || other.status !== 'pending') continue
          if (Number(other.store_order || 0) >= Number(item.store_order || 0)) continue
          other.status = 'invalidated'
          other.resolution = 'invalidated'
          other.invalidated_by = requestId
          other.resolved_at = item.resolved_at
          if (other.unread === true) this._decrementUnread(other)
          other.unread = false
          other.seen_at = other.seen_at || time
          other.updated_at = time
          changed.push(other)
        }
      }

      await this._persist(changed)
      return clone(item)
    })
  }

  findByFlag (selfId, flag, groupOpenid = '') {
    this._assertReady()
    if (selfId && typeof selfId === 'object') {
      const input = selfId
      selfId = input.self_id ?? input.selfId ?? ''
      flag = input.flag ?? input.join_request_id ?? input.joinRequestId ?? ''
      groupOpenid = input.group_openid ?? input.groupOpenid ?? ''
    }
    selfId = String(selfId || '')
    flag = String(flag || '')
    groupOpenid = String(groupOpenid || '')
    if (!selfId || !flag) return null
    const item = [...this._records.values()]
      .filter(record => record.self_id === selfId && record.join_request_id === flag && (!groupOpenid || record.group_openid === groupOpenid))
      .sort((a, b) => this._sortRecords(a, b))[0]
    return clone(item || null)
  }

  findBySequence (selfId, sequence) {
    this._assertReady()
    selfId = String(selfId || '')
    sequence = Number(sequence)
    if (!selfId || !Number.isSafeInteger(sequence) || sequence <= 0) return null
    const item = [...this._records.values()].find(record => record.self_id === selfId && Number(record.store_order) === sequence)
    return clone(item || null)
  }

  findAnyBySequence (sequence) {
    this._assertReady()
    sequence = Number(sequence)
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null
    const item = [...this._records.values()].find(record => Number(record.store_order) === sequence)
    return clone(item || null)
  }

  findAnyByFlag (flag) {
    this._assertReady()
    flag = String(flag || '')
    if (!flag) return null
    const item = [...this._records.values()]
      .filter(record => record.join_request_id === flag)
      .sort((a, b) => this._sortRecords(a, b))[0]
    return clone(item || null)
  }

  async expire (options = {}, before) {
    this._assertReady()
    if (typeof options === 'string') options = { self_id: options, before }
    else if (typeof options === 'number' || options instanceof Date) options = { before: options }
    else if (!options || typeof options !== 'object') options = {}
    const selfId = String(options.self_id ?? options.selfId ?? '')
    const groupOpenid = String(options.group_openid ?? options.groupOpenid ?? '')
    const requestId = String(options.join_request_id ?? options.joinRequestId ?? options.request_id ?? '')
    const cutoff = options.maxAgeMs != null
      ? Date.now() - Math.max(0, Number(options.maxAgeMs) || 0)
      : (toIso(options.before, nowIso()) ? Date.parse(toIso(options.before, nowIso())) : Date.now())

    return this._enqueueMutation(async () => {
      const changed = []
      const time = nowIso()
      for (const item of this._records.values()) {
        if (item.status !== 'pending' || (selfId && item.self_id !== selfId) || (groupOpenid && item.group_openid !== groupOpenid) || (requestId && item.join_request_id !== requestId)) continue
        const itemTime = Date.parse(item.application_time || item.created_at || '')
        if (!Number.isFinite(itemTime) || itemTime > cutoff) continue
        item.status = 'expired'
        item.resolution = 'expired'
        item.resolved_at = time
        if (item.unread === true) this._decrementUnread(item)
        item.unread = false
        item.seen_at = item.seen_at || time
        item.updated_at = time
        changed.push(item)
      }
      if (changed.length) await this._persist(changed)
      return changed.length
    })
  }

  async close () {
    if (this._initPromise) await this._initPromise
    if (!this._ready) return
    await this._mutationQueue.catch(() => {})
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this.type === 'json') {
      await this._queueJsonWrite()
      await this._writeQueue.catch(() => {})
    }
    await this._closeLevel()
    this._ready = false
  }
}

const joinRequestStore = new JoinRequestStore()

export { JoinRequestStore }
export default joinRequestStore
