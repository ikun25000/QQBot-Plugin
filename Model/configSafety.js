import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import YAML from 'yaml'

const CONFIG_FILE = resolve(process.cwd(), 'config', 'QQBot.yaml')
const BACKUP_DIR = resolve(process.cwd(), 'data', 'QQBotConfigBackup')
const LATEST_BACKUP = join(BACKUP_DIR, 'latest-good.yaml')
const LATEST_CREDENTIAL_BACKUP = join(BACKUP_DIR, 'latest-credential.yaml')
const REMOVAL_AUTHORIZATION = join(BACKUP_DIR, 'authorized-removal.sha256')
const LOSS_NOTIFICATION = join(BACKUP_DIR, 'credential-loss-notified.sha256')
const MAX_BACKUPS = 30
const HOOK_KEY = Symbol.for('QQBotPlugin.configSafetyHook')
const TIMER_KEY = Symbol.for('QQBotPlugin.configSafetyTimer')
const STATE_KEY = Symbol.for('QQBotPlugin.configSafetyState')
const originalWriteFile = globalThis[HOOK_KEY]?.originalWriteFile || fsPromises.writeFile.bind(fsPromises)
const originalRename = fsPromises.rename.bind(fsPromises)
const originalUnlink = fsPromises.unlink.bind(fsPromises)
const originalReadFile = fsPromises.readFile.bind(fsPromises)
const originalMkdir = fsPromises.mkdir.bind(fsPromises)
const originalReaddir = fsPromises.readdir.bind(fsPromises)

const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  writeQueue: Promise.resolve(),
  writeSeq: 0,
  interval: null,
  allowedCredentialRemovalHash: '',
  allowedCredentialRemovalUntil: 0,
  pendingCredentialLoss: null,
  credentialLossNotifier: null,
  credentialLossSync: null,
  credentialLossNotifierReady: false,
  watcher: null,
  watchTimer: null,
  attemptedCredentialLoss: new Set()
})
if (typeof state.allowedCredentialRemovalHash !== 'string') state.allowedCredentialRemovalHash = ''
if (!Number.isFinite(state.allowedCredentialRemovalUntil)) state.allowedCredentialRemovalUntil = 0
if (!(state.attemptedCredentialLoss instanceof Set)) state.attemptedCredentialLoss = new Set()

function parseValidConfig (text) {
  if (!String(text || '').trim()) throw new Error('QQBot配置为空')
  const value = YAML.parse(String(text))
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error('QQBot配置不是有效对象')
  return value
}

function credentialAccounts (value) {
  const accounts = new Map()
  if (!Array.isArray(value?.token)) return accounts
  for (const item of value.token) {
    const parts = String(item || '').split(':').map(part => part.trim())
    const selfId = parts[0]
    const appid = parts[1]
    const secret = parts.length === 4 ? parts[2] : parts.length === 6 ? parts[3] : ''
    if (selfId && appid && secret) accounts.set(selfId, { selfId, appid })
  }
  return accounts
}

function credentialTokenMap (value) {
  const tokens = new Map()
  if (!Array.isArray(value?.token)) return tokens
  for (const token of value.token) {
    const text = String(token || '')
    const account = credentialAccounts({ token: [text] }).values().next().value
    if (account) tokens.set(account.selfId, text)
  }
  return tokens
}

function hasCredentials (value) {
  return credentialAccounts(value).size > 0
}

function getMissingCredentialAppids (next, current) {
  const nextAccounts = credentialAccounts(next)
  return [...credentialAccounts(current).values()]
    .filter(item => !nextAccounts.has(item.selfId))
    .map(item => item.appid)
    .filter(Boolean)
}

function preserveCurrentCredentialRemovals (next, current, baseline) {
  const baselineTokens = credentialTokenMap(baseline)
  const currentTokens = credentialTokenMap(current)
  const nextTokens = credentialTokenMap(next)
  const result = []
  for (const [selfId, token] of nextTokens) {
    if (currentTokens.has(selfId) || !baselineTokens.has(selfId)) result.push(token)
  }
  for (const [selfId, token] of currentTokens) {
    if (!nextTokens.has(selfId)) result.push(token)
  }
  return result
}

