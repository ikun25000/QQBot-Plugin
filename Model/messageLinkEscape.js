// Escape displayed URL scheme separators, not HTTP transport addresses or JSON
// syntax. The result is a runtime string with real backslashes (not a JSON trick).
const schemes = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*):(?:\\?\/){2}/g
const lineBreak = char => char === '\n' || char === '\r'
const runEnd = (text, start) => {
  let end = start + 1
  while (text[end] === text[start]) end++
  return end
}
const lineEnd = (text, start) => {
  let end = start
  while (end < text.length && !lineBreak(text[end])) end++
  return end
}
const nextLine = (text, end) => end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1)

function fenceEnd (text, start, marker, size) {
  let at = nextLine(text, lineEnd(text, start))
  while (at < text.length) {
    const end = lineEnd(text, at)
    let first = at
    while (first < at + 3 && text[first] === ' ') first++
    if (text[first] === marker) {
      const run = runEnd(text, first)
      if (run - first >= size && /^[ \t]*$/.test(text.slice(run, end))) return end
    }
    at = nextLine(text, end)
  }
  return text.length
}

function codeEnd (text, start, size) {
  let at = start + size
  while ((at = text.indexOf('`', at)) >= 0) {
    const end = runEnd(text, at)
    if (end - at === size) return end
    at = end
  }
  // Be conservative around incomplete code snippets; do not rewrite the tail.
  return text.length
}

function imageEnd (text, start) {
  let at = start + 2, brackets = 1
  for (; at < text.length && brackets; at++) {
    if (text[at] === '\\') at++
    else if (text[at] === '[') brackets++
    else if (text[at] === ']') brackets--
  }
  if (brackets || text[at] !== '(') return start
  let depth = 1, quote = ''
  for (at++; at < text.length; at++) {
    const char = text[at]
    if (char === '\\') { at++; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if ((char === '"' || char === "'") && /\s/.test(text[at - 1])) { quote = char; continue }
    if (char === '(') depth++
    if (char === ')' && --depth === 0) return at + 1
  }
  return start
}

function commandEnd (text, start) {
  let quote = ''
  for (let at = start + 1; at < text.length; at++) {
    const char = text[at]
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return at + 1
  }
  return text.length
}

export function escapeMessageLinks (text) {
  if (typeof text !== 'string' || (!text.includes(':/') && !text.includes(':\\/'))) return text
  const parts = []
  let plain = 0, at = 0
  const protect = end => {
    parts.push(text.slice(plain, at).replace(schemes, (_, scheme) => `${scheme}:\\/\\/`), text.slice(at, end))
    at = plain = end
  }
  while (at < text.length) {
    if (at === 0 || lineBreak(text[at - 1])) {
      let first = at
      while (first < at + 3 && text[first] === ' ') first++
      if (text[first] === '`' || text[first] === '~') {
        const end = runEnd(text, first)
        if (end - first >= 3) { protect(fenceEnd(text, end, text[first], end - first)); continue }
      }
      if (text[first] === '[') {
        const end = lineEnd(text, first)
        // Reference destinations can be used by images as well as hyperlinks.
        if (/^\[[^\]\r\n]+\]:[ \t]*\S/.test(text.slice(first, end))) { protect(end); continue }
      }
    }
    if (text[at] === '\\') { at += 2; continue }
    if (text[at] === '`') { protect(codeEnd(text, at, runEnd(text, at) - at)); continue }
    if (text.startsWith('![', at)) {
      const end = imageEnd(text, at)
      if (end > at) { protect(end); continue }
    }
    if (text[at] === '<' && /^<\/?qqbot-[a-z]/i.test(text.slice(at, at + 24))) { protect(commandEnd(text, at)); continue }
    at++
  }
  parts.push(text.slice(plain).replace(schemes, (_, scheme) => `${scheme}:\\/\\/`))
  return parts.join('')
}

// Lazy shallow copies keep caller-owned payloads reusable for retry. Only
// display-text fields are visited; identifiers, keyboards, media and URL fields
// must keep their protocol semantics and are intentionally not traversed.
function fields (value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  let result = value
  for (const name of names) {
    const next = escapeMessageLinks(value[name])
    if (next !== value[name]) {
      if (result === value) result = { ...value }
      result[name] = next
    }
  }
  return result
}

function mapChanged (values, transform) {
  if (!Array.isArray(values)) return values
  let changed = false
  const result = values.map(value => {
    const next = transform(value)
    if (next !== value) changed = true
    return next
  })
  return changed ? result : values
}

function markdownText (value) {
  let result = fields(value, ['content'])
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const params = mapChanged(result.params, param => {
    if (!param || typeof param !== 'object') return param
    const values = mapChanged(param.values, escapeMessageLinks)
    return values === param.values ? param : { ...param, values }
  })
  if (params !== result.params) result = { ...result, params }
  return result
}

function embedText (value) {
  let result = fields(value, ['title', 'description', 'prompt'])
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const items = mapChanged(result.fields, item => fields(item, ['name', 'value']))
  if (items !== result.fields) result = { ...result, fields: items }
  return result
}

function arkItems (items) {
  return mapChanged(items, item => {
    if (!item || typeof item !== 'object') return item
    // ARK uses key names to distinguish actionable destinations from text.
    if (/(?:url|link|image|icon|cover|thumb)/i.test(String(item.key || ''))) return item
    let result = fields(item, ['value'])
    const objects = mapChanged(result.obj, object => {
      if (!object || typeof object !== 'object') return object
      const kv = arkItems(object.obj_kv)
      return kv === object.obj_kv ? object : { ...object, obj_kv: kv }
    })
    if (objects !== result.obj) result = { ...result, obj: objects }
    return result
  })
}

export function escapeMessageLinkPayload (requestUrl, payload, enabled = false) {
  if (enabled !== true || !/\/messages$/.test(String(requestUrl).split(/[?#]/, 1)[0]) || !payload) return payload
  const binary = Buffer.isBuffer(payload)
  const serialized = typeof payload === 'string' || binary
  let data = payload
  if (serialized) {
    try { data = JSON.parse(binary ? payload.toString('utf8') : payload) } catch { return payload }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return payload
  let result = fields(data, ['content'])
  const markdown = markdownText(data.markdown), embed = embedText(data.embed)
  const kv = data.ark && arkItems(data.ark.kv)
  if (markdown !== data.markdown || embed !== data.embed || (data.ark && kv !== data.ark.kv)) {
    if (result === data) result = { ...data }
    if (markdown !== data.markdown) result.markdown = markdown
    if (embed !== data.embed) result.embed = embed
    if (data.ark && kv !== data.ark.kv) result.ark = { ...data.ark, kv }
  }
  if (result === data) return payload
  if (!serialized) return result
  const text = JSON.stringify(result)
  return binary ? Buffer.from(text) : text
}
