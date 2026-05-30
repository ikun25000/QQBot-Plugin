import fullMessageStore from './fullMessageStore.js'

const FULL_MESSAGE_OPTIONS = {
  '仅回复@机器人': {
    key: 'replyOnlyIsYou',
    label: '仅回复 @机器人',
    defaultValue: true
  },
  '处理非@消息': {
    key: 'handleMissingIsYou',
    label: '处理非 @消息',
    defaultValue: false
  },
  '忽略@全体的指令': {
    key: 'ignoreAllIsYou',
    label: '忽略 @全体 的指令',
    defaultValue: true
  },
  '全体通知': {
    key: 'notifyAllMention',
    label: '@全体通知',
    defaultValue: false
  },
  '忽略其他机器人': {
    key: 'ignoreBotAuthor',
    label: '忽略其他机器人',
    defaultValue: true
  },
  '@机器人严判': {
    key: 'strictBotMention',
    label: '@机器人严判',
    defaultValue: false
  },
  '记录群': {
    key: 'recordGroup',
    label: '记录全量消息开启时间和群openid',
    defaultValue: false
  }
}

const FULL_MESSAGE_EXTRA_DEFAULTS = {
  botLimitEnabled: true,
  botLimitCount: 5,
  botLimitMinutes: 1,
  ignoreBotAuthorAt: false
}

const FULL_MESSAGE_OPTION_ALIASES = {
  '仅回复isyou': '仅回复@机器人',
  '处理无isyou': '处理非@消息',
  '忽略全体isyou': '忽略@全体的指令',
  isyou严判: '@机器人严判'
}

function resolveFullMessageOptionName (name) {
  return FULL_MESSAGE_OPTIONS[name] ? name : FULL_MESSAGE_OPTION_ALIASES[name]
}

