import inviteStore from './inviteStore.js'

function limitButtonRows (rows) {
  return rows
    .filter(row => Array.isArray(row) && row.length)
    .slice(0, 5)
    .map(row => row.slice(0, 2))
}

// ========== icebreaker config ==========
function ensureIcebreakerConfig (config, selfId = '') {
  if (!config.icebreaker || typeof config.icebreaker !== 'object') config.icebreaker = {}
  if (!config.icebreaker.bots || typeof config.icebreaker.bots !== 'object') config.icebreaker.bots = {}
  const key = selfId || 'default'
  if (!config.icebreaker.bots[key] || typeof config.icebreaker.bots[key] !== 'object') {
    config.icebreaker.bots[key] = {}
  }
  const ib = config.icebreaker.bots[key]
  if (typeof ib.groupEnabled !== 'boolean') ib.groupEnabled = false
  if (typeof ib.friendEnabled !== 'boolean') ib.friendEnabled = false
  if (!Array.isArray(ib.disabledGroups)) ib.disabledGroups = []
  if (typeof ib.groupMarkdown !== 'string') ib.groupMarkdown = ''
  if (typeof ib.friendMarkdown !== 'string') ib.friendMarkdown = ''
  if (typeof ib.groupButtonEnabled !== 'boolean') ib.groupButtonEnabled = false
  if (typeof ib.friendButtonEnabled !== 'boolean') ib.friendButtonEnabled = false
  // button 存储为 raw JSON object (rows)
  if (!ib.groupButton || typeof ib.groupButton !== 'object') ib.groupButton = null
  if (!ib.friendButton || typeof ib.friendButton !== 'object') ib.friendButton = null
  return ib
}

// ========== recall config ==========
function ensureRecallConfig (config, selfId = '') {
  if (!config.recall || typeof config.recall !== 'object') config.recall = {}
  if (!config.recall.bots || typeof config.recall.bots !== 'object') config.recall.bots = {}
  const key = selfId || 'default'
  if (!config.recall.bots[key] || typeof config.recall.bots[key] !== 'object') {
    config.recall.bots[key] = {}
  }
  const rc = config.recall.bots[key]
  if (typeof rc.markdown !== 'string') rc.markdown = ''
  if (typeof rc.buttonEnabled !== 'boolean') rc.buttonEnabled = false
  if (!rc.button || typeof rc.button !== 'object') rc.button = null
  if (typeof rc.batchCount !== 'number') rc.batchCount = 0
  return rc
}

// ========== icebreaker menus ==========
function getIcebreakerMenuMsg (config, selfId = '') {
  const ib = ensureIcebreakerConfig(config, selfId)
  const isRaw = config.markdown?.[selfId] === 'raw'
  return [
    `#[${selfId || '-'}] 破冰菜单`,
    '',
    `>群聊破冰: ${ib.groupEnabled ? '开启' : '关闭'}`,
    '',
    `><qqbot-cmd-input text="#QQBot破冰设置 群聊总开关 ${ib.groupEnabled ? '关闭' : '开启'}" show="${ib.groupEnabled ? '关闭' : '开启'}群聊破冰"/>`,
    '',
    `>私聊破冰: ${ib.friendEnabled ? '开启' : '关闭'}`,
    '',
    `><qqbot-cmd-input text="#QQBot破冰设置 私聊总开关 ${ib.friendEnabled ? '关闭' : '开启'}" show="${ib.friendEnabled ? '关闭' : '开启'}私聊破冰"/>`,
    '',
    `>群聊Markdown: ${ib.groupMarkdown ? '已设置' : '未设置'}`,
    '',
    `>私聊Markdown: ${ib.friendMarkdown ? '已设置' : '未设置'}`,
    '',
    `>群聊Button: ${ib.groupButtonEnabled ? '开启' : '关闭'}${ib.groupButton ? '' : '(未配置)'}`,
    '',
    `>私聊Button: ${ib.friendButtonEnabled ? '开启' : '关闭'}${ib.friendButton ? '' : '(未配置)'}`,
    '',
    `>禁用群数量: ${ib.disabledGroups.length}`,
    '',
    `>Markdown模式: ${isRaw ? 'raw' : '纯文本'}`,
    '',
    '```text',
    '破冰: 机器人被拉入群聊/添加好友时自动发送消息',
    '群聊总开关开启后，仅能用禁用单独群来拉黑',
    '私聊无需禁用/开启单独',
    '平台禁止单发按钮，没配置Markdown不能配置按钮',
    '```'
  ].join('\n')
}

