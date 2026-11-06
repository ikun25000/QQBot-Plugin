import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { fillMissing } from './configMigration.js'

export function wsDefaults () {
  return {
    sessionSave: false,
    sandbox: false,
    offline: { enabled: false, interval: 5, autoReconnect: true, heartbeatTimeout: 60000, maxRetry: '.inf' },
    notifications: { enabled: false, zero: false, consumption: false, offline: false, method: 'sendmastermsg', recipient: '' }
  }
}

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

  async loadAccount (id, legacy = {}) {
    id = String(id)
    if (this.accounts.has(id)) return this.accounts.get(id)
    if (!this.loading.has(id)) {
      const loading = this.serial(`account:${id}`, async () => {
        const stored = await this.read(`account:${id}`)
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

  settings (id) { return structuredClone(this.accounts.get(String(id))?.settings || wsDefaults()) }
  selfOpenid (id) { return this.accounts.get(String(id))?.selfOpenid || '' }

  async update (id, change) {
    id = String(id)
    await this.loadAccount(id)
    return this.serial(`account:${id}`, async () => {
      const record = structuredClone(this.accounts.get(id))
      await change(record)
      if (JSON.stringify(record) !== JSON.stringify(this.accounts.get(id))) {
        await (await this.db()).put(`account:${id}`, record, { sync: true })
        this.accounts.set(id, record)
      }
      return this.settings(id)
    })
  }

  async saveSession (key, value) {
    return this.serial(`session:${key}`, async () => {
      const db = await this.db('wsSession')
      if (value) await db.put(key, value, { sync: true })
      else await db.del(key, { sync: true })
    })
  }

  loadSession (key) { return this.read(key, 'wsSession') }

  async close () {
    await Promise.allSettled([...this.queues.values()])
    await Promise.all([...this.databases.values()].map(async db => (await db).close()))
    this.databases.clear()
  }
}

export const wsStore = new WsStore()
