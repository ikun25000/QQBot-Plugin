import { createHash } from 'node:crypto'

export function wsSessionLabel (value) {
  const id = String(value || '')
  if (!id) return '无'
  const masked = id.length > 12 && /^[\w-]+$/.test(id) ? `${id.slice(0, 4)}…${id.slice(-4)}` : '[hidden]'
  return `${masked}(指纹=${createHash('sha256').update(id).digest('hex').slice(0, 10)})`
}

export function redactWsText (value, secrets = []) {
  let text = String(value || '')
  for (const secret of secrets) if (secret) text = text.split(String(secret)).join('[redacted]')
  return text
    .replace(/((?:access[_-]?token|client[_-]?secret|app[_-]?secret|session[_-]?id|authorization|token|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1"[redacted]"')
    .replace(/((?:access[_-]?token|client[_-]?secret|app[_-]?secret|session[_-]?id|authorization|token|secret)["']?\s*[:=]\s*)(?:QQBot\s+|Bearer\s+)?[^\s,;}\])"']+/gi, '$1[redacted]')
}

export function wsErrorDiagnostic (error, stage, secrets = []) {
  const safe = value => redactWsText(value, secrets).replace(/[\r\n]/g, ' ').slice(0, 500)
  const result = new Error(`[WS] stage=${safe(stage)} code=${safe(error?.code || error?.cause?.code || 'unknown')} ${safe(error?.message || error || '未知异常')}`)
  result.stage = stage
  const frames = redactWsText(error?.stack, secrets).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 8).map(line => line.slice(0, 500))
  result.stack = `${result.name}: ${result.message}${frames.length ? `\n${frames.join('\n')}` : ''}`
  return result
}
