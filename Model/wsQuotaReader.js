// Read-only REST access for offline/configured accounts. This must never start
// an SDK or a WebSocket, and must not mutate lifecycle/reconnect state.
export function createWsQuotaReader ({ request, now = Date.now }) {
  const queries = new Map()
  const tokens = new Map()
  return async function read ({ id, appid, secret, endpoints, headers = {}, accessToken, tokenExpireTime, fresh = false }) {
    const previous = queries.get(id)
    const same = previous?.appid === appid && previous?.secret === secret && previous?.base === endpoints.apiBase
    if (same && previous.pending) return previous.pending
    if (!fresh && same && now() - previous.attemptAt < 15000) return previous.value ? { ...previous.value, cached: true, failed: previous.failed } : null
    const entry = { appid, secret, base: endpoints.apiBase, value: same ? previous.value : null, attemptAt: now() }
    queries.set(id, entry)
    entry.pending = Promise.resolve().then(async () => {
      let token = accessToken && tokenExpireTime > now() ? accessToken : null
      if (!token) {
        let saved = tokens.get(appid)
        if (saved?.secret !== secret || (!saved.pending && saved.until <= now())) {
          saved = { secret, until: 0 }
          tokens.set(appid, saved)
        }
        if (!saved.token && !saved.pending) {
          saved.pending = request.post(endpoints.tokenUrl, { appId: appid, clientSecret: secret }, { headers, timeout: 5000 }).then(response => {
            if (!response.data?.access_token) throw new Error('查询WS配额：获取访问凭证失败')
            saved.token = response.data.access_token
            saved.until = now() + Math.max(0, Number(response.data.expires_in || 0) - 60) * 1000
            return saved.token
          }).finally(() => { saved.pending = null })
        }
        token = saved.token || await saved.pending
      }
      const response = await request.get(`${endpoints.apiBase}/gateway/bot`, {
        timeout: 5000,
        headers: { ...headers, Authorization: `QQBot ${token}`, 'X-Union-Appid': appid }
      })
      const limit = response.data?.session_start_limit
      if (!limit || !Number.isSafeInteger(limit.remaining) || limit.remaining < 0 ||
          !Number.isSafeInteger(limit.total) || limit.total < limit.remaining ||
          !Number.isSafeInteger(limit.reset_after) || limit.reset_after < 0 ||
          !Number.isSafeInteger(limit.max_concurrency) || limit.max_concurrency < 1) throw new Error('查询WS配额：网关未返回有效Session配额')
      entry.value = { data: response.data, at: now(), cached: false }
      return entry.value
    }).catch(() => {
      entry.failed = true
      if (entry.value) return { ...entry.value, cached: true, failed: true }
      return null
    }).finally(() => { entry.pending = null })
    return entry.pending
  }
}
