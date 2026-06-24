import advancedWelcomeStore from './advancedWelcomeStore.js'

function limitButtonRows (rows) {
  return rows
    .filter(row => Array.isArray(row) && row.length)
    .slice(0, 5)
    .map(row => row.slice(0, 2))
}

function ensureAdvancedWelcomeConfig (config, selfId = '') {
  if (!config.advancedWelcome || typeof config.advancedWelcome !== 'object') config.advancedWelcome = {}
  if (!config.advancedWelcome.bots || typeof config.advancedWelcome.bots !== 'object' || Array.isArray(config.advancedWelcome.bots)) config.advancedWelcome.bots = {}
  const key = selfId || 'default'
  if (!config.advancedWelcome.bots[key] || typeof config.advancedWelcome.bots[key] !== 'object') config.advancedWelcome.bots[key] = {}
  const aw = config.advancedWelcome.bots[key]
  if (typeof aw.enabled !== 'boolean') aw.enabled = false
  if (typeof aw.markdown !== 'string') aw.markdown = ''
  if (!aw.button || typeof aw.button !== 'object') aw.button = null
  aw.totalLimit = normalizeLimit(aw.totalLimit, 3)
  aw.dayLimit = normalizeLimit(aw.dayLimit, 0)
  aw.weekLimit = normalizeLimit(aw.weekLimit, 0)
  aw.hour5Limit = normalizeLimit(aw.hour5Limit, 0)
  aw.hour1Limit = normalizeLimit(aw.hour1Limit, 0)
  aw.min5Limit = normalizeLimit(aw.min5Limit, 0)
  aw.min1Limit = normalizeLimit(aw.min1Limit, 0)
  aw.cooldownSeconds = Math.max(0, Number(aw.cooldownSeconds) || 0)
  aw.speechLimit = Math.max(0, Number(aw.speechLimit) || 0)
  return aw
}

function normalizeLimit (value, fallback = 0) {
  if (value === '无限') return 0
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(0, num) : fallback
}

function formatLimit (value) { return Number(value) > 0 ? `${Number(value)}次` : '无限' }

function formatLimitValue (value) { return Number(value) > 0 ? `${Number(value)}` : '无限' }

function getAdvancedWelcomeRecommendButtonJson (selfId = '') {
  return JSON.stringify({
    rows: [
      {
        buttons: [
          { render_data: { label: '关闭通知' }, action: { type: 2, permission: { type: 2 }, data: `#我要关闭通知 ${selfId}`, enter: true } },
          { render_data: { label: '投诉通知' }, action: { type: 2, permission: { type: 2 }, data: `#我要投诉通知 ${selfId}`, enter: true } }
        ]
      }
    ]
  })
}

function buttonTextWarnings (button) {
  const warnings = []
  const rows = Array.isArray(button?.rows) ? button.rows : []
  for (const row of rows) {
    for (const btn of row?.buttons || []) {
      const text = btn?.render_data?.label || btn?.text || ''
      if ([...String(text)].length > 6) warnings.push(text)
    }
  }
  return warnings
}

function replaceWelcomeVariables (text = '', context = {}) {
  return String(text || '').replace(/<@openid>/g, `<@${context.memberOpenid || ''}>`)
}