function getIcebreakerMenuButtons (config, selfId = '') {
  const ib = ensureIcebreakerConfig(config, selfId)
  return limitButtonRows([
    [
      { text: `${ib.groupEnabled ? '关' : '开'}群聊`, callback: `#QQBot破冰设置 群聊总开关 ${ib.groupEnabled ? '关闭' : '开启'}` },
      { text: `${ib.friendEnabled ? '关' : '开'}私聊`, callback: `#QQBot破冰设置 私聊总开关 ${ib.friendEnabled ? '关闭' : '开启'}` }
    ],
    [
      { text: '设群聊MD', input: '#QQBot破冰设置 群聊 Markdown ' },
      { text: '设私聊MD', input: '#QQBot破冰设置 私聊 Markdown ' }
    ],
    [
      { text: '设群按钮', input: '#QQBot破冰设置 群聊 button ' },
      { text: '设私按钮', input: '#QQBot破冰设置 私聊 button ' }
    ],
    [
      { text: `${ib.groupButtonEnabled ? '关' : '开'}群按钮`, callback: `#QQBot破冰设置 群聊 button ${ib.groupButtonEnabled ? '关闭' : '开启'}` },
      { text: `${ib.friendButtonEnabled ? '关' : '开'}私按钮`, callback: `#QQBot破冰设置 私聊 button ${ib.friendButtonEnabled ? '关闭' : '开启'}` }
    ],
    [
      { text: '禁用群', input: '#QQBot破冰设置 禁用单独群 ' },
      { text: '开启群', input: '#QQBot破冰设置 开启单独群 ' }
    ]
  ])
}

// ========== recall menus ==========
function getRecallMenuMsg (config, selfId = '') {
  const rc = ensureRecallConfig(config, selfId)
  const { canRecall, cannotRecall } = inviteStore.getRecallableList(selfId)
  const totalUsers = inviteStore.getC2cUserCount(selfId)
  const dbType = config.inviteDB || 'json'
  return [
    `#[${selfId || '-'}] 召回菜单`,
    '',
    `>可召回用户: ${canRecall.length}`,
    '',
    `>不可召回用户: ${cannotRecall.length}`,
    '',
    `>私信用户总数: ${totalUsers}`,
    '',
    `>召回Markdown: ${rc.markdown ? '已设置' : '未设置'}`,
    '',
    `>召回Button: ${rc.buttonEnabled ? '开启' : '关闭'}${rc.button ? '' : '(未配置)'}`,
    '',
    `>存储方式: ${dbType}`,
    '',
    `><qqbot-cmd-input text="#QQBot召回预览" show="打开预览菜单"/>`,
    '',
    '```text',
    '召回: 向私信用户发送互动召回消息(is_wakeup)',
    '用户主动对话后30天内可下发，每周期1条',
    '周期: 当天(自然日0天)、1-3天、4-7天、8-30天',
    '```'
  ].join('\n')
}

function getRecallMenuButtons (config, selfId = '') {
  const dbType = config.inviteDB || 'json'
  return limitButtonRows([
    [
      { text: '可召回', callback: '#QQBot可召回列表' },
      { text: '不可召回', callback: '#QQBot不可召回列表' }
    ],
    [
      { text: '召回查看', callback: '#QQBot召回查看' },
      { text: '召回预览', callback: '#QQBot召回预览' }
    ],
    [
      { text: '设置MD', input: '#QQBot召回设置 Markdown ' },
      { text: '设置按钮', input: '#QQBot召回设置 button ' }
    ],
    [
      dbType === 'level'
        ? { text: '切JSON存储', callback: '#QQBot召回设置 存储 json' }
        : { text: '切LevelDB存储', callback: '#QQBot召回设置 存储 level' },
      { text: '返回', callback: '#QQBot普通设置' }
    ]
  ])
}

function getRecallOverviewMsg (config, selfId = '') {
  const rc = ensureRecallConfig(config, selfId)
  const { canRecall, cannotRecall } = inviteStore.getRecallableList(selfId)
  const totalUsers = inviteStore.getC2cUserCount(selfId)
  const maxBatch = canRecall.length
  return [
    `#[${selfId || '-'}] 召回查看`,
    '',
    `>可召回数量: ${canRecall.length}`,
    '',
    `>不可召回数量: ${cannotRecall.length}`,
    '',
    `>私信用户总数: ${totalUsers}`,
    '',
    `>全部召回命令:`,
    '',
    `><qqbot-cmd-input text="#QQBot全部召回设置数量 ${maxBatch}" show="设置全部召回(${maxBatch})"/>`,
    '',
    '```text',
    `当前可召回最大数量: ${maxBatch}`,
    '输入数量后需要确认才会执行',
    '```'
  ].join('\n')
}

