export const businessParameterLimits = {
  silenceMinutes: [1, 1440], takeoverMinutes: [1, 1440], cooldownMinutes: [1, 1440],
  dailyLimit: [0, 100], reserve: [0, 100000], probeSeconds: [5, 60], observeSeconds: [15, 120]
}

export function businessDefaults () {
  return {
    enabled: false, helper: false, temporaryIdentify: false, autoTakeover: false, allowSender: false,
    silence: false, consumption: false,
    silenceMinutes: 10, takeoverMinutes: 3, cooldownMinutes: 30,
    dailyLimit: 6, reserve: 10, probeSeconds: 15, observeSeconds: 60,
    binding: null
  }
}

export function validateBusinessSettings (value, invalid) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('businessDetection')
  for (const key of ['enabled', 'helper', 'temporaryIdentify', 'autoTakeover', 'allowSender', 'silence', 'consumption']) {
    if (typeof value[key] !== 'boolean') invalid(`businessDetection.${key}`)
  }
  for (const [key, [min, max]] of Object.entries(businessParameterLimits)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) invalid(`businessDetection.${key}`)
  }
  const binding = value.binding
  if (binding === null) return
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return invalid('businessDetection.binding')
  for (const key of ['senderQQ', 'senderAppid', 'receiverAppid', 'senderGroup', 'receiverGroup', 'senderMemberOpenid']) {
    if (typeof binding[key] !== 'string' || !binding[key].trim()) invalid(`businessDetection.binding.${key}`)
  }
  if (binding.senderAppid === binding.receiverAppid || binding.senderGroup === binding.receiverGroup) invalid('businessDetection.binding（两端AppID及群OpenID必须分别独立）')
  if (typeof binding.sandbox !== 'boolean') invalid('businessDetection.binding.sandbox')
}

const businessEvents = new Set(['MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE',
  'C2C_MESSAGE_CREATE', 'INTERACTION_CREATE', 'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MEMBER_ADD', 'GROUP_MEMBER_REMOVE',
  'GROUP_JOIN_REQUEST', 'FRIEND_ADD', 'FRIEND_DEL', 'C2C_MSG_RECEIVE', 'C2C_MSG_REJECT', 'GROUP_MSG_RECEIVE', 'GROUP_MSG_REJECT'])
export const isBusinessEvent = frame => frame?.op === 0 && !!frame.d && businessEvents.has(frame.t)

export function businessGroupContext (event) {
  const original = event?.raw?._qqbotOriginalEvent || event?._qqbotOriginalEvent
  const raw = original?.d || event?.raw || event || {}
  const mentions = raw._mentions || raw.mentions || event?._mentions || event?.mentions || []
  return {
    group: String(raw.group_openid || event?.group_openid || ''),
    actor: String(raw.author?.member_openid || raw.author?.user_openid || raw.author?.id || event?.user_id || ''),
    human: !!raw.author && raw.author.bot !== true,
    isYou: Array.isArray(mentions) && mentions.some(item => item?.is_you === true),
    hasMentions: Array.isArray(mentions) && mentions.length > 0,
    full: original?.t === 'GROUP_MESSAGE_CREATE' || raw._qqbotRawEvent === 'GROUP_MESSAGE_CREATE' || event?._qqbotFullMessageCreate === true
  }
}

export function matchBusinessGroups (receiver, groups) {
  const name = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  const expected = name(receiver?.group_name)
  if (!expected) return []
  const count = Number(receiver.group_member_num) || 0
  // Cached permissions/counts can be stale. Neither may silently hide a named
  // group; live permissions are checked only for the one explicitly selected.
  const candidates = groups.filter(group => name(group.group_name) === expected)
    .map(group => ({ ...group, difference: count && Number(group.group_member_num) ? Math.abs(count - Number(group.group_member_num)) : Infinity }))
    .sort((a, b) => a.difference - b.difference)
  return candidates.slice(0, 200)
}
