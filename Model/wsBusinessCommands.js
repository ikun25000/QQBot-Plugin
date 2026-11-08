import { randomBytes } from 'node:crypto'
import { businessGroupContext, businessParameterLimits } from './wsBusinessConfig.js'

const switches = { 业务检测: 'enabled', 辅助探测: 'helper', 临时鉴权: 'temporaryIdentify', 自动接管: 'autoTakeover', 静默检测: 'silence', 消耗检测: 'consumption', 允许辅助发送: 'allowSender' }
const parameters = { 静默时间: ['silenceMinutes', '分钟'], 接管时间: ['takeoverMinutes', '分钟'], 冷却时间: ['cooldownMinutes', '分钟'],
  每日次数: ['dailyLimit', '次'], 保留次数: ['reserve', '次'], 探针超时: ['probeSeconds', '秒'], 观察时间: ['observeSeconds', '秒'] }
const state = value => value ? '开启' : '关闭'
const xml = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hint = (command, title) => `<qqbot-cmd-input text="${xml(command)}" show="${xml(title)}"/>`
// Pending edits are transient, per store/operator/conversation/target, not YAML.
const settingConfirmations = new WeakMap()
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '无'
const mode = value => ({ all: '全量接收', only_mention: '仅@', mention_and_context: '@及上下文' }[value] || value || '未获取')
const permission = value => typeof value === 'boolean' ? value ? '允许' : '不允许' : '未获取'

function groupText (title, group) {
  if (!group) return `${title}：尚未选定`
  const errors = [group.info?.error, group.stateError, group.state?.error].filter(error => error && error.message !== '不是管理员').map(error => error.message || String(error))
  return [`${title}（机器人 ${group.qq}）`, `群名：${group.info?.group_name || '未缓存'}`, `群OpenID：${group.openid}`,
    `人数：${group.info?.group_member_num || '未知'}`, `主动消息：${permission(group.state?.allow_proactive_msg)}`,
    `接收模式：${mode(group.state?.recv_msg_setting)}`, `群内身份：${group.state?.member_role || '未获取'}`, `资料刷新：${date(group.info?.fetched_at)}`, `权限刷新：${date(group.state?.fetched_at)}`,
    ...(errors.length ? [`资料提示：${[...new Set(errors)].join('；')}`] : [])].join('\n')
}

