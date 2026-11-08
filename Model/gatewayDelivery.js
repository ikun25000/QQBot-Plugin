import { redactWsText } from './wsDiagnostics.js'

let collecting

// SDK EventEmitter delivery is synchronous, but application processing is not.
// Collect the promises explicitly registered by our three inbound listeners.
export function trackGatewayWork (promise) {
  Promise.resolve(promise).catch(() => {})
  if (collecting) collecting.push(Promise.resolve(promise))
  return promise
}

export function collectGatewayWork (work) {
  const previous = collecting
  const pending = collecting = []
  try {
    const result = work()
    if (result?.then) pending.push(result)
    return pending.length ? Promise.all(pending) : result
  } catch (error) {
    for (const promise of pending) promise.catch(() => {})
    throw error
  } finally { collecting = previous }
}

// The SDK's original method catches parsing failures and returns normally.
// Keep its parsing/emission contract but allow lifecycle to observe failures.
function logInformationalEvent (bot, event, payload, description) {
  const secrets = [bot.config?.secret, bot.sessionManager?.access_token, bot.sessionManager?.sessionRecord?.sessionID]
  bot.logger.info(`[WS] ${event} ${description} 原始事件=${redactWsText(JSON.stringify(payload), secrets)}`)
}

export function dispatchSdkEvent (event, payload, eventNames, originalEvent) {
  if (!payload || typeof event !== 'string' || !event) throw new Error('网关事件缺少事件名或数据')
  const transformed = Object.hasOwn(eventNames, event) ? eventNames[event] : undefined
  if (!transformed) {
    // No frozen list: future event IDs receive the same full-JSON diagnostic.
    // This is an intentional completed skip, not an application parser failure.
    logInformationalEvent(this, event, originalEvent || payload, '未支持事件（仅记录，跳过业务处理）')
    return
  }
  if (!payload.d) throw new Error('网关事件缺少事件名或数据')
  if (['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE'].includes(event) && payload.d.target?.type === 'ReactionTargetType_COMMENT') {
    // The legacy SDK only parses message reactions. Comment reactions are
    // deliberately informational: no synthetic message notice, but a completed
    // dispatch so this known target cannot pin the durable Resume checkpoint.
    logInformationalEvent(this, event, originalEvent || payload, 'ReactionTargetType_COMMENT（仅记录，跳过业务处理）')
    return
  }
  const parsed = this.processPayload(payload.id || '', transformed, payload.d)
  if (!parsed) throw new Error(`网关事件解析失败: ${event}`)
  // processPayload clones d before parsing, so a WeakMap keyed by d alone
  // cannot carry the original frame into the resulting SDK event.
  if (originalEvent) Object.defineProperty(parsed, '_qqbotOriginalEvent', { value: originalEvent, configurable: true })
  return this.em(transformed, parsed)
}
