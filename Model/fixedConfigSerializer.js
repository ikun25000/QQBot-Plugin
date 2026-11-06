// Remove only data that is confirmed persisted in Level. Failed migrations
// retain their YAML source, and serialization never mutates the live config.
export function fixedConfigValue (config, store) {
  const value = structuredClone(config)
  for (const [id, record] of store.accounts) {
    if (value.selfOpenid?.[id] === record.selfOpenid) delete value.selfOpenid[id]
    if (value.bots?.[id]) delete value.bots[id].offlineDetect
  }
  if (value.selfOpenid && !Object.keys(value.selfOpenid).length) delete value.selfOpenid
  const ids = (value.token || []).map(token => String(token).split(':')[0]).filter(Boolean)
  if (ids.length && ids.every(id => store.accounts.has(id))) delete value.offlineDetect
  return value
}
