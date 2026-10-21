import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { detectMediaImageType, MEDIA_IMAGE_MAX_BYTES, MEDIA_IMAGE_TTL, mediaErrorText } from './mediaImageApi.js'

const DAY = 86400000
export const MEDIA_IMAGE_PRESSURE_THRESHOLD = 90
export const MEDIA_IMAGE_PRESSURE_TARGET = 70
export const MEDIA_IMAGE_HARD_LIMIT = 100
export const MEDIA_IMAGE_LIST_COOLDOWN_MS = 5000
export const MEDIA_IMAGE_DEFAULTS = Object.freeze({ provider: 'official', autoCleanup: true, retentionDays: 3, quotaPolicy: 'cleanup' })
export function mediaImageSettings (value = {}) {
  return {
    provider: value.provider === 'ci' ? 'ci' : 'official', autoCleanup: value.autoCleanup !== false,
    retentionDays: Math.max(1, Math.min(90, Number(value.retentionDays) || 3)),
    quotaPolicy: value.quotaPolicy === 'ci' ? 'ci' : 'cleanup'
  }
}

export class MediaImageQuotaError extends Error {
  constructor (total) {
    super(`官方素材已满（${total}/${MEDIA_IMAGE_HARD_LIMIT}）`)
    this.name = 'MediaImageQuotaError'
    this.code = 'QQBOT_MEDIA_QUOTA_FULL'
    this.total = total
  }
}

function storedImage (image) {
  const { preview_url, ...rest } = image
  return rest
}

