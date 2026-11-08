import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { fillMissing } from './configMigration.js'
import { wsDefaults } from './wsSettings.js'
export { wsDefaults } from './wsSettings.js'

// No timers, credential copies, YAML writes, or database opens on import.
export class WsStore {
  constructor (openDb = async name => {
    const { Level } = await import('level')
    const path = fileURLToPath(new URL(`../db/${name}`, import.meta.url))
    await mkdir(path, { recursive: true, mode: 0o700 })
    const db = new Level(path, { valueEncoding: 'json' })
    try { await db.open(); return db } catch (error) { await db.close().catch(() => {}); throw error }
  }) {
    this.openDb = openDb
    this.databases = new Map()
    this.accounts = new Map()
    this.loading = new Map()
    this.queues = new Map()
    // Process-local fence only; settings and persistence switches never change.
    this.sessionCacheCleared = false
    this.sessionClearListeners = new Set()
  }

  async db (name = 'wsConfig') {
    if (!this.databases.has(name)) {
      const opening = this.openDb(name).catch(error => { this.databases.delete(name); throw error })
      this.databases.set(name, opening)
    }
    return this.databases.get(name)
  }

  async read (key, name) {
    try { return await (await this.db(name)).get(key) } catch (error) {
      if (!error.notFound && error.code !== 'LEVEL_NOT_FOUND') throw error
      return null
    }
  }

  serial (key, operation) {
    const previous = this.queues.get(key) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.queues.set(key, next)
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) }).catch(() => {})
    return next
  }

  useSettings (backend) { this.settingsBackend = backend }

  async loadAccount (id, legacy = {}) {
    id = String(id)
    if (this.accounts.has(id)) return this.accounts.get(id)
    if (!this.loading.has(id)) {
      const loading = this.serial(`account:${id}`, async () => {
        const stored = await this.read(`account:${id}`)
        if (this.settingsBackend) {
          if (stored && (typeof stored !== 'object' || Array.isArray(stored))) throw new Error('WS账号运行数据损坏')
          await this.settingsBackend.migrate(id, stored, legacy)
          const record = { ...stored, settingsStorage: 'yaml-v1', notificationMigrationVersion: 1,
            selfOpenid: stored?.selfOpenid || String(legacy.selfOpenid || '') }
          delete record.settings
          // YAML has committed before the old Level settings are removed.
          if (JSON.stringify(record) !== JSON.stringify(stored)) await (await this.db()).put(`account:${id}`, record, { sync: true })
          this.accounts.set(id, record)
          return record
        }
        if (stored && (typeof stored !== 'object' || Array.isArray(stored) || !stored.settings ||
            typeof stored.settings.sandbox !== 'boolean' || typeof stored.settings.sessionSave !== 'boolean')) {
          throw new Error('WS账号配置损坏，拒绝使用默认环境覆盖')
        }
        const defaults = wsDefaults()
        const oldOffline = {}
        fillMissing(oldOffline, stored?.settings?.offline, legacy.offline)
        const legacyNotify = typeof oldOffline.notify === 'boolean' ? oldOffline.notify : undefined
        const shouldImportLegacyNotify = typeof legacyNotify === 'boolean' && (!stored || stored.notificationMigrationVersion !== 1)
        const offline = {}
        fillMissing(offline, stored?.settings?.offline, legacy.offline, defaults.offline)
        const record = {
          ...stored,
          notificationMigrationVersion: 1,
          settings: {
            ...defaults, ...stored?.settings,
            offline,
            notifications: {
              ...defaults.notifications,
              ...(shouldImportLegacyNotify ? { enabled: legacyNotify, offline: legacyNotify } : {}),
              ...stored?.settings?.notifications
            }
          },
          selfOpenid: stored?.selfOpenid || String(legacy.selfOpenid || '')
        }
        delete record.settings.offline.notify
        // Also commit upgrades to existing records BEFORE exposing them as
        // migrated; the YAML serializer only trusts this committed cache.
        if (JSON.stringify(record) !== JSON.stringify(stored)) await (await this.db()).put(`account:${id}`, record, { sync: true })
        this.accounts.set(id, record)
        return record
      }).finally(() => this.loading.delete(id))
      this.loading.set(id, loading)
    }
    return this.loading.get(id)
  }

  settings (id) { return this.settingsBackend ? this.settingsBackend.read(String(id)) : structuredClone(this.accounts.get(String(id))?.settings || wsDefaults()) }
  selfOpenid (id) { return this.accounts.get(String(id))?.selfOpenid || '' }

  async update (id, change) {
    id = String(id)
    await this.loadAccount(id)
    return this.serial(`account:${id}`, async () => {
      const record = structuredClone(this.accounts.get(id))
      const previousSettings = this.settingsBackend ? this.settings(id) : null
      if (this.settingsBackend) record.settings = structuredClone(previousSettings)
      await change(record)
      if (this.settingsBackend) {
        if (JSON.stringify(record.settings) !== JSON.stringify(previousSettings)) await this.settingsBackend.write(id, record.settings, previousSettings)
        delete record.settings
      }
      if (JSON.stringify(record) !== JSON.stringify(this.accounts.get(id))) {
        await (await this.db()).put(`account:${id}`, record, { sync: true })
        this.accounts.set(id, record)
      }
      return this.settings(id)
    })
  }

  async saveSession (key, value) {
    // One queue for Session mutations lets the global clear run AFTER every
    // already-started write, without racing per-account queues.
    return this.serial('sessions', async () => {
      if (this.sessionCacheCleared && value) return
      const db = await this.db('wsSession')
      if (this.sessionCacheCleared && value) return
      if (value) await db.put(key, value, { sync: true })
      else await db.del(key, { sync: true })
    })
  }

  async loadSession (key) {
    if (this.sessionCacheCleared) return null
    const value = await this.read(key, 'wsSession')
    return this.sessionCacheCleared ? null : value
  }

  async businessState (key) { return await this.read(`business:${key}`) ?? {} }

  updateBusinessState (key, change) {
    return this.serial(`business:${key}`, async () => {
      const value = await this.businessState(key)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('业务检测预算数据损坏')
      await change(value)
      await (await this.db()).put(`business:${key}`, value, { sync: true })
      return value
    })
  }

  onSessionCacheClear (listener) {
    if (this.sessionCacheCleared) { listener(); return () => {} }
    this.sessionClearListeners.add(listener)
    return () => this.sessionClearListeners.delete(listener)
  }

  clearAllSessions () {
    // Fence synchronously before awaiting I/O: pending checkpoints, shutdown
    // flushes, restores and newly created controllers cannot revive old data.
    // Saving resumes only with a fresh store after the next process restart.
    this.sessionCacheCleared = true
    for (const listener of this.sessionClearListeners) listener()
    this.sessionClearListeners.clear()
    return this.serial('sessions', async () => {
      const db = await this.db('wsSession')
      let deleted = 0
      let batch = []
      // Delete every key, including stale credentials/environments and accounts
      // absent from the current config. Durable batches never touch wsConfig.
      for await (const key of db.keys()) {
        batch.push({ type: 'del', key })
        if (batch.length >= 500) {
          await db.batch(batch, { sync: true })
          deleted += batch.length
          batch = []
        }
      }
      if (batch.length) { await db.batch(batch, { sync: true }); deleted += batch.length }
      return deleted
    })
  }

  async close () {
    await Promise.allSettled([...this.queues.values()])
    await Promise.all([...this.databases.values()].map(async db => (await db).close()))
    this.databases.clear()
  }
}

export const wsStore = new WsStore()
