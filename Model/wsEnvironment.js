export function wsEndpoints ({ sandbox = false, apiMode = 'old' } = {}) {
  // There is no documented new-domain sandbox endpoint. Sandbox always uses
  // the established sandbox gateway/API, never the production new-domain URL.
  const modern = apiMode === 'new'
  return {
    tokenUrl: modern ? 'https://api.bot.qq.com/app/getAppAccessToken' : 'https://bots.qq.com/app/getAppAccessToken',
    apiBase: sandbox ? 'https://sandbox.api.sgroup.qq.com' : modern ? 'https://api.bot.qq.com' : 'https://api.sgroup.qq.com',
    wsUrl: sandbox ? 'wss://sandbox.api.sgroup.qq.com/websocket' : modern ? 'wss://api.bot.qq.com/websocket/' : 'wss://api.sgroup.qq.com/websocket'
  }
}
