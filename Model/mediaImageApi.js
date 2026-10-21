import { createHash } from 'node:crypto'

export const MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const MEDIA_IMAGE_TTL = 7776000
export const mediaErrorCode = error => Number(error?.response?.data?.err_code || error?.response?.data?.code || error?.code) || 0
export const mediaErrorText = error => `code=${mediaErrorCode(error)} ${error?.response?.data?.message || error?.message || '未知错误'}`.replace(/https?:\/\/\S+/g, '[URL]')

export function detectMediaImageType (buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: 'png', mime: 'image/png' }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' }
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return { ext: 'gif', mime: 'image/gif' }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}

function normalizePreviewUrl (value) {
  if (!value) return ''
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return ''
    return url.toString()
  } catch { return '' }
}

export function normalizeMediaImage (image) {
  if (!image?.image_id || !String(image.url || '').startsWith('qqbot-media://image/v1/')) throw new Error('官方素材响应缺少有效图片 ID 或引用')
  const previewUrl = normalizePreviewUrl(image.preview_url)
  return {
    image_id: String(image.image_id), url: image.url, file_name: String(image.file_name || ''),
    created_at: Number(image.created_at) || 0, expires_at: Number(image.expires_at) || 0,
    ...(previewUrl ? { preview_url: previewUrl } : {})
  }
}

// Tokens and COS signatures stay in memory. Never send the bot Authorization to COS.
export class MediaImageApi {
  constructor ({ transport, getToken, validate = () => {}, apiTimeout = 10000, uploadTimeout = 45000 }) {
    Object.assign(this, { transport, getToken, validate, apiTimeout, uploadTimeout })
  }

  async request (method, path, data) {
    this.validate()
    const signal = AbortSignal.timeout(this.apiTimeout)
    let stop
    try {
      const token = await Promise.race([
        Promise.resolve().then(() => this.getToken(signal)),
        new Promise((resolve, reject) => {
          stop = () => reject(new Error('官方素材获取凭据超时'))
          signal.addEventListener('abort', stop, { once: true })
        })
      ])
      this.validate()
      const response = await this.transport({
        method, url: `https://api.bot.qq.com${path}`, data, signal, timeout: this.apiTimeout,
        maxRedirects: 0, headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' }
      })
      this.validate()
      if (response.status < 200 || response.status >= 300 || Number(response.data?.code || response.data?.err_code)) throw Object.assign(new Error('官方素材接口失败'), { response })
      return response.data
    } finally {
      if (stop) signal.removeEventListener('abort', stop)
    }
  }

  async list () {
    const images = [], seen = new Set()
    let cursor = '', total = 0
    for (let page = 0; page < 100; page++) {
      const body = await this.request('GET', `/v2/media-images${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
      if (!Array.isArray(body.images) || !Number.isFinite(Number(body.total))) throw new Error('官方素材列表响应无效')
      images.push(...body.images.map(normalizeMediaImage))
      total = Number(body.total)
      cursor = body.next_cursor || ''
      if (!cursor) return { images, total }
      if (seen.has(cursor)) throw new Error('官方素材列表游标重复')
      seen.add(cursor)
    }
    throw new Error('官方素材列表超过分页上限')
  }

  prepare (buffer, fileName, type) {
    return this.request('POST', '/v2/media-images/prepare', {
      file_name: fileName, file_size: buffer.length, content_type: type.mime,
      md5: createHash('md5').update(buffer).digest('hex'), sha1: createHash('sha1').update(buffer).digest('hex')
    })
  }

  async put (url, buffer, mime) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.myqcloud.com') || parsed.username || parsed.password) throw new Error('官方素材预签名上传地址无效')
    this.validate()
    const response = await this.transport({
      method: 'PUT', url, data: buffer, timeout: this.uploadTimeout, signal: AbortSignal.timeout(this.uploadTimeout),
      maxRedirects: 0, maxBodyLength: Infinity,
      headers: { 'Content-Type': mime, 'Content-Length': String(buffer.length) }
    })
    this.validate()
    const etag = String(response.headers?.etag || response.headers?.get?.('etag') || '').replace(/^"|"$/g, '')
    if (response.status !== 200 || etag.toLowerCase() !== createHash('md5').update(buffer).digest('hex')) throw new Error('官方素材上传 ETag 校验失败')
    return etag
  }

  async complete (uploadId, md5) {
    const body = await this.request('POST', '/v2/media-images/complete', { upload_id: uploadId, md5 })
    return { ...normalizeMediaImage(body), ttl: Number(body.ttl) || MEDIA_IMAGE_TTL }
  }

  async delete (imageId) {
    try { await this.request('DELETE', `/v2/media-images/${encodeURIComponent(imageId)}/delete`) } catch (error) {
      if (mediaErrorCode(error) !== 40035008) throw error
    }
  }
}