function getRecallOverviewButtons (config, selfId = '') {
  const { canRecall } = inviteStore.getRecallableList(selfId)
  const maxBatch = canRecall.length
  return limitButtonRows([
    [
      { text: '可召回列表', callback: '#QQBot可召回列表' },
      { text: '不可召回列表', callback: '#QQBot不可召回列表' }
    ],
    [
      { text: `全部召回(${maxBatch})`, input: `#QQBot全部召回设置数量 ${maxBatch}` },
      { text: '返回', callback: '#QQBot召回菜单' }
    ]
  ])
}

function getRecallPeriodLabel (period) {
  const map = {
    0: '当天(自然日0天)',
    1: '1-3天',
    2: '4-7天',
    3: '8-30天'
  }
  return map[String(period)] || '-'
}

function getRecallListMsg (config, selfId = '', type = 'can', page = 1, pageSize = 20) {
  const { canRecall, cannotRecall } = inviteStore.getRecallableList(selfId)
  const list = type === 'can' ? canRecall : cannotRecall
  const typeName = type === 'can' ? '可召回' : '不可召回'
  const total = list.length
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  page = Math.max(1, Math.min(maxPage, Number(page) || 1))
  const start = (page - 1) * pageSize
  const pageList = list.slice(start, start + pageSize)
  const cmdPrefix = type === 'can' ? '#QQBot可召回列表' : '#QQBot不可召回列表'

  const lines = [
    `#[${selfId || '-'}] ${typeName}列表`,
    '',
    `>共 ${total} 个，第 ${page}/${maxPage} 页`,
    ''
  ]

  if (!pageList.length) {
    lines.push(`>暂无${typeName}用户`)
  } else {
    lines.push('```QbotRecallList')
    pageList.forEach((item, index) => {
      const idx = start + index + 1
      lines.push(`${idx}. ${item.openid}`)
      lines.push(`   最后活跃: ${item.lastActive || '-'}`)
      lines.push(`   周期: ${getRecallPeriodLabel(item.period)}`)
      if (item.reason) lines.push(`   原因: ${item.reason}`)
    })
    lines.push('```')
    if (type === 'can') {
      pageList.forEach((item) => {
        lines.push('', `><qqbot-cmd-input text="#QQBot单独召回 ${item.openid}" show="召回 ${item.openid.slice(0, 8)}..."/>`)
      })
    }
  }

  if (page > 1) lines.push('', `><qqbot-cmd-input text="${cmdPrefix} ${page - 1}" show="上一页"/>`)
  if (page < maxPage) lines.push('', `><qqbot-cmd-input text="${cmdPrefix} ${page + 1}" show="下一页"/>`)
  return lines.join('\n')
}

function getRecallListButtons (config, selfId = '', type = 'can', page = 1, pageSize = 20) {
  const { canRecall, cannotRecall } = inviteStore.getRecallableList(selfId)
  const list = type === 'can' ? canRecall : cannotRecall
  const total = list.length
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  page = Math.max(1, Math.min(maxPage, Number(page) || 1))
  const cmdPrefix = type === 'can' ? '#QQBot可召回列表' : '#QQBot不可召回列表'

  const rows = []
  const pageRow = []
  if (page > 1) pageRow.push({ text: '上一页', callback: `${cmdPrefix} ${page - 1}` })
  if (page < maxPage) pageRow.push({ text: '下一页', callback: `${cmdPrefix} ${page + 1}` })
  if (pageRow.length) rows.push(pageRow)
  rows.push([
    { text: '刷新', callback: `${cmdPrefix} ${page}` },
    { text: '返回', callback: '#QQBot召回菜单' }
  ])

  return limitButtonRows(rows)
}

async function initInviteStore (config) {
  const type = config?.inviteDB || 'json'
  await inviteStore.init(type)
}

async function switchInviteDB (config, configSave, type) {
  if (type !== 'json' && type !== 'level') return '存储方式仅支持 json 或 level'

  const oldType = config.inviteDB || 'json'
  if (oldType === type) return `存储方式已经是 ${type}`

  const oldData = inviteStore.getAllData()
  await inviteStore.close()

  config.inviteDB = type
  await inviteStore.init(type)

  const { inviteCount, c2cCount } = await inviteStore.migrateFrom(oldData)
  const migrateMsg = (inviteCount || c2cCount) ? `，已迁移 ${inviteCount} 条邀请记录 + ${c2cCount} 条私信用户` : ''

  await configSave()
  return `存储方式已切换为 ${type}${migrateMsg}`
}

export {
  ensureIcebreakerConfig,
  ensureRecallConfig,
  getIcebreakerMenuMsg,
  getIcebreakerMenuButtons,
  getRecallMenuMsg,
  getRecallMenuButtons,
  getRecallOverviewMsg,
  getRecallOverviewButtons,
  getRecallListMsg,
  getRecallListButtons,
  initInviteStore,
  switchInviteDB,
  limitButtonRows
}