export async function handleBusinessCommand ({ event, store, manager, configured, listConfigured = () => [], isLocalEvent, reply, buttons, now = Date.now }) {
  const context = businessGroupContext(event)
  let msg = String(event.msg || '').trim()
  // Authorization uses the original real mention, never its display spelling.
  if (context.isYou) {
    const start = msg.search(/#q+bot/i)
    if (start >= 0) msg = msg.slice(start)
  }
  msg = msg.replace(/^(#q+bot)临时\s*identify(?=\s|开|关|$)/i, '$1临时鉴权')
  let match, id = '', bindingAction = false
  // Current-bot menus need no redundant QQ. Keep explicit routing only when
  // there is no QQBot event context, or an old command targets another bot.
  const commandFor = (text, target = id) => target && (!isLocalEvent || target !== String(event.self_id)) ? `${text} ${target}` : text
  const command = (text, title, target = id) => hint(commandFor(text, target), title)
  const resultText = value => {
    if (!value) return '暂无'
    const detail = String(value.detail || '').replace(/辅助探针|对比探针|探针/g, label => {
      const probe = value.probes?.find(item => item.kind === (label === '对比探针' ? '对比探针' : '辅助探针'))
      return probe ? command(`#qqbot检测探针详情 ${probe.nonce}`, label) : label
    })
    const extra = (value.probes || []).filter(probe => !detail.includes(`#qqbot检测探针详情 ${probe.nonce}`))
      .map(probe => command(`#qqbot检测探针详情 ${probe.nonce}`, probe.kind)).join('　')
    return `${value.status}：${detail}${extra ? `（${extra}）` : ''}`
  }
  const result = (text, target = id) => reply([text, buttons([{ text: '返回', callback: target ? commandFor('#qqbot检测菜单', target) : '#QQBot帮助' }])], true)
  const target = explicit => {
    if (!explicit && !isLocalEvent) throw new Error('其他适配器触发时必须指定接收者QQ，例如 #qqbot检测菜单 接收者QQ')
    const value = String(explicit || event.self_id || '')
    if (!configured(value)) throw new Error('请指定本地接收者QQ，例如 #qqbot检测菜单 接收者QQ')
    return value
  }
  // Guidance only: binding and all switches remain independent. In particular,
  // a missing binding must never undo a successfully saved helper switch.
  const helperActivationHints = () => {
    const config = store.settings(id).businessDetection, binding = config.binding
    const requirement = (qq, role, name, value) => `${role} ${qq} ${name}：${state(value)}${value ? '' : `　${command(`#qqbot${name} 开启`, '开启', qq)}`}`
    const lines = ['硬性要求：接收者和发送者不能是同一个机器人，QQ和AppID都必须不同。',
      '有效辅助检测需要：接收者开启总开关、辅助探测，并由绑定发送者开启允许辅助发送。',
      requirement(id, '接收者', '业务检测', config.enabled), requirement(id, '接收者', '辅助探测', config.helper)]
    let senderEnabled = false
    if (!binding) {
      lines.push('绑定状态无效：尚未完成辅助机器人绑定（待绑定不算已绑定）。开关已按命令保存，不受影响；完成绑定后才能有效辅助检测。',
        `请在接收者 ${id} 所在QQ群由真人真实@接收者发送 #qqbot检测绑定 发送者QQ。`)
      if (isLocalEvent && id === String(event.self_id)) lines.push(hint('#qqbot检测绑定 ', '填写发送者QQ开始绑定'))
      lines.push(command('#qqbot检测绑定状态', '查看绑定状态'), command('#qqbot检测辅助菜单', '查看绑定说明'))
    } else {
      try {
        senderEnabled = store.settings(binding.senderQQ).businessDetection.allowSender
        lines.push(requirement(binding.senderQQ, '发送者', '允许辅助发送', senderEnabled))
      } catch {
        // An unrelated bot's unreadable settings cannot turn this successful
        // binding/switch write into an apparent failure or a silent rollback.
        lines.push(`发送者 ${binding.senderQQ} 允许辅助发送：状态未获取，请到发送者核对。　${command('#qqbot检测辅助菜单', '查看发送者设置', binding.senderQQ)}`)
      }
      lines.push('绑定成功不代表检测开关已开启；上述必要开关都开启后才能执行辅助检测，实际检测仍需双方运行及群权限正常。')
      if (config.enabled && config.helper && senderEnabled) lines.push(command('#qqbot立即检测 辅助', '立即辅助检测'))
    }
    if (!config.silence && !config.consumption) {
      lines.push(`若需自动检测，还需开启静默检测或消耗检测（任选其一）；仅手动检测不需要这两个触发开关。\n${command('#qqbot静默检测 开启', '开启静默检测')}　${command('#qqbot消耗检测 开启', '开启消耗检测')}`)
    } else lines.push('自动触发条件已开启，满足相应条件时才会自动检测。')
    return lines.join('\n')
  }
  const bindingReply = (text, requested = 1, detail) => {
    const view = manager.bindingView(id, context)
    const editable = ['选群', '定位'].includes(view.phase)
    const selecting = view.phase === '选群'
    const pages = Math.max(1, Math.ceil(view.candidates.length / 5)), page = Math.max(1, Math.min(pages, requested))
    const candidates = view.candidates.slice((page - 1) * 5, page * 5)
    const progress = view.progress ? [view.progress.running ? '双方资料刷新中' : '双方资料刷新已结束',
      ...view.progress.sides.map(side => `机器人 ${side.qq}：${side.done}/${side.total}，失败${side.failed}${side.error ? `\n${side.error}` : ''}`),
      '刷新不会主动试发；完成后点“重新匹配”或搜索群。'].join('\n') : ''
    const body = [text, `接收者：${id}\n发送者：${view.senderQQ || '尚未指定'}\n待绑定：${view.phase || '无'}\n硬性要求：接收者和发送者不能是同一个机器人，QQ和AppID都必须不同。`,
      groupText(view.phase ? '接收者当前群' : '接收者绑定群', view.receiver), groupText('发送者已选群', detail || view.sender), progress,
      ...(view.lastError ? [`上次操作：${view.lastError}`] : []),
      `候选群 ${page}/${pages}（${view.candidates.length}个，最多保留200个；可用更精确关键词缩小范围）`,
      candidates.map(group => `${group.index}. ${group.info?.group_name || '未缓存群名'}，人数=${group.info?.group_member_num || '未知'}\n发送者 ${group.qq} 的群OpenID：${group.openid}\n${hint(`#qqbot检测群资料 ${group.index}`, '群资料')}${selecting ? `　${hint(`#qqbot检测选群 ${group.index} ${view.selectionCode}`, '选择此群')}` : group.openid === view.sender?.openid ? '　已选定（不再重复选群）' : ''}`).join('\n\n') || (view.phase ? '暂无候选；这不等于两台机器人不在同一个群。' : '无待选候选群。'),
      ...(view.probe ? [hint(`#qqbot检测探针详情 ${view.probe.nonce}`, '查看校验探针')] : []),
      ...(view.phase ? [`当前阶段：${view.phase}；有效至：${date(view.expires)}\n${hint('#qqbot检测绑定状态', '刷新绑定状态')}`] : []),
      ...(view.confirmationCode ? [`主动校验已通过。请原发起人在原群实际@接收者 ${id} 后发送：\n${hint(`#qqbot检测绑定确认 ${view.confirmationCode}`, '确认绑定')}\n点击仅填写命令，不能替代真人真实@。`] : view.phase === '确认' ? ['主动校验已通过，等待原发起人在原群真实@接收者查看确认入口。'] : []),
      ...(view.locator ? [`请真人在同群实际@发送者 ${view.senderQQ} 发送以下特定文本：\n${view.locator}\n定位后仍需主动校验到达原群及原发起人@接收者确认。`] : []),
      ...(editable ? [
        '绑定操作请在原群真人@接收者。快速刷新每台最多50个近期收到消息的不同群，当前群优先；刷新/搜索不消耗Identify、不广播消息。',
        hint('#qqbot检测刷新双方', '刷新双方最近群'),
        ...(selecting ? [hint('#qqbot检测搜群 ', '搜索发送者群名/备注/OpenID'), hint('#qqbot检测搜群', '刷新后重新匹配')] : []),
        hint('#qqbot检测强制绑定', '特定文本强制定位'), hint('#qqbot检测刷新进度', '查看刷新进度')
      ] : [view.phase === '校验' ? '已完成选群，正在等待接收者收到校验探针；无需再次选群。收到后进入真人确认，可点击“刷新绑定状态”。' : view.phase ? '请按当前阶段继续；如需重选，请重新发起绑定。' : '当前无待绑定任务（已完成或已过期）。重新发起绑定后可刷新双方及搜索候选；现有绑定在新确认成功前不变。',
        hint('#qqbot检测绑定 ', '填写发送者QQ重新绑定'), hint(`#qqbot检测强制绑定${view.senderQQ ? ` ${view.senderQQ}` : ' '}`, '特定文本强制定位')])].filter(Boolean).join('\n\n')
    const rows = selecting ? [
      [{ text: '刷新双方', callback: '#qqbot检测刷新双方' }, { text: '搜索群', input: '#qqbot检测搜群 ', send: false }],
      [{ text: '群资料', callback: '#qqbot检测群资料' }, { text: '强制绑定', callback: '#qqbot检测强制绑定' }],
      [{ text: '重新匹配', callback: '#qqbot检测搜群' }, { text: '刷新进度', callback: '#qqbot检测刷新进度' }]
    ] : editable ? [
      [{ text: '刷新双方', callback: '#qqbot检测刷新双方' }, { text: '刷新进度', callback: '#qqbot检测刷新进度' }],
      [{ text: '强制绑定', callback: '#qqbot检测强制绑定' }, { text: '重新绑定', input: '#qqbot检测绑定 ', send: false }]
    ] : [[{ text: '刷新状态', callback: '#qqbot检测绑定状态' },
      ...(view.confirmationCode ? [{ text: '确认绑定', input: `#qqbot检测绑定确认 ${view.confirmationCode}`, send: false }] : view.probe ? [{ text: '查看探针', callback: `#qqbot检测探针详情 ${view.probe.nonce}` }] : [])],
    [{ text: '重新绑定', input: '#qqbot检测绑定 ', send: false },
      ...(view.senderQQ ? [{ text: '强制绑定', callback: `#qqbot检测强制绑定 ${view.senderQQ}` }] : [])]]
    const navigation = []
    if (page > 1) navigation.push({ text: '上一页', callback: `#qqbot检测候选 ${page - 1}` })
    if (page < pages) navigation.push({ text: '下一页', callback: `#qqbot检测候选 ${page + 1}` })
    if (navigation.length) rows.push(navigation)
    rows.push([{ text: '返回', callback: commandFor('#qqbot检测辅助菜单') }])
    return reply([body, buttons(...rows)], true)
  }
  try {
    if ((match = /^#q+bot检测(?:绑定\s+(\d+)|选群\s+(\d+)(?:\s+([a-f0-9]{8}))?|绑定确认\s+([a-f0-9]{8})|强制绑定(?:\s+(\d+))?|定位\s+([a-f0-9]{32}))(?:\s+[^#]*)?$/i.exec(msg))) {
      // Full-message peers must not all answer a command actually @another bot.
      if (context.group && context.hasMentions && !context.isYou) return true
      if (context.group && !context.isYou) return result('请在原群使用QQ的@功能真实@对应机器人后发送；点击qbotcmd仅填写命令，不代表已经@。')
      bindingAction = true
      id = target(); await store.loadAccount(id)
      if (match[6]) return result(await manager.locate(id, match[6], context))
      if (match[1]) return bindingReply(await manager.bind(id, match[1], context))
      if (match[2]) return bindingReply(await manager.choose(id, Number(match[2]), context, match[3]))
      if (match[4]) {
        const text = await manager.confirm(id, match[4], context)
        return result(`${text}\n\n${helperActivationHints()}`)
      }
      return bindingReply(await manager.forceBinding(id, context, match[5]))
    }
    if ((match = /^#q+bot检测(刷新双方|刷新进度|群资料(?:\s+(\d+))?|候选(?:\s+(\d+))?|搜群(?:\s+([\s\S]+))?)$/i.exec(msg))) {
      if (context.group && context.hasMentions && !context.isYou) return true
      if (context.group && !context.isYou) return result('请在原群真实@接收者后发送绑定操作；点击qbotcmd仅填写命令。')
      bindingAction = true
      id = target(); await store.loadAccount(id)
      if (match[1] === '刷新双方') {
        manager.refreshGroups(id, context)
        return bindingReply('已启动双方资料刷新队列；可随时查看进度。')
      }
      if (match[1].startsWith('搜群')) {
        await manager.searchGroups(id, match[4] || '', context)
        return bindingReply(match[4] ? `搜索完成：${match[4]}` : '已按当前缓存重新匹配同名群；人数和旧权限仅供参考。')
      }
      const view = manager.bindingView(id)
      if (match[2]) {
        const detail = view.candidates[Number(match[2]) - 1]
        if (!detail) throw new Error('候选群序号无效，请先搜索或查看候选')
        return bindingReply('所选候选群的缓存资料如下；查看资料不会发送校验。', Math.ceil(Number(match[2]) / 5), detail)
      }
      return bindingReply('双方群资料与候选；群OpenID分别属于对应机器人，不能互换。', Number(match[3]) || 1)
    }
    if ((match = /^#q+bot(业务检测|辅助探测|临时鉴权|自动接管|静默检测|消耗检测|允许辅助发送)\s*(开启|关闭)(?:\s+(\d+))?$/i.exec(msg))) {
      id = target(match[3]); await store.loadAccount(id)
      await store.update(id, record => { record.settings.businessDetection[switches[match[1]]] = match[2] === '开启' })
      manager.refresh(id)
      return result(`[${id}] ${match[1]}已${match[2]}\n其他开关不变。${match[1] === '临时鉴权' && match[2] === '开启' ? '\n此方法会消耗Session次数，受冷却、每日预算与配额预留限制。' : ''}${match[1] === '辅助探测' && match[2] === '开启' ? `\n\n${helperActivationHints()}` : ''}`)
    }
    if ((match = /^#q+bot检测设置(?:(确认|取消)\s+([a-f0-9]{8})(?:\s+(\d+))?|\s+(静默时间|接管时间|冷却时间|每日次数|保留次数|探针超时|观察时间)\s+(-?\d+(?:\.\d+)?)\s*(分钟|次|秒)?(?:\s+(\d+))?)$/i.exec(msg))) {
      id = target(match[3] || match[7]); await store.loadAccount(id)
      const actor = String(event.user_id || event.sender?.user_id || context.actor || '')
      if (!actor) throw new Error('缺少操作者身份，无法确认设置修改')
      const scope = JSON.stringify([String(event.self_id), id, actor, context.group || event.group_id || '', !!isLocalEvent])
      if (!settingConfirmations.has(store)) settingConfirmations.set(store, new Map())
      const pending = settingConfirmations.get(store)
      for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key)
      if (!match[1]) {
        const [key, unit] = parameters[match[4]], value = Number(match[5]), [min, max] = businessParameterLimits[key]
        if (match[6] && match[6] !== unit) return result(`单位应为${unit}`)
        if (!Number.isSafeInteger(value) || value < min || value > max) return result(`${match[4]}应为${min}～${max}${unit}的整数；未修改配置。`)
        const previous = store.settings(id).businessDetection[key]
        if (previous === value) return result(`[${id}] ${match[4]}已是${value}${unit}，无需修改。`)
        const code = randomBytes(4).toString('hex')
        if (pending.size >= 1000) pending.delete(pending.keys().next().value)
        pending.set(scope, { code, key, value, previous, name: match[4], unit, expires: now() + 120000 })
        return reply([`[${id}] 请确认修改：${match[4]}\n${previous}${unit} → ${value}${unit}\n两分钟内由原操作者在当前会话确认后才保存，开关保持不变。\n\n${command(`#qqbot检测设置确认 ${code}`, '确认修改')}　${command(`#qqbot检测设置取消 ${code}`, '取消修改')}`,
          buttons([{ text: '确认修改', callback: commandFor(`#qqbot检测设置确认 ${code}`) }, { text: '取消修改', callback: commandFor(`#qqbot检测设置取消 ${code}`) }])], true)
      }
      const edit = pending.get(scope)
      if (!edit || edit.code !== match[2].toLowerCase()) return result('修改确认不存在或已过期，请重新输入设置；未修改配置。')
      pending.delete(scope)
      if (match[1] === '取消') return result('已取消本次修改，配置保持不变。')
      await store.update(id, record => {
        if (now() >= edit.expires || record.settings.businessDetection[edit.key] !== edit.previous) throw new Error('确认已过期或该设置已变化，请重新输入设置')
        record.settings.businessDetection[edit.key] = edit.value
      })
      manager.refresh(id)
      return result(`[${id}] ${edit.name}已设为${edit.value}${edit.unit}\n开关保持不变。`)
    }
    if ((match = /^#q+bot检测探针详情\s+([a-f0-9]{32})(?:\s+(\d+))?$/i.exec(msg))) {
      id = target(match[2]); await store.loadAccount(id)
      const probe = manager.probeDetail(id, match[1].toLowerCase())
      if (!probe) return result('此探针详情不存在或已超出保留记录；旧记录不补造随机字符，不会重新发送探针。')
      return result(`[${id}] ${probe.kind}\n发送者：${probe.senderQQ}\n接收者：${probe.receiverQQ}\n发送时间：${date(probe.sentAt)}\n发送消息ID：${probe.messageId || '未记录'}\n旧连接收到：${date(probe.mainReceivedAt)}\n候选连接收到：${date(probe.candidateReceivedAt)}\n以下为发送者当次实际发送内容；仅供查看，不重新发送或注册校验：\n\n\`\`\`text\n${probe.content}\n\`\`\``)
    }
    if ((match = /^#q+bot查看辅助对象(?:\s+(\d+))?$/i.exec(msg))) {
      id = target(match[1]); await store.loadAccount(id)
      const ids = listConfigured().filter(receiver => store.settings(receiver).businessDetection?.binding?.senderQQ === id)
      return result(`[${id}] 已绑定本机作为发送者的接收者：${ids.join('、') || '无'}\n本机允许协助发送：${state(store.settings(id).businessDetection.allowSender)}`)
    }
    if ((match = /^#q+bot(?:立即检测(?:\s+(辅助|临时))?|检测绑定校验)(?:\s+(\d+))?$/i.exec(msg))) {
      id = target(match[2]); await store.loadAccount(id)
      const value = await manager.check(id, msg.includes('绑定校验') ? 'helper' : { 辅助: 'helper', 临时: 'temporary' }[match[1]] || 'auto', { manual: true })
      return result(`[${id}] ${resultText(value)}`)
    }
    if ((match = /^#q+bot停止检测(?:\s+(\d+))?$/i.exec(msg))) {
      id = target(match[1]); manager.stop(id)
      return result('已请求取消当前检测；不关闭已经接管的主连接，不改变配置开关。')
    }
    if ((match = /^#q+bot检测解绑(?:\s+(\d+))?$/i.exec(msg))) {
      id = target(match[1]); await store.loadAccount(id)
      return result(await manager.unbind(id))
    }
    match = /^#q+bot检测(菜单|状态|记录|绑定状态|辅助菜单|临时菜单|策略菜单)(?:\s+(\d+))?$/i.exec(msg)
    if (!match) return false
    id = target(match[2]); await store.loadAccount(id)
    const status = await manager.status(id), config = status.config
    const toggle = (name, key) => ({ text: `${config[key] ? '关闭' : '开启'}${name}`, callback: commandFor(`#qqbot${name} ${config[key] ? '关闭' : '开启'}`) })
    const switchState = name => command(`#qqbot${name} ${config[switches[name]] ? '关闭' : '开启'}`, state(config[switches[name]]))
    const parameter = name => command(`#qqbot检测设置 ${name} ${config[parameters[name][0]]}`, String(config[parameters[name][0]]))
    const helperMechanism = `\`\`\`text\n辅助检测机制：\n硬性要求：接收者和发送者不能是同一个机器人，\nQQ和AppID都必须不同。\n官方屏蔽机器人自身消息，单台不能自发自收校验。\n本地至少需要两台当前凭证已鉴权连接的可用机器人；\n历史记录、已回收/注销、停用和凭证错误不计入。\n需开启总开关和辅助探测，并完成同群绑定。\n发送者需开启允许辅助发送、具备主动消息权限，\n接收者需全量接收。\n绑定发送者主动发送带随机标识的QQBOT-CHECK探针，\n使用接收者现有主连接确认到达，最多等待${config.probeSeconds}秒。\n收到匹配探针，表示当前主路径可用。\n发送失败则检测未完成；发送成功但超时未收到，\n只能判定结果不确定，不能直接认定掉线。\n本方法不新建WS，不额外消耗Session连接次数。\n立即辅助检测不受${config.cooldownMinutes}分钟冷却限制，\n也不新增或延长冷却；仍保留发送间隔和检测互斥。\n自动触发仍遵守触发开关和自动检测冷却。\n探针详情仅查看当次发送内容，不会重新发送。\n\`\`\``
    const temporaryMechanism = `\`\`\`text\n临时Identify机制：\n需开启总开关和临时Identify方法。\n尝试前检查临时连接冷却、每日预算和实时配额；\n扣除本次后，剩余次数不得低于预留。\n以同AppID、同环境、同订阅建立隔离候选连接，\nIdentify会消耗连接次数；手动检测也不绕过限制。\n候选最多观察${config.observeSeconds}秒，只鉴权、心跳、观察，\n不进入SDK业务处理或外部插件。\nREADY/ACK不算业务证据，需收到有效的新业务事件。\n旧连接收到新业务则保留旧连接、关闭候选。\n候选有业务证据且心跳有效、自动接管已开启，\n旧连接静默满${config.takeoverMinutes}分钟时才可接管；\n接管使用同一个候选连接，不再次Identify。\n自动接管关闭、静默不足或证据不确定时，\n保留旧连接，结束后关闭候选。\n隔离窗口不补交全部事件，不保证零漏消息。\n\`\`\``
    const strategyMechanism = `\`\`\`text\n检测机制：\n自动检测由已开启的静默/消耗条件触发。\n辅助探测先发探针，最多等待${config.probeSeconds}秒；\n旧连接收到则结束，不新建Identify。\n未收到不等于故障：仅开启临时Identify，\n且冷却、每日预算、实时配额检查通过后，\n才建立隔离候选连接。\n单独立即检测临时方法，不先发辅助探针。\n候选只观察，不进入插件；READY/ACK不算业务证据。\n候选有业务证据、旧连接静默满${config.takeoverMinutes}分钟，\n且自动接管开启时才可接管，不再次Identify。\n旧连接收到新业务则保留旧连接；证据不足不切换。\n隔离窗口不补交全部事件，不保证零漏消息。\n立即检测辅助不建连接、不占自动检测冷却；\n手动临时Identify仍受临时连接冷却和预算限制。\n\`\`\``
    if (match[1] === '记录') {
      const body = status.history.slice(-10).reverse().map(item => `${date(item.at)} ${resultText(item)}`).join('\n\n')
      return result(`[${id}] 最近检测记录（最多显示10条）\n${body || '暂无记录'}`)
    }
    const binding = config.binding
    const bindingText = binding ? `发送者：${binding.senderQQ}\n发送者群OpenID：${binding.senderGroup}\n接收者群OpenID：${binding.receiverGroup}` : '尚未绑定'
    if (match[1] === '绑定状态') return bindingReply(`[${id}] ${bindingText}\n待绑定阶段：${status.pending || '无'}`)
    if (match[1] === '辅助菜单') return reply([
      `[${id}] 辅助探测：${switchState('辅助探测')}\n本机允许协助发送：${switchState('允许辅助发送')}\n${bindingText}\n点击当前状态可填写切换命令。\n\n\`\`\`text\n绑定准备：\n将两个不同AppID的本地机器人拉入同群，\n发送者允许主动消息、接收者全量接收。\n\n真人实际@接收者发送：\n#qqbot检测绑定 发送者QQ\n\n找不到候选时可刷新双方最近50个入站群、\n搜索后选群，或用特定文本强制定位；\n仍需主动校验和原发起人在原群@接收者确认。\n单一候选会自动进入校验，无需再次选群；\n校验到达后点刷新绑定状态，按确认入口继续。\n绑定不会开启检测；后续探测需发送者开启协助。\n点击命令只填写文本，仍需真人真实@后发送。\n\`\`\`\n\n${helperMechanism}\n\n${hint('#qqbot检测绑定 ', '填写发送者QQ开始绑定')}\n\n${hint('#qqbot检测强制绑定 ', '填写发送者QQ强制定位')}\n\n${command('#qqbot检测绑定状态', '绑定状态与群资料')}\n\n${command('#qqbot立即检测 辅助', '立即辅助检测')}\n\n${command('#qqbot检测解绑', '解除绑定')}`,
      buttons([toggle('辅助探测', 'helper'), { text: '绑定状态', callback: commandFor('#qqbot检测绑定状态') }],
        [{ text: '立即检测', callback: commandFor('#qqbot立即检测 辅助') }, { text: '返回', callback: commandFor('#qqbot检测菜单') }])
    ], true)
    if (match[1] === '临时菜单') return reply([
      `[${id}] 临时Identify：${switchState('临时鉴权')}\n自动接管：${switchState('自动接管')}\n每日最多${parameter('每日次数')}次尝试\n临时连接冷却${parameter('冷却时间')}分钟\n至少保留${parameter('保留次数')}次配额\n点击状态切换，点击数值填写新数值；数值修改确认后保存。\n\n${temporaryMechanism}\n\n${command('#qqbot立即检测 临时', '立即临时鉴权检测')}`,
      buttons([toggle('临时鉴权', 'temporaryIdentify'), toggle('自动接管', 'autoTakeover')],
        [{ text: '立即检测', callback: commandFor('#qqbot立即检测 临时') }, { text: '返回', callback: commandFor('#qqbot检测菜单') }])
    ], true)
    if (match[1] === '策略菜单') return reply([
      `[${id}] 静默检测：${switchState('静默检测')}\n消耗检测：${switchState('消耗检测')}\n消耗门槛：滚动5分钟≥10次\n辅助、临时方法独立，检测不依赖通知。\n点击状态切换，点击数值编辑；数值修改确认后保存。\n\n${Object.entries(parameters).map(([name, [, unit]]) => `${name}：${parameter(name)}${unit}`).join('\n')}\n\n${strategyMechanism}`,
      buttons([toggle('静默检测', 'silence'), toggle('消耗检测', 'consumption')], [{ text: '返回', callback: commandFor('#qqbot检测菜单') }])
    ], true)
    const text = `[${id}] 业务检测\n总开关：${switchState('业务检测')}\n辅助探测：${switchState('辅助探测')}\n临时Identify：${switchState('临时鉴权')}\n自动接管：${switchState('自动接管')}\n静默触发：${switchState('静默检测')}\n消耗触发：${switchState('消耗检测')}\n允许辅助发送：${switchState('允许辅助发送')}\n绑定：${binding ? `发送者${binding.senderQQ}` : '未绑定'}\n待绑定：${status.pending || '无'}\n检测进行中：${status.busy ? '是' : '否'}\n最近新业务帧：${date(status.lastBusinessAt)}\n最近检测：${date(status.lastCheckAt)}\n自动检测冷却至：${date(status.automaticNextAllowedAt)}\n临时连接冷却至：${date(status.temporaryNextAllowedAt)}\n手动辅助测试不受上述冷却限制。\n近5分钟消耗：${config.consumption ? status.count : '未启用采样'}\n临时尝试预算：${status.budget?.day || '无记录'} ${status.budget?.used || 0}/${config.dailyLimit}\n最近结果：${resultText(status.lastResult)}\n所有新增开关默认关闭，按机器人保存在YAML。点击状态可填写切换命令。\n\n${command('#qqbot检测辅助菜单', '辅助机器人与绑定')}\n\n${command('#qqbot检测临时菜单', '临时Identify与接管')}\n\n${command('#qqbot检测策略菜单', '触发条件与预算')}\n\n${command('#qqbot检测记录', '查看检测记录')}`
    return reply([text, buttons(
      [toggle('业务检测', 'enabled'), { text: '刷新状态', callback: commandFor('#qqbot检测状态') }],
      [{ text: '辅助探测', callback: commandFor('#qqbot检测辅助菜单') }, { text: '临时鉴权', callback: commandFor('#qqbot检测临时菜单') }],
      [{ text: '触发策略', callback: commandFor('#qqbot检测策略菜单') }, { text: '检测记录', callback: commandFor('#qqbot检测记录') }],
      [{ text: '立即检测', callback: commandFor('#qqbot立即检测') }, { text: '停止检测', callback: commandFor('#qqbot停止检测') }],
      [{ text: '返回', callback: '#QQBot帮助' }])], true)
  } catch (error) {
    const message = `业务检测操作未完成：${error?.message || '未知错误'}`
    if (bindingAction && id && manager.bindingView(id).phase) return bindingReply(message)
    return result(message)
  }
}