function getAdvancedWelcomeMenuMsg (config, selfId = '') {
  const aw = ensureAdvancedWelcomeConfig(config, selfId)
  const summary = advancedWelcomeStore.getSummary(selfId)
  const enabledGroups = aw.enabled && aw.markdown ? summary.enabledCandidates : 0
  const groupEvent = config.bots?.[selfId]?.groupEvent ?? config.groupEvent
  return [
    `#[${selfId || '-'}] 高级群欢迎菜单`,
    '',
    `>总开关: ${aw.enabled ? '开启' : '关闭'}`,
    '',
    `><qqbot-cmd-input text="#QQBot高级群欢迎设置 总开关 ${aw.enabled ? '关闭' : '开启'}" show="${aw.enabled ? '关闭' : '开启'}高级群欢迎"/>`,
    '',
    `>Markdown: ${aw.markdown ? '已设置' : '未设置'}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 Markdown " show="设置Markdown"/>',
    '',
    `>按钮: ${aw.button ? '已设置' : '未设置'}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 button " show="设置按钮"/>',
    '',
    `>群事件开关: ${groupEvent ? '开启(建议关闭，以防重复发送)' : '关闭(正常)'}`,
    '',
    ...(groupEvent ? ['><qqbot-cmd-input text="#QQBot普通设置 群事件 关闭" show="关闭群事件"/>', ''] : []),
    '><qqbot-cmd-input text="#QQBot高级群欢迎预览" show="发送预览"/>',
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 限制菜单" show="限制菜单"/>',
    '',
    `>单群总次数: ${formatLimit(aw.totalLimit)}`,
    '',
    `>单群天/周: ${formatLimit(aw.dayLimit)} / ${formatLimit(aw.weekLimit)}`,
    '',
    `>单群5小时/1小时: ${formatLimit(aw.hour5Limit)} / ${formatLimit(aw.hour1Limit)}`,
    '',
    `>单群5分钟/1分钟: ${formatLimit(aw.min5Limit)} / ${formatLimit(aw.min1Limit)}`,
    '',
    `>限发间隔: ${aw.cooldownSeconds ? `${aw.cooldownSeconds}秒` : '关闭'}`,
    '',
    `>发言限制: ${aw.speechLimit ? `上次欢迎后收到全量群消息 ${aw.speechLimit} 次才发送` : '关闭(不要求发言数)'}`,
    '',
    `>记录群数: ${summary.recordTotal}`,
    '',
    `>当前开启群数: ${aw.enabled ? enabledGroups : 0}`,
    '',
    `>当前关闭群数: ${summary.disabledTotal}`,
    '',
    `>当前关闭率: ${(summary.closeRate * 100).toFixed(2)}%`,
    '',
    `>累计欢迎下发: ${summary.sentTotal}`,
    '',
    `>被投诉群聊: ${summary.complaintGroups}`,
    '',
    '```text',
    '请先配置 Markdown，再按需配置按钮。平台禁止单发按钮，未配置Markdown时不能配置按钮。',
    '用户变量: 自定义Markdown中的 <@openid > 会替换为入群用户openid。(去掉d后面的空格)',
    '发言限制只统计 GROUP_MESSAGE_CREATE 次数，非全量群不会因发言限制跳过通知。',
    '群管理/群主关闭: #我要关闭通知 当前机器人QQ',
    '群成员投诉: #我要投诉通知 当前机器人QQ',
    '撤回投诉: #我要撤回投诉 当前机器人QQ',
    '查看: #QQBot高级群欢迎查看 1',
    '关闭列表: #QQBot高级群欢迎查看关闭 1',
    '投诉列表: #QQBot高级群欢迎查看投诉 1',
    '关闭群: #QQBot高级群欢迎关闭 群openid',
    '开启群: #QQBot高级群欢迎开启 群openid',
    '详情: #QQBot高级群欢迎查看详情 群openid',
    '```'
  ].join('\n')
}

function getAdvancedWelcomeMenuButtons (config, selfId = '') {
  const aw = ensureAdvancedWelcomeConfig(config, selfId)
  return limitButtonRows([
    [
      { text: aw.enabled ? '关闭欢迎' : '开启欢迎', callback: `#QQBot高级群欢迎设置 总开关 ${aw.enabled ? '关闭' : '开启'}` },
      { text: '设置MD', input: '#QQBot高级群欢迎设置 Markdown ' }
    ],
    [
      { text: '设置按钮', input: '#QQBot高级群欢迎设置 button ' },
      { text: '预览', callback: '#QQBot高级群欢迎预览' }
    ],
    [
      { text: '限制菜单', callback: '#QQBot高级群欢迎设置 限制菜单' },
      { text: '查看群', callback: '#QQBot高级群欢迎查看 1' }
    ],
    [
      { text: '推荐MD', callback: '#QQBot高级群欢迎设置 推荐MD' },
      { text: '推荐按钮', callback: '#QQBot高级群欢迎设置 推荐按钮' }
    ],
    [
      { text: '删按钮', callback: '#QQBot高级群欢迎设置 删除按钮' },
      { text: '返回', callback: '#QQBot帮助' }
    ]
  ])
}

