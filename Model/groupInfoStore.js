import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEVEL_DATA_DIR = join(pluginPath, 'db', 'groupInfo')
const JSON_DATA_DIR = join(process.cwd(), 'data', 'QQBotGroupInfo')
const TTL = 10 * 60 * 1000
const RETRIES = 2

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const keyOf = (selfId, groupOpenid) => `${String(selfId)}:${String(groupOpenid)}`
const now = () => new Date().toISOString()

function errorInfo (err) {
  const data = err?.response?.data || {}
  const message = String(data.message || data.msg || err?.message || err || '')
  const wrappedCode = Number(/code\((\d+)\)/i.exec(message)?.[1] || 0)
  return {
    status: Number(err?.response?.status || 0),
    code: Number(data.code || err?.code || wrappedCode || 0),
    err_code: Number(data.err_code || err?.err_code || wrappedCode || 0),
    message,
    trace_id: String(data.trace_id || err?.response?.headers?.['x-tps-trace-id'] || ''),
    at: now()
  }
}

function rateLimited (err) {
  const info = errorInfo(err)
  return info.status === 429 || info.code === 100017 || info.err_code === 40034100 || /频率|频控|rate.?limit/i.test(info.message)
}

function normalizeInfo (value = {}) {
  return {
    group_openid: String(value.group_openid || ''),
    group_name: String(value.group_name || value.name || ''),
    group_finger_memo: String(value.group_finger_memo || ''),
    group_class_text: String(value.group_class_text || ''),
    group_tags: Array.isArray(value.group_tags) ? value.group_tags.map(String) : [],
    group_member_num: Number(value.group_member_num) || 0
  }
}

function normalizeState (value = {}) {
  return {
    member_openid: String(value.member_openid || ''),
    joined_at: value.joined_at || '',
    allow_proactive_msg: value.allow_proactive_msg === true,
    recv_msg_setting: String(value.recv_msg_setting || ''),
    member_role: String(value.member_role || '')
  }
}

class GroupInfoStore {
  constructor () {
    this._db = null
    this._ready = false
    this._data = new Map()
    this._queues = new Map()
    this._requestTimes = new Map()
    this._pending = new Map()
    this._refreshing = new Map()
    this._lastRefresh = new Map()
    this._counters = new Map()
    this._updateQueues = new Map()
    this._jsonWriteQueue = Promise.resolve()
  }

  async init () {
    if (this._ready) return this
    try {
      const { default: Level } = await import('./level.js')
      fs.mkdirSync(LEVEL_DATA_DIR, { recursive: true })
      this._db = new Level(LEVEL_DATA_DIR)
      await this._db.open({ cleanup: false })
      for await (const [key, value] of this._db.db.iterator({ gte: 'group:', lt: 'group:\uffff' })) this._data.set(String(key).slice(6), value)
    } catch (err) {
      this._db = null
      fs.mkdirSync(JSON_DATA_DIR, { recursive: true })
      try {
        const data = JSON.parse(fs.readFileSync(join(JSON_DATA_DIR, 'groups.json'), 'utf8'))
        for (const [key, value] of Object.entries(data || {})) this._data.set(key, value)
      } catch {}
      globalThis.logger?.warn?.('[QQBot-Plugin] 群资料缓存使用JSON存储:', err.message)
    }
    this._ready = true
    return this
  }

  getGroup (selfId, groupOpenid) {
    return clone(this._data.get(keyOf(selfId, groupOpenid)) || null)
  }

  getInfo (selfId, groupOpenid) { return this.getGroup(selfId, groupOpenid)?.info || null }
  getBotState (selfId, groupOpenid) { return this.getGroup(selfId, groupOpenid)?.bot_state || null }
  getGroupMemberCount (selfId, groupOpenid) { return Number(this.getInfo(selfId, groupOpenid)?.group_member_num) || 0 }

