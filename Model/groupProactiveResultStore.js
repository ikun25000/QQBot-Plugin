import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Level from './level.js'
import { pluginPath } from './common.js'

const HISTORY_LIMIT = 100

class GroupProactiveResultStore {
  constructor (directory = join(pluginPath, 'db', 'groupProactiveResults')) {
    this.directory = directory
    this.db = null
    this.opening = null
    this.queue = Promise.resolve()
  }

  async init () {
    if (this.db) return
    if (!this.opening) {
      this.opening = (async () => {
        fs.mkdirSync(this.directory, { recursive: true })
        const db = new Level(this.directory)
        try {
          await db.open({ cleanup: false })
          this.db = db
        } catch (err) {
          await db.close().catch(() => {})
          throw err
        }
      })().finally(() => { this.opening = null })
    }
    await this.opening
  }

  _prefix (selfId) { return `run:${encodeURIComponent(String(selfId))}:` }

  _key (selfId, run, id) {
    const time = Number.isFinite(Date.parse(run?.started_at)) ? new Date(run.started_at).toISOString() : new Date(0).toISOString()
    return `${this._prefix(selfId)}${time}:${id}`
  }

  async _keys (selfId) {
    const prefix = this._prefix(selfId)
    const keys = []
    for await (const [key] of this.db.db.iterator({ gte: prefix, lt: `${prefix}\uffff`, reverse: true })) keys.push(String(key))
    return keys
  }

  async _write (operation) {
    await this.init()
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  async addRun (selfId, run) {
    return this._write(async () => {
      const key = this._key(selfId, run, run.run_id || randomUUID())
      await this.db.db.put(key, run)
      await this._prune(selfId)
    })
  }

  async _prune (selfId) {
    const keys = await this._keys(selfId)
    if (keys.length > HISTORY_LIMIT) await this.db.db.batch(keys.slice(HISTORY_LIMIT).map(key => ({ type: 'del', key })))
  }

  async migrate (config, configSave) {
    await this.init()
    for (const [selfId, settings] of Object.entries(config.groupProactive?.bots || {})) {
      if (!Array.isArray(settings?.results)) continue
      const legacy = settings.results
      await this._write(async () => {
        for (const [index, run] of legacy.entries()) {
          if (!run || typeof run !== 'object') continue
          const hash = createHash('sha256').update(JSON.stringify(run)).digest('hex')
          const id = run.run_id || `legacy-${String(legacy.length - index).padStart(6, '0')}-${hash}`
          const key = this._key(selfId, run, id)
          await this.db.db.put(key, run)
        }
        await this._prune(selfId)
      })
      delete settings.results
      await configSave()
    }
  }

  async listRuns (selfId, requestedPage = 1, pageSize = 10) {
    await this.init()
    await this.queue
    const keys = await this._keys(selfId)
    const pageCount = Math.max(1, Math.ceil(keys.length / pageSize))
    const page = Math.min(pageCount, Math.max(1, Number(requestedPage) || 1))
    const list = await Promise.all(keys.slice((page - 1) * pageSize, page * pageSize).map(key => this.db.db.get(key)))
    return { list, page, pageCount, total: keys.length }
  }

  async countRuns (selfId) {
    await this.init()
    await this.queue
    return (await this._keys(selfId)).length
  }

  async clearRuns (selfId) {
    return this._write(async () => {
      const keys = await this._keys(selfId)
      if (keys.length) await this.db.db.batch(keys.map(key => ({ type: 'del', key })))
      return keys.length
    })
  }

  async close () {
    if (this.opening) await this.opening
    await this.queue
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }
}

export const groupProactiveResultStore = new GroupProactiveResultStore()
export { GroupProactiveResultStore }