function getAdvancedWelcomeLimitMenuMsg (config, selfId = '') {
  const aw = ensureAdvancedWelcomeConfig(config, selfId)
  return [
    `#[${selfId || '-'}] 高级群欢迎限制菜单`,
    '',
    `>单群总次数: ${formatLimit(aw.totalLimit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群总次数 3" show="设单群总次数"/>',
    '',
    `>单群天次数: ${formatLimit(aw.dayLimit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群天次数 0" show="设单群天次数"/>',
    '',
    `>单群周次数: ${formatLimit(aw.weekLimit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群周次数 0" show="设单群周次数"/>',
    '',
    `>单群5小时次数: ${formatLimit(aw.hour5Limit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群5小时次数 0" show="设单群5小时"/>',
    '',
    `>单群1小时次数: ${formatLimit(aw.hour1Limit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群1小时次数 0" show="设单群1小时"/>',
    '',
    `>单群5分钟次数: ${formatLimit(aw.min5Limit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群5分钟次数 0" show="设单群5分钟"/>',
    '',
    `>单群1分钟次数: ${formatLimit(aw.min1Limit)}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 单群1分钟次数 0" show="设单群1分钟"/>',
    '',
    `>限发间隔: ${aw.cooldownSeconds ? `${aw.cooldownSeconds}秒` : '关闭'}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 限发间隔 15" show="设限发间隔"/>',
    '',
    `>发言限制: ${aw.speechLimit ? `上次欢迎后收到全量群消息 ${aw.speechLimit} 次才发送` : '关闭(不要求发言数)'}`,
    '',
    '><qqbot-cmd-input text="#QQBot高级群欢迎设置 发言限制 30" show="设发言限制"/>',
    '',
    '```text',
    '0 或 无限 表示不限制。单群总次数默认 3，其余默认不限制。',
    '发言限制只统计 GROUP_MESSAGE_CREATE 次数，非全量群不会因发言限制跳过通知。',
    '```'
  ].join('\n')
}

function getAdvancedWelcomeLimitMenuButtons () {
  return limitButtonRows([
    [
      { text: '单群总', input: '#QQBot高级群欢迎设置 单群总次数 3' },
      { text: '单群天', input: '#QQBot高级群欢迎设置 单群天次数 0' }
    ],
    [
      { text: '单群周', input: '#QQBot高级群欢迎设置 单群周次数 0' },
      { text: '单5小时', input: '#QQBot高级群欢迎设置 单群5小时次数 0' }
    ],
    [
      { text: '单1小时', input: '#QQBot高级群欢迎设置 单群1小时次数 0' },
      { text: '单5分钟', input: '#QQBot高级群欢迎设置 单群5分钟次数 0' }
    ],
    [
      { text: '单1分钟', input: '#QQBot高级群欢迎设置 单群1分钟次数 0' },
      { text: '限发', input: '#QQBot高级群欢迎设置 限发间隔 15' }
    ],
    [
      { text: '发言', input: '#QQBot高级群欢迎设置 发言限制 30' },
      { text: '返回', callback: '#QQBot高级群欢迎菜单' }
    ]
  ])
}

function getAdvancedWelcomeListMsg (config, selfId = '', type = 'all', page = 1, pageSize = 5) {
  const aw = ensureAdvancedWelcomeConfig(config, selfId)
  let groups = advancedWelcomeStore.getGroups(selfId)
  if (type === 'disabled') groups = groups.filter(item => item.disabled)
  if (type === 'complaint') groups = groups.filter(item => Object.keys(item.complaints || {}).length || Object.keys(item.withdrawn_complaints || {}).length)
  groups.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  const total = groups.length
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  page = Math.max(1, Math.min(maxPage, Number(page) || 1))
  const list = groups.slice((page - 1) * pageSize, page * pageSize)
  const summary = advancedWelcomeStore.getSummary(selfId)
  const titleMap = { all: '高级群欢迎查看', disabled: '高级群欢迎关闭群', complaint: '高级群欢迎投诉群' }
  const lines = [
    `#[${selfId}] ${titleMap[type] || titleMap.all}`,
    '',
    `>共 ${total} 个，第 ${page}/${maxPage} 页`,
    '',
    `>当前开启群数: ${aw.enabled && aw.markdown ? summary.enabledCandidates : 0}`,
    '',
    `>当前关闭群数: ${summary.disabledTotal}`,
    '',
    `>累计欢迎下发次数: ${summary.sentTotal}`,
    ''
  ]
  if (!list.length) lines.push('暂无记录')
  list.forEach((item, index) => {
    const complaints = Object.keys(item.complaints || {}).length
    const withdrawn = Object.keys(item.withdrawn_complaints || {}).length
    const counts = advancedWelcomeStore.getSentWindowCounts(item.self_id, item.group_openid)
    lines.push('```text')
    lines.push(`${(page - 1) * pageSize + index + 1}. ${item.group_openid}`)
    lines.push(`状态: ${item.disabled ? '关闭' : '开启'}`)
    lines.push(`额度: 总${counts.total}/${formatLimit(aw.totalLimit)} 天${counts.day}/${formatLimit(aw.dayLimit)} 周${counts.week}/${formatLimit(aw.weekLimit)}`)
    lines.push(`短期: 5时: ${counts.hour5}/${formatLimitValue(aw.hour5Limit)} 1时: ${counts.hour1}/${formatLimitValue(aw.hour1Limit)} 5分: ${counts.min5}/${formatLimitValue(aw.min5Limit)} 1分: ${counts.min1}/${formatLimitValue(aw.min1Limit)}`)
    lines.push(`加群/退群: ${item.join_count || 0}/${item.leave_count || 0}`)
    lines.push(`全量群消息状态: ${item.full_message_active ? '可用' : '不可用'}，已统计${item.full_message_create_count || 0}次`)
    lines.push(`发送/失败: ${item.sent_count || 0}/${item.failed_count || 0}`)
    lines.push(`投诉/撤回: ${complaints}/${withdrawn}`)
    lines.push(`最近失败: ${item.last_failed_reason || '-'}`)
    lines.push('```')
    lines.push(`><qqbot-cmd-input text="#QQBot高级群欢迎${item.disabled ? '开启' : '关闭'} ${item.group_openid}" show="${item.disabled ? '开启' : '关闭'}此群"/>`)
    lines.push(`><qqbot-cmd-input text="#QQBot高级群欢迎查看详情 ${item.group_openid}" show="查看详情"/>`)
    if (index < list.length - 1) lines.push('')
  })
  return { msg: lines.join('\n'), page, maxPage, type }
}

function getAdvancedWelcomeListButtons (type = 'all', page = 1, maxPage = 1) {
  const cmdMap = { all: '#QQBot高级群欢迎查看', disabled: '#QQBot高级群欢迎查看关闭', complaint: '#QQBot高级群欢迎查看投诉' }
  const cmd = cmdMap[type] || cmdMap.all
  const rows = []
  const pageRow = []
  if (page > 1) pageRow.push({ text: '上一页', callback: `${cmd} ${page - 1}` })
  if (page < maxPage) pageRow.push({ text: '下一页', callback: `${cmd} ${page + 1}` })
  if (pageRow.length) rows.push(pageRow)
  rows.push([{ text: '全部群', callback: '#QQBot高级群欢迎查看 1' }, { text: '关闭群', callback: '#QQBot高级群欢迎查看关闭 1' }])
  rows.push([{ text: '投诉群', callback: '#QQBot高级群欢迎查看投诉 1' }, { text: '返回', callback: '#QQBot高级群欢迎菜单' }])
  return limitButtonRows(rows)
}

function checkAdvancedWelcomeSend (config, selfId = '', groupOpenid = '') {
  const aw = ensureAdvancedWelcomeConfig(config, selfId)
  const group = advancedWelcomeStore.getGroup(selfId, groupOpenid)
  if (!aw.enabled) return { ok: false, reason: '全局高级群欢迎未开启', globalOff: true }
  if (group?.disabled) return { ok: false, reason: '当前群已关闭欢迎推送', groupDisabled: true }
  if (!aw.markdown) return { ok: false, reason: '高级群欢迎Markdown未配置', configError: true }
  const speechLimitEnabled = aw.speechLimit > 0 && group?.full_message_active === true
  if (speechLimitEnabled && (Number(group?.speech_since_sent) || 0) < aw.speechLimit) return { ok: false, reason: `上次欢迎后GROUP_MESSAGE_CREATE未达到 ${aw.speechLimit} 次`, limited: true }
  if (aw.cooldownSeconds > 0 && group?.last_sent_at) {
    const last = Date.parse(group.last_sent_at)
    if (Number.isFinite(last) && Date.now() - last < aw.cooldownSeconds * 1000) return { ok: false, reason: `限发间隔 ${aw.cooldownSeconds} 秒内已发送`, limited: true }
  }
  const counts = advancedWelcomeStore.getSentWindowCounts(selfId, groupOpenid)
  const limits = [
    ['total', aw.totalLimit, '单群总次数'],
    ['day', aw.dayLimit, '单群天次数'],
    ['week', aw.weekLimit, '单群周次数'],
    ['hour5', aw.hour5Limit, '单群5小时次数'],
    ['hour1', aw.hour1Limit, '单群1小时次数'],
    ['min5', aw.min5Limit, '单群5分钟次数'],
    ['min1', aw.min1Limit, '单群1分钟次数']
  ]
  for (const [key, limit, label] of limits) {
    if (Number(limit) > 0 && Number(counts[key]) >= Number(limit)) return { ok: false, reason: `${label}已达上限 ${limit}`, limited: true }
  }
  return { ok: true, markdown: aw.markdown, button: aw.button }
}

export {
  advancedWelcomeStore,
  buttonTextWarnings,
  checkAdvancedWelcomeSend,
  ensureAdvancedWelcomeConfig,
  getAdvancedWelcomeListButtons,
  getAdvancedWelcomeListMsg,
  getAdvancedWelcomeLimitMenuButtons,
  getAdvancedWelcomeLimitMenuMsg,
  getAdvancedWelcomeMenuButtons,
  getAdvancedWelcomeMenuMsg,
  getAdvancedWelcomeRecommendButtonJson,
  replaceWelcomeVariables
}
