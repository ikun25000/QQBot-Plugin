import { fileURLToPath } from 'node:url'

// Open lazily: loading the plugin alone does not create a database.
export class MediaImageStore {
  constructor (openDb = async () => {
    const { default: Level } = await import('./level.js')
    const db = new Level(fileURLToPath(new URL('../db/mediaImages', import.meta.url)))
    try { await db.open({ cleanup: false }); return db } catch (error) { await db.close().catch(() => {}); throw error }
  }) {
    this.openDb = openDb
  }

  async init () {
    if (!this.opening) this.opening = this.openDb().catch(error => { this.opening = null; throw error })
    return this.opening
  }

  async load (appid) {
    const db = await this.init()
    let value
    try { value = await db.db.get(`app:${appid}`) } catch (error) { if (!error.notFound && error.code !== 'LEVEL_NOT_FOUND') throw error }
    return structuredClone(value || { images: {}, pending: {}, lastCleanup: null })
  }

  async save (appid, state) {
    const db = await this.init()
    const stored = structuredClone(state)
    for (const image of Object.values(stored.images || {})) delete image.preview_url
    await db.db.put(`app:${appid}`, stored)
  }

  async close () {
    if (this.opening) await (await this.opening).close()
    this.opening = null
  }
}
