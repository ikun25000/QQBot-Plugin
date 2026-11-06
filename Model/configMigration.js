const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Missing means undefined, never false/0/empty string. Every inherited value
// gets its own copy so changing one bot cannot mutate another bot's defaults.
export function fillMissing (target, ...sources) {
  let changed = false
  for (const source of sources) {
    if (!isRecord(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || value === undefined) continue
      if (target[key] === undefined) {
        target[key] = structuredClone(value)
        changed = true
      } else if (isRecord(target[key]) && isRecord(value)) changed = fillMissing(target[key], value) || changed
    }
  }
  return changed
}

export function configuredBotIds (config, ...extra) {
  return [...new Set([
    ...(Array.isArray(config.token) ? config.token.map(token => String(token).split(':')[0]) : []),
    ...Object.keys(config.bots || {}), ...extra.flat()
  ].filter(Boolean))]
}

// Shared by startup configuration and accounts added without restarting.
export function botOptionDefaults () {
  return {
    toQRCode: true, toCallback: false, toBotUpload: true,
    markdownImageConvert: false,
    imageFallback: { provider: 'official', autoCleanup: true, retentionDays: 3, quotaPolicy: 'cleanup' },
    forceSilk: true, audioErrorFallback: true, audioErrorFallbackPriority: 'file', audioCorrectFileName: true,
    markdownReference: false, groupEvent: false, toQQUin: false, toImg: true, callStats: false, userStats: false,
    joinNotify: false, joinNotifyMode: 'group', joinNotifyUserOpenid: ''
  }
}

export function legacyWsAccountConfig (config, id) {
  const offline = {}
  fillMissing(offline, config.bots?.[id]?.offlineDetect, config.offlineDetect, config.bots?.default?.offlineDetect)
  const retry = offline.maxRetry === undefined ? config.bot?.maxRetry : offline.maxRetry
  const number = typeof retry === 'number' || typeof retry === 'string' && retry.trim() ? Number(retry) : NaN
  offline.maxRetry = Number.isFinite(number) && number >= 0 ? number : '.inf'
  // sandbox is intentionally NOT a migration input.
  return { offline, selfOpenid: config.selfOpenid?.[id] }
}

export function migrateLegacyUserAgent (config, id) {
  const value = config.bots?.[id]?.userAgent ?? config.userAgent ?? config.bots?.default?.userAgent
  const fallback = id !== 'default' ? config.userManage?.bots?.default : null
  if (typeof value !== 'string' && typeof value !== 'boolean' && !fallback) return false
  if (!isRecord(config.userManage)) config.userManage = {}
  if (!isRecord(config.userManage.bots)) config.userManage.bots = {}
  if (!isRecord(config.userManage.bots[id])) config.userManage.bots[id] = {}
  const target = config.userManage.bots[id]
  const defaults = typeof value === 'string' ? { ua: value, uaEnabled: !!value.trim() }
    : typeof value === 'boolean' ? { uaEnabled: value } : {}
  const template = fallback ? { ua: fallback.ua, uaEnabled: fallback.uaEnabled } : {}
  let changed = fillMissing(target, defaults, template)
  if (config.bots?.[id]?.userAgent !== undefined) {
    delete config.bots[id].userAgent
    changed = true
  }
  return changed
}

export function migrateLegacyClawConfig (config, selfId = '') {
  const root = config.claw
  if (!isRecord(root)) return false
  const keys = ['online', 'code', 'json']
  if (!keys.some(key => root[key] !== undefined) && root.groups === undefined) return false
  if (!isRecord(root.bots)) root.bots = {}
  const ids = configuredBotIds(config, Object.keys(root.bots), selfId)
  if (!ids.length) ids.push('default')
  for (const id of ids) {
    if (!isRecord(root.bots[id])) root.bots[id] = {}
    const target = root.bots[id]
    const legacy = Object.fromEntries(keys.filter(key => root[key] !== undefined).map(key => [key, root[key]]))
    fillMissing(target, legacy)
  }
  for (const key of [...keys, 'groups']) delete root[key]
  return true
}
