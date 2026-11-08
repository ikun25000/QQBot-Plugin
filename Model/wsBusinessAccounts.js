// Read current credentials and their authenticated transports only. A cached
// account/contact/Session record is never evidence of a usable local robot.
// This lookup performs no network requests, Identify, settings writes or DB IO.
export function listUsableBusinessBots ({ tokens, parseAccount, getBot, adapter }) {
  if (!Array.isArray(tokens)) return []
  const ids = [], qqs = new Set(), appids = new Set()
  for (const token of tokens) {
    try {
      const parsed = parseAccount(token)
      if (!parsed?.ok) continue
      const account = parsed.account, id = String(account.selfId), appid = String(account.appid)
      if (qqs.has(id) || appids.has(appid)) continue
      const bot = getBot(id), sdk = bot?.sdk, lifecycle = sdk?._sessionLifecycle
      if (bot?.adapter !== adapter || bot.disabledRuntime || bot.readOnlyMode || bot.defaultWsMode || bot.businessCredentialInvalid) continue
      if (String(sdk?.config?.appid || '') !== appid || sdk?.config?.secret !== account.secret) continue
      const socket = lifecycle?.readySocket
      if (!socket || socket !== sdk.ws || socket.readyState !== 1 || lifecycle.busy || lifecycle.terminal || lifecycle.isActive?.() !== true) continue
      qqs.add(id); appids.add(appid); ids.push(id)
    } catch { /* An unreadable/invalid account is not proof of availability. */ }
  }
  return ids
}