  async _save (key, value) {
    if (this._db) return this._db.db.put(`group:${key}`, value)
    const file = join(JSON_DATA_DIR, 'groups.json')
    const write = this._jsonWriteQueue.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(this._data)), 'utf8')
      await fs.promises.rename(tmp, file)
    })
    this._jsonWriteQueue = write
    await write
  }

  async _update (selfId, groupOpenid, patch) {
    const key = keyOf(selfId, groupOpenid)
    const previous = this._updateQueues.get(key) || Promise.resolve()
    const update = previous.catch(() => {}).then(async () => {
      const current = this._data.get(key) || {}
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch
      const value = { ...current, self_id: String(selfId), group_openid: String(groupOpenid), ...resolvedPatch }
      this._data.set(key, value)
      await this._save(key, value)
      return clone(value)
    })
    this._updateQueues.set(key, update)
    update.finally(() => {
      if (this._updateQueues.get(key) === update) this._updateQueues.delete(key)
    }).catch(() => {})
    return update
  }

  recordGroup (selfId, groupOpenid) {
    if (!selfId || !groupOpenid || String(groupOpenid).startsWith('qg_')) return Promise.resolve(null)
    const key = keyOf(selfId, groupOpenid)
    const old = this._data.get(key)
    if (old) return Promise.resolve(clone(old))
    return this._update(selfId, groupOpenid, { created_at: now(), last_seen_at: now() })
  }

  async _request (selfId, groupOpenid, kind, request, options = {}) {
    const key = `${selfId}:${kind}`
    const queue = this._queues.get(key) || Promise.resolve()
    const run = queue.catch(() => {}).then(async () => {
      let lastErr
      const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : RETRIES
      for (let attempt = 0; attempt <= retries; attempt++) {
        const last = this._requestTimes.get(key) || 0
        await sleep(Math.max(0, 2000 - (Date.now() - last)))
        this._requestTimes.set(key, Date.now())
        try { return await request() } catch (err) {
          lastErr = err
          if (attempt >= retries) throw err
          await sleep(rateLimited(err) ? 60000 : 2000)
        }
      }
      throw lastErr
    })
    const tracked = run.finally(() => { if (this._queues.get(key) === tracked) this._queues.delete(key) })
    this._queues.set(key, tracked)
    return tracked
  }

  requestEndpoint (selfId, groupOpenid, kind, request, options) {
    return this._request(selfId, groupOpenid, kind, request, options)
  }

  _runRefresh (key, task) {
    const active = this._refreshing.get(key)
    if (active) return active
    const running = Promise.resolve().then(task)
    this._refreshing.set(key, running)
    running.finally(() => {
      if (this._refreshing.get(key) === running) this._refreshing.delete(key)
    }).catch(() => {})
    return running
  }

  async _refreshInfo (selfId, groupOpenid, request) {
    const bot = globalThis.Bot?.[selfId]
    const key = keyOf(selfId, groupOpenid)
    const old = this._data.get(key) || {}
    try {
      const result = await this._request(selfId, groupOpenid, 'info', () => request ? request() : bot.sdk.request.get(`/v2/groups/${groupOpenid}/info`))
      const info = normalizeInfo(result?.data || result)
      return this._update(selfId, groupOpenid, { info: { ...info, fetched_at: now(), error: null }, last_seen_at: now() })
    } catch (err) {
      return this._update(selfId, groupOpenid, current => ({ info: { ...(current.info || old.info || {}), error: errorInfo(err) } }))
    }
  }

  refreshInfo (selfId, groupOpenid, request) {
    return this._runRefresh(`${keyOf(selfId, groupOpenid)}:info`, () => this._refreshInfo(selfId, groupOpenid, request))
  }

  async _refreshBotState (selfId, groupOpenid, request) {
    const bot = globalThis.Bot?.[selfId]
    const key = keyOf(selfId, groupOpenid)
    const old = this._data.get(key) || {}
    try {
      const result = await this._request(selfId, groupOpenid, 'bot_state', () => request ? request() : bot.sdk.request.get(`/v2/groups/${groupOpenid}/bot_state`))
      const state = normalizeState(result?.data || result)
      const roleError = state.member_role && !['owner', 'admin'].includes(state.member_role) ? { message: '不是管理员', at: now() } : null
      return this._update(selfId, groupOpenid, { bot_state: { ...state, fetched_at: now(), error: roleError } })
    } catch (err) {
      return this._update(selfId, groupOpenid, current => ({ bot_state: { ...(current.bot_state || old.bot_state || {}), error: errorInfo(err) } }))
    }
  }

  refreshBotState (selfId, groupOpenid, request) {
    return this._runRefresh(`${keyOf(selfId, groupOpenid)}:bot_state`, () => this._refreshBotState(selfId, groupOpenid, request))
  }

  async refreshGroup (selfId, groupOpenid, options = {}) {
    const tasks = []
    if (options.info !== false) tasks.push(this.refreshInfo(selfId, groupOpenid, options.infoRequest))
    if (options.botState !== false) tasks.push(this.refreshBotState(selfId, groupOpenid, options.botStateRequest))
    await Promise.all(tasks)
    return this.getGroup(selfId, groupOpenid)
  }

  forceRefresh (selfId, groupOpenid, options = {}) {
    return this.scheduleRefresh(selfId, groupOpenid, 'force_refresh', { ...options, force: true, info: options.info !== false, botState: options.botState !== false })
  }

  scheduleRefresh (selfId, groupOpenid, reason = '', options = {}) {
    if (!selfId || !groupOpenid) return Promise.resolve(null)
    const baseKey = keyOf(selfId, groupOpenid)
    const nowMs = Date.now()
    const schedule = (type, enabled, refresh) => {
      if (!enabled) return null
      const key = `${baseKey}:${type}`
      const pending = this._pending.get(key)
      if (pending) return pending
      if (!options.force && nowMs - (this._lastRefresh.get(key) || 0) < TTL) return null
      this._lastRefresh.set(key, nowMs)
      const task = this._update(selfId, groupOpenid, current => ({
        pending_refresh: {
          reason,
          options: {
            info: current.pending_refresh?.options?.info === true || type === 'info',
            botState: current.pending_refresh?.options?.botState === true || type === 'bot_state'
          },
          created_at: current.pending_refresh?.created_at || now()
        }
      }))
        .then(refresh)
        .catch(err => {
          globalThis.logger?.warn?.('群资料刷新失败:', reason, err.message)
          return this.getGroup(selfId, groupOpenid)
        })
        .finally(async () => {
          this._pending.delete(key)
          const hasPending = [...this._pending.keys()].some(item => item.startsWith(`${baseKey}:`))
          if (!hasPending) await this._update(selfId, groupOpenid, { pending_refresh: null }).catch(() => {})
        })
      this._pending.set(key, task)
      return task
    }
    const tasks = [
      schedule('info', options.info !== false, () => this.refreshInfo(selfId, groupOpenid, options.infoRequest)),
      schedule('bot_state', options.botState !== false, () => this.refreshBotState(selfId, groupOpenid, options.botStateRequest))
    ].filter(Boolean)
    if (!tasks.length) return Promise.resolve(this.getGroup(selfId, groupOpenid))
    return Promise.all(tasks).then(() => this.getGroup(selfId, groupOpenid))
  }

  resumePending (selfId) {
    const tasks = []
    for (const item of this._data.values()) {
      if (item.self_id !== String(selfId) || !item.pending_refresh) continue
      if (item.pending_refresh.options?.info !== false) this._lastRefresh.delete(`${keyOf(selfId, item.group_openid)}:info`)
      if (item.pending_refresh.options?.botState !== false) this._lastRefresh.delete(`${keyOf(selfId, item.group_openid)}:bot_state`)
      tasks.push(this.scheduleRefresh(selfId, item.group_openid, item.pending_refresh.reason || 'resume', item.pending_refresh.options || {}))
    }
    return Promise.allSettled(tasks)
  }

  recordTrigger (selfId, groupOpenid, type) {
    if (!selfId || !groupOpenid) return
    const key = keyOf(selfId, groupOpenid)
    const counters = this._counters.get(key) || { at: 0, full: 0, member: 0, bot: 0 }
    counters[type] = (Number(counters[type]) || 0) + 1
    this._counters.set(key, counters)
    const limit = type === 'full' ? 200 : type === 'member' ? 20 : type === 'bot' ? 10 : 20
    if (counters[type] !== 1 && counters[type] % limit !== 0) return
    this.scheduleRefresh(selfId, groupOpenid, `${type}:${counters[type]}`, { info: true, botState: type === 'full' })
  }

  async listMemberCountRank (selfId, limit = 0) {
    const list = [...this._data.values()].filter(item => item.self_id === String(selfId) && item.info).sort((a, b) => (b.info.group_member_num || 0) - (a.info.group_member_num || 0))
    return (Number(limit) > 0 ? list.slice(0, Number(limit)) : list).map(clone)
  }
}

export default new GroupInfoStore()
