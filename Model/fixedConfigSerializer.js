// Canonical bots.<QQ>.ws settings stay in YAML. Only obsolete, successfully
// migrated sources and learned runtime data are removed from serialization.
export function fixedConfigValue (config, store) {
  const value = structuredClone(config)
  // The removed raw-send switch must not silently enable active link rewriting.
  delete value.messageRawSend
  for (const bot of Object.values(value.bots || {})) {
    if (bot && typeof bot === 'object') delete bot.messageRawSend
  }
  for (const [id, record] of store.accounts) {
    if (value.selfOpenid && value.selfOpenid[id] === record.selfOpenid) delete value.selfOpenid[id]
    if (value.bots?.[id] && (!store.settingsBackend || record.settingsStorage === 'yaml-v1' && value.bots[id].ws)) delete value.bots[id].offlineDetect
  }
  if (value.selfOpenid && !Object.keys(value.selfOpenid).length) delete value.selfOpenid
  const ids = (value.token || []).map(token => String(token).split(':')[0]).filter(Boolean)
  if (ids.length && ids.every(id => store.accounts.has(id) && (!store.settingsBackend || value.bots?.[id]?.ws))) delete value.offlineDetect
  return value
}
