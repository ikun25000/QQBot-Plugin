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
export function dispatchSdkEvent (event, payload, eventNames, originalEvent) {
  if (!payload?.d || !event) throw new Error('网关事件缺少事件名或数据')
  const transformed = eventNames[event]
  if (!transformed) return // explicitly unsupported events need no business ACK
  const parsed = this.processPayload(payload.id || '', transformed, payload.d)
  if (!parsed) throw new Error(`网关事件解析失败: ${event}`)
  // processPayload clones d before parsing, so a WeakMap keyed by d alone
  // cannot carry the original frame into the resulting SDK event.
  if (originalEvent) Object.defineProperty(parsed, '_qqbotOriginalEvent', { value: originalEvent, configurable: true })
  return this.em(transformed, parsed)
}