function escapeRegExp (text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getBotNamesFromEvent (event) {
  return [
    event?.bot?.nickname,
    event?.bot?._qqbotNickname,
    event?.raw?.bot?.nickname,
    event?.raw?.bot?._qqbotNickname
  ].filter(Boolean).map(String)
}

function getBotNicknameFromConfigOrStore (config, selfId = '') {
  const stored = fullMessageStore.getBotNickname(selfId)
  return stored || config?.fullMessage?.botNicknames?.[selfId] || ''
}

async function fetchBotNickname (bot, retry = 3, delayMs = 3000) {
  for (let i = 0; i < retry; i++) {
    try {
      const { data } = await bot.sdk.request.get('/users/@me')
      if (data?.username) {
        return {
          username: data.username,
          avatar: data.avatar || '',
          data
        }
      }
    } catch (err) {
      if (i < retry - 1) await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return null
}

function hasStrictBotNameMention (event, content) {
  const names = [...new Set(getBotNamesFromEvent(event))]
  if (!names.length || !content) return false

  return names.some(name => {
    const pattern = escapeRegExp(name)
    const atName = `(?:@${pattern}|\\[@${pattern}\\])`
    return new RegExp(`(?:^|\\s)${atName}(?=\\s|/|#|$)`, 'i').test(content) ||
      new RegExp(`(?:^|\\s)(?:/|#)\\S+\\s+${atName}(?=\\s|$)`, 'i').test(content)
  })
}

function limitButtonRows (rows) {
  return rows
    .filter(row => Array.isArray(row) && row.length)
    .slice(0, 5)
    .map(row => row.slice(0, 2))
}

function formatRecordTime (value) {
  if (!value) return '-'
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const num = Number(value)
    if (!Number.isFinite(num)) return String(value)
    return new Date(num < 10000000000 ? num * 1000 : num).toISOString()
  }
  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) return value
  return String(value)
}

function normalizeRecordTime (event) {
  const value = event._rawTimestamp || event.raw?._rawTimestamp || event.raw?.timestamp || event.timestamp || event.raw?.time || event.time || new Date().toISOString()
  return formatRecordTime(value)
}

function ensureFullMessageConfig (config, selfId = '') {
  if (!config.fullMessage || typeof config.fullMessage !== 'object') {
    config.fullMessage = {}
  }

  const legacyOptions = Object.values(FULL_MESSAGE_OPTIONS).map(option => option.key)
  const hasLegacy = legacyOptions.some(key => Object.prototype.hasOwnProperty.call(config.fullMessage, key))
  if (!config.fullMessage.bots || typeof config.fullMessage.bots !== 'object' || Array.isArray(config.fullMessage.bots)) {
    config.fullMessage.bots = {}
  }

  const key = selfId || 'default'
  if (!config.fullMessage.bots[key] || typeof config.fullMessage.bots[key] !== 'object') {
    config.fullMessage.bots[key] = {}
  }

  const fullMessage = config.fullMessage.bots[key]

  if (hasLegacy && selfId) {
    for (const optionKey of legacyOptions) {
      if (Object.prototype.hasOwnProperty.call(config.fullMessage, optionKey) && typeof fullMessage[optionKey] !== 'boolean') {
        fullMessage[optionKey] = config.fullMessage[optionKey]
      }
    }
    for (const optionKey of legacyOptions) delete config.fullMessage[optionKey]
  }

  for (const option of Object.values(FULL_MESSAGE_OPTIONS)) {
    if (typeof fullMessage[option.key] !== 'boolean') {
      fullMessage[option.key] = option.defaultValue
    }
  }

  if (typeof fullMessage.botLimitEnabled !== 'boolean') fullMessage.botLimitEnabled = FULL_MESSAGE_EXTRA_DEFAULTS.botLimitEnabled
  fullMessage.botLimitCount = Math.max(1, Number(fullMessage.botLimitCount) || FULL_MESSAGE_EXTRA_DEFAULTS.botLimitCount)
  fullMessage.botLimitMinutes = Math.max(1, Number(fullMessage.botLimitMinutes) || FULL_MESSAGE_EXTRA_DEFAULTS.botLimitMinutes)
  if (typeof fullMessage.ignoreBotAuthorAt !== 'boolean') fullMessage.ignoreBotAuthorAt = FULL_MESSAGE_EXTRA_DEFAULTS.ignoreBotAuthorAt

  if (fullMessage.handleMissingIsYou) {
    fullMessage.replyOnlyIsYou = false
  }

  return fullMessage
}

function migrateLegacyFullMessageOptions (config) {
  if (!config.fullMessage || typeof config.fullMessage !== 'object') return false
  const legacyOptions = Object.values(FULL_MESSAGE_OPTIONS).map(option => option.key)
  const legacy = {}
  for (const key of legacyOptions) {
    if (Object.prototype.hasOwnProperty.call(config.fullMessage, key)) legacy[key] = config.fullMessage[key]
  }
  if (!Object.keys(legacy).length) return false

  if (!config.fullMessage.bots || typeof config.fullMessage.bots !== 'object' || Array.isArray(config.fullMessage.bots)) config.fullMessage.bots = {}
  const selfIds = Array.isArray(config.token)
    ? config.token.map(token => String(token).split(':')[0]).filter(Boolean)
    : []
  const targets = selfIds.length ? selfIds : ['default']
  for (const selfId of targets) {
    if (!config.fullMessage.bots[selfId] || typeof config.fullMessage.bots[selfId] !== 'object') config.fullMessage.bots[selfId] = {}
    for (const [key, value] of Object.entries(legacy)) {
      if (typeof config.fullMessage.bots[selfId][key] !== 'boolean') config.fullMessage.bots[selfId][key] = value
    }
  }
  for (const key of Object.keys(legacy)) delete config.fullMessage[key]
  return true
}

function getFullMessageStatusMsg (config, selfId = '', receiveEnabled = true) {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  const total = fullMessageStore.getRecordCount(selfId)
  const title = selfId ? `#[${selfId}]全量消息设置菜单` : '#全量消息设置菜单'
  const lines = [title]

  for (const [name, option] of Object.entries(FULL_MESSAGE_OPTIONS)) {
    if (name === '忽略其他机器人') {
      lines.push('', '>配置限制: 机器人消息限制菜单')
      lines.push('', '><qqbot-cmd-input text="#QQBot全量消息设置 配置限制" show="打开配置限制"/>')
      continue
    }
    const enabled = fullMessage[option.key]
    lines.push('', `>${option.label}: ${enabled ? '开启' : '关闭'}`)
    lines.push('', `><qqbot-cmd-input text="#QQBot全量消息设置 ${name} ${enabled ? '关闭' : '开启'}" show="${enabled ? '关闭' : '开启'}${option.label}"/>`)
  }

  lines.push('', `>WebSocket全量解析: ${receiveEnabled ? '已接入' : '未接入'}`)
  lines.push('', `>已记录群数: ${total}`)
  lines.push('', `>存储方式: ${config.fullMessageDB || 'json'}`)
  lines.push('', `><qqbot-cmd-input text="#QQBot全量存储 json" show="切换JSON存储"/>`)
  lines.push('', `><qqbot-cmd-input text="#QQBot全量存储 level" show="切换LevelDB存储"/>`)
  lines.push('', `>记录开启时间: ${fullMessageStore.getStartTime(selfId) || '-'}`)
  lines.push('', '><qqbot-cmd-input text="#QQBot全量查看" show="查看全量记录"/>')
  lines.push('', '><qqbot-cmd-input text="#QQBot全量清空" show="清空全量记录"/>')
  lines.push('', '>可用命令: #QQBot全量消息设置 <仅回复@机器人|处理非@消息|忽略@全体的指令|全体通知|忽略其他机器人|@机器人严判|记录群> <开启|关闭>')
  lines.push('', '>限制菜单: #QQBot全量消息设置 配置限制')
  lines.push('', '>存储设置: #QQBot全量存储 <json|level>')
  return lines.join('\n')
}

function getFullMessageStatusButtons (config, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  const dbType = config.fullMessageDB || 'json'
  const getButton = (name, text) => {
    const option = FULL_MESSAGE_OPTIONS[name]
    const enabled = fullMessage[option.key]
    return {
      text: `${enabled ? '关' : '开'}${text}`,
      callback: `#QQBot全量消息设置 ${name} ${enabled ? '关闭' : '开启'}`
    }
  }

  return limitButtonRows([
    [getButton('仅回复@机器人', '仅回复'), getButton('处理非@消息', '处理非@')],
    [getButton('忽略@全体的指令', '忽略全体'), getButton('全体通知', '全体通知')],
    [{ text: '配置限制', callback: '#QQBot全量消息设置 配置限制' }, getButton('@机器人严判', '严判')],
    [getButton('记录群', '记录群'), { text: '查看记录', callback: '#QQBot全量查看' }],
    [
      dbType === 'level'
        ? { text: '切JSON存储', callback: '#QQBot全量存储 json' }
        : { text: '切LevelDB存储', callback: '#QQBot全量存储 level' },
      { text: '清空记录', callback: '#QQBot全量清空' }
    ]
  ])
}

function getFullMessageBotLimitMsg (config, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  const atDisabled = !fullMessage.ignoreBotAuthor
  return [
    `#[${selfId || '-'}] 配置限制菜单 `,
    '',
    `>配置bot限制: ${fullMessage.botLimitEnabled ? '开启' : '关闭'}`,
    '',
    `><qqbot-cmd-input text="#QQBot全量消息设置 配置bot限制 ${fullMessage.botLimitEnabled ? '关闭' : '开启'}" show="${fullMessage.botLimitEnabled ? '关闭' : '开启'}bot限制"/>`,
    '',
    `>bot限制设置: ${fullMessage.botLimitCount}条${fullMessage.botLimitMinutes}分钟`,
    '',
    `><qqbot-cmd-input text="#QQBot全量消息设置 bot限制设置 ${fullMessage.botLimitCount}条${fullMessage.botLimitMinutes}分钟" show="设置限流"/>`,
    '',
    `>忽略其他机器人总开关: ${fullMessage.ignoreBotAuthor ? '开启' : '关闭'}`,
    '',
    `><qqbot-cmd-input text="#QQBot全量消息设置 忽略其他机器人总开关 ${fullMessage.ignoreBotAuthor ? '关闭' : '开启'}" show="${fullMessage.ignoreBotAuthor ? '关闭' : '开启'}总开关"/>`,
    '',
    `>忽略其他机器人正常@: ${fullMessage.ignoreBotAuthorAt ? '开启' : '关闭'}${atDisabled ? '（总开关关闭时不可用）' : ''}`,
    '',
    `><qqbot-cmd-input text="#QQBot全量消息设置 忽略其他机器人正常@ ${fullMessage.ignoreBotAuthorAt ? '关闭' : '开启'}" show="${fullMessage.ignoreBotAuthorAt ? '关闭' : '开启'}正常@"/>`,
    '',
    '```text',
    'bot限制: 当其他机器人在群内发消息超过设定条数/时间窗口后',
    '后续消息将不再触发任何插件命令处理',
    '仅限制群消息(全量+普通@)，私聊/频道等不受影响',
    '',
    '总开关: 控制全量消息(GROUP_MESSAGE_CREATE)是否直接忽略机器人',
    '正常@: 控制普通@消息(GROUP_AT_MESSAGE_CREATE)是否忽略机器人',
    '正常@依赖总开关，总开关关闭时正常@不可用',
    '```'
  ].join('\n')
}

function getFullMessageBotLimitButtons (config, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  return limitButtonRows([
    [
      { text: `${fullMessage.botLimitEnabled ? '关' : '开'}限流`, callback: `#QQBot全量消息设置 配置bot限制 ${fullMessage.botLimitEnabled ? '关闭' : '开启'}` },
      { text: '设5/1', callback: '#QQBot全量消息设置 bot限制设置 5条1分钟' }
    ],
    [
      { text: `${fullMessage.ignoreBotAuthor ? '关' : '开'}总开关`, callback: `#QQBot全量消息设置 忽略其他机器人总开关 ${fullMessage.ignoreBotAuthor ? '关闭' : '开启'}` },
      { text: `${fullMessage.ignoreBotAuthorAt ? '关' : '开'}正常@`, callback: `#QQBot全量消息设置 忽略其他机器人正常@ ${fullMessage.ignoreBotAuthorAt ? '关闭' : '开启'}` }
    ],
    [
      { text: '返回', callback: '#QQBot全量消息设置' },
      { text: '设10/1', callback: '#QQBot全量消息设置 bot限制设置 10条1分钟' }
    ]
  ])
}

async function recordFullMessageGroup (config, data, event) {
  const fullMessage = ensureFullMessageConfig(config, data.self_id)
  if (!fullMessage.recordGroup) return false

  await fullMessageStore.ensureStartTime(data.self_id)

  const groupOpenid = event.group_openid || event.raw?.group_openid || event.group_id
  if (!groupOpenid) return false

  const key = `${data.self_id}:${groupOpenid}`
  const existing = fullMessageStore.getRecord(key)
  const eventTime = normalizeRecordTime(event)
  if (!existing) {
    await fullMessageStore.setRecord(key, {
      self_id: data.self_id,
      group_openid: groupOpenid,
      raw_group_id: event.group_id || '',
      first_time: eventTime,
      last_time: eventTime
    })
  } else {
    if (existing.last_time && Math.abs(new Date(eventTime) - new Date(existing.last_time)) < 60000) return false
    existing.last_time = eventTime
    await fullMessageStore.setRecord(key, existing)
  }
  return true
}

function getFullMessageMentionState (config, event, selfId = '') {
  const botSelfId = selfId || event.self_id || event.bot?.uin || event.bot?.config?.real_self_id || event.raw?.self_id || ''
  const fullMessage = ensureFullMessageConfig(config, botSelfId)
  const mentions = event._mentions || event.raw?._mentions || []
  const content = event._rawContent || event.raw?._rawContent || event.raw?.content || event.content || ''
  const isAllMention = mentions.some(item => item.scope === 'all') && content.includes('<@all>')
  const author = event.author || event.raw?.author || {}
  const ignoredBotAuthor = fullMessage.ignoreBotAuthor && author.bot === true
  const ignoredAllMention = isAllMention && fullMessage.ignoreAllIsYou
  const nickname = getBotNicknameFromConfigOrStore(config, botSelfId)
  const strictNameMention = fullMessage.strictBotMention && nickname ? hasStrictBotNameMention({ ...event, bot: { nickname } }, content) : false
  const isYou = strictNameMention || mentions.some(item => item.is_you === true || (fullMessage.handleMissingIsYou && typeof item.is_you === 'undefined' && item.bot === true))
  const shouldDispatch = !ignoredBotAuthor && !ignoredAllMention && (fullMessage.handleMissingIsYou || !fullMessage.replyOnlyIsYou || (isAllMention && fullMessage.notifyAllMention) || isYou)

  return {
    isAllMention,
    ignoredAllMention,
    ignoredBotAuthor,
    strictNickname: nickname || '',
    strictNameMention,
    isYou: isAllMention && fullMessage.ignoreAllIsYou ? false : isYou,
    shouldDispatch,
    shouldNotifyAll: isAllMention && fullMessage.notifyAllMention
  }
}

function getFullMessageAllNotifyMsg (data) {
  return [
    `[${data.self_id}] QQBot 全量消息 @全体通知`,
    `账号: ${data.self_id}`,
    `群: ${data.group_id}`,
    `群openid: ${data.group_openid || '-'}`,
    `用户: ${data.user_id}`,
    `内容: ${data.raw_message || '(空消息)'}`
  ].join('\n')
}

function getFullMessageRecordsMsg (config, page = 1, pageSize = 20, selfId = '') {
  const records = Object.values(fullMessageStore.getRecords())
    .filter(item => !selfId || item.self_id === selfId)
    .sort((a, b) => String(b.last_time || '').localeCompare(String(a.last_time || '')))
  const total = records.length
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  page = Math.max(1, Math.min(maxPage, Number(page) || 1))
  const start = (page - 1) * pageSize
  const list = records.slice(start, start + pageSize)
  const prefix = selfId ? `[${selfId}] ` : ''
  const lines = [`#${prefix.trimEnd()}`, '', `>全量消息记录: 共 ${total} 个,当前第 ${page}/${maxPage} 页\n`, '```QbotAllMsgNum']

  if (!list.length) {
    lines.push('暂无记录。开启“记录群”后收到 GROUP_MESSAGE_CREATE 才会记录。')
  } else {
    list.forEach((item, index) => {
      lines.push(`${start + index + 1}. ${item.group_openid}`)
      lines.push(`账号: ${item.self_id}`)
      lines.push(`原群ID: ${item.raw_group_id || '-'}`)
      lines.push(`首次: ${formatRecordTime(item.first_time)}`)
      lines.push(`最近: ${formatRecordTime(item.last_time)}`)
      if (index < list.length - 1) lines.push('')
    })
  }

  lines.push('```')
  if (page > 1) lines.push('', `><qqbot-cmd-input text="#QQBot全量查看 ${page - 1}" show="上一页"/>`)
  if (page < maxPage) lines.push('', `><qqbot-cmd-input text="#QQBot全量查看 ${page + 1}" show="下一页"/>`)
  lines.push('', '><qqbot-cmd-input text="#QQBot全量清空" show="清空记录"/>')
  return lines.join('\n')
}

function getFullMessageRecordsButtons (config, page = 1, pageSize = 20, selfId = '') {
  const total = fullMessageStore.getRecordCount(selfId)
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  page = Math.max(1, Math.min(maxPage, Number(page) || 1))
  const rows = []
  const pageRow = []

  if (page > 1) pageRow.push({ text: '上一页', callback: `#QQBot全量查看 ${page - 1}` })
  if (page < maxPage) pageRow.push({ text: '下一页', callback: `#QQBot全量查看 ${page + 1}` })
  if (pageRow.length) rows.push(pageRow)
  rows.push([
    { text: '刷新', callback: `#QQBot全量查看 ${page}` },
    { text: '清空记录', callback: '#QQBot全量清空' }
  ])

  return limitButtonRows(rows)
}

function getFullMessageClearConfirmMsg (config, selfId = '') {
  const total = fullMessageStore.getRecordCount(selfId)
  const prefix = selfId ? `[${selfId}] ` : ''
  return [
    `#${prefix.trimEnd()}清空全量消息记录`,
    '',
    `>将清空 QQBot 全量消息记录，共 ${total} 个。`,
    '',
    '><qqbot-cmd-input text="#QQBot全量清空确认" show="确认清空"/>',
    '',
    '><qqbot-cmd-input text="#QQBot全量查看" show="返回查看"/>'
  ].join('\n')
}

function getFullMessageClearConfirmButtons () {
  return limitButtonRows([
    [
      { text: '确认清空', callback: '#QQBot全量清空确认' },
      { text: '返回查看', callback: '#QQBot全量查看' }
    ]
  ])
}

async function clearFullMessageRecords (config, configSave, selfId = '') {
  const total = await fullMessageStore.clearRecords(selfId)
  await fullMessageStore.clearStartTime(selfId)
  return `#${selfId ? `[${selfId}]` : ''}清空完成\n\n>已清空 QQBot 全量消息记录，共 ${total} 个。`
}

async function setFullMessageOption (config, configSave, name, state, selfId = '') {
  name = resolveFullMessageOptionName(name)
  const option = FULL_MESSAGE_OPTIONS[name]
  if (!option) return false

  const fullMessage = ensureFullMessageConfig(config, selfId)
  if (option.key === 'handleMissingIsYou' && state) {
    fullMessage.replyOnlyIsYou = false
  }
  if (option.key === 'replyOnlyIsYou' && state && fullMessage.handleMissingIsYou) {
    fullMessage.handleMissingIsYou = false
  }
  if (option.key === 'recordGroup') {
    if (state) await fullMessageStore.ensureStartTime(selfId)
    else await fullMessageStore.clearStartTime(selfId)
  }
  if (option.key === 'ignoreBotAuthor' && !state) {
    fullMessage.ignoreBotAuthorAt = false
  }
  if (option.key === 'strictBotMention' && state) {
    const bot = Bot[selfId]
    if (!bot) return '机器人不存在'
    let nickname = getBotNicknameFromConfigOrStore(config, selfId)
    if (!nickname) {
      const result = await fetchBotNickname(bot, 3, 3000)
      if (!result?.username) return `获取 ${selfId} 机器人昵称失败，无法开启 @机器人严判`
      nickname = result.username
      await fullMessageStore.setBotNickname(selfId, nickname)
    }
    fullMessage[option.key] = state
    await configSave()
    return `\n${option.label}已开启\n\n>当前机器人名：${nickname}`
  }
  fullMessage[option.key] = state
  await configSave()

  if (option.key === 'strictBotMention') {
    const nickname = getBotNicknameFromConfigOrStore(config, selfId) || '未获取'
    return `\n${option.label}已关闭\n\n>当前机器人名：${nickname}`
  }

  return `${option.label}已${state ? '开启' : '关闭'}`
}

async function setFullMessageBotLimitEnabled (config, configSave, state, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  fullMessage.botLimitEnabled = state
  await configSave()
  return `配置bot限制已${state ? '开启' : '关闭'}`
}

async function setFullMessageBotLimitConfig (config, configSave, count, minutes, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  fullMessage.botLimitCount = Math.max(1, Number(count) || FULL_MESSAGE_EXTRA_DEFAULTS.botLimitCount)
  fullMessage.botLimitMinutes = Math.max(1, Number(minutes) || FULL_MESSAGE_EXTRA_DEFAULTS.botLimitMinutes)
  await configSave()
  return `bot限制设置已更新为 ${fullMessage.botLimitCount}条${fullMessage.botLimitMinutes}分钟`
}

async function setFullMessageIgnoreBotAt (config, configSave, state, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  if (!fullMessage.ignoreBotAuthor) return '忽略其他机器人总开关关闭时，正常@忽略不可用'
  fullMessage.ignoreBotAuthorAt = state
  await configSave()
  return `忽略其他机器人正常@已${state ? '开启' : '关闭'}`
}

async function setFullMessageIgnoreBotMaster (config, configSave, state, selfId = '') {
  const fullMessage = ensureFullMessageConfig(config, selfId)
  fullMessage.ignoreBotAuthor = state
  if (!state) fullMessage.ignoreBotAuthorAt = false
  await configSave()
  return `忽略其他机器人总开关已${state ? '开启' : '关闭'}`
}

async function initFullMessageStore (config) {
  const type = config.fullMessageDB || 'json'
  await fullMessageStore.init(type)
  let cleanedConfig = migrateLegacyFullMessageOptions(config)

  if (config.fullMessage?.records && typeof config.fullMessage.records === 'object' && !Array.isArray(config.fullMessage.records)) {
    const entries = Object.entries(config.fullMessage.records)
    if (entries.length) {
      const count = await fullMessageStore.migrateFromConfig(config.fullMessage.records)
      if (count > 0) {
        logger.info(`[QQBot-Plugin] 全量消息记录迁移：从配置迁移 ${count} 条记录到${type === 'level' ? 'LevelDB' : 'JSON'}存储`)
      }
      config.fullMessage.records = {}
      cleanedConfig = true
    }
  }

  if (await fullMessageStore.migrateMetaFromConfig(config.fullMessage || {})) {
    logger.info(`[QQBot-Plugin] 全量消息记录时间迁移：从配置迁移到${type === 'level' ? 'LevelDB' : 'JSON'}存储`)
  }
  if (config.fullMessage) {
    if (Object.prototype.hasOwnProperty.call(config.fullMessage, 'recordStartTime')) {
      delete config.fullMessage.recordStartTime
      cleanedConfig = true
    }
    if (Object.prototype.hasOwnProperty.call(config.fullMessage, 'recordStartTimes')) {
      delete config.fullMessage.recordStartTimes
      cleanedConfig = true
    }
    if (Object.prototype.hasOwnProperty.call(config.fullMessage, 'botNicknames')) {
      delete config.fullMessage.botNicknames
      cleanedConfig = true
    }
  }
  return cleanedConfig
}

async function switchFullMessageDB (config, configSave, type) {
  if (type !== 'json' && type !== 'level') return '存储方式仅支持 json 或 level'

  const oldType = config.fullMessageDB || 'json'
  if (oldType === type) return `存储方式已经是 ${type}`

  const oldRecords = { ...fullMessageStore.getRecords() }
  const oldMeta = fullMessageStore.getMeta()
  await fullMessageStore.close()

  config.fullMessageDB = type
  await fullMessageStore.init(type)

  if (Object.keys(oldRecords).length) {
    const count = await fullMessageStore.migrateFromConfig(oldRecords)
    logger.info(`[QQBot-Plugin] 全量消息存储切换：从 ${oldType} 迁移 ${count} 条记录到 ${type}`)
  }
  await fullMessageStore.migrateMetaFromConfig(oldMeta)

  await configSave()
  return `存储方式已切换为 ${type}${Object.keys(oldRecords).length ? `，已迁移 ${Object.keys(oldRecords).length} 条记录` : ''}`
}

export {
  FULL_MESSAGE_OPTIONS,
  ensureFullMessageConfig,
  clearFullMessageRecords,
  getFullMessageClearConfirmMsg,
  getFullMessageAllNotifyMsg,
  getFullMessageStatusMsg,
  getFullMessageStatusButtons,
  getFullMessageBotLimitMsg,
  getFullMessageBotLimitButtons,
  getBotNicknameFromConfigOrStore,
  getFullMessageRecordsMsg,
  getFullMessageRecordsButtons,
  getFullMessageClearConfirmButtons,
  getFullMessageMentionState,
  recordFullMessageGroup,
  setFullMessageOption,
  setFullMessageBotLimitEnabled,
  setFullMessageBotLimitConfig,
  setFullMessageIgnoreBotAt,
  setFullMessageIgnoreBotMaster,
  initFullMessageStore,
  switchFullMessageDB
}
