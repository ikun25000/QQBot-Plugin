import crypto from 'node:crypto'
import axios from 'axios'
import QRCode from 'qrcode'

const PORTAL_HOST = process.env.QQ_PORTAL_HOST || 'q.qq.com'
const CREATE_BIND_TASK_URL = `https://${PORTAL_HOST}/lite/create_bind_task`
const POLL_BIND_RESULT_URL = `https://${PORTAL_HOST}/lite/poll_bind_result`
const CONNECT_URL = `https://${PORTAL_HOST}/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=yunzai`
const POLL_INTERVAL = 2000
const REQUEST_TIMEOUT = 10000
const MAX_REFRESHES = 3
const QR_TIMEOUT_MS = 4 * 60 * 1000

const BindStatus = {
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3
}

function getResponseError (data, fallback) {
  return data?.message || data?.msg || fallback
}

function decryptSecret (encryptedBase64, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(encryptedBase64, 'base64')
  if (raw.length < 29) throw new Error('扫码凭证格式错误')
  const iv = raw.subarray(0, 12)
  const encrypted = raw.subarray(12)
  const authTag = encrypted.subarray(encrypted.length - 16)
  const ciphertext = encrypted.subarray(0, encrypted.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

async function createBindTask () {
  const key = crypto.randomBytes(32).toString('base64')
  const { data } = await axios.post(CREATE_BIND_TASK_URL, { key }, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'QQBotAdapter/Yunzai (Node.js)'
    }
  })
  if (data?.retcode !== 0) throw new Error(getResponseError(data, '创建绑定任务失败'))
  const taskId = data.data?.task_id
  if (!taskId) throw new Error('创建绑定任务失败：响应缺少 task_id')
  return { taskId, key }
}

async function pollBindResult (taskId) {
  const { data } = await axios.post(POLL_BIND_RESULT_URL, { task_id: taskId }, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'QQBotAdapter/Yunzai (Node.js)'
    }
  })
  if (data?.retcode !== 0) throw new Error(getResponseError(data, '轮询绑定结果失败'))
  return {
    status: Number(data.data?.status || 0),
    appId: String(data.data?.bot_appid || ''),
    encryptedSecret: data.data?.bot_encrypt_secret || '',
    userOpenid: data.data?.user_openid || ''
  }
}

async function qrRegister ({ onQRCode, onStatusChange } = {}) {
  const deadline = Date.now() + QR_TIMEOUT_MS
  let lastError = null

  for (let refreshCount = 0; refreshCount <= MAX_REFRESHES && Date.now() < deadline; refreshCount++) {
    const { taskId, key } = await createBindTask()
    const url = CONNECT_URL.replace('{task_id}', encodeURIComponent(taskId))
    const imageBuffer = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 2 })
    await onQRCode?.(imageBuffer, url)
    await onStatusChange?.(BindStatus.PENDING, '请使用手机 QQ 扫描二维码')

    while (Date.now() < deadline) {
      let result
      try {
        result = await pollBindResult(taskId)
        lastError = null
      } catch (err) {
        lastError = err
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
        continue
      }
      if (result.status === BindStatus.COMPLETED) {
        if (!result.appId || !result.encryptedSecret) throw new Error('扫码结果缺少机器人凭证')
        const clientSecret = decryptSecret(result.encryptedSecret, key)
        await onStatusChange?.(BindStatus.COMPLETED, '扫码成功')
        return { appId: result.appId, clientSecret, userOpenid: result.userOpenid }
      }
      if (result.status === BindStatus.EXPIRED) {
        await onStatusChange?.(BindStatus.EXPIRED, refreshCount >= MAX_REFRESHES ? '二维码已过期' : '二维码已过期，正在刷新')
        break
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
    }
  }

  if (lastError) throw lastError
  throw new Error(Date.now() >= deadline ? '扫码授权超时' : '二维码已过期')
}

export { BindStatus, qrRegister }