async function syncFile (file) {
  const handle = await fsPromises.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncDirectory (dir) {
  try {
    const handle = await fsPromises.open(dir, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {}
}

async function writeAtomic (file, text, mode = 0o600) {
  await originalMkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.${++state.writeSeq}.tmp`
  try {
    await originalWriteFile(tmp, text, { encoding: 'utf8', mode })
    await syncFile(tmp)
    await originalRename(tmp, file)
    await syncDirectory(dirname(file))
  } catch (err) {
    try { await originalUnlink(tmp) } catch {}
    throw err
  }
}

function hashText (text) {
  return createHash('sha256').update(text).digest('hex')
}

async function readValidText (file) {
  const text = await originalReadFile(file, 'utf8')
  parseValidConfig(text)
  return text
}

async function pruneBackups () {
  const entries = await originalReaddir(BACKUP_DIR, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(item => item.isFile() && /^QQBot-\d{8}T\d{6}-[a-f0-9]{12}\.yaml$/.test(item.name))
    .map(item => item.name)
    .sort()
  for (const name of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
    try { await originalUnlink(join(BACKUP_DIR, name)) } catch {}
  }
}

async function saveBackup (text, updateCredential = true) {
  const value = parseValidConfig(text)
  await originalMkdir(BACKUP_DIR, { recursive: true, mode: 0o700 })
  const hash = hashText(text)
  const entries = await originalReaddir(BACKUP_DIR).catch(() => [])
  if (!entries.some(name => name.endsWith(`-${hash.slice(0, 12)}.yaml`))) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')
    await writeAtomic(join(BACKUP_DIR, `QQBot-${stamp}-${hash.slice(0, 12)}.yaml`), text)
  }
  await writeAtomic(LATEST_BACKUP, text)
  if (updateCredential && hasCredentials(value)) await writeAtomic(LATEST_CREDENTIAL_BACKUP, text)
  await pruneBackups()
}

async function findLatestValidBackup () {
  const entries = await originalReaddir(BACKUP_DIR).catch(() => [])
  const candidates = [LATEST_BACKUP, ...entries
    .filter(name => /^QQBot-\d{8}T\d{6}-[a-f0-9]{12}\.yaml$/.test(name))
    .sort()
    .reverse()
    .map(name => join(BACKUP_DIR, name))]
  for (const file of candidates) {
    try { return { file, text: await readValidText(file) } } catch {}
  }
  return null
}

async function findLatestCredentialBackup () {
  const entries = await originalReaddir(BACKUP_DIR).catch(() => [])
  const candidates = [LATEST_CREDENTIAL_BACKUP, LATEST_BACKUP, ...entries
    .filter(name => /^QQBot-\d{8}T\d{6}-[a-f0-9]{12}\.yaml$/.test(name))
    .sort()
    .reverse()
    .map(name => join(BACKUP_DIR, name))]
  for (const file of candidates) {
    try {
      const text = await readValidText(file)
      if (hasCredentials(parseValidConfig(text))) return { file, text }
    } catch {}
  }
  return null
}

async function isAuthorizedCredentialRemoval (text) {
  parseValidConfig(text)
  try { return String(await originalReadFile(REMOVAL_AUTHORIZATION, 'utf8')).trim() === hashText(text) } catch { return false }
}

async function flushQQBotCredentialLossNotification () {
  state.credentialLossNotifierReady = true
  const pending = state.pendingCredentialLoss
  if (!pending || typeof state.credentialLossNotifier !== 'function') return false
  if (state.attemptedCredentialLoss.has(pending.signature)) return false
  state.attemptedCredentialLoss.add(pending.signature)
  try {
    await state.credentialLossNotifier([...pending.appids])
    await writeAtomic(LOSS_NOTIFICATION, pending.signature)
    if (state.pendingCredentialLoss?.signature === pending.signature) state.pendingCredentialLoss = null
    return true
  } catch (err) {
    state.attemptedCredentialLoss.delete(pending.signature)
    globalThis.logger?.error?.('[QQBot-Plugin] QQBot凭据丢失主人通知失败:', err.message)
    return false
  }
}

function setQQBotCredentialLossNotifier (notifier) {
  state.credentialLossNotifier = typeof notifier === 'function' ? notifier : null
}

function setQQBotCredentialLossSync (sync) {
  state.credentialLossSync = typeof sync === 'function' ? sync : null
}

async function queueCredentialLossNotification (appids, tokens = []) {
  appids = [...new Set(appids.map(String).filter(Boolean))].sort()
  if (!appids.length) return
  state.credentialLossSync?.([...tokens])
  const signature = hashText(appids.join(','))
  try {
    if (String(await originalReadFile(LOSS_NOTIFICATION, 'utf8')).trim() === signature) return
  } catch {}
  state.pendingCredentialLoss = { appids, signature }
  if (state.credentialLossNotifierReady) await flushQQBotCredentialLossNotification()
}

async function clearCredentialLossNotification () {
  state.pendingCredentialLoss = null
  state.attemptedCredentialLoss.clear()
  try { await originalUnlink(LOSS_NOTIFICATION) } catch {}
}

async function preserveBrokenConfig () {
  try {
    const text = await originalReadFile(CONFIG_FILE, 'utf8')
    await originalMkdir(BACKUP_DIR, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeAtomic(join(BACKUP_DIR, `broken-${stamp}.yaml`), text)
  } catch {}
}

async function prepareQQBotConfig () {
  if (!fs.existsSync(CONFIG_FILE)) {
    const latest = await findLatestValidBackup()
    const backup = latest && await isAuthorizedCredentialRemoval(latest.text) ? latest : await findLatestCredentialBackup() || latest
    if (backup) await writeAtomic(CONFIG_FILE, backup.text)
    return
  }
  try {
    const text = await readValidText(CONFIG_FILE)
    const current = parseValidConfig(text)
    const authorizedRemoval = await isAuthorizedCredentialRemoval(text)
    const credentialBackup = await findLatestCredentialBackup()
    if (!authorizedRemoval && credentialBackup) {
      const missingAppids = getMissingCredentialAppids(current, parseValidConfig(credentialBackup.text))
      if (missingAppids.length) {
        if (!hasCredentials(current)) throw new Error('QQBot配置中的全部凭据均已丢失')
        await queueCredentialLossNotification(missingAppids, current.token)
        await saveBackup(text, false)
        return
      }
    }
    if (authorizedRemoval && hasCredentials(current)) { try { await originalUnlink(REMOVAL_AUTHORIZATION) } catch {} }
    await clearCredentialLossNotification()
    await saveBackup(text)
  } catch (err) {
    let backup = null
    try {
      const latest = await findLatestValidBackup()
      if (latest && await isAuthorizedCredentialRemoval(latest.text)) backup = latest
    } catch {}
    if (!backup) backup = await findLatestCredentialBackup() || await findLatestValidBackup()
    if (!backup) throw new Error(`QQBot配置损坏且没有有效备份，已拒绝使用默认配置覆盖: ${err.message}`)
    await preserveBrokenConfig()
    await writeAtomic(CONFIG_FILE, backup.text)
    globalThis.logger?.warn?.('[QQBot-Plugin] QQBot配置损坏，已恢复最近有效备份')
  }
}

async function safeConfigWrite (file, data, options) {
  let text = Buffer.isBuffer(data) ? data.toString(options?.encoding || 'utf8') : String(data)
  let next
  try { next = parseValidConfig(text) } catch (err) {
    throw err
  }
  const allowRemoval = state.allowedCredentialRemovalHash === hashText(text) && state.allowedCredentialRemovalUntil >= Date.now()
  if (allowRemoval || state.allowedCredentialRemovalUntil < Date.now()) {
    state.allowedCredentialRemovalHash = ''
    state.allowedCredentialRemovalUntil = 0
  }
  state.writeQueue = state.writeQueue.catch(() => {}).then(async () => {
    let current = ''
    try {
      current = await readValidText(CONFIG_FILE)
    } catch (err) {
      await prepareQQBotConfig()
      if (fs.existsSync(CONFIG_FILE)) current = await readValidText(CONFIG_FILE)
    }
    const currentAuthorizedRemoval = current ? await isAuthorizedCredentialRemoval(current) : false
    const credentialBackup = await findLatestCredentialBackup()
    const baseline = credentialBackup ? parseValidConfig(credentialBackup.text) : null
    const currentValue = current ? parseValidConfig(current) : null
    const currentMissingAppids = currentValue && !currentAuthorizedRemoval && baseline ? getMissingCredentialAppids(currentValue, baseline) : []
    if (!allowRemoval && currentMissingAppids.length && baseline && getMissingCredentialAppids(next, baseline).length < currentMissingAppids.length) {
      next.token = preserveCurrentCredentialRemovals(next, currentValue, baseline)
      text = YAML.stringify(next)
    }
    const missingAppids = !allowRemoval && !currentAuthorizedRemoval && baseline ? getMissingCredentialAppids(next, baseline) : []
    if (missingAppids.length && !hasCredentials(next)) {
      await writeAtomic(CONFIG_FILE, credentialBackup.text)
      await saveBackup(credentialBackup.text)
      await clearCredentialLossNotification()
      globalThis.logger?.warn?.('[QQBot-Plugin] QQBot配置中的全部凭据均已丢失，已恢复最近完整凭据备份')
      return
    }
    if (current && hashText(current) !== hashText(text)) {
      await saveBackup(current, currentAuthorizedRemoval || currentMissingAppids.length === 0)
    }
    if (allowRemoval && !hasCredentials(next)) await writeAtomic(REMOVAL_AUTHORIZATION, hashText(text))
    else if (allowRemoval) { try { await originalUnlink(REMOVAL_AUTHORIZATION) } catch {} }
    await writeAtomic(CONFIG_FILE, text)
    await saveBackup(text, allowRemoval || currentAuthorizedRemoval || missingAppids.length === 0)
    if (missingAppids.length) await queueCredentialLossNotification(missingAppids, next.token)
    else await clearCredentialLossNotification()
    if (currentAuthorizedRemoval && !allowRemoval && !hasCredentials(next)) await writeAtomic(REMOVAL_AUTHORIZATION, hashText(text))
    else if (currentAuthorizedRemoval && hasCredentials(next)) { try { await originalUnlink(REMOVAL_AUTHORIZATION) } catch {} }
  })
  return state.writeQueue
}

function allowNextQQBotCredentialRemoval (nextConfig) {
  const text = typeof nextConfig === 'string' ? nextConfig : YAML.stringify(nextConfig)
  state.allowedCredentialRemovalHash = hashText(text)
  state.allowedCredentialRemovalUntil = Date.now() + 60000
}

function installQQBotConfigSafetyHook () {
  const baseWriteFile = globalThis[HOOK_KEY]?.originalWriteFile || originalWriteFile
  const hookedWriteFile = function (file, data, options) {
    const target = resolve(String(file))
    if (target !== CONFIG_FILE) return baseWriteFile(file, data, options)
    return safeConfigWrite(target, data, options)
  }
  fsPromises.writeFile = hookedWriteFile
  const hookState = { configFile: CONFIG_FILE, backupDir: BACKUP_DIR, originalWriteFile: baseWriteFile }
  globalThis[HOOK_KEY] = hookState
  return hookState
}

function startQQBotConfigBackupCheck () {
  state.backupCheck = prepareQQBotConfig
  if (!state.watcher) {
    state.watcher = fs.watch(dirname(CONFIG_FILE), { persistent: false }, (eventType, fileName) => {
      if (fileName && basename(String(fileName)) !== basename(CONFIG_FILE)) return
      if (state.watchTimer) clearTimeout(state.watchTimer)
      state.watchTimer = setTimeout(() => {
        state.watchTimer = null
        state.writeQueue = state.writeQueue.catch(() => {}).then(() => state.backupCheck())
        state.writeQueue.catch(err => globalThis.logger?.error?.('[QQBot-Plugin] QQBot配置变更校验失败:', err.message))
      }, 500)
      state.watchTimer.unref?.()
    })
  }
  if (state.interval || globalThis[TIMER_KEY]) return
  state.interval = setInterval(() => {
    state.writeQueue = state.writeQueue.catch(() => {}).then(() => state.backupCheck())
    state.writeQueue.catch(err => {
      globalThis.logger?.error?.('[QQBot-Plugin] QQBot配置定期校验失败:', err.message)
    })
  }, 6 * 60 * 60 * 1000)
  state.interval.unref?.()
  globalThis[TIMER_KEY] = state.interval
}

async function reloadSafeQQBotConfig () {
  await prepareQQBotConfig()
  return parseValidConfig(await originalReadFile(CONFIG_FILE, 'utf8'))
}

export {
  CONFIG_FILE,
  BACKUP_DIR,
  installQQBotConfigSafetyHook,
  allowNextQQBotCredentialRemoval,
  prepareQQBotConfig,
  reloadSafeQQBotConfig,
  startQQBotConfigBackupCheck,
  setQQBotCredentialLossNotifier,
  setQQBotCredentialLossSync,
  flushQQBotCredentialLossNotification
}
