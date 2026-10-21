export const UNKNOWN_OPENID = 'unknown'

export function isKnownQQBotOpenid (value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const text = String(value).trim()
  return Boolean(text && !/(?:^|[:：])(?:unknown|undefined|null)$/i.test(text) && !/^\d+[:：]$/.test(text))
}

export function getQQBotMessageUserOpenid (event = {}) {
  return [event.author?.id, event.author?.member_openid, event.sender?.user_id,
    event.author?.user_openid, event.user_id].find(isKnownQQBotOpenid)?.toString().trim() || ''
}

export function displayQQBotOpenid (value) {
  return isKnownQQBotOpenid(value) ? String(value).trim() : UNKNOWN_OPENID
}
