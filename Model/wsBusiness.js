import { randomBytes } from 'node:crypto'
import { businessDefaults, isBusinessEvent, matchBusinessGroups } from './wsBusinessConfig.js'

const member = frame => String(frame?.d?.author?.member_openid || frame?.d?.author?.user_openid || frame?.d?.author?.id || '')
const prefix = nonce => `[QQBOT-CHECK] ${nonce}`
const aborted = () => new DOMException('业务检测已取消', 'AbortError')
const eventKey = frame => { const id = frame?.d?.id || frame?.id; return typeof id === 'string' && id.length <= 512 && id ? `${frame.t}:${id}` : '' }

// One local coordinator. Live binding/proof tokens stay in memory; settings
// are YAML-backed, budgets and bounded diagnostic history are Level-backed.
export function createWsBusiness ({ store, getRuntime, getGroup, getGroups, send, createCandidate, promote,
  getRecentGroups = async () => [], peekGroup = () => ({}), listUsableBots = () => [],
  queryQuota, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  random = () => randomBytes(16).toString('hex') }) {
  const states = new Map(), bindings = new Map(), locators = new Map(), refreshOwners = new Map(), tokens = new Map(), knownTokens = new Map(), jobs = new Map(), apps = new Set(), sendWindows = new Map()
  const settings = id => ({ ...businessDefaults(), ...store.settings(id).businessDetection })
  const state = id => {
    id = String(id)
    if (!states.has(id)) states.set(id, { startedAt: now(), lastBusinessAt: 0, drops: [], identifies: [], probeIdentifies: [], previous: null, timer: null, recent: new Map(), receivedGroups: new Map(), registered: false })
    return states.get(id)
  }
  const appKey = runtime => `${runtime.appid}:${runtime.sandbox ? 'sandbox' : 'production'}`
  const runtime = id => {
    const value = getRuntime(String(id))
    if (!value || value.disabled) throw new Error(`[${id}] 本地QQBot未运行或已停用`)
    return value
  }
  const alive = (id, identity) => {
    const current = getRuntime(String(id))
    return current && !current.disabled && current.identity === identity
  }
  function requireUsablePair (id, senderQQ) {
    const usable = new Set(listUsableBots().map(String))
    if (usable.size < 2) throw new Error(`拒绝绑定：当前本地只有${usable.size}个可用机器人凭证，至少需要2个。硬性要求：接收者和发送者不能是同一个机器人，QQ和AppID都必须不同。QQ官方屏蔽机器人自身消息，单个机器人收不到自己发送的消息，不能自发自收完成校验。请先配置并成功连接另一台本地机器人；数据库历史记录、已回收/注销、停用或凭证错误的账号不计入可用数量。`)
    if (!usable.has(String(id))) throw new Error(`[${id}] 接收者未运行或当前不可用，请使用当前凭证已鉴权连接的本地机器人绑定`)
    if (!usable.has(String(senderQQ))) throw new Error(`[${senderQQ}] 发送者未运行或当前不可用，请选择当前凭证已鉴权连接的本地机器人，不能使用数据库中的历史账号`)
  }
  // Bound dependencies even when they ignore AbortSignal. Late completions are
  // observed, but cannot keep a cancelled job/AppID lock or resume its work.
  function waitFor (work, signal, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let settled = false, timer
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimer(timer)
        signal?.removeEventListener('abort', cancel)
        callback(value)
      }
      const cancel = () => finish(reject, aborted())
      if (signal?.aborted) { cancel(); return }
      signal?.addEventListener('abort', cancel, { once: true })
      timer = setTimer(() => finish(reject, new Error('业务检测依赖操作超时')), timeoutMs)
      Promise.resolve().then(() => {
        signal?.throwIfAborted()
        if (settled) throw aborted()
        return work()
      }).then(value => finish(resolve, value), error => finish(reject, error))
    })
  }
  function delay (ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(aborted()); return }
      const cancel = () => { clearTimer(timer); reject(aborted()) }
      const timer = setTimer(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }
  async function result (id, status, detail, extra = {}) {
    const value = { at: now(), status, detail, ...structuredClone(extra) }
    const s = state(id)
    const checkAt = s.lastCheckAt ?? store.accounts.get(id)?.business?.lastCheckAt ?? 0
    s.lastResult = value
    log(status === '接管成功' ? 'warn' : 'info', id, `${status}：${detail}`)
    try {
      await waitFor(() => store.update(id, record => {
        record.business ||= {}
        if (s.lastAutomaticCheckAt !== undefined) {
          record.business.lastAutomaticCheckAt = Math.max(record.business.lastAutomaticCheckAt ?? record.business.lastCheckAt ?? 0, s.lastAutomaticCheckAt)
        }
        record.business.lastCheckAt = Math.max(record.business.lastCheckAt || 0, checkAt)
        if (!record.business.lastResult || record.business.lastResult.at <= value.at) record.business.lastResult = value
        record.business.history = [...(record.business.history || []), value].slice(-30)
      }))
    } catch { log('error', id, '业务检测记录写入失败；不会回滚现有连接') }
    return value
  }
  function closeBinding (id) {
    const task = bindings.get(String(id))
    if (!task) return
    task.abort.abort()
    clearTimer(task.timer)
    tokens.delete(task.nonce)
    locators.delete(task.nonce)
    bindings.delete(String(id))
  }
  function watchBinding (task) {
    clearTimer(task.timer)
    task.timer = setTimer(() => {
      if (bindings.get(task.id) !== task) return
      closeBinding(task.id)
      void result(task.id, '绑定超时', `未在有效期内完成${task.phase}；未写入绑定，不会自动向其他群试发`, { probes: task.sent && task.diagnostic ? [task.diagnostic] : [] })
    }, Math.max(0, task.expires - now()))
    task.timer.unref?.()
  }
  function requireContext (context, task) {
    if (!context.group || !context.isYou || !context.human || !context.actor) throw new Error('请在QQ群中由真人明确@接收者发送命令（依据is_you校验）')
    if (task && (task.group !== context.group || task.actor !== context.actor)) throw new Error('请由发起人在原群@接收者确认')
  }
  function rememberToken (task) {
    tokens.set(task.nonce, task)
    if (knownTokens.size >= 512) knownTokens.delete(knownTokens.keys().next().value)
    knownTokens.set(task.nonce, now() + 300000)
  }
  function extendBinding (task, ms = 600000) {
    task.expires = now() + ms
    watchBinding(task)
  }
  function bindingTask (id, context) {
    const task = bindings.get(String(id))
    requireContext(context, task)
    if (!task || task.abort.signal.aborted || now() >= task.expires) throw new Error('没有有效的待绑定任务，请先@接收者发送 #qqbot检测绑定 发送者QQ')
    if (!alive(task.id, task.receiverIdentity) || !alive(task.senderQQ, task.senderIdentity)) throw new Error('机器人运行态已改变，请重新绑定')
    requireUsablePair(task.id, task.senderQQ)
    return task
  }
  function groupDetails (task, qq, openid, fallback = {}) {
    if (!openid) return null
    const cached = task?.groupCache?.get(`${qq}:${openid}`) || peekGroup(qq, openid) || {}
    const info = { ...fallback, ...cached.info, group_name: cached.info?.group_name || fallback.group_name || fallback.name || '',
      group_member_num: cached.info?.group_member_num || fallback.group_member_num || 0 }
    return { qq, openid, info, state: cached.state || null, stateError: cached.stateError,
      receivedAt: states.get(qq)?.receivedGroups.get(openid) || fallback.receivedAt || 0 }
  }
  function bindingView (id, context) {
    id = String(id)
    const task = bindings.get(id), saved = settings(id).binding
    const senderQQ = task?.senderQQ || saved?.senderQQ
    const canConfirm = task?.phase === '确认' && task.sent && task.received && now() < task.expires &&
      alive(id, task.receiverIdentity) && alive(task.senderQQ, task.senderIdentity) &&
      context?.human && context.isYou && context.group === task.group && context.actor === task.actor
    return { phase: task?.phase || '', senderQQ, expires: task?.expires || 0, keyword: task?.keyword || '', lastError: task?.lastError || '',
      selectionCode: task?.selectionCode || '', confirmationCode: canConfirm ? task.code : '',
      probe: task?.sent && task.diagnostic ? structuredClone(task.diagnostic) : null,
      receiver: groupDetails(task, id, task?.group || saved?.receiverGroup),
      sender: senderQQ ? groupDetails(task, senderQQ, task?.senderGroup || saved?.senderGroup, task?.candidates.find(group => group.openid === task.senderGroup) || {}) : null,
      candidates: (task?.candidates || []).map((group, index) => ({ index: index + 1, ...groupDetails(task, senderQQ, group.openid, group) })),
      progress: task?.refreshProgress ? structuredClone(task.refreshProgress) : null,
      locator: task?.phase === '定位' ? `#qqbot检测定位 ${task.nonce}` : '' }
  }
  async function knownSenderGroups (task) {
    const known = await waitFor(() => getGroups(task.senderQQ), task.abort.signal)
    const groups = new Map(known.map(group => [group.openid, group]))
    const prefix = `${task.senderQQ}:`
    const recent = new Set(states.get(task.senderQQ)?.receivedGroups.keys() || [])
    for (const key of task.groupCache.keys()) if (key.startsWith(prefix)) recent.add(key.slice(prefix.length))
    // A recent group may lie beyond the legacy 5,000-entry contact listing.
    // Freshly discovered metadata must still be searchable in this workspace.
    for (const openid of recent) {
      const previous = groups.get(openid) || {}
      const info = groupDetails(task, task.senderQQ, openid)?.info || {}
      groups.set(openid, { ...previous, openid, group_name: info.group_name || previous.group_name || previous.name || '',
        group_member_num: info.group_member_num || previous.group_member_num || 0 })
    }
    return [...groups.values()]
  }
  async function searchGroups (id, keyword, context) {
    const task = bindingTask(id, context)
    if (task.phase !== '选群') throw new Error('请等待当前校验/确认完成，或重新发起绑定后再搜索')
    const groups = await knownSenderGroups(task)
    if (bindingTask(id, context) !== task || task.phase !== '选群') throw new Error('绑定阶段已改变，请重新查看候选')
    const text = String(keyword || '').normalize('NFKC').toLowerCase().trim()
    if (text.length > 100) throw new Error('搜索关键词不能超过100字')
    task.keyword = text
    task.candidates = text
      ? groups.filter(group => [group.group_name, group.name, group.remark_name, group.openid].some(value => String(value || '').normalize('NFKC').toLowerCase().includes(text))).slice(0, 200)
      : matchBusinessGroups(groupDetails(task, task.id, task.group)?.info, groups)
    task.selectionCode = random().slice(-8)
    task.lastError = ''
    extendBinding(task)
    return bindingView(task.id)
  }
  function refreshGroups (id, context) {
    const task = bindingTask(id, context)
    if (!['选群', '定位'].includes(task.phase)) throw new Error('正在校验或确认，请稍后刷新资料')
    if (task.refreshProgress?.running) return bindingView(task.id)
    for (const qq of [task.id, task.senderQQ]) if (refreshOwners.has(qq)) throw new Error(`机器人 ${qq} 已有群资料刷新任务，请等待完成`)
    for (const qq of [task.id, task.senderQQ]) refreshOwners.set(qq, task)
    extendBinding(task)
    const progress = task.refreshProgress = { running: true, startedAt: now(), sides: [task.id, task.senderQQ].map(qq => ({ qq, total: 0, done: 0, failed: 0, error: '' })) }
    const work = async side => {
      const signal = task.abort.signal, identity = runtime(side.qq).identity
      const check = () => {
        signal.throwIfAborted()
        if (bindings.get(task.id) !== task || !alive(side.qq, identity)) throw aborted()
      }
      try {
        const stored = await waitFor(() => getRecentGroups(side.qq, { signal }), signal)
        check()
        const recent = new Map((stored || []).map(group => [group.openid, group.receivedAt || 0]))
        for (const [group, at] of state(side.qq).receivedGroups) recent.set(group, Math.max(recent.get(group) || 0, at))
        const ordered = [...recent].sort((a, b) => b[1] - a[1]).map(([openid]) => openid)
        const priority = side.qq === task.id ? task.group : task.senderGroup
        const groups = [...new Set([priority, ...ordered].filter(Boolean))].slice(0, 50)
        side.total = groups.length
        if (!groups.length) side.error = '没有入站群记录，请在原群真人@此机器人发送一条消息后重试'
        for (const openid of groups) {
          check()
          try {
            const value = await waitFor(() => getGroup(side.qq, openid, { info: true, force: true, signal }), signal)
            check()
            task.groupCache.set(`${side.qq}:${openid}`, value)
            if (!value.info?.group_name || value.info.error || !value.state) side.failed++
          } catch (error) {
            check()
            side.failed++
            side.error = String(error.message || '资料刷新失败').slice(0, 200)
          }
          side.done++
        }
      } catch (error) { side.error = signal.aborted ? '已取消' : String(error.message || '刷新失败').slice(0, 200) }
      finally { if (refreshOwners.get(side.qq) === task) refreshOwners.delete(side.qq) }
    }
    // Each bot has a single worker; the shared group-info queues retain their
    // normal REST pacing. No gateway socket or group message is created here.
    void Promise.all(progress.sides.map(work)).finally(() => { progress.running = false; progress.completedAt = now() }).catch(() => {})
    return bindingView(task.id)
  }
  async function activeSend (senderQQ, group, text, signal, beforeSend = () => {}) {
    signal?.throwIfAborted()
    const identity = runtime(senderQQ).identity
    const fresh = await waitFor(() => getGroup(senderQQ, group, { signal }), signal)
    signal?.throwIfAborted()
    if (!alive(senderQQ, identity)) throw aborted()
    if (fresh.state?.allow_proactive_msg !== true) throw new Error('发送者在此群没有确认可用的主动消息权限')
    const key = `${senderQQ}:${group}`
    const senderKey = `sender:${runtime(senderQQ).appid}`
    for (;;) {
      const last = sendWindows.get(key)
      const senderAt = sendWindows.get(senderKey)
      const wait = Math.max(0, last === undefined ? 0 : last + 3000 - now(), senderAt === undefined ? 0 : senderAt + 2100 - now())
      if (!wait) break
      await delay(wait, signal)
    }
    signal?.throwIfAborted()
    if (!alive(senderQQ, identity)) throw aborted()
    if (sendWindows.size >= 512) sendWindows.delete(sendWindows.keys().next().value)
    sendWindows.set(key, now())
    sendWindows.set(senderKey, now())
    beforeSend()
    const receipt = await waitFor(() => send(senderQQ, group, text, signal), signal)
    signal?.throwIfAborted()
    return receipt
  }
  function diagnostic (nonce, id, senderQQ, receiverGroup, senderGroup, content, kind) {
    return { nonce, receiverQQ: id, senderQQ, receiverGroup, senderGroup, content, kind,
      sentAt: now(), messageId: '', mainReceivedAt: 0, candidateReceivedAt: 0 }
  }
  // Read-only historical lookup. A displayed nonce is never registered again as
  // a live proof token, and old records without diagnostics are not fabricated.
  function probeDetail (id, nonce) {
    id = String(id)
    const task = bindings.get(id)
    const values = [task?.sent && task.diagnostic,
      ...(states.get(id)?.lastResult?.probes || []),
      ...(store.accounts.get(id)?.business?.history || []).flatMap(item => item.probes || [])]
    const value = values.find(item => item && item.nonce === nonce)
    return value ? structuredClone(value) : null
  }
  async function promptBinding (task) {
    if (!task.sent || !task.received || task.prompting || task.abort.signal.aborted) return
    task.prompting = true
    task.phase = '确认'
    extendBinding(task, 180000)
    try {
      requireUsablePair(task.id, task.senderQQ)
      await activeSend(task.senderQQ, task.senderGroup, `${prefix(task.nonce)} INFO\n请真人@接收者 ${task.id} 发送：\n#qqbot检测绑定确认 ${task.code}\n必须真正@接收者，由原发起人在原群发送，三分钟内有效。`, task.abort.signal, () => requireUsablePair(task.id, task.senderQQ))
    } catch {
      if (bindings.get(task.id) === task && task.phase === '确认') {
        closeBinding(task.id)
        await result(task.id, '绑定失败', '发送者无法主动发送真人确认提示', { probes: task.diagnostic ? [task.diagnostic] : [] })
      }
    }
  }
  async function testBinding (task, index) {
    if (task.phase !== '选群') throw new Error('当前绑定任务不在选群阶段')
    requireUsablePair(task.id, task.senderQQ)
    const group = task.candidates[index - 1]
    if (!group) throw new Error('候选群序号无效')
    if (group.openid === task.group) throw new Error('候选误用了接收者的群OpenID；不同AppID不能共用群OpenID')
    task.senderGroup = group.openid
    task.phase = '校验'
    extendBinding(task, 180000)
    rememberToken(task)
    try {
      const content = `${prefix(task.nonce)} CHECK\n业务检测群映射校验，目标接收者 ${task.id}；无需回复此条。`
      const receipt = await activeSend(task.senderQQ, task.senderGroup, content, task.abort.signal, () => {
        requireUsablePair(task.id, task.senderQQ)
        task.diagnostic = diagnostic(task.nonce, task.id, task.senderQQ, task.group, task.senderGroup, content, '绑定校验探针')
      })
      task.diagnostic.messageId = receipt?.id || ''
      task.sent = true
      void promptBinding(task)
    } catch (error) {
      if (bindings.get(task.id) === task) {
        if (!task.abort.signal.aborted && alive(task.id, task.receiverIdentity) && alive(task.senderQQ, task.senderIdentity)) {
          // Keep discovery/diagnostics usable after a single permission or send
          // failure, but retire its proof code before another explicit choice.
          tokens.delete(task.nonce)
          locators.delete(task.nonce)
          task.nonce = random(); task.code = random().slice(0, 8).toUpperCase()
          task.received = task.senderMemberOpenid = undefined
          task.sent = task.prompting = false
          task.diagnostic = null
          task.phase = '选群'
          task.lastError = String(error.message || '主动校验失败').slice(0, 200)
          extendBinding(task)
        } else closeBinding(task.id)
      }
      throw error
    }
    return '已向唯一选定的发送者群主动发送校验消息；接收者收到后，发送者会主动发送真人确认提示。'
  }
  async function bind (id, senderQQ, context, { force = false } = {}) {
    id = String(id); senderQQ = String(senderQQ)
    requireContext(context)
    requireUsablePair(id, senderQQ)
    if (id === senderQQ) throw new Error('不能绑定自己：QQ官方屏蔽机器人自身消息，收不到自己发送的消息，请选择另一台本地可用机器人')
    const receiver = runtime(id), sender = runtime(senderQQ)
    if (bindings.get(id)?.phase === '保存') throw new Error('绑定配置正在保存，请稍后再重新绑定')
    if (receiver.appid === sender.appid) throw new Error('发送者与接收者必须是不同AppID的机器人')
    if (receiver.sandbox !== sender.sandbox) throw new Error('不能跨正式/沙箱环境绑定')
    if (!receiver.ready || !sender.ready) throw new Error('请先确保两个机器人均已连接')
    if (bindings.size >= 100 && !bindings.has(id)) throw new Error('待绑定任务过多，请稍后重试')
    closeBinding(id)
    const abort = new AbortController()
    const task = { id, senderQQ, group: context.group, actor: context.actor, receiverIdentity: receiver.identity,
      senderIdentity: sender.identity, senderAppid: sender.appid, receiverAppid: receiver.appid, sandbox: receiver.sandbox,
      nonce: random(), code: random().slice(0, 8).toUpperCase(), selectionCode: random().slice(-8), abort, phase: '准备', expires: now() + 600000, groupCache: new Map(), candidates: [] }
    bindings.set(id, task)
    watchBinding(task)
    try {
      const receiverGroup = await waitFor(() => getGroup(id, context.group, { info: true, signal: abort.signal }), abort.signal)
      requireUsablePair(id, senderQQ)
      task.groupCache.set(`${id}:${context.group}`, receiverGroup)
      if (receiverGroup.state?.recv_msg_setting !== 'all') throw new Error('接收者在当前群必须开启接收全量消息')
      if (force) {
        abort.signal.throwIfAborted()
        if (!alive(id, receiver.identity) || !alive(senderQQ, sender.identity)) throw aborted()
        task.phase = '定位'
        locators.set(task.nonce, task)
        return `已生成强制绑定定位文本（仅跳过群名筛选，不跳过主动校验和真人确认）。\n请真人在同一个群实际@发送者 ${senderQQ} 发送：\n#qqbot检测定位 ${task.nonce}\n发送者将取得它自己的群OpenID并主动发校验，随后由原发起人在原群@接收者确认。十分钟内有效。`
      }
      const groups = await knownSenderGroups(task)
      abort.signal.throwIfAborted()
      if (!alive(id, receiver.identity) || !alive(senderQQ, sender.identity)) throw aborted()
      requireUsablePair(id, senderQQ)
      task.candidates = matchBusinessGroups(receiverGroup.info, groups)
      task.phase = '选群'
      if (!task.candidates.length) return '未找到同名候选群。已保留本次绑定，可刷新双方最近50个入站群、搜索后选群，或使用特定文本强制定位；不会猜测或向全部群试发。'
      if (task.candidates.length === 1) return await testBinding(task, 1)
      return '发现多个候选，不会批量试发。请查看候选群资料，在原群@接收者发送 #qqbot检测选群 序号。'
    } catch (error) { if (bindings.get(id) === task && task.phase !== '选群') closeBinding(id); throw error }
  }
  async function choose (id, index, context, selectionCode) {
    const task = bindingTask(id, context)
    if (selectionCode && selectionCode.toLowerCase() !== task.selectionCode) return '此选群入口已过期；请按当前绑定阶段继续，未重新发送校验。'
    if (task.phase !== '选群') return `当前处于${task.phase}阶段，选群已完成或暂不可选；请查看下方当前操作，未重复发送校验。`
    return testBinding(task, index)
  }
  async function forceBinding (id, context, senderQQ) {
    const task = bindings.get(String(id))
    if (task) requireContext(context, task)
    const sender = senderQQ || task?.senderQQ || settings(String(id)).binding?.senderQQ
    if (!sender) throw new Error('请先@接收者发送 #qqbot检测强制绑定 发送者QQ')
    return bind(id, sender, context, { force: true })
  }
  async function locate (senderQQ, code, context) {
    requireContext(context)
    const task = locators.get(String(code).toLowerCase())
    if (!task || task.phase !== '定位' || now() >= task.expires || task.senderQQ !== String(senderQQ)) throw new Error('没有属于当前发送者的有效定位文本')
    if (!alive(task.id, task.receiverIdentity) || !alive(task.senderQQ, task.senderIdentity)) throw new Error('机器人运行态已改变，请重新绑定')
    requireUsablePair(task.id, task.senderQQ)
    locators.delete(task.nonce)
    task.candidates = [{ openid: context.group, source: '真人特定文本定位' }]
    task.phase = '选群'
    return testBinding(task, 1)
  }
  async function confirm (id, code, context) {
    id = String(id)
    const task = bindings.get(id)
    requireContext(context, task)
    if (!task || task.phase !== '确认' || now() >= task.expires || task.code !== String(code).toUpperCase() || !task.received || !task.sent) throw new Error('确认码无效、已过期或群映射尚未通过主动校验')
    if (!alive(id, task.receiverIdentity) || !alive(task.senderQQ, task.senderIdentity)) throw new Error('机器人运行态已改变，请重新绑定')
    requireUsablePair(id, task.senderQQ)
    task.phase = '保存'
    clearTimer(task.timer)
    try {
      const group = await waitFor(() => getGroup(id, task.group, { signal: task.abort.signal }), task.abort.signal)
      if (group.state?.recv_msg_setting !== 'all') throw new Error('接收者已不是全量接收状态')
      task.abort.signal.throwIfAborted()
      await store.update(id, record => {
        task.abort.signal.throwIfAborted()
        if (bindings.get(id) !== task || !alive(id, task.receiverIdentity) || !alive(task.senderQQ, task.senderIdentity)) throw aborted()
        requireUsablePair(id, task.senderQQ)
        record.settings.businessDetection.binding = { senderQQ: task.senderQQ, senderAppid: task.senderAppid, receiverAppid: task.receiverAppid,
          sandbox: task.sandbox, senderGroup: task.senderGroup, receiverGroup: task.group, senderMemberOpenid: task.received,
          confirmedAt: now() }
      })
      task.abort.signal.throwIfAborted()
      if (bindings.get(id) !== task) throw aborted()
      task.phase = '完成'; closeBinding(id)
      await result(id, '绑定成功', `${task.senderQQ} → ${id}；分别保存双方群OpenID，未自动开启任何开关`, { probes: task.diagnostic ? [task.diagnostic] : [] })
      return '绑定成功，辅助探测、临时Identify及其他开关保持原样。'
    } catch (error) {
      if (bindings.get(id) === task) { task.phase = '确认'; watchBinding(task) }
      throw error
    }
  }
  async function unbind (id) {
    closeBinding(id); stop(id)
    await store.update(id, record => { record.settings.businessDetection.binding = null })
    return '已解除绑定并取消本账号正在执行的检测；配置开关保持不变。'
  }

  function observe (id, frame, { live = true, candidate = false, newSeq = true } = {}) {
    id = String(id)
    const match = (frame?.t === 'GROUP_MESSAGE_CREATE' || frame?.t === 'GROUP_AT_MESSAGE_CREATE') &&
      /^\[QQBOT-CHECK\] ([a-f0-9]{32}) (CHECK|INFO)\b/.exec(String(frame.d?.content || ''))
    if (match && frame.d?.author?.bot === true) {
      const task = tokens.get(match[1])
      if (task && now() < task.expires) {
        if (id === task.id && frame.t === 'GROUP_MESSAGE_CREATE' && frame.d.group_openid === task.group && member(frame) &&
            (!task.senderMemberOpenid || member(frame) === task.senderMemberOpenid)) {
          if (match[2] === 'CHECK') {
            if (task.diagnostic) task.diagnostic[candidate ? 'candidateReceivedAt' : 'mainReceivedAt'] ||= now()
            if (task.type === 'probe') {
              if (candidate) task.candidate = true
              else { task.main = true; task.resolve?.(true) }
            } else if (!candidate && task.phase === '校验' && !task.received) {
              // The first calibrated identity is immutable through confirmation
              // and saving; later observations must match it, never replace it.
              task.senderMemberOpenid = task.received = member(frame)
              void promptBinding(task)
            }
          }
          return candidate ? match[2] === 'CHECK' && task.type === 'probe' ? true : null : true
        }
        // Other full-message robots consume this locally known internal packet,
        // but never enter binding/confirmation state merely because they saw it.
        return candidate ? null : true
      }
    }
    if (match && frame.d?.author?.bot === true && (knownTokens.get(match[1]) || 0) > now()) return candidate ? null : true
    if (!candidate && live && newSeq && ['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(frame?.t) && frame.d?.group_openid && states.has(id)) {
      const groups = state(id).receivedGroups
      groups.delete(frame.d.group_openid)
      groups.set(frame.d.group_openid, now())
      if (groups.size > 50) groups.delete(groups.keys().next().value)
    }
    if (isBusinessEvent(frame) && (candidate || states.has(id))) {
      const s = state(id), key = eventKey(frame)
      if (candidate && key && s.recent.has(key)) return null
      const seen = key && s.recent.has(key)
      if (!candidate && key) {
        if (s.recent.size >= 256) s.recent.delete(s.recent.keys().next().value)
        s.recent.set(key, now())
      }
      if (!candidate && live && newSeq && !seen) s.lastBusinessAt = now()
    }
    return false
  }
  function validateBinding (id) {
    const binding = settings(id).binding
    if (!binding) throw new Error('尚未完成辅助机器人绑定')
    const receiver = runtime(id), sender = runtime(binding.senderQQ)
    if (receiver.appid !== binding.receiverAppid || sender.appid !== binding.senderAppid ||
        receiver.sandbox !== binding.sandbox || sender.sandbox !== binding.sandbox) throw new Error('AppID或环境已改变，请重新绑定')
    if (!settings(binding.senderQQ).allowSender) throw new Error('发送者未开启允许辅助发送')
    if (!sender.ready) throw new Error('辅助发送者未连接')
    return binding
  }
  async function probe (id, job, { linger = false } = {}) {
    const binding = validateBinding(id)
    const receiverGroup = await waitFor(() => getGroup(id, binding.receiverGroup, { signal: job.abort.signal }), job.abort.signal)
    if (receiverGroup.state?.recv_msg_setting !== 'all') throw new Error('接收者不再是全量接收状态，不能用探针判定故障')
    job.abort.signal.throwIfAborted()
    const task = { type: 'probe', id, group: binding.receiverGroup, senderMemberOpenid: binding.senderMemberOpenid,
      nonce: random(), expires: 0, main: false, candidate: false }
    const duration = settings(id).probeSeconds * 1000
    let timer
    const received = new Promise(resolve => { task.resolve = resolve })
    const cancel = () => task.resolve(false)
    job.abort.signal.addEventListener('abort', cancel, { once: true })
    try {
      const content = `${prefix(task.nonce)} CHECK\n业务检测探针，目标 ${id}；无需回复。`
      const receipt = await activeSend(binding.senderQQ, binding.senderGroup, content, job.abort.signal, () => {
        task.diagnostic = diagnostic(task.nonce, id, binding.senderQQ, binding.receiverGroup, binding.senderGroup, content, linger ? '对比探针' : '辅助探针')
        task.expires = now() + duration + (linger ? 6000 : 1000)
        rememberToken(task)
        if (linger) job.probeTokens.add(task.nonce)
        timer = setTimer(() => task.resolve(false), duration)
      })
      task.diagnostic.messageId = receipt?.id || ''
      job.probes.push(task.diagnostic)
      await received
      job.abort.signal.throwIfAborted()
      return task
    } finally {
      clearTimer(timer)
      if (!linger) tokens.delete(task.nonce)
      job.abort.signal.removeEventListener('abort', cancel)
    }
  }

  function quota (id, value) {
    if (!settings(id).enabled || !settings(id).consumption) return
    const s = state(id), at = now()
    if (!value || value.cached || value.known === false || !Number.isSafeInteger(value.remaining)) return
    value = { ...value, resetAt: value.resetAt ?? at + value.reset_after }
    const previous = s.previous
    const reset = previous && (value.remaining > previous.remaining || value.total !== previous.total || Math.abs((value.resetAt || 0) - (previous.resetAt || 0)) > 5000)
    if (reset) { s.drops = []; s.identifies = []; s.probeIdentifies = [] }
    if (previous && !reset && at - previous.at < 300000 && value.remaining < previous.remaining) s.drops.push({ at: previous.at, count: previous.remaining - value.remaining })
    s.previous = { ...value, at }
    consumption(id)
  }
  function identify (id, { probe = false } = {}) {
    if (!settings(id).enabled || !settings(id).consumption) return
    state(id).identifies.push(now())
    if (probe) state(id).probeIdentifies.push(now())
    consumption(id)
  }
  function consumption (id) {
    const s = state(id), at = now()
    s.drops = s.drops.filter(item => at - item.at < 300000)
    s.identifies = s.identifies.filter(time => at - time < 300000)
    s.probeIdentifies = s.probeIdentifies.filter(time => at - time < 300000)
    return Math.max(s.drops.reduce((sum, item) => sum + item.count, 0), s.identifies.length)
  }
  async function reserve (id, original, config, signal) {
    if (!config.dailyLimit) throw new Error('每日临时连接预算为0，不建立临时连接')
    const value = await waitFor(() => queryQuota(id, true), signal)
    signal.throwIfAborted()
    if (!value || value.cached || value.known === false || !Number.isSafeInteger(value.remaining) || value.remaining <= config.reserve) throw new Error('配额未知、不新鲜或不足预留次数，未建立临时连接')
    const key = appKey(original)
    const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10)
    await waitFor(() => store.updateBusinessState(key, budget => {
      signal.throwIfAborted()
      if (budget.used !== undefined && (!Number.isSafeInteger(budget.used) || budget.used < 0) ||
          budget.lastAttemptAt !== undefined && (!Number.isFinite(budget.lastAttemptAt) || budget.lastAttemptAt < 0)) throw new Error('临时连接预算损坏，拒绝继续消耗次数')
      if (budget.day !== day) { budget.day = day; budget.used = 0 }
      if ((budget.used || 0) >= config.dailyLimit) throw new Error('本AppID今日临时连接尝试预算已用尽')
      if (budget.lastAttemptAt != null && now() - budget.lastAttemptAt < config.cooldownMinutes * 60000) throw new Error('临时连接仍在冷却，未消耗新次数')
      budget.used = (budget.used || 0) + 1
      budget.lastAttemptAt = now()
    }), signal)
    return value
  }
  // Older records used lastCheckAt for every incident. Preserve that historical
  // cooldown once; new manual checks only update the display/history timestamp.
  const automaticCheckAt = id => states.get(id)?.lastAutomaticCheckAt ??
    store.accounts.get(id)?.business?.lastAutomaticCheckAt ?? store.accounts.get(id)?.business?.lastCheckAt ?? 0
  async function check (id, method = 'auto', { manual = false } = {}) {
    id = String(id)
    const config = settings(id)
    if (!config.enabled) throw new Error('业务检测总开关关闭')
    const useHelper = method !== 'temporary' && config.helper
    const useTemporary = method !== 'helper' && config.temporaryIdentify
    if (!useHelper && !useTemporary) throw new Error('对应检测方法尚未开启')
    if (jobs.has(id)) throw new Error('本机器人已有检测进行中')
    const original = runtime(id)
    if (!original.ready || original.busy || !original.socket) throw new Error('基础WS尚未就绪或正在恢复，不额外建立检测连接')
    const key = original.appid
    if (apps.has(key)) throw new Error('同AppID已有检测进行中')
    const s = state(id)
    const last = automaticCheckAt(id)
    if (!manual && last && now() - last < config.cooldownMinutes * 60000) throw new Error('业务检测仍在冷却')
    s.lastAutomaticCheckAt = manual ? last : now()
    s.lastCheckAt = now()
    const job = { abort: new AbortController(), original, method, started: now(), probeTokens: new Set(), probes: [] }
    jobs.set(id, job); apps.add(key)
    let candidate
    // Preparation includes the initial helper wait and bounded REST/storage
    // work. The candidate still gets its own full observation window below.
    let deadline = setTimer(() => job.abort.abort(), config.probeSeconds * 1000 + 60000)
    let released = false
    const release = () => {
      if (released) return
      released = true
      clearTimer(deadline)
      for (const nonce of job.probeTokens) tokens.delete(nonce)
      candidate?.stop()
      job.abort.abort()
      if (jobs.get(id) === job) jobs.delete(id)
      apps.delete(key)
    }
    const finish = (status, detail) => {
      // Diagnostic persistence must not keep transport resources or flight
      // locks alive, especially when storage itself caused the cancellation.
      release()
      return result(id, status, detail, { source: manual ? 'manual' : 'automatic', probes: job.probes })
    }
    const valid = () => {
      job.abort.signal.throwIfAborted()
      const current = runtime(id)
      const fresh = settings(id)
      if (current.identity !== original.identity || current.socket !== original.socket || !fresh.enabled ||
          useHelper && !fresh.helper || useTemporary && !fresh.temporaryIdentify) throw aborted()
    }
    try {
      // Manual helper tests never start/extend incident or paid cooldowns.
      // Paid attempts still reserve their durable AppID budget below.
      await waitFor(() => store.update(id, record => {
        job.abort.signal.throwIfAborted()
        record.business ||= {}
        record.business.lastAutomaticCheckAt = Math.max(record.business.lastAutomaticCheckAt ?? record.business.lastCheckAt ?? 0, s.lastAutomaticCheckAt)
        record.business.lastCheckAt = Math.max(record.business.lastCheckAt || 0, s.lastCheckAt)
      }), job.abort.signal)
      valid()
      if (useHelper) {
        const initial = await probe(id, job)
        valid()
        if (initial.main) return await finish('旧路径可用', '辅助探针已到达，不建立临时Identify')
        if (!useTemporary) return await finish('结果不确定', '主动发送成功但旧路径未收到探针；临时Identify关闭，保留原连接')
      }
      const quota = await reserve(id, original, config, job.abort.signal)
      valid()
      clearTimer(deadline)
      deadline = setTimer(() => job.abort.abort(new Error('临时连接观察时间已到')), config.observeSeconds * 1000)
      candidate = createCandidate(id, { signal: job.abort.signal, quota, reserve: config.reserve, validate: valid,
        onFrame: frame => observe(id, frame, { candidate: true }), timeoutMs: config.observeSeconds * 1000 })
      await waitFor(() => candidate.ready, job.abort.signal, config.observeSeconds * 1000)
      valid()
      let compared
      if (useHelper) {
        compared = await probe(id, job, { linger: true })
        valid()
        if (compared.main) return await finish('旧路径可用', '对比探针已到达旧连接，关闭候选')
        if (!compared.candidate) return await finish('结果不确定', '两条路径均未确认收到探针，保留原连接')
      }
      await waitFor(() => candidate.proof, job.abort.signal, config.observeSeconds * 1000)
      valid()
      await delay(5000, job.abort.signal)
      valid()
      if (compared?.main) return await finish('旧路径可用', '对比探针迟到但已到达旧连接，取消接管')
      if (s.lastBusinessAt >= job.started) return await finish('旧路径可用', '旧连接已收到新的业务事件，关闭候选')
      if (eventKey(candidate.evidence?.frame) && s.recent.has(eventKey(candidate.evidence.frame))) return await finish('旧路径可用', '旧连接也看到候选证明事件，取消接管')
      const silentSince = Math.max(s.lastBusinessAt || s.startedAt, original.readyAt || 0)
      if (!settings(id).autoTakeover) return await finish('候选可用', '自动接管关闭，候选仍不进入业务处理，随后关闭')
      if (now() - silentSince < settings(id).takeoverMinutes * 60000) return await finish('候选可用', '旧连接静默尚未达到接管门槛，保留原连接')
      if (!candidate.acknowledged || candidate.closed) throw new Error('候选连接已失效，不能接管')
      const adopted = promote(id, candidate, original)
      if (!adopted) throw new Error('运行态已改变，接管已取消')
      return await finish('接管成功', '旧路径不可靠，现有候选已转为主连接；未再次Identify，未清空其他账号Session')
    } catch (error) {
      const detail = job.abort.signal.aborted ? '检测已取消、运行态已变化或观察超时，未切换主连接' : String(error?.message || '检测失败').slice(0, 300)
      return await finish('检测未完成', detail)
    } finally { release() }
  }
  function stop (id) { jobs.get(String(id))?.abort.abort() }
  function refresh (id, { cancel = true } = {}) {
    id = String(id)
    if (cancel) stop(id)
    const s = state(id)
    clearTimer(s.timer); s.timer = null
    const config = settings(id)
    if (!config.allowSender) {
      for (const [receiver, job] of jobs) if (settings(receiver).binding?.senderQQ === id && job.method !== 'temporary') job.abort.abort()
    }
    const r = getRuntime(id)
    // A temporary read-only state pauses work, not the scheduler. Permanent
    // disable/logout unregisters the runtime and removes its timer separately.
    if (!s.registered || !config.enabled || (!config.helper && !config.temporaryIdentify) || (!config.silence && !config.consumption) || !r) return
    s.timer = setTimer(async () => {
      s.timer = null
      try {
        const current = settings(id), running = getRuntime(id)
        if (!current.enabled || !running || running.disabled) return
        if (current.consumption) {
          const value = await waitFor(() => queryQuota(id))
          if (states.get(id) !== s || getRuntime(id)?.identity !== running.identity) return
          quota(id, value)
        }
        const silentSince = Math.max(s.lastBusinessAt || s.startedAt, running.readyAt || 0)
        const high = current.consumption && consumption(id) - s.probeIdentifies.length >= 10
        const checkAt = automaticCheckAt(id)
        const cooled = !checkAt || now() - checkAt >= current.cooldownMinutes * 60000
        if (cooled && (current.silence && now() - silentSince >= current.silenceMinutes * 60000 || high)) {
          await check(id, 'auto')
        }
      } catch { /* stopped/busy runtimes are retried at the next enabled tick */ }
      finally { if (states.get(id) === s && s.registered) refreshWithoutCancel(id) }
    }, 60000)
    s.timer.unref?.()
  }
  function refreshWithoutCancel (id) {
    refresh(id, { cancel: false })
  }
  function unregister (id) {
    id = String(id)
    stop(id)
    const s = states.get(id)
    clearTimer(s?.timer)
    states.delete(id)
    for (const [receiver, task] of bindings) if (receiver === id || task.senderQQ === id) closeBinding(receiver)
    for (const [receiver, job] of jobs) if (settings(receiver).binding?.senderQQ === id) job.abort.abort()
  }
  async function status (id) {
    const r = getRuntime(String(id)), s = state(id)
    const stored = store.accounts.get(String(id))?.business || {}
    const budget = r ? await store.businessState(appKey(r)) : null
    const lastCheckAt = s.lastCheckAt ?? stored.lastCheckAt
    const automaticAt = automaticCheckAt(String(id)), temporaryAt = budget?.lastAttemptAt || 0
    const automaticNextAllowedAt = automaticAt ? automaticAt + settings(id).cooldownMinutes * 60000 : 0
    const temporaryNextAllowedAt = temporaryAt ? temporaryAt + settings(id).cooldownMinutes * 60000 : 0
    return { config: settings(id), pending: bindings.get(String(id))?.phase || '', busy: jobs.has(String(id)),
      lastBusinessAt: s.lastBusinessAt, lastResult: s.lastResult || stored.lastResult,
      history: stored.history || [], count: consumption(id), lastCheckAt,
      automaticNextAllowedAt, temporaryNextAllowedAt,
      nextAllowedAt: Math.max(automaticNextAllowedAt, temporaryNextAllowedAt), budget }
  }
  return { bind, choose, confirm, unbind, forceBinding, locate, bindingView, probeDetail, searchGroups, refreshGroups, observe, quota, identify, check, stop, refresh, unregister, status,
    shutdown () {
      for (const id of states.keys()) unregister(id)
      for (const id of bindings.keys()) closeBinding(id)
    },
    register (id) {
      id = String(id)
      const identity = getRuntime(id)?.identity
      if (states.get(id)?.runtimeIdentity && states.get(id).runtimeIdentity !== identity) unregister(id)
      const s = state(id)
      s.runtimeIdentity = identity
      s.registered = true
      refresh(id)
    } }
}