function referenceText (payload) {
  const strings = [], seen = new WeakSet()
  const visit = value => {
    if (typeof value === 'string') {
      if (value.includes('qqbot-media://image/v1/')) strings.push(value)
    } else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && !seen.has(value)) {
      seen.add(value)
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(payload)
  return strings.join('\n')
}

export class MediaImageManager {
  constructor ({ store, context, settings, customLoaded, ciUpload, pinned = () => '', now = Date.now, log = () => {} }) {
    Object.assign(this, { store, context, settings, customLoaded, ciUpload, pinned, now, log })
    this.queues = new Map()
    this.waiters = new Map()
    this.uploads = new Map()
    this.leases = new Map()
    this.sends = new AsyncLocalStorage()
    this.health = new Map()
    this.snapshots = new Map()
    this.lists = new Map()
  }

  writable () {
    if (this.customLoaded()) throw new Error('已加载自定义图床，内置素材管理写操作已停用')
  }

  async locked (ctx, work) {
    const waiting = this.waiters.get(ctx.appid) || 0
    if (waiting >= 64) throw new Error('素材管理等待队列已满')
    this.waiters.set(ctx.appid, waiting + 1)
    const previous = this.queues.get(ctx.appid) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => { ctx.validate?.(); return work() })
    this.queues.set(ctx.appid, next)
    try { return await next } finally {
      if (this.queues.get(ctx.appid) === next) this.queues.delete(ctx.appid)
      const remaining = this.waiters.get(ctx.appid) - 1
      if (remaining) this.waiters.set(ctx.appid, remaining)
      else this.waiters.delete(ctx.appid)
    }
  }

  remember (selfId, provider, reason = '') {
    this.health.set(String(selfId), { provider, reason, time: this.now() })
  }

  async withSend (selfId, work) {
    const scope = { selfId: String(selfId), held: new Set(), closed: false }
    try { return await this.sends.run(scope, work) } finally {
      scope.closed = true
      for (const key of scope.held) {
        const count = (this.leases.get(key) || 1) - 1
        if (count) this.leases.set(key, count)
        else this.leases.delete(key)
      }
    }
  }

  hold (appid, imageId) {
    const scope = this.sends.getStore()
    if (!scope || scope.closed) return
    const key = `${appid}:${imageId}`
    if (!scope.held.has(key)) { scope.held.add(key); this.leases.set(key, (this.leases.get(key) || 0) + 1) }
  }

  protected (ctx, image) {
    return !!this.leases.get(`${ctx.appid}:${image.image_id}`) || String(this.pinned(ctx.appid) || '').includes(image.url)
  }

  async getList (ctx, { fresh = false } = {}) {
    const cached = this.lists.get(ctx.appid)
    if (!fresh && cached && this.now() - cached.at < MEDIA_IMAGE_LIST_COOLDOWN_MS) {
      return { images: cached.images.map(image => ({ ...image })), total: cached.total, at: cached.at, cached: true }
    }
    const list = await ctx.api.list()
    const entry = { images: list.images, total: list.total, at: this.now() }
    this.lists.set(ctx.appid, entry)
    return { images: entry.images.map(image => ({ ...image })), total: entry.total, at: entry.at, cached: false }
  }

  rememberListImage (appid, image) {
    const cached = this.lists.get(appid)
    if (!cached) return
    const index = cached.images.findIndex(item => item.image_id === image.image_id)
    if (index >= 0) cached.images[index] = { ...image }
    else {
      cached.images.push({ ...image })
      cached.total++
    }
  }

  forgetListImage (appid, imageId) {
    const cached = this.lists.get(appid)
    if (!cached) return
    const index = cached.images.findIndex(item => item.image_id === imageId)
    if (index < 0) return
    cached.images.splice(index, 1)
    cached.total = Math.max(0, cached.total - 1)
  }

  async sync (ctx, state, { fresh = true } = {}) {
    const list = await this.getList(ctx, { fresh })
    const visible = new Map(list.images.map(image => [image.image_id, image]))
    for (const [id, local] of Object.entries(state.images)) {
      // A cached five-second list may be missing a just-uploaded image. Only
      // prune against a fresh list; cached data still updates visible records.
      if (!visible.has(id)) {
        if (fresh) delete state.images[id]
      } else state.images[id] = storedImage({ ...local, ...visible.get(id) })
    }
    // Recover only uploads with a durably recorded intent, never claim unrelated images.
    for (const [hash, pending] of Object.entries(state.pending)) {
      const found = list.images.find(image => image.file_name === pending.file_name)
      if (found) {
        state.images[found.image_id] = storedImage({ ...found, hash, lastUsed: pending.startedAt, size: pending.size })
        delete state.pending[hash]
      } else if (this.now() - pending.startedAt > 4 * 3600000) delete state.pending[hash]
    }
    // Deterministic names contain the SHA256, so our images can be re-adopted after local data loss.
    for (const image of list.images) {
      if (state.images[image.image_id] || image.expires_at * 1000 <= this.now()) continue
      const match = /^qqbot-managed-([a-f0-9]{64})\.(?:png|jpg|gif|webp)$/i.exec(image.file_name)
      if (match) state.images[image.image_id] = storedImage({ ...image, hash: match[1].toLowerCase(), lastUsed: this.now() })
    }
    await this.store.save(ctx.appid, state)
    this.snapshots.set(ctx.appid, { total: list.total, managed: Object.keys(state.images).length, lastCleanup: state.lastCleanup, syncedAt: this.now() })
    return list
  }

  async view (selfId) {
    const ctx = this.context(selfId)
    return this.locked(ctx, async () => {
      const state = await this.store.load(ctx.appid), list = await this.sync(ctx, state)
      return { ...list, appid: ctx.appid, lastCleanup: state.lastCleanup, images: list.images.map(image => {
        const local = state.images[image.image_id]
        return { ...local, ...image, managed: !!local, protected: this.protected(ctx, image), lastUsed: local?.lastUsed }
      }) }
    })
  }

  async fallback (buffer, selfId) {
    this.writable()
    const settings = mediaImageSettings(this.settings(selfId)), type = detectMediaImageType(buffer)
    let reason = ''
    if (settings.provider === 'official') {
      if (buffer.length > MEDIA_IMAGE_MAX_BYTES) reason = '图片超过 10MiB'
      else if (!type || !buffer.length) reason = '官方素材不支持此图片格式'
      else {
        try { return await this.upload(buffer, selfId, type) } catch (error) {
          if (!settings.autoCleanup && error?.code === 'QQBOT_MEDIA_QUOTA_FULL') {
            return this.resolveFullQuota(buffer, selfId, type, settings, error)
          }
          reason = mediaErrorText(error)
          this.log('warn', selfId, `官方素材上传失败，转腾讯云 CI：${reason}`)
        }
      }
    }
    return this.uploadCi(buffer, selfId, reason)
  }

  async uploadCi (buffer, selfId, reason = '') {
    this.writable()
    try {
      const url = await this.ciUpload(buffer, selfId)
      this.remember(selfId, 'ci', reason)
      return url
    } catch (error) {
      const detail = `${reason ? reason + '；' : ''}CI：${mediaErrorText(error)}`
      this.remember(selfId, 'failed', detail)
      throw new Error(`内置图床上传失败：${detail}`)
    }
  }

  async resolveFullQuota (buffer, selfId, type, settings, quotaError) {
    const notes = [quotaError.message]
    const tryCi = async () => {
      this.writable()
      try {
        const url = await this.ciUpload(buffer, selfId)
        this.remember(selfId, 'ci', notes.join('；'))
        return { url }
      } catch (error) {
        notes.push(`CI：${mediaErrorText(error)}`)
        return { error }
      }
    }
    const tryCleanup = async () => {
      let result
      try {
        result = await this.cleanup(selfId, { forceCount: 5 })
      } catch (error) {
        notes.push(`强制清理失败：${mediaErrorText(error)}`)
        return { error }
      }
      if (!result.deleted) {
        notes.push('强制清理未删除任何素材（可能均受保护或不属于本插件）')
        return { error: new Error(notes.at(-1)) }
      }
      notes.push(`强制清理最早 ${result.deleted} 张`)
      try {
        return { url: await this.upload(buffer, selfId, type) }
      } catch (error) {
        notes.push(`清理后上传失败：${mediaErrorText(error)}`)
        return { error }
      }
    }
    if (settings.quotaPolicy === 'cleanup') {
      const cleaned = await tryCleanup()
      if (cleaned.url) return cleaned.url
      const ci = await tryCi()
      if (ci.url) return ci.url
    } else {
      const ci = await tryCi()
      if (ci.url) return ci.url
      const cleaned = await tryCleanup()
      if (cleaned.url) return cleaned.url
    }
    this.remember(selfId, 'failed', notes.join('；'))
    throw new Error(`官方素材已满，兜底失败：${notes.join('；')}`)
  }

  async upload (buffer, selfId, type) {
    const ctx = this.context(selfId), hash = createHash('sha256').update(buffer).digest('hex'), key = `${ctx.appid}:${hash}`
    let work = this.uploads.get(key)
    if (!work) {
      work = this.locked(ctx, async () => {
        this.writable()
        if (mediaImageSettings(this.settings(selfId)).provider === 'ci') throw new Error('内置图床已切换为腾讯云 CI')
        const state = await this.store.load(ctx.appid)
        let currentImages
        // Reconcile once per process/account, then periodically; incomplete uploads always reconcile.
        if (!this.snapshots.has(ctx.appid) || state.pending[hash] || this.now() - (this.snapshots.get(ctx.appid).syncedAt || 0) > 1800000) {
          currentImages = (await this.sync(ctx, state, { fresh: false })).images
        }
        let image = Object.values(state.images).find(item => item.hash === hash && item.expires_at * 1000 > this.now() + 60000)
        if (image) {
          this.hold(ctx.appid, image.image_id)
          image.lastUsed = this.now()
          await this.store.save(ctx.appid, state)
          return { image, cached: true }
        }
        this.writable()
        // A complete response may have been lost. Do not create another image until its intent expires.
        if (state.pending[hash]) throw new Error('该图片的上传结果待核对，暂用 CI')
        if (Object.keys(state.pending).length >= 32) throw new Error('未完成的官方素材上传任务较多，暂用 CI')
        const fileName = `qqbot-managed-${hash}.${type.ext}`
        // The hash is part of the official file name, so a list lookup recovers cached images
        // even after local metadata loss and prevents uploading the same bytes again.
        if (!currentImages) {
          const listed = await this.getList(ctx, { fresh: false })
          currentImages = listed.images
          const snapshot = this.snapshots.get(ctx.appid)
          if (snapshot) snapshot.total = listed.total
        }
        const reusable = currentImages.find(item => item.file_name === fileName && item.expires_at * 1000 > this.now() + 60000)
        if (reusable) {
          const adopted = { ...reusable, file_name: fileName, hash, size: buffer.length, lastUsed: this.now() }
          this.hold(ctx.appid, adopted.image_id)
          state.images[adopted.image_id] = storedImage(adopted)
          await this.store.save(ctx.appid, state)
          const snapshot = this.snapshots.get(ctx.appid)
          if (snapshot) snapshot.managed = Object.keys(state.images).length
          return { image: adopted, cached: true }
        }
        const settings = mediaImageSettings(this.settings(selfId))
        if (settings.autoCleanup) {
          // There is no periodic task: retention cleanup runs before each upload,
          // reusing the list fetched above (at most once per five-second cooldown).
          await this.cleanState(ctx, state, { automatic: true })
          if ((this.snapshots.get(ctx.appid)?.total || 0) >= MEDIA_IMAGE_PRESSURE_THRESHOLD) await this.cleanState(ctx, state, { pressure: true })
        }
        const total = this.snapshots.get(ctx.appid)?.total ?? currentImages.length
        if (total >= MEDIA_IMAGE_HARD_LIMIT) throw new MediaImageQuotaError(total)
        this.writable()
        state.pending[hash] = { file_name: fileName, startedAt: this.now(), size: buffer.length }
        await this.store.save(ctx.appid, state)
        this.writable()
        let prepared
        try { prepared = await ctx.api.prepare(buffer, fileName, type) } catch (error) {
          // A rejected prepare cannot have created a completed image.
          delete state.pending[hash]
          await this.store.save(ctx.appid, state)
          throw error
        }
        if (!prepared.upload_id || !prepared.presigned_url) throw new Error('官方素材申请响应无效')
        this.writable()
        let md5
        try { md5 = await ctx.api.put(prepared.presigned_url, buffer, type.mime) } catch (error) {
          // Complete was never requested, so retrying later cannot duplicate a finalized image.
          delete state.pending[hash]
          await this.store.save(ctx.appid, state)
          throw error
        }
        this.writable()
        let completed, recovered = false
        try { completed = await ctx.api.complete(prepared.upload_id, md5) } catch (error) {
          await this.sync(ctx, state)
          completed = Object.values(state.images).find(item => item.file_name === fileName)
          if (!completed) throw error
          recovered = true
        }
        image = storedImage({ ...completed, file_name: fileName, hash, size: buffer.length, lastUsed: this.now(),
          created_at: completed.created_at || Math.floor(this.now() / 1000), expires_at: completed.expires_at || Math.floor(this.now() / 1000) + (completed.ttl || MEDIA_IMAGE_TTL) })
        this.hold(ctx.appid, image.image_id)
        state.images[image.image_id] = image
        delete state.pending[hash]
        await this.store.save(ctx.appid, state)
        this.rememberListImage(ctx.appid, image)
        const snapshot = this.snapshots.get(ctx.appid)
        if (snapshot) {
          if (!recovered) snapshot.total++
          snapshot.managed = Object.keys(state.images).length
        }
        return { image, cached: false }
      })
      this.uploads.set(key, work)
      work.finally(() => { if (this.uploads.get(key) === work) this.uploads.delete(key) }).catch(() => {})
    }
    let result
    try {
      result = await work
    } catch (error) {
      // A rejected in-flight entry must not block the full-quota retry path.
      if (this.uploads.get(key) === work) this.uploads.delete(key)
      throw error
    }
    ctx.validate?.()
    this.writable()
    this.hold(ctx.appid, result.image.image_id)
    this.remember(selfId, result.cached ? 'cache' : 'official')
    return result.image.url
  }

  async protectPayload (selfId, payload) {
    const text = referenceText(payload)
    if (!text) return
    const ctx = this.context(selfId)
    await this.locked(ctx, async () => {
      const state = await this.store.load(ctx.appid)
      for (const image of Object.values(state.images)) if (text.includes(image.url)) this.hold(ctx.appid, image.image_id)
    })
  }

  async sent (selfId, payload) {
    const text = referenceText(payload)
    if (!text) return
    const ctx = this.context(selfId)
    await this.locked(ctx, async () => {
      const state = await this.store.load(ctx.appid)
      for (const image of Object.values(state.images)) if (text.includes(image.url)) {
        image.lastUsed = this.now()
        image.expires_at = Math.floor(this.now() / 1000) + MEDIA_IMAGE_TTL
      }
      await this.store.save(ctx.appid, state)
    })
  }

  async cleanState (ctx, state, { pressure = false, all = false, dryRun = false, ids, automatic = false, forceCount = 0 } = {}) {
    const settings = mediaImageSettings(this.settings(ctx.selfId)), now = this.now()
    const allowed = ids ? new Set(ids) : null
    const forced = Number(forceCount) > 0
    const candidates = Object.values(state.images).filter(image => (!allowed || allowed.has(image.image_id)) && !this.protected(ctx, image) && (
      forced || all || pressure || image.expires_at * 1000 <= now || now - image.lastUsed >= settings.retentionDays * DAY
    )).sort((a, b) => a.lastUsed - b.lastUsed)
    const target = forced ? Math.floor(forceCount) : pressure ? Math.max(0, (this.snapshots.get(ctx.appid)?.total || 0) - MEDIA_IMAGE_PRESSURE_TARGET) : candidates.length
    if (dryRun) return { candidates: candidates.slice(0, target).map(image => image.image_id), deleted: 0, failed: 0 }
    const result = { time: now, deleted: 0, failed: 0, skipped: 0 }
    for (const image of candidates.slice(0, target)) {
      this.writable(); ctx.validate?.()
      if (!forced && (automatic || pressure) && !mediaImageSettings(this.settings(ctx.selfId)).autoCleanup) break
      if (this.protected(ctx, image)) { result.skipped++; continue }
      try {
        await ctx.api.delete(image.image_id)
        delete state.images[image.image_id]
        this.forgetListImage(ctx.appid, image.image_id)
        // Persist each deletion. A failed write is recoverable by the next list reconciliation.
        await this.store.save(ctx.appid, state)
        result.deleted++
      } catch (error) { result.failed++; result.error = mediaErrorText(error) }
    }
    if (automatic && !result.deleted && !result.failed) return result
    state.lastCleanup = result
    await this.store.save(ctx.appid, state)
    const snapshot = this.snapshots.get(ctx.appid)
    if (snapshot) { snapshot.total -= result.deleted; snapshot.managed = Object.keys(state.images).length; snapshot.lastCleanup = result }
    return result
  }

  async cleanup (selfId, options = {}) {
    if (!options.dryRun) this.writable()
    const ctx = this.context(selfId)
    return this.locked(ctx, async () => {
      if (!options.dryRun) this.writable()
      const state = await this.store.load(ctx.appid)
      await this.sync(ctx, state)
      return this.cleanState(ctx, state, options)
    })
  }

  async delete (selfId, imageId) {
    this.writable()
    const ctx = this.context(selfId)
    return this.locked(ctx, async () => {
      this.writable()
      const state = await this.store.load(ctx.appid), list = await this.sync(ctx, state)
      const image = list.images.find(item => item.image_id === imageId)
      if (!image) throw new Error('当前机器人不存在该素材')
      if (this.protected(ctx, image)) throw new Error('该素材正在发送或被固定配置引用，暂不能删除')
      this.writable()
      await ctx.api.delete(imageId)
      delete state.images[imageId]
      this.forgetListImage(ctx.appid, imageId)
      await this.store.save(ctx.appid, state)
      this.snapshots.delete(ctx.appid)
    })
  }
}
