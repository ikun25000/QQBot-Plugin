import { fillMissing } from './configMigration.js'
import { businessDefaults, validateBusinessSettings } from './wsBusinessConfig.js'

export function wsDefaults () {
  return {
    sessionSave: false,
    sandbox: false,
    offline: { enabled: false, interval: 5, autoReconnect: true, heartbeatTimeout: 60000, maxRetry: '.inf' },
    notifications: { enabled: false, zero: false, consumption: false, offline: false, method: 'sendmastermsg', recipient: '' },
    businessDetection: businessDefaults()
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function wsSettings (value = {}) {
  if (!object(value)) throw new Error('WS设置必须是对象')
  const result = {}
  fillMissing(result, value, wsDefaults())
  const invalid = field => { throw new Error(`WS设置 ${field} 无效，请检查 bots.<QQ>.ws`) }
  for (const key of ['sessionSave', 'sandbox']) if (typeof result[key] !== 'boolean') invalid(key)
  for (const key of ['offline', 'notifications']) if (!object(result[key])) invalid(key)
  for (const key of ['enabled', 'autoReconnect']) if (typeof result.offline[key] !== 'boolean') invalid(`offline.${key}`)
  if (!Number.isFinite(result.offline.interval) || result.offline.interval < 1 || result.offline.interval > 30) invalid('offline.interval')
  if (!Number.isFinite(result.offline.heartbeatTimeout) || result.offline.heartbeatTimeout <= 0) invalid('offline.heartbeatTimeout')
  const retry = result.offline.maxRetry
  if (retry === Infinity || retry === '.inf') result.offline.maxRetry = '.inf'
  else if (!Number.isSafeInteger(retry) || retry < 0) invalid('offline.maxRetry')
  for (const key of ['enabled', 'zero', 'consumption', 'offline']) if (typeof result.notifications[key] !== 'boolean') invalid(`notifications.${key}`)
  if (!['sendmastermsg', '本号'].includes(result.notifications.method)) invalid('notifications.method')
  if (typeof result.notifications.recipient !== 'string') invalid('notifications.recipient')
  validateBusinessSettings(result.businessDetection, invalid)
  return result
}

// Settings have one source of truth: YAML. Level is consulted ONCE for migration,
// then retains only runtime state and a migration marker, never active settings.
export function createWsYamlSettings ({ config, save }) {
  let queue = Promise.resolve()
  const serial = work => {
    const next = queue.catch(() => {}).then(work)
    queue = next
    return next
  }
  const read = id => wsSettings(config.bots?.[id]?.ws)
  async function persist (id, value, force = false) {
    const next = wsSettings(value)
    if (config.bots !== undefined && !object(config.bots)) throw new Error('bots配置必须是对象')
    const bots = config.bots ||= {}
    if (bots[id] !== undefined && !object(bots[id])) throw new Error(`bots.${id} 配置必须是对象`)
    const bot = bots[id] ||= {}
    const previous = bot.ws
    if (!force && JSON.stringify(previous) === JSON.stringify(next)) return next
    bot.ws = next
    try { await save() } catch (error) {
      // Never undo a later user edit or another setting's unrelated changes.
      if (bot.ws === next) {
        if (previous === undefined) delete bot.ws
        else bot.ws = previous
      }
      throw error
    }
    return next
  }
  return {
    read,
    write: (id, value, expected) => serial(() => {
      if (expected && JSON.stringify(read(id)) !== JSON.stringify(expected)) throw new Error('WS配置已刷新，请重试本次设置')
      return persist(id, value)
    }),
    migrate: (id, stored, legacy) => serial(async () => {
      const explicit = config.bots?.[id]?.ws
      if (explicit !== undefined) wsSettings(explicit)
      if (stored?.settingsStorage === 'yaml-v1') return read(id)
      if (stored?.settings !== undefined && !object(stored.settings)) throw new Error('旧WS设置损坏，拒绝猜测默认值')
      const value = {}
      const old = { offline: { ...legacy.offline } }
      const notify = stored?.settings?.offline?.notify ?? old.offline.notify
      if (typeof notify === 'boolean' && stored?.notificationMigrationVersion !== 1) old.notifications = { enabled: notify, offline: notify }
      // Old YAML accepted numeric strings and clamped the detection interval.
      for (const key of ['interval', 'heartbeatTimeout']) {
        if (old.offline[key] === undefined) continue
        const n = Number(old.offline[key])
        old.offline[key] = key === 'interval' ? Math.max(1, Math.min(30, n || 5)) : Number.isFinite(n) && n > 0 ? n : 60000
      }
      fillMissing(value, explicit, stored?.settings, old, wsDefaults())
      if (object(value.offline)) delete value.offline.notify
      // Even an identical in-memory value must pass the guarded YAML writer
      // before Level cleanup: defaults/migration may not have hit disk yet.
      return persist(id, value, true)
    }),
    validate (candidate) {
      if (candidate.bots !== undefined && !object(candidate.bots)) throw new Error('bots配置必须是对象')
      for (const [id, bot] of Object.entries(candidate.bots || {})) {
        if (bot?.ws !== undefined) {
          try { wsSettings(bot.ws) } catch (error) { throw new Error(`[${id}] ${error.message}`) }
        }
      }
    },
    exclusive: serial
  }
}
