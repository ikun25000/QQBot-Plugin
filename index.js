import _ from 'lodash'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { join } from 'node:path'
import imageSize from 'image-size'
import { randomUUID } from 'node:crypto'
import { encode as encodeSilk } from 'silk-wasm'
import crypto from 'node:crypto'
import axios from 'axios'
import {
  Dau,
  importJS,
  Runtime,
  Handler,
  config,
  configSave,
  refConfig,
  clearFullMessageRecords,
  ensureFullMessageConfig,
  getFullMessageAllNotifyMsg,
  getFullMessageClearConfirmButtons,
  getFullMessageClearConfirmMsg,
  getFullMessageBotLimitButtons,
  getFullMessageBotLimitMsg,
  getFullMessageMentionState,
  getFullMessageRecordsButtons,
  getFullMessageRecordsMsg,
  getFullMessageStatusButtons,
  getFullMessageStatusMsg,
  getBotNicknameFromConfigOrStore,
  initFullMessageStore,
  recordFullMessageGroup,
  setFullMessageBotLimitConfig,
  setFullMessageBotLimitEnabled,
  setFullMessageIgnoreBotAt,
  setFullMessageIgnoreBotMaster,
  setFullMessageOption,
  splitMarkDownTemplate,
  getMustacheTemplating,
  switchFullMessageDB,
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
  inviteStore
} from './Model/index.js'
import { createRequire } from 'module'
import { Bot as QQBot } from 'qq-official-bot'
const require = createRequire(import.meta.url)

function stripAttachmentPlaceholders (text) {
  if (typeof text !== 'string' || !text.includes('<')) return text
  return text
    .replace(/\s*<attachmentType\s*=\s*"[^"]+"\s*,\s*attachmentIndex\s*=\s*\d+(?:\s*,\s*description\s*=\s*"[^"]*")?\s*>/ig, '')
    .replace(/\s*<(?:image|video|audio)(?:,[^>]*)?>/ig, '')
    .trim()
}

function escapeRegExp (text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripBotNameMentionText (text, botNames = []) {
  if (typeof text !== 'string' || !text) return text
  let result = text
  for (const name of [...new Set(botNames.filter(Boolean).map(String))]) {
    const atName = `(?:@${escapeRegExp(name)}|\\[@${escapeRegExp(name)}\\])`
    result = result
      .replace(new RegExp(`^\\s*${atName}\\s*(?=[/#])`, 'i'), '')
      .replace(new RegExp(`(?<=\\S)\\s+${atName}\\s*$`, 'i'), '')
      .replace(new RegExp(`^\\s*${atName}\\s+`, 'i'), '')
      .replace(new RegExp(`\\s+${atName}\\s*$`, 'i'), '')
  }
  return result.trim()
}

function stripSelfMentionTags (text, mentions = []) {
  if (typeof text !== 'string' || !text.includes('<@') || !Array.isArray(mentions)) return text
  const selfMentionIds = mentions
    .filter(mention => mention?.bot === true && mention?.is_you === true && mention?.id)
    .map(mention => escapeRegExp(mention.id))
  if (!selfMentionIds.length) return text

  const mentionTag = '<@[^>]+>'
  const mentionBlock = `${mentionTag}(?: {1,2}${mentionTag})*`
  const hasSelfMention = block => selfMentionIds.some(id => new RegExp(`<@${id}>`).test(block))

  return text
    .replace(new RegExp(`^(${mentionBlock})( {1,2})(?=\\S)`), (match, block) => hasSelfMention(block) ? '' : match)
    .replace(new RegExp(`(?<=\\S)( {1,2})(${mentionBlock})$`), (match, space, block) => hasSelfMention(block) ? '' : match)
    .trim()
}

function normalizeIncomingCommandText (text, botNames = []) {
  return stripBotNameMentionText(stripAttachmentPlaceholders(text), botNames)
}

const PER_BOT_CONFIG_KEYS = [
  'toQRCode',
  'toCallback',
  'toBotUpload',
  'forceSilk',
  'toQQUin',
  'toImg',
  'callStats',
  'userStats',
  'offlineDetect'
]

function ensureBotConfig (selfId = '') {
  if (!config.bots || typeof config.bots !== 'object' || Array.isArray(config.bots)) config.bots = {}
  const key = selfId || 'default'
  if (!config.bots[key] || typeof config.bots[key] !== 'object') config.bots[key] = {}
  const botConfig = config.bots[key]

  for (const cfgKey of PER_BOT_CONFIG_KEYS) {
    if (typeof botConfig[cfgKey] === 'undefined' && typeof config[cfgKey] !== 'undefined') {
      if (cfgKey === 'offlineDetect') botConfig[cfgKey] = { ...(config[cfgKey] || {}) }
      else botConfig[cfgKey] = config[cfgKey]
    }
  }
  if (!botConfig.offlineDetect || typeof botConfig.offlineDetect !== 'object') botConfig.offlineDetect = { ...(config.offlineDetect || {}) }
  return botConfig
}

function getBotConfigValue (selfId, key) {
  const botConfig = ensureBotConfig(selfId)
  return typeof botConfig[key] === 'undefined' ? config[key] : botConfig[key]
}

function setBotConfigValue (selfId, key, value) {
  const botConfig = ensureBotConfig(selfId)
  botConfig[key] = value
}

function getOfflineDetectConfig (selfId = '') {
  return ensureBotConfig(selfId).offlineDetect || {}
}

function getQRCodeRegExp (selfId = '') {
  const toQRCode = getBotConfigValue(selfId, 'toQRCode')
  if (toQRCode === false) return false
  if (typeof toQRCode === 'string') return new RegExp(toQRCode, 'g')
  return /(?<!\[(.*?)\]\()https?:\/\/[-\w_]+(\.[-\w_]+)+([-\w.,@?^=%&:/~+#]*[-\w@?^=%&/~+#])?/g
}

const botAuthorLimitBuckets = new Map()

function isGroupBotAuthorEvent (event) {
  return event?.message_type === 'group' && (event?.author?.bot === true || event?.raw?.author?.bot === true)
}

function isQQBotGroupMessageCreate (event) {
  return event?._qqbotFullMessageCreate === true || event?.raw?._qqbotFullMessageCreate === true
}

function isQQBotGroupAtMessageCreate (event) {
  return event?.message_type === 'group' && !isQQBotGroupMessageCreate(event)
}

function shouldLimitBotAuthorMessage (config, event, selfId = '') {
  if (!isGroupBotAuthorEvent(event)) return false
  if (!isQQBotGroupMessageCreate(event) && !isQQBotGroupAtMessageCreate(event)) return false

  const fullMessage = ensureFullMessageConfig(config, selfId)
  if (!fullMessage.botLimitEnabled) return false

  const count = Math.max(1, Number(fullMessage.botLimitCount) || 5)
  const windowMs = Math.max(1, Number(fullMessage.botLimitMinutes) || 1) * 60 * 1000
  const groupId = event.group_openid || event.raw?.group_openid || event.group_id || event.raw?.group_id || ''
  const userId = event.author?.id || event.raw?.author?.id || event.sender?.user_id || event.raw?.sender?.user_id || ''
  const key = `${selfId}:${groupId}:${userId}`
  const now = Date.now()
  const bucket = (botAuthorLimitBuckets.get(key) || []).filter(time => now - time < windowMs)

  if (bucket.length >= count) {
    botAuthorLimitBuckets.set(key, bucket)
    return true
  }

  bucket.push(now)
  botAuthorLimitBuckets.set(key, bucket)
  return false
}

function getQQBotAuthError (data) {
  const code = Number(data?.code || data?.err_code)
  const message = String(data?.message || data?.msg || data || '')
  if (code === 100016) return 'secret输入错误'
  if (code === 10004) return 'appid输入错误'
  if (code === 100007) return '机器人被封禁/不存在'
  if (message.includes('code(100016)')) return 'secret输入错误'
  if (message.includes('code(10004)')) return 'appid输入错误'
  if (message.includes('code(100007)')) return '机器人被封禁/不存在'
  return ''
}

function isQQBotReadOnlyError (data) {
  const message = String(data?.message || data?.msg || data || '')
  return Number(data?.code || data?.err_code) === 11300 || message.includes('code(11300)') || message.includes('link type check failed')
}

function isQQBotCanceledError (data) {
  const message = String(data?.message || data?.msg || data || '')
  return Number(data?.code || data?.err_code) === 11700 || message.includes('code(11700)') || message.includes('robot has canceled')
}

function isQQBotNoOfficialWsError (data) {
  const message = String(data?.message || data?.msg || data || '')
  return message.includes('4925')
}

function getQQBotFatalWsErrorText (data) {
  const message = String(data?.message || data?.msg || data || '')
  if (message.includes('4925')) return '官方 websocket 不可用，请解绑元器'
  if (message.includes('4903')) return '机器人停止服务(被回收)，请重新提审'
  return ''
}

function clearRuntimeTimers (target, seen = new Set()) {
  if (!target || typeof target !== 'object' || seen.has(target)) return
  seen.add(target)
  for (const [key, value] of Object.entries(target)) {
    if (/timer|timeout|interval|heartbeat|reconnect/i.test(key)) {
      if (value) {
        try { clearTimeout(value) } catch {}
        try { clearInterval(value) } catch {}
      }
      try { target[key] = null } catch {}
    }
  }
}

function migrateLegacyBotConfig () {
  const legacy = {}
  for (const key of PER_BOT_CONFIG_KEYS) {
    if (typeof config[key] !== 'undefined') legacy[key] = config[key]
  }
  if (!Object.keys(legacy).length) return false
  if (!config.bots || typeof config.bots !== 'object' || Array.isArray(config.bots)) config.bots = {}
  const selfIds = Array.isArray(config.token)
    ? config.token.map(token => String(token).split(':')[0]).filter(Boolean)
    : []
  const targets = selfIds.length ? selfIds : ['default']
  for (const selfId of targets) {
    if (!config.bots[selfId] || typeof config.bots[selfId] !== 'object') config.bots[selfId] = {}
    for (const [key, value] of Object.entries(legacy)) {
      if (typeof config.bots[selfId][key] === 'undefined') {
        config.bots[selfId][key] = key === 'offlineDetect' ? { ...(value || {}) } : value
      }
    }
  }
  for (const key of Object.keys(legacy)) delete config[key]
  return true
}

function patchGroupMessageCreateEvent () {
  try {
    const eventModule = require('qq-official-bot/lib/event/index.js')
    const messageModule = require('qq-official-bot/lib/event/message.js')
    const noticeModule = require('qq-official-bot/lib/event/notice.js')
    const qqBotModule = require('qq-official-bot/lib/qqBot.js')
    const QQBotClass = qqBotModule.QQBot

    if (!QQBotClass.prototype._qqbotFullMessageDispatchPatched) {
      const originalDispatchEvent = QQBotClass.prototype.dispatchEvent
      QQBotClass.prototype.dispatchEvent = function (event, wsRes) {
        if (wsRes?.d && typeof event === 'string') wsRes.d._qqbotRawEvent = event
        return originalDispatchEvent.call(this, event, wsRes)
      }
      QQBotClass.prototype._qqbotFullMessageDispatchPatched = true
    }

    if (!messageModule.MessageEvent.parse._qqbotFullMessageParsePatched) {
      const originalParse = messageModule.MessageEvent.parse.bind(messageModule.MessageEvent)
      const GroupMessageEvent = messageModule.GroupMessageEvent
      const parseGroupMessageFallback = function (payload, isFullGroupMessage = false) {
        if (typeof payload?.content === 'string') payload.content = stripSelfMentionTags(payload.content, payload.mentions)
        if (typeof payload?.content === 'string') {
          payload._rawContent = payload.content
          payload.content = normalizeIncomingCommandText(payload.content, [this.nickname, this._qqbotNickname])
        }
        if (payload?.timestamp) payload._rawTimestamp = payload.timestamp
        if (Array.isArray(payload?.mentions)) payload._mentions = payload.mentions.map(item => ({ ...item }))
        if (isFullGroupMessage) payload._qqbotFullMessageCreate = true

        let text = normalizeIncomingCommandText((payload.content || '').trim(), [this.nickname, this._qqbotNickname])
        if (isFullGroupMessage) {
          text = text.replace(/<@all>\s*/ig, '').trim()
          text = text.replace(/^\/\s*/, '#')
        }
        payload.message = text ? [{ type: 'text', text }] : []
        payload.user_id = payload.author?.id
        payload.message_id = payload.id
        payload.raw_message = text
        payload.sender = {
          user_id: payload.author?.id,
          nickname: payload.author?.username,
          card: payload.author?.username,
          user_name: payload.author?.username,
          permissions: ['normal'],
          user_openid: payload.author?.user_openid || payload.author?.member_openid
        }
        payload.time = new Date(payload.timestamp).getTime() / 1000
        payload.timestamp = payload.time
        payload.font = 0
        payload.seq = payload.seq || payload.s || payload.message_id
        return new GroupMessageEvent(this, payload)
      }
      const patchedParse = function (event, payload) {
        const isFullGroupMessage = payload?._qqbotRawEvent === 'GROUP_MESSAGE_CREATE'
        if (isFullGroupMessage) return parseGroupMessageFallback.call(this, payload, true)
        if (typeof payload?.content === 'string') payload.content = stripSelfMentionTags(payload.content, payload.mentions)
        if (typeof payload?.content === 'string') {
          payload._rawContent = payload.content
          payload.content = normalizeIncomingCommandText(payload.content, [this.nickname, this._qqbotNickname])
        }
        if (payload?.timestamp) payload._rawTimestamp = payload.timestamp
        if (Array.isArray(payload?.mentions)) {
          payload._mentions = payload.mentions.map(item => ({ ...item }))
        }
        try {
          return originalParse(event, payload)
        } catch (err) {
          if (payload?._qqbotRawEvent === 'GROUP_AT_MESSAGE_CREATE') {
            return parseGroupMessageFallback.call(this, payload, false)
          }
          throw err
        }
      }
      patchedParse._qqbotFullMessageParsePatched = true
      messageModule.MessageEvent.parse = patchedParse
    }
    if (!noticeModule.ActionNoticeEvent.parse._qqbotClawConfigParsePatched) {
      const originalActionParse = noticeModule.ActionNoticeEvent.parse.bind(noticeModule.ActionNoticeEvent)
      noticeModule.ActionNoticeEvent.parse = function (event, payload) {
        const type = Number(payload?.data?.type)
        if (type === 2001 || type === 2002) {
          const noticeType = payload.scene === 'group' ? 'group' : payload.scene === 'c2c' ? 'friend' : 'guild'
          const notice = {
            bot: this,
            replied: false,
            sub_type: 'action',
            event_id: payload.event_id,
            notice_id: payload.id,
            data: payload.data,
            notice_type: noticeType,
            group_id: payload.group_openid,
            guild_id: payload.guild_id,
            channel_id: payload.channel_id,
            operator_id: payload.group_member_openid || payload.user_openid || payload.data?.resolved?.user_id,
            raw: payload,
            async reply (code = 0) {
              if (this.replied) return true
              this.replied = true
              return this.bot.replyAction(this.notice_id, code)
            }
          }
          const groupText = payload.group_openid ? `在群${payload.group_openid}` : ''
          this.logger.info(`开发者${groupText}${type === 2001 ? '查询' : '设置'}了龙虾状态`)
          return notice
        }
        try {
          return originalActionParse.call(this, event, payload)
        } catch (err) {
          if (payload?.data?.type === 11) {
            const noticeType = payload.scene === 'group' ? 'group' : payload.scene === 'c2c' ? 'friend' : 'guild'
            return {
              bot: this,
              replied: false,
              sub_type: 'action',
              event_id: payload.event_id,
              notice_id: payload.id,
              data: payload.data,
              notice_type: noticeType,
              group_id: payload.group_openid,
              guild_id: payload.guild_id,
              channel_id: payload.channel_id,
              operator_id: payload.group_member_openid || payload.user_openid || payload.data?.resolved?.user_id,
              raw: payload,
              async reply (code = 0) {
                if (this.replied) return true
                this.replied = true
                return this.bot.replyAction(this.notice_id, code)
              }
            }
          }
          throw err
        }
      }
      noticeModule.ActionNoticeEvent.parse._qqbotClawConfigParsePatched = true
      eventModule.EventParserMap.set(eventModule.QQEvent.INTERACTION_CREATE, noticeModule.ActionNoticeEvent.parse)
    }

    // ===== 补丁: GroupChangeNoticeEvent / FriendChangeNoticeEvent 保留 event_id =====
    if (!noticeModule.GroupChangeNoticeEvent._qqbotEventIdPatched) {
      const OrigGroupChange = noticeModule.GroupChangeNoticeEvent
      const origGroupParse = OrigGroupChange.parse
      OrigGroupChange.parse = function (event, payload) {
        const result = origGroupParse.call(this, event, payload)
        if (result && payload?.event_id) result.event_id = payload.event_id
        if (result && payload?.timestamp) result._rawTimestamp = payload.timestamp
        return result
      }
      OrigGroupChange._qqbotEventIdPatched = true
      eventModule.EventParserMap.set(eventModule.QQEvent.GROUP_ADD_ROBOT, OrigGroupChange.parse)
      eventModule.EventParserMap.set(eventModule.QQEvent.GROUP_DEL_ROBOT, OrigGroupChange.parse)
    }
    if (!noticeModule.FriendChangeNoticeEvent._qqbotEventIdPatched) {
      const OrigFriendChange = noticeModule.FriendChangeNoticeEvent
      const origFriendParse = OrigFriendChange.parse
      OrigFriendChange.parse = function (event, payload) {
        const result = origFriendParse.call(this, event, payload)
        if (result && payload?.event_id) result.event_id = payload.event_id
        if (result && payload?.timestamp) result._rawTimestamp = payload.timestamp
        return result
      }
      OrigFriendChange._qqbotEventIdPatched = true
      eventModule.EventParserMap.set(eventModule.QQEvent.FRIEND_ADD, OrigFriendChange.parse)
      eventModule.EventParserMap.set(eventModule.QQEvent.FRIEND_DEL, OrigFriendChange.parse)
    }

    eventModule.QQEvent.GROUP_MESSAGE_CREATE = 'message.group'
    eventModule.EventParserMap.set(eventModule.QQEvent.GROUP_MESSAGE_CREATE, messageModule.MessageEvent.parse)
  } catch (err) {
    Bot.makeLog?.('debug', ['GROUP_MESSAGE_CREATE 事件补丁加载失败', err.message], 'QQBot-Plugin')
  }
}

patchGroupMessageCreateEvent()

const startTime = new Date()
logger.info(logger.yellow('- 正在加载 QQBot 适配器插件'))

const userIdCache = {}
const markdown_template = await importJS('Model/template/markdownTemplate.js', 'default')
const TmplPkg = await importJS('templates/index.js')

// ========== 账号掉线检测状态管理 ==========
const offlineCheckState = {
  timers: {},       // 每个bot的检测定时器 id => intervalId
  retrying: {},     // 正在重连中 id => true
  waitingReset: {}  // 正在等待reset_after id => timeoutId
}

const CLAW_DEFAULT_CFG = {
  channel_type: 'qqbot',
  channel_ver: '1.7.1',
  claw_type: 'openclaw',
  claw_ver: '2026.3.24',
  require_mention: 'mention',
  group_policy: 'open',
  mention_patterns: '机器人, 助手',
  online_state: 'offline'
}

function ensureClawConfig (selfId = '') {
  if (!config.claw || typeof config.claw !== 'object') config.claw = {}

  const legacyKeys = ['online', 'code', 'json', 'groups']
  const hasLegacy = legacyKeys.some(key => Object.prototype.hasOwnProperty.call(config.claw, key))
  if (!config.claw.bots || typeof config.claw.bots !== 'object' || Array.isArray(config.claw.bots)) config.claw.bots = {}
  if (hasLegacy && selfId) {
    if (!config.claw.bots[selfId] || typeof config.claw.bots[selfId] !== 'object') config.claw.bots[selfId] = {}
    const target = config.claw.bots[selfId]
    if (typeof target.online !== 'boolean' && typeof config.claw.online === 'boolean') target.online = config.claw.online
    if (typeof target.code === 'undefined' && typeof config.claw.code !== 'undefined') target.code = config.claw.code
    if (!target.json && config.claw.json && typeof config.claw.json === 'object') target.json = config.claw.json
    for (const key of legacyKeys) delete config.claw[key]
    configSave()
  }

  const key = selfId || 'default'
  if (!config.claw.bots[key] || typeof config.claw.bots[key] !== 'object') config.claw.bots[key] = {}
  const claw = config.claw.bots[key]
  if (typeof claw.online !== 'boolean') claw.online = false
  if (typeof claw.code !== 'string') claw.code = String(claw.code ?? '0')
  if (!claw.json || typeof claw.json !== 'object' || Array.isArray(claw.json)) claw.json = {}
  if (Object.prototype.hasOwnProperty.call(claw, 'groups')) {
    delete claw.groups
    configSave()
  }
  return claw
}

function getClawCfg (selfId = '') {
  const claw = ensureClawConfig(selfId)
  return {
    ...CLAW_DEFAULT_CFG,
    ...claw.json,
    online_state: claw.online ? 'online' : 'offline'
  }
}

// ========== 扩展 segment.file 支持 force_chunk 和 recall_time 参数 ==========
const originalSegmentFile = segment.file.bind(segment)
segment.file = function (file, name, forceChunk, recallTime) {
  let result
  if (typeof file === 'object' && file !== null && !Buffer.isBuffer(file)) {
    result = originalSegmentFile(file)
    if (typeof file.force_chunk !== 'undefined') {
      result.force_chunk = file.force_chunk
    }
    if (typeof file.recall_time !== 'undefined') {
      result.recall_time = file.recall_time
    }
  } else {
    result = originalSegmentFile(file, name)
    if (typeof forceChunk !== 'undefined') {
      result.force_chunk = forceChunk
    }
    if (typeof recallTime !== 'undefined') {
      result.recall_time = recallTime
    }
  }
  return result
}
// ========== 扩展结束 ==========

// ========== segment.callfl - 外部插件调用单独召回 ==========
segment.callfl = function (openid, force, md, button) {
  if (!openid) throw new Error('segment.callfl: openid 必须填写')
  // segment.callfl(openid) / segment.callfl(openid, 0) / segment.callfl(openid, 1, md, button)
  const forceVal = force === 1 || force === true
  return { type: '_callfl', openid, force: forceVal, md: md || '', button: button || null }
}
// ========== segment.callfl 结束 ==========

const adapter = new class QQBotAdapter {
  constructor () {
    this.id = 'QQBot'
    this.name = 'QQBot'
    this.path = 'data/QQBot/'
    this.version = 'qq-group-bot v11.45.14'

    const defaultToQRCode = typeof config.toQRCode === 'undefined' ? true : config.toQRCode
    if (typeof defaultToQRCode == 'boolean') {
      this.toQRCodeRegExp = defaultToQRCode ? /(?<!\[(.*?)\]\()https?:\/\/[-\w_]+(\.[-\w_]+)+([-\w.,@?^=%&:/~+#]*[-\w@?^=%&/~+#])?/g : false
    } else {
      this.toQRCodeRegExp = new RegExp(defaultToQRCode, 'g')
    }

    this.sep = config.sep || ((process.platform == 'win32') && '') || ':'
  }

  normalizeSdkMessage (segments) {
    if (!Array.isArray(segments)) return []
    const botNames = [getBotNicknameFromConfigOrStore(config, this.sdk?.config?.real_self_id || this.sdk?.self_id), this.sdk?.nickname, this.sdk?._qqbotNickname]
    return segments.map(seg => {
      if (seg == null || typeof seg !== 'object') return seg
      const inner = seg.data
      if (inner != null && typeof inner === 'object' && !Array.isArray(inner)) {
        const { data: _, ...rest } = seg
        const normalized = { ...rest, ...inner }
        if (normalized.type === 'text') normalized.text = normalizeIncomingCommandText(normalized.text, botNames)
        return normalized
      }
      const normalized = { ...seg }
      if (normalized.type === 'text') normalized.text = normalizeIncomingCommandText(normalized.text, botNames)
      return normalized
    })
      .filter(seg => !(seg?.type === 'text' && !seg.text))
  }

  async makeRecord (file, selfId = '', forceSilk = false) {
    if (getBotConfigValue('', 'toBotUpload')) {
      for (const i of Bot.uin) {
        if (!Bot[i].uploadRecord) continue
        try {
          const url = await Bot[i].uploadRecord(file)
          if (url) return url
        } catch (err) {
          Bot.makeLog('error', ['Bot', i, '语音上传错误', file, err])
        }
      }
    }

    if (!forceSilk && !getBotConfigValue(selfId, 'forceSilk')) {
      const ext = typeof file === 'string' ? file.split('?')[0].split('.').pop()?.toLowerCase() : ''
      if (['silk', 'wav', 'mp3', 'flac'].includes(ext)) return file
    }

    const inputFile = join('temp', randomUUID())
    const pcmFile = join('temp', randomUUID())

    try {
      fs.writeFileSync(inputFile, await Bot.Buffer(file))
      await Bot.exec(`ffmpeg -i "${inputFile}" -f s16le -ar 48000 -ac 1 "${pcmFile}"`)
      file = Buffer.from((await encodeSilk(fs.readFileSync(pcmFile), 48000)).data)
    } catch (err) {
      logger.error(`silk 转码错误：${err}`)
    }

    for (const i of [inputFile, pcmFile]) {
      try {
        fs.unlinkSync(i)
      } catch (err) { }
    }
    return file
  }

  async makeRecordFileInfo (data, file, name = '') {
    const recordFile = await this.makeRecord(file, data.self_id)
    const ext = this.getFileExt(file, name) || 'silk'
    const fileName = name || (typeof file === 'string' ? this.extractFileNameFromUrl(file) : this.getDefaultAudioFileName(ext))
    return {
      type: 'audio',
      file_type: 3,
      file: recordFile,
      raw_file: file,
      raw_name: name || fileName,
      name: fileName
    }
  }

  async makeQRCode (data) {
    return (await QRCode.toDataURL(data)).replace('data:image/png;base64,', 'base64://')
  }

  async uploadImage (file, selfId = '', opts = {}) {
    const buffer = await Bot.Buffer(file)
    const image = { url: await Bot.fileToUrl(file) }

    try {
      const size = imageSize(buffer)
      image.width = size.width
      image.height = size.height
    } catch (err) {
      Bot.makeLog('error', ['图片分辨率检测错误', file, err], selfId)
    }

    if (!opts.skipHandler && Handler.has('QQBot.makeMarkdownImage')) {
      const res = await Handler.call(
        'QQBot.makeMarkdownImage',
        { self_id: selfId, bot: Bot[selfId] },
        {
          image,
          buffer,
          file,
          summary: opts.summary || '图片',
          config
        }
      )
      if (res) typeof res == 'object' ? Object.assign(image, res) : image.url = res
    }

    return image
  }

  async makeRawMarkdownText (data, text, button) {
    const toQRCodeRegExp = getQRCodeRegExp(data.self_id)
    const match = toQRCodeRegExp && text.match(toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        const img = await this.makeMarkdownImage(data, await this.makeQRCode(url), '二维码')
        text = text.replace(url, `${img.des}${img.url}`)
      }
    }
    return text
  }

  async makeBotImage (file, selfId = '') {
    if (getBotConfigValue(selfId, 'toBotUpload')) {
      for (const i of Bot.uin) {
        if (!Bot[i].uploadImage) continue
        if (Bot[i].adapter?.name !== 'QQBot') continue
        try {
          const image = await Bot[i].uploadImage(file, { skipHandler: true })
          if (image.url) return image
        } catch (err) {
          Bot.makeLog('error', ['Bot', i, '图片上传错误', file, err])
        }
      }
    }
  }

  async makeMarkdownImage (data, file, summary = '图片') {
    const buffer = await Bot.Buffer(file)
    const image = await this.makeBotImage(buffer, data.self_id) || { url: await Bot.fileToUrl(file) }

    if (!image.width || !image.height) {
      try {
        const size = imageSize(buffer)
        image.width = size.width
        image.height = size.height
      } catch (err) {
        Bot.makeLog('error', ['图片分辨率检测错误', file, err], data.self_id)
      }
    }

    image.width = Math.floor(image.width * config.markdownImgScale)
    image.height = Math.floor(image.height * config.markdownImgScale)
    if (Handler.has('QQBot.makeMarkdownImage')) {
      const res = await Handler.call(
        'QQBot.makeMarkdownImage',
        data,
        {
          image,
          buffer,
          file,
          summary,
          config
        }
      )
      if (res) {
        typeof res == 'object' ? Object.assign(image, res) : image.url = res
      }
    }
    return {
      des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
      url: `(${image.url})`
    }
  }

  /**
   * 撤回消息（群聊或私聊）
   * @param {Object} data - 消息数据
   * @param {string} message_id - 消息ID
   * @param {string} target_type - 'group' 或 'user'
   * @param {string} target_id - 群openid 或 用户openid
   */
  async recallMessageById (data, message_id, target_type, target_id) {
    try {
      const url = `/v2/${target_type}s/${target_id}/messages/${message_id}`
      Bot.makeLog('debug', ['撤回消息', { url, target_type, target_id, message_id }], data.self_id)
      await data.bot.sdk.request.delete(url)
      Bot.makeLog('info', [`撤回${target_type === 'group' ? '群' : '私聊'}文件消息成功`, { target_id, message_id }], data.self_id)
    } catch (err) {
      Bot.makeLog('error', ['撤回消息失败', { target_type, target_id, message_id }, err.message, err.response?.data], data.self_id)
    }
  }

  /**
   * 上传文件到QQ官方API
   */
  async uploadFileToQQ (data, target_id, target_type, file_data, file_name, force_chunk = false, file_type = 4) {
    if (typeof file_data === 'string' && file_data.startsWith('http') && !force_chunk) {
      let fileSizeMB = 0
      try {
        const headResponse = await fetch(file_data, { method: 'HEAD' })
        const contentLength = headResponse.headers.get('content-length')
        fileSizeMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0
        Bot.makeLog('info', [`网络文件大小: ${fileSizeMB.toFixed(2)} MB`], data.self_id)
      } catch (err) {
        Bot.makeLog('debug', ['无法获取文件大小，尝试直传', err.message], data.self_id)
      }

      Bot.makeLog('info', ['检测到网络 URL，使用直传（不下载文件）', { url: file_data.substring(0, 100), file_name }], data.self_id)

      try {
        const filesUrl = `/v2/${target_type}s/${target_id}/files`
        const filesData = {
          file_type,
          srv_send_msg: false,
          url: file_data,
          file_name: file_name || this.extractFileNameFromUrl(file_data)
        }

        Bot.makeLog('debug', ['URL 直传', filesUrl, filesData], data.self_id)

        const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)

        Bot.makeLog('info', ['URL 直传成功，无需下载文件', result], data.self_id)

        return result
      } catch (error) {
        Bot.makeLog('warn', ['URL 直传失败', error.message, error.response?.data], data.self_id)

        if (file_type === 3 && fileSizeMB > 10) {
          throw error
        }

        if (fileSizeMB > 10) {
          Bot.makeLog('info', [`文件大于 10MB (${fileSizeMB.toFixed(2)} MB)，降级为分片上传`], data.self_id)
          force_chunk = true
        } else {
          Bot.makeLog('info', [`文件较小 (${fileSizeMB.toFixed(2)} MB)，降级为 base64 上传`], data.self_id)
        }
      }
    }

    const getFileBuffer = async (file_data) => {
      if (file_data instanceof Uint8Array) {
        return Buffer.from(file_data)
      } else if (Buffer.isBuffer(file_data)) {
        return file_data
      } else if (typeof file_data === 'string') {
        if (file_data.startsWith('http')) {
          Bot.makeLog('info', ['开始下载网络文件...'], data.self_id)
          const response = await fetch(file_data)
          const buffer = Buffer.from(await response.arrayBuffer())
          Bot.makeLog('info', [`下载完成，大小: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`], data.self_id)
          return buffer
        } else if (file_data.startsWith('base64://')) {
          return Buffer.from(file_data.replace('base64://', ''), 'base64')
        } else if (file_data.startsWith('file://')) {
          return fs.readFileSync(file_data.replace('file://', ''))
        } else {
          try {
            return fs.readFileSync(file_data)
          } catch {
            return Buffer.from(file_data)
          }
        }
      } else {
        throw new Error('不支持的文件数据类型')
      }
    }

    const extractFileName = (file_data, fileBuffer) => {
      let name = ''
      let ext = ''

      if (typeof file_data === 'string') {
        if (file_data.startsWith('http')) {
          try {
            const url = new URL(file_data)
            const pathname = url.pathname
            const segments = pathname.split('/')
            const lastSegment = segments[segments.length - 1]
            const fileNameWithoutParams = lastSegment.split('?')[0]
            if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
              name = decodeURIComponent(fileNameWithoutParams)
              ext = name.substring(name.lastIndexOf('.'))
            }
          } catch {}
        } else if (file_data.startsWith('file://')) {
          const path = file_data.replace('file://', '')
          name = path.split('/').pop() || path.split('\\').pop()
          if (name && name.includes('.')) {
            ext = name.substring(name.lastIndexOf('.'))
          }
        } else {
          name = file_data.split('/').pop() || file_data.split('\\').pop()
          if (name && name.includes('.')) {
            ext = name.substring(name.lastIndexOf('.'))
          }
        }
      }

      if (!ext && fileBuffer) {
        const header = fileBuffer.toString('hex', 0, 16).toUpperCase()
        const fileTypeMap = {
          '89504E47': '.png',
          '47494638': '.gif',
          'FFD8FF': '.jpg',
          '25504446': '.pdf',
          '494433': '.mp3',
          '52494646': '.wav',
          '00000018': '.mp4',
          '00000020': '.mp4',
          'D0CF11E0': '.doc',
          '504B0304': '.zip',
          '7B22': '.json',
          '3C3F786D': '.xml',
          'EFBBBF': '.txt',
          'FFFE': '.txt',
          'FEFF': '.txt'
        }

        for (const [signature, extension] of Object.entries(fileTypeMap)) {
          if (header.startsWith(signature)) {
            ext = extension
            break
          }
        }

        if (header.startsWith('52494646')) {
          const riffType = fileBuffer.toString('hex', 8, 12).toUpperCase()
          if (riffType === '57454250') {
            ext = '.webp'
          } else {
            ext = '.wav'
          }
        }
      }

      if (!name || !name.includes('.')) {
        const timestamp = Date.now().toString(36)
        const random = Math.random().toString(36).substring(2, 8)
        name = `file_${timestamp}_${random}${ext || '.bin'}`
      }

      if (name.length > 100) {
        const extension = name.substring(name.lastIndexOf('.'))
        const baseName = name.substring(0, name.lastIndexOf('.'))
        name = baseName.substring(0, 80) + '...' + extension
      }

      return name
    }

    try {
      const fileBuffer = await getFileBuffer(file_data)
      const file_size = fileBuffer.length

      if (!file_name) {
        file_name = extractFileName(file_data, fileBuffer)
      }

      const shouldUseChunk = force_chunk || target_type === 'user'

      Bot.makeLog('debug', ['上传方式判断', { force_chunk, target_type, shouldUseChunk, file_size_mb: (file_size / 1024 / 1024).toFixed(2) }], data.self_id)

      if (!shouldUseChunk && target_type === 'group') {
        Bot.makeLog('debug', ['群聊使用 base64 直传', { target_id, file_name, size: file_size }], data.self_id)

        const filesUrl = `/v2/${target_type}s/${target_id}/files`
        const base64Data = fileBuffer.toString('base64')
        const filesData = {
          file_type,
          srv_send_msg: false,
          file_data: base64Data,
          file_name: file_name
        }

        const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)

        Bot.makeLog('debug', ['群聊 base64 直传成功', result], data.self_id)

        return result
      }

      const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex')
      const sha1Hash = crypto.createHash('sha1').update(fileBuffer).digest('hex')
      const MD5_10M_SIZE = 10002432
      const md5_10m = crypto.createHash('md5')
        .update(fileBuffer.slice(0, Math.min(MD5_10M_SIZE, file_size)))
        .digest('hex')

      Bot.makeLog('debug', ['准备分片上传', { target_id, target_type, file_name, file_size }], data.self_id)

      const prepareUrl = `/v2/${target_type}s/${target_id}/upload_prepare`
      const prepareData = {
        file_type,
        file_name,
        file_size,
        md5: md5Hash,
        sha1: sha1Hash,
        md5_10m
      }

      Bot.makeLog('debug', ['调用 upload_prepare', prepareUrl, prepareData], data.self_id)

      const { data: prepareResult } = await data.bot.sdk.request.post(prepareUrl, prepareData)

      Bot.makeLog('debug', ['upload_prepare 返回', prepareResult], data.self_id)

      const { upload_id, parts } = prepareResult
      const block_size = Number(prepareResult.block_size)

      const axios = await import('axios').then(m => m.default)
      for (const part of parts) {
        const { index, presigned_url } = part
        const start = (index - 1) * block_size
        const end = Math.min(start + block_size, file_size)
        const partBuffer = fileBuffer.slice(start, end)

        Bot.makeLog('debug', [`上传分片 ${index}/${parts.length}`, { start, end, size: partBuffer.length }], data.self_id)

        await axios.put(presigned_url, partBuffer, {
          headers: { 'Content-Type': 'application/octet-stream' }
        })

        const partFinishUrl = `/v2/${target_type}s/${target_id}/upload_part_finish`
        const partFinishData = {
          upload_id,
          part_index: index,
          block_size: partBuffer.length,
          md5: crypto.createHash('md5').update(partBuffer).digest('hex')
        }

        Bot.makeLog('debug', ['调用 upload_part_finish', partFinishUrl, partFinishData], data.self_id)

        await data.bot.sdk.request.post(partFinishUrl, partFinishData)
      }

      const filesUrl = `/v2/${target_type}s/${target_id}/files`
      const filesData = { upload_id }

      Bot.makeLog('debug', ['调用 /files 提交', filesUrl, filesData], data.self_id)

      const { data: filesResult } = await data.bot.sdk.request.post(filesUrl, filesData)

      Bot.makeLog('debug', ['分片上传成功', filesResult], data.self_id)

      return filesResult

    } catch (error) {
      Bot.makeLog('error', ['文件上传失败，尝试最终降级', error.message, error.response?.data], data.self_id)

      try {
        const fileBuffer = await getFileBuffer(file_data)

        let finalFileName = file_name
        if (!finalFileName) {
          finalFileName = extractFileName(file_data, fileBuffer)
        }

        const filesUrl = `/v2/${target_type}s/${target_id}/files`
        let filesData

        if (typeof file_data === 'string' && file_data.startsWith('http')) {
          filesData = {
            file_type,
            srv_send_msg: false,
            url: file_data,
            file_name: finalFileName
          }
          Bot.makeLog('debug', ['最终降级为 URL 直传', filesUrl, filesData], data.self_id)
        } else {
          const base64Data = fileBuffer.toString('base64')
          filesData = {
            file_type,
            srv_send_msg: false,
            file_data: base64Data,
            file_name: finalFileName
          }
          Bot.makeLog('debug', ['最终降级为 base64 上传', filesUrl, { file_name: finalFileName, size: fileBuffer.length }], data.self_id)
        }

        const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)

        Bot.makeLog('debug', ['降级上传成功', result], data.self_id)

        return result

      } catch (fallbackError) {
        Bot.makeLog('error', ['所有上传方式均失败', fallbackError.message, fallbackError.response?.data], data.self_id)
        throw new Error(`文件上传失败: ${fallbackError.response?.data?.message || fallbackError.message}`)
      }
    }
  }

  /**
   * 从 URL 提取文件名
   */
  extractFileNameFromUrl (url) {
    try {
      const urlObj = new URL(url)
      const pathname = urlObj.pathname
      const lastSegment = pathname.split('/').pop()
      const fileNameWithoutParams = lastSegment.split('?')[0]
      if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
        return decodeURIComponent(fileNameWithoutParams)
      }
    } catch {}
    return `file_${Date.now()}.bin`
  }

  getFileExt (file, name = '') {
    const source = name || (typeof file === 'string' ? file.split('?')[0] : '')
    const ext = source.includes('.') ? source.split('.').pop()?.toLowerCase() : ''
    return ext || ''
  }

  getDefaultAudioFileName (ext = '') {
    return `你需要的文件.${ext || 'mp3'}`
  }

  /**
   * 发送文件消息，支持延迟撤回
   */
  async sendFileMessage (data, target_id, target_type, fileInfo) {
    try {
      let actualFile, actualName, actualForceChunk, actualRecallTime

      if (typeof fileInfo.file === 'object' && fileInfo.file !== null && fileInfo.file.file) {
        actualFile = fileInfo.file.file
        actualName = fileInfo.file.name || fileInfo.name
        actualForceChunk = !!(fileInfo.file.force_chunk || fileInfo.force_chunk)
        actualRecallTime = fileInfo.file.recall_time ?? fileInfo.recall_time ?? 0
      } else {
        actualFile = fileInfo.file
        actualName = fileInfo.name
        actualForceChunk = !!(fileInfo.force_chunk)
        actualRecallTime = fileInfo.recall_time ?? 0
      }

      actualRecallTime = Number(actualRecallTime) || 0

      Bot.makeLog('debug', ['解析后的文件信息', {
        actualFile: typeof actualFile === 'string' ? actualFile : 'Buffer',
        actualName,
        actualForceChunk,
        actualRecallTime
      }], data.self_id)

      const result = await this.uploadFileToQQ(
        data,
        target_id,
        target_type,
        actualFile,
        actualName,
        actualForceChunk,
        fileInfo.file_type || 4
      )

      const messageUrl = `/v2/${target_type}s/${target_id}/messages`
      const messageData = {
        msg_type: 7,
        media: { file_info: result.file_info }
      }

      if (data.message_id) {
        messageData.msg_id = data.message_id
      }

      Bot.makeLog('debug', ['发送文件消息', messageUrl, messageData], data.self_id)

      const { data: sendResult } = await data.bot.sdk.request.post(messageUrl, messageData)

      Bot.makeLog('debug', ['文件消息发送成功', sendResult], data.self_id)

      // 延迟撤回
      if (actualRecallTime > 0 && sendResult && sendResult.id) {
        const msgId = sendResult.id
        Bot.makeLog('info', [`文件消息将在 ${actualRecallTime} 秒后撤回`, { msgId, target_type, target_id }], data.self_id)
        setTimeout(async () => {
          await this.recallMessageById(data, msgId, target_type, target_id)
        }, actualRecallTime * 1000)
      }

      return { id: sendResult.id }
    } catch (error) {
      const rawExt = this.getFileExt(fileInfo.raw_file, fileInfo.raw_name || fileInfo.name)
      if (fileInfo.file_type === 3 && fileInfo.raw_file && !fileInfo._silkRetry && rawExt && rawExt !== 'silk') {
        Bot.makeLog('warn', ['语音直传失败，转为 silk 后重试', error.message, error.response?.data], data.self_id)
        const silkFile = await this.makeRecord(fileInfo.raw_file, data.self_id, true)
        return this.sendFileMessage(data, target_id, target_type, {
          ...fileInfo,
          file: silkFile,
          name: fileInfo.name?.replace?.(/\.[^.]+$/, '.silk') || `record_${Date.now()}.silk`,
          _silkRetry: true
        })
      }
      if (fileInfo.file_type === 3 && fileInfo.raw_file && !fileInfo._fileFallback && ['silk', 'wav', 'mp3', 'flac'].includes(rawExt)) {
        const fallbackFile = rawExt === 'silk' ? fileInfo.file : fileInfo.raw_file
        const fallbackName = rawExt === 'silk'
          ? (fileInfo.name || this.getDefaultAudioFileName('silk'))
          : (fileInfo.raw_name || this.extractFileNameFromUrl(fileInfo.raw_file) || this.getDefaultAudioFileName(rawExt))
        Bot.makeLog('warn', ['语音发送失败，改为文件发送', { rawExt, fallbackName, error: error.message, data: error.response?.data }], data.self_id)
        return this.sendFileMessage(data, target_id, target_type, {
          ...fileInfo,
          file_type: 4,
          file: fallbackFile,
          name: fallbackName,
          _fileFallback: true
        })
      }
      Bot.makeLog('error', ['文件消息发送失败', error.message], data.self_id)
      throw error
    }
  }

  makeButton (data, button) {
    const msg = {
      id: randomUUID(),
      render_data: {
        label: button.text,
        visited_label: button.clicked_text,
        style: button.style ?? 1,
        ...button.QQBot?.render_data
      }
    }

    if (button.input) {
      msg.action = {
        type: 2,
        permission: { type: 2 },
        data: button.input,
        enter: button.send,
        ...button.QQBot?.action
      }
    } else if (button.callback) {
      if (getBotConfigValue(data.self_id, 'toCallback')) {
        msg.action = {
          type: 1,
          permission: { type: 2 },
          ...button.QQBot?.action
        }
        if (!Array.isArray(data._ret_id)) data._ret_id = []

        data.bot.callback[msg.id] = {
          id: data.message_id,
          user_id: data.user_id,
          group_id: data.group_id,
          message: button.callback,
          message_id: data._ret_id
        }
        setTimeout(() => delete data.bot.callback[msg.id], 300000)
      } else {
        msg.action = {
          type: 2,
          permission: { type: 2 },
          data: button.callback,
          enter: false,
          ...button.QQBot?.action
        }
      }
    } else if (button.link) {
      msg.action = {
        type: 0,
        permission: { type: 2 },
        data: button.link,
        ...button.QQBot?.action
      }
    } else return false

    if (button.permission) {
      if (button.permission == 'admin') {
        msg.action.permission.type = 1
      } else {
        msg.action.permission.type = 0
        msg.action.permission.specify_user_ids = []
        if (!Array.isArray(button.permission)) button.permission = [button.permission]
        for (let id of button.permission) {
          if (getBotConfigValue(data.self_id, 'toQQUin') && userIdCache[id]) id = userIdCache[id]
          msg.action.permission.specify_user_ids.push(id.replace(`${data.self_id}${this.sep}`, ''))
        }
      }
    }
    return msg
  }

  makeButtons (data, button_square) {
    const msgs = []
    for (const button_row of button_square) {
      const buttons = []
      for (let button of button_row) {
        button = this.makeButton(data, button)
        if (button) buttons.push(button)
      }
      if (buttons.length) { msgs.push({ type: 'button', buttons }) }
    }
    return msgs
  }

  /**
   * 统一解析 file segment
   */
  _parseFileSegment (i, data) {
    let fileData = {
      file: null,
      name: null,
      force_chunk: false,
      recall_time: 0
    }

    if (typeof i.file === 'string') {
      fileData.file = i.file

      if (typeof i.name === 'object' && i.name !== null) {
        fileData.name = i.name.name || null
        fileData.force_chunk = typeof i.name.force_chunk !== 'undefined' ? !!i.name.force_chunk : false
        fileData.recall_time = Number(i.name.recall_time) || 0
      } else {
        fileData.name = i.name || null

        let thirdParam = undefined
        if (typeof i.force_chunk !== 'undefined') {
          thirdParam = i.force_chunk
        } else if (typeof i.data !== 'undefined' && typeof i.data !== 'object') {
          thirdParam = i.data
        } else if (typeof i[2] !== 'undefined') {
          thirdParam = i[2]
        } else if (typeof i['2'] !== 'undefined') {
          thirdParam = i['2']
        } else if (Array.isArray(i.args) && i.args.length > 0) {
          thirdParam = i.args[0]
        }
        fileData.force_chunk = typeof thirdParam !== 'undefined' ? !!thirdParam : false

        let fourthParam = undefined
        if (typeof i.recall_time !== 'undefined') {
          fourthParam = i.recall_time
        } else if (typeof i[3] !== 'undefined') {
          fourthParam = i[3]
        } else if (typeof i['3'] !== 'undefined') {
          fourthParam = i['3']
        } else if (Array.isArray(i.args) && i.args.length > 1) {
          fourthParam = i.args[1]
        }
        fileData.recall_time = Number(fourthParam) || 0

        Bot.makeLog('debug', ['参数检测', { thirdParam, fourthParam, force_chunk: fileData.force_chunk, recall_time: fileData.recall_time }], data.self_id)
      }
    } else if (typeof i.file === 'object' && i.file !== null) {
      if (i.file.file) {
        fileData.file = i.file.file
        fileData.name = i.file.name || i.name || null
        fileData.force_chunk = typeof i.file.force_chunk !== 'undefined'
          ? !!i.file.force_chunk
          : (typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false)
        fileData.recall_time = Number(i.file.recall_time ?? i.recall_time) || 0
      } else {
        fileData.file = i.file
        fileData.name = i.name || null
        fileData.force_chunk = typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false
        fileData.recall_time = Number(i.recall_time) || 0
      }
    }

    if (!fileData.name && typeof fileData.file === 'string' && fileData.file.startsWith('http')) {
      try {
        const url = new URL(fileData.file)
        const lastSegment = url.pathname.split('/').pop()
        const fileNameWithoutParams = lastSegment.split('?')[0]
        if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
          fileData.name = decodeURIComponent(fileNameWithoutParams)
        }
      } catch {}
    }

    return fileData
  }

  async makeRawMarkdownMsg (data, msg, skipHandle = false) {
    if (!skipHandle && Handler.has('QQBot.makeRawMarkdownMsg')) {
      const res = await Handler.call('QQBot.makeRawMarkdownMsg', data, {
        adapter: this,
        data,
        msg,
        make: nextMsg => this.makeRawMarkdownMsg(data, nextMsg ?? msg, true)
      })
      if (res !== false && res !== undefined && res !== null) return res
    }

    const messages = []
    const button = []
    const files = []
    let content = ''
    let reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') { i = { ...i } } else { i = { type: 'text', text: i } }

      switch (i.type) {
        case 'record':
        case 'audio':
          files.push(await this.makeRecordFileInfo(data, i.file, i.name))
          continue
        case 'video':
        case 'face':
        case 'ark':
        case 'embed':
          messages.push([i])
          content += ''
          break
        case 'file': {
          Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
          const fileData = this._parseFileSegment(i, data)
          files.push(fileData)
          Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
          content += ''
          break
        }
        case 'at':
          if (i.qq == 'all') { content += '@everyone' } else { content += `<@${i.qq?.replace?.(`${data.self_id}${this.sep}`, '')}>` }
          break
        case 'text':
          content += await this.makeRawMarkdownText(data, i.text, button)
          break
        case 'image': {
          const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
          content += `${des}${url}`
          break
        }
        case 'markdown':
          if (typeof i.data == 'object') messages.push([{ type: 'markdown', ...i.data }])
          else content += i.data
          break
        case 'button':
          button.push(...this.makeButtons(data, i.data))
          break
        case 'reply':
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
          continue
        case 'node':
          for (const { message } of i.data) { messages.push(...(await this.makeRawMarkdownMsg(data, message, true))) }
          continue
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
          } else if (i.data && (i.data.type === 'keyboard' || i.data.type === 'button')) {
            button.push(i.data)
          } else {
            messages.push([i.data])
          }
          break
        default:
          content += await this.makeRawMarkdownText(data, JSON.stringify(i), button)
      }
    }

    if (content) { messages.unshift([{ type: 'markdown', content }]) }

    if (button.length) {
      for (const i of messages) {
        if (i[0].type == 'markdown') { i.push(...button.splice(0, 5)) }
        if (!button.length) break
      }
      while (button.length) {
        messages.push([
          { type: 'markdown', content: ' ' },
          ...button.splice(0, 5)
        ])
      }
    }

    if (reply) {
      for (const i in messages) {
        if (Array.isArray(messages[i])) messages[i].unshift(reply)
        else messages[i] = [reply, messages[i]]
      }
    }

    if (files.length) {
      data._files = (data._files || []).concat(files)
    }

    return messages
  }

  makeMarkdownText (data, text, button) {
    const toQRCodeRegExp = getQRCodeRegExp(data.self_id)
    const match = toQRCodeRegExp && text.match(toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        text = text.replace(url, '[链接(请点击按钮查看)]')
      }
    }
    return text.replace(/\n/g, '\r')
  }

  makeMarkdownTemplate (data, template) {
    let keys; let custom_template_id; let params = []; let index = 0; let type = 0
    const result = []
    if (markdown_template) {
      custom_template_id = markdown_template.custom_template_id
      params = _.cloneDeep(markdown_template.params)
      type = 1
    } else {
      const custom = config.customMD?.[data.self_id]
      custom_template_id = custom?.custom_template_id || config.markdown[data.self_id]
      keys = _.cloneDeep(custom?.keys) || config.markdown.template.split('')
    }
    for (const temp of template) {
      if (!temp.length) continue

      for (const i of splitMarkDownTemplate(temp)) {
        if (index == (type == 1 ? markdown_template.params.length : keys.length)) {
          result.push({
            type: 'markdown',
            custom_template_id,
            params: _.cloneDeep(params)
          })
          params = type == 1 ? _.cloneDeep(markdown_template.params) : []
          index = 0
        }

        if (type == 1) {
          params[index].values = [i]
        } else {
          params.push({
            key: keys[index],
            values: [i]
          })
        }
        index++
      }
    }

    if (config.mdSuffix?.[data.self_id]) {
      if (!params.some(p => config.mdSuffix[data.self_id].some(c => (c.key === p.key && p.values[0] !== '\u200B')))) {
        for (const i of config.mdSuffix[data.self_id]) {
          if (data.group_id) data.group = data.bot.pickGroup(data.group_id)
          if (data.user_id) data.friend = data.bot.pickFriend(data.user_id)
          if (data.user_id && data.group_id) data.member = data.bot.pickMember(data.group_id, data.user_id)
          const value = getMustacheTemplating(i.values[0], { e: data })
          params.push({ key: i.key, values: [value] })
        }
      }
    }

    if (params.length) {
      result.push({
        type: 'markdown',
        custom_template_id,
        params
      })
    }

    return result
  }

  async makeMarkdownMsg (data, msg, skipHandle = false) {
    if (!skipHandle && Handler.has('QQBot.makeMarkdownMsg')) {
      const res = await Handler.call('QQBot.makeMarkdownMsg', data, {
        adapter: this,
        data,
        msg,
        make: nextMsg => this.makeMarkdownMsg(data, nextMsg ?? msg, true)
      })
      if (res !== false && res !== undefined && res !== null) return res
    }

    const messages = []
    const button = []
    const files = []
    let template = []
    let content = ''
    let reply
    const length = markdown_template?.params?.length || config.customMD?.[data.self_id]?.keys?.length || config.markdown.template.length

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') i = { ...i }
      else i = { type: 'text', text: i }

      switch (i.type) {
        case 'record':
        case 'audio':
          files.push(await this.makeRecordFileInfo(data, i.file, i.name))
          continue
        case 'video':
        case 'face':
        case 'ark':
        case 'embed':
          messages.push([i])
          content += ''
          break
        case 'file': {
          Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
          const fileData = this._parseFileSegment(i, data)
          files.push(fileData)
          Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
          content += ''
          break
        }
        case 'at':
          if (i.qq == 'all') content += '@everyone'
          else {
            if (getBotConfigValue(data.self_id, 'toQQUin') && userIdCache[i.qq]) i.qq = userIdCache[i.qq]
            content += `<@${i.qq?.replace?.(`${data.self_id}${this.sep}`, '')}>`
          }
          break
        case 'text':
          content += this.makeMarkdownText(data, i.text, button)
          break
        case 'node':
          if (Handler.has('ws.tool.toImg') && getBotConfigValue(data.self_id, 'toImg')) {
            const getButton = data => {
              return data.flatMap(item => {
                if (Array.isArray(item.message)) {
                  return item.message.flatMap(msg => {
                    if (msg.type === 'node') return getButton(msg.data)
                    if (msg.type === 'button') return msg
                    return []
                  })
                }
                if (typeof item.message === 'object') {
                  if (item.message.type === 'button') return item.message
                  if (item.message.type === 'node') return getButton(item.message.data)
                }
                return []
              })
            }
            const btn = getButton(i.data)
            let result = btn.reduce((acc, cur) => {
              const duplicate = acc.find(obj => obj.text === cur.text && obj.callback === cur.callback && obj.input === cur.input && obj.link === cur.link)
              if (!duplicate) return acc.concat([cur])
              else return acc
            }, [])

            const e = {
              reply: (msg) => { i = msg },
              user_id: data.bot.uin,
              nickname: data.bot.nickname
            }

            e.runtime = new Runtime(e)
            i.data.cfg = { retType: 'msgId', returnID: true }
            let { wsids } = await Handler.call('ws.tool.toImg', e, i.data)

            if (!result.length && data.wsids && data.wsids?.fnc) {
              wsids = wsids.map((id, k) => ({ text: `${data.wsids.text}${k}`, callback: `#ws查看${id}` }))
              result = _.chunk(_.tail(wsids), data.wsids.col)
            }

            for (const b of result) {
              button.push(...this.makeButtons(data, b.data ? b.data : [b]))
            }
          } else if (TmplPkg && TmplPkg?.nodeMsg) {
            messages.push(...(await this.makeMarkdownMsg(data, TmplPkg.nodeMsg(i.data), true)))
            continue
          } else {
            for (const { message } of i.data) {
              messages.push(...(await this.makeMarkdownMsg(data, message, true)))
            }
            continue
          }
        case 'image': {
          const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
          const limit = template.length % (length - 1)

          if (template.length && !limit) {
            if (content) template.push(content)
            template.push(des)
          } else template.push(content + des)

          content = url
          break
        }
        case 'markdown':
          if (typeof i.data == 'object') messages.push([{ type: 'markdown', ...i.data }])
          else content += i.data
          break
        case 'button':
          button.push(...this.makeButtons(data, i.data))
          break
        case 'reply':
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
          continue
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
          } else if (i.data && (i.data.type === 'keyboard' || i.data.type === 'button')) {
            button.push(i.data)
          } else {
            messages.push([i.data])
          }
          break
        case 'custom':
          template.push(...i.data)
          break
        default:
          content += this.makeMarkdownText(data, JSON.stringify(i), button)
      }
    }

    if (content) template.push(content)
    if (template.length > length) {
      const templates = _(template).chunk(length).map(v => this.makeMarkdownTemplate(data, v)).value()
      messages.push(...templates)
    } else if (template.length) {
      const tmp = this.makeMarkdownTemplate(data, template)
      if (tmp.length > 1) {
        messages.push(...tmp.map(i => ([i])))
      } else {
        messages.push(tmp)
      }
    }

    if (template.length && button.length < 5 && config.btnSuffix[data.self_id]) {
      let { position, values } = config.btnSuffix[data.self_id]
      position = +position - 1
      if (position > button.length) {
        position = button.length
      }
      const btn = values.filter(i => {
        if (i.show) {
          switch (i.show.type) {
            case 'random':
              if (i.show.data <= _.random(1, 100)) return false
              break
            default:
              break
          }
        }
        return true
      })
      button.splice(position, 0, ...this.makeButtons(data, [btn]))
    }

    if (button.length) {
      for (const i of messages) {
        if (i[0].type == 'markdown') i.push(...button.splice(0, 5))
        if (!button.length) break
      }
      while (button.length) {
        messages.push([
          ...this.makeMarkdownTemplate(data, [' ']),
          ...button.splice(0, 5)
        ])
      }
    }
    if (reply) {
      for (const i of messages) {
        i.unshift(reply)
      }
    }

    if (files.length) {
      data._files = (data._files || []).concat(files)
    }

    return messages
  }

  async makeMsg (data, msg, skipHandle = false) {
    if (!skipHandle && Handler.has('QQBot.makeMsg')) {
      const res = await Handler.call('QQBot.makeMsg', data, {
        adapter: this,
        data,
        msg,
        make: nextMsg => this.makeMsg(data, nextMsg ?? msg, true)
      })
      if (res !== false && res !== undefined && res !== null) return res
    }

    const sendType = ['audio', 'image', 'video', 'file']
    const messages = []
    const button = []
    const files = []
    let message = []
    let reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') { i = { ...i } } else { i = { type: 'text', text: i } }

      switch (i.type) {
        case 'at':
          continue
        case 'text':
        case 'face':
        case 'ark':
        case 'embed':
          break
        case 'record':
        case 'audio':
          files.push(await this.makeRecordFileInfo(data, i.file, i.name))
          continue
        case 'video':
        case 'image':
          if (message.some(s => sendType.includes(s.type))) {
            messages.push(message)
            message = []
          }
          break
        case 'file': {
          Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
          const fileData = this._parseFileSegment(i, data)
          files.push(fileData)
          Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
          continue
        }
        case 'reply':
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
          continue
        case 'markdown':
          if (typeof i.data == 'object') { i = { type: 'markdown', ...i.data } } else { i = { type: 'markdown', content: i.data } }
          break
        case 'button':
          config.sendButton && button.push(...this.makeButtons(data, i.data))
          continue
        case 'node':
          if (Handler.has('ws.tool.toImg') && getBotConfigValue(data.self_id, 'toImg')) {
            const e = {
              reply: (msg) => { i = msg },
              user_id: data.bot.uin,
              nickname: data.bot.nickname
            }
            e.runtime = new Runtime(e)
            await Handler.call('ws.tool.toImg', e, i.data)
            if (message.some(s => sendType.includes(s.type))) {
              messages.push(message)
              message = []
            }
          } else {
            for (const { message } of i.data) {
              messages.push(...(await this.makeMsg(data, message, true)))
            }
          }
          break
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        default:
          i = { type: 'text', text: JSON.stringify(i) }
      }

      if (i.type === 'text' && i.text) {
        const toQRCodeRegExp = getQRCodeRegExp(data.self_id)
        const match = toQRCodeRegExp && i.text.match(toQRCodeRegExp)
        if (match) {
          for (const url of match) {
            const msg = segment.image(await Bot.fileToUrl(await this.makeQRCode(url)))
            if (message.some(s => sendType.includes(s.type))) {
              messages.push(message)
              message = []
            }
            message.push(msg)
            i.text = i.text.replace(url, '[链接(请扫码查看)]')
          }
        }
      }

      if (i.type !== 'node') message.push(i)
    }

    if (message.length) { messages.push(message) }

    while (button.length) {
      messages.push([{
        type: 'keyboard',
        content: { rows: button.splice(0, 5) }
      }])
    }

    if (reply) {
      for (const i of messages) i.unshift(reply)
    }

    if (files.length) {
      data._files = (data._files || []).concat(files)
    }

    return messages
  }

  async sendMsg (data, send, msg) {
    // 拦截 segment.callfl 召回消息
    const msgArr = Array.isArray(msg) ? msg : [msg]
    for (const item of msgArr) {
      if (item?.type === '_callfl') {
        const rets = { message_id: [], data: [], error: [] }
        // 校验 openid 是否存在
        const user = inviteStore.getC2cUser(data.self_id, item.openid)
        if (!user) {
          rets.error.push(new Error(`openid ${item.openid} 不存在于记录中`))
          return rets
        }
        const result = await adapter._sendWakeupMessage(
          data.self_id,
          item.openid,
          item.md || undefined,
          item.button || undefined,
          undefined,
          !!item.force
        )
        if (result.success) {
          if (result.data?.id) rets.message_id.push(result.data.id)
          rets.data.push(result.data)
        } else {
          rets.error.push(new Error(result.error))
        }
        return rets
      }
    }

    const rets = { message_id: [], data: [], error: [] }
    let msgs

    const sendMsg = async () => {
      for (const i of msgs) {
        try {
          Bot.makeLog('debug', ['发送消息', i], data.self_id)
          const ret = await send(i)
          Bot.makeLog('debug', ['发送消息返回', ret], data.self_id)

          rets.data.push(ret)
          if (ret.id) rets.message_id.push(ret.id)
          Bot[data.self_id].dau.setDau('send_msg', data)
        } catch (err) {
          logger.error(data.self_id, '发送消息错误', i, err)
          rets.error.push(err)
          return false
        }
      }
    }

    if (TmplPkg && TmplPkg?.Button && !data.toQQBotMD) {
      let fncName = /\[.*?\((\S+)\)\]/.exec(data.logFnc)[1]
      const Btn = TmplPkg.Button[fncName]

      if (msg.type === 'node') data.wsids = { toImg: getBotConfigValue(data.self_id, 'toImg') }

      let res
      if (Btn) res = Btn(data, msg)

      if (res?.nodeMsg) {
        data.toQQBotMD = true
        data.wsids = {
          text: res.nodeMsg,
          fnc: fncName,
          col: res.col
        }
      } else if (res) {
        data.toQQBotMD = true
        res = segment.button(...res)
        msg = _.castArray(msg)

        let _btn = msg.findIndex(b => b.type === 'button')
        if (_btn === -1) msg.push(res)
        else msg[_btn] = res
      }
    }

    if ((config.markdown[data.self_id] || (data.toQQBotMD === true && config.customMD[data.self_id])) && data.toQQBotMD !== false) {
      if (config.markdown[data.self_id] == 'raw') msgs = await this.makeRawMarkdownMsg(data, msg)
      else msgs = await this.makeMarkdownMsg(data, msg)

      const [mds, btns] = _.partition(msgs[0], v => v.type === 'markdown')
      if (mds.length > 1) {
        for (const idx in mds) {
          msgs = mds[idx]
          if (idx === mds.length - 1) msgs.push(...btns)
          await sendMsg()
        }

        if (data._files && data._files.length) {
          await this.sendFiles(data, data._files)
          data._files = []
        }

        return rets
      }
    } else {
      msgs = await this.makeMsg(data, msg)
    }

    if (await sendMsg() === false) {
      msgs = await this.makeMsg(data, msg)
      await sendMsg()
    }

    if (data._files && data._files.length) {
      await this.sendFiles(data, data._files)
      data._files = []
    }

    if (Array.isArray(data._ret_id)) { data._ret_id.push(...rets.message_id) }
    return rets
  }

  async sendFiles (data, files) {
    let target_type, target_id

    if (data.group_id) {
      target_type = 'group'
      target_id = data.raw?.group_id || data.group_id.replace(`${data.self_id}${this.sep}`, '')
    } else {
      target_type = 'user'
      target_id = data.raw?.sender?.user_id || data.user_id.replace(`${data.self_id}${this.sep}`, '')
    }

    Bot.makeLog('debug', ['准备发送文件列表', { target_type, target_id, count: files.length }], data.self_id)

    for (const fileInfo of files) {
      try {
        await this.sendFileMessage(data, target_id, target_type, fileInfo)
        Bot.makeLog('info', ['文件发送成功', { target_type, target_id, file: fileInfo.name, force_chunk: fileInfo.force_chunk, recall_time: fileInfo.recall_time }], data.self_id)
      } catch (err) {
        Bot.makeLog('error', ['发送文件失败', fileInfo, err.message, err.response?.data], data.self_id)
      }
    }
  }

  sendFriendMsg (data, msg, event) {
    return this.sendMsg(data, msg => data.bot.sdk.sendPrivateMessage(data.user_id, msg, event), msg)
  }

  async sendGroupMsg (data, msg, event) {
    if (Handler.has('QQBot.group.sendMsg')) {
      const res = await Handler.call(
        'QQBot.group.sendMsg',
        data,
        {
          self_id: data.self_id,
          group_id: `${data.self_id}${this.sep}${data.group_id}`,
          raw_group_id: data.group_id,
          user_id: data.user_id,
          msg,
          event
        }
      )
      if (res !== false) {
        return res
      }
    }
    return this.sendMsg(data, msg => data.bot.sdk.sendGroupMessage(data.group_id, msg, event), msg)
  }

  async makeGuildMsg (data, msg) {
    const messages = []
    let message = []
    let reply
    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') { i = { ...i } } else { i = { type: 'text', text: i } }

      switch (i.type) {
        case 'at':
          i.user_id = i.qq?.replace?.(/^qg_/, '')
        case 'text':
        case 'face':
        case 'ark':
        case 'embed':
          break
        case 'image':
          message.push(i)
          messages.push(message)
          message = []
          continue
        case 'record':
        case 'video':
        case 'file':
          return []
        case 'reply':
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
          continue
        case 'markdown':
          if (typeof i.data == 'object') { i = { type: 'markdown', ...i.data } } else { i = { type: 'markdown', content: i.data } }
          break
        case 'button':
          continue
        case 'node':
          for (const { message } of i.data) { messages.push(...(await this.makeGuildMsg(data, message))) }
          continue
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        default:
          i = { type: 'text', text: JSON.stringify(i) }
      }

      if (i.type == 'text' && i.text) {
        const toQRCodeRegExp = getQRCodeRegExp(data.self_id)
        const match = toQRCodeRegExp && i.text.match(toQRCodeRegExp)
        if (match) {
          for (const url of match) {
            const msg = segment.image(await this.makeQRCode(url))
            message.push(msg)
            messages.push(message)
            message = []
            i.text = i.text.replace(url, '[链接(请扫码查看)]')
          }
        }
      }

      message.push(i)
    }

    if (message.length) {
      messages.push(message)
    }
    if (reply) {
      for (const i of messages) i.unshift(reply)
    }
    return messages
  }

  async sendGMsg (data, send, msg) {
    const rets = { message_id: [], data: [], error: [] }
    let msgs

    const sendMsg = async () => {
      for (const i of msgs) {
        try {
          Bot.makeLog('debug', ['发送消息', i], data.self_id)
          const ret = await send(i)
          Bot.makeLog('debug', ['发送消息返回', ret], data.self_id)

          rets.data.push(ret)
          if (ret.id) rets.message_id.push(ret.id)
          Bot[data.self_id].dau.setDau('send_msg', data)
        } catch (err) {
          logger.error(data.self_id, '发送消息错误', i, err)
          rets.error.push(err)
          return false
        }
      }
    }

    msgs = await this.makeGuildMsg(data, msg)
    if (await sendMsg() === false) {
      msgs = await this.makeGuildMsg(data, msg)
      await sendMsg()
    }
    return rets
  }

  async sendDirectMsg (data, msg, event) {
    if (!data.guild_id) {
      if (!data.src_guild_id) {
        Bot.makeLog('error', [`发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg], data.self_id)
        return false
      }
      const dms = await data.bot.sdk.createDirectSession(data.src_guild_id, data.user_id)
      data.guild_id = dms.guild_id
      data.channel_id = dms.channel_id
      data.bot.fl.set(`qg_${data.user_id}`, {
        ...data.bot.fl.get(`qg_${data.user_id}`),
        ...dms
      })
    }
    return this.sendGMsg(data, msg => data.bot.sdk.sendDirectMessage(data.guild_id, msg, event), msg)
  }

  async recallMsg (data, recall, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id) {
      try {
        msgs.push(await recall(i))
      } catch (err) {
        Bot.makeLog('debug', ['撤回消息错误', i, err], data.self_id)
        msgs.push(false)
      }
    }
    return msgs
  }

  recallFriendMsg (data, message_id) {
    Bot.makeLog('info', `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallFriendMessage(data.user_id, i), message_id)
  }

  recallGroupMsg (data, message_id) {
    Bot.makeLog('info', `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
  }

  recallDirectMsg (data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog('info', `撤回${hide ? '并隐藏' : ''}频道私聊消息：[${data.guild_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide), message_id)
  }

  recallGuildMsg (data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog('info', `撤回${hide ? '并隐藏' : ''}频道消息：[${data.channel_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide), message_id)
  }

  sendGuildMsg (data, msg, event) {
    return this.sendGMsg(data, msg => data.bot.sdk.sendGuildMessage(data.channel_id, msg, event), msg)
  }

  pickFriend (id, user_id) {
    if (getBotConfigValue(id, 'toQQUin') && userIdCache[user_id]) user_id = userIdCache[user_id]
    if (user_id.startsWith('qg_')) return this.pickGuildFriend(id, user_id)

    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, '')
    }
    return {
      ...i,
      sendMsg: msg => this.sendFriendMsg(i, msg),
      recallMsg: message_id => this.recallFriendMsg(i, message_id),
      getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/0`
    }
  }

  pickMember (id, group_id, user_id) {
    if (getBotConfigValue(id, 'toQQUin') && userIdCache[user_id]) {
      user_id = userIdCache[user_id]
    }
    if (user_id.startsWith('qg_')) { return this.pickGuildMember(id, group_id, user_id) }
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ''),
      group_id: group_id.replace(`${id}${this.sep}`, '')
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i
    }
  }

  pickGroup (id, group_id) {
    if (group_id.startsWith?.('qg_')) { return this.pickGuild(id, group_id) }
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id: group_id.replace?.(`${id}${this.sep}`, '') || group_id
    }
    return {
      ...i,
      sendMsg: msg => this.sendGroupMsg(i, msg),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      getMemberMap: () => i.bot.gml.get(group_id)
    }
  }

  pickGuildFriend (id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, '')
    }
    return {
      ...i,
      sendMsg: msg => this.sendDirectMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide)
    }
  }

  pickGuildMember (id, group_id, user_id) {
    const guild_id = group_id.replace(/^qg_/, '').split('-')
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      src_guild_id: guild_id[0],
      src_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, '')
    }
    return {
      ...this.pickGuildFriend(id, user_id),
      ...i,
      sendMsg: msg => this.sendDirectMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide)
    }
  }

  pickGuild (id, group_id) {
    const guild_id = group_id.replace(/^qg_/, '').split('-')
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1]
    }
    return {
      ...i,
      sendMsg: msg => this.sendGuildMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id)
    }
  }

  async makeFriendMessage (data, event) {
    data.sender = {
      user_id: `${data.self_id}${this.sep}${event.sender.user_id}`
    }
    Bot.makeLog('info', `好友消息：[${data.user_id}] ${data.raw_message}`, data.self_id)
    data.reply = msg => this.sendFriendMsg({
      ...data, user_id: event.sender.user_id
    }, msg, { id: data.message_id })
    await this.setFriendMap(data)
    // 记录 C2C openid 用于召回
    const rawUserOpenid = event.sender?.user_id || event.author?.user_openid || event.author?.member_openid || ''
    if (rawUserOpenid) {
      inviteStore.recordC2cUser(data.self_id, rawUserOpenid, event.event_id || '', event._rawTimestamp || event.raw?._rawTimestamp || event.timestamp || event.time || '')
    }
    // 注入 raw.invite
    if (rawUserOpenid) {
      data.raw.invite = this._makeInviteRaw(data.self_id, rawUserOpenid)
    }
  }

  async makeGroupMessage (data, event) {
    data.sender = {
      user_id: `${data.self_id}${this.sep}${event.sender.user_id}`
    }
    data.group_id = `${data.self_id}${this.sep}${event.group_id}`
    if (event.group_openid) data.group_openid = event.group_openid
    if (getBotConfigValue(data.self_id, 'toQQUin') && Handler.has('ws.tool.findUserId')) {
      const user_id = await Handler.call('ws.tool.findUserId', { user_id: data.user_id })
      if (user_id?.custom) {
        userIdCache[user_id.custom] = data.user_id
        data.sender.user_id = user_id.custom
      }
    }

    const filterLog = config.filterLog?.[data.self_id] || []
    let logStat = filterLog.includes(_.trim(data.raw_message)) ? 'debug' : 'info'
    const _author = event.author || event.raw?.author || {}
    const _authorName = _author.username || '未知用户'
    const _authorTag = _author.bot === true ? '🤖' : '🚻'
    const _msgType = event._qqbotFullMessageCreate ? '群全量消息' : '群@机器消息'
    Bot.makeLog(logStat, `${_msgType}: [${_authorName}-${_authorTag}]：[${data.group_id}, ${data.user_id}] ${data.raw_message}`, data.self_id)

    data.reply = msg => this.sendGroupMsg({
      ...data, group_id: event.group_id
    }, msg, { id: data.message_id })
    await this.setGroupMap(data)

    const fullMessage = ensureFullMessageConfig(config, data.self_id)
    if (shouldLimitBotAuthorMessage(config, event, data.self_id)) {
      Bot.makeLog('debug', ['机器人消息限流触发', {
        self_id: data.self_id,
        group_id: data.group_id,
        user_id: data.user_id,
        limit: `${fullMessage.botLimitCount}条${fullMessage.botLimitMinutes}分钟`,
        event: event._qqbotFullMessageCreate ? 'GROUP_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE'
      }], data.self_id)
      return false
    }

    if (!event._qqbotFullMessageCreate && fullMessage.ignoreBotAuthor && fullMessage.ignoreBotAuthorAt && isGroupBotAuthorEvent(event)) {
      Bot.makeLog('debug', ['忽略其他机器人正常@', { self_id: data.self_id, group_id: data.group_id, user_id: data.user_id }], data.self_id)
      return false
    }

    if (event._qqbotFullMessageCreate) await recordFullMessageGroup(config, data, event)

    if (event._qqbotFullMessageCreate) {
      const mentionState = getFullMessageMentionState(config, event, data.self_id)
      data.full_message = mentionState
      Bot.makeLog('debug', ['全量消息过滤状态', mentionState, { msg: data.raw_message, mentions: event._mentions || [] }], data.self_id)
      Bot.makeLog('debug', ['全量消息文本诊断', {
        raw_message: data.raw_message,
        raw_json: JSON.stringify(data.raw_message),
        message: data.message,
        char_codes: [...String(data.raw_message || '')].map(i => i.charCodeAt(0))
      }], data.self_id)
      await this.debugFullMessagePluginRules(data)
      if (mentionState.shouldNotifyAll) {
        Bot.makeLog('info', `[${data.self_id}] 全量消息@全体通知：[${data.group_id}, ${data.group_openid || '-'}, ${data.user_id}] ${data.raw_message}`, data.self_id)
        try {
          await Bot.sendMasterMsg(getFullMessageAllNotifyMsg(data))
        } catch (err) {
          Bot.makeLog('error', ['全量消息@全体通知发送失败', err.message], data.self_id)
        }
      }
      if (!mentionState.shouldDispatch) return false
      data.atBot = true
    }
  }

  async debugFullMessagePluginRules (data) {
    try {
      const loader = (await import(`file://${process.cwd()}/lib/plugins/loader.js`)).default
      const msg = String(data.raw_message || '')
      const plugins = loader.priority || []
      const matched = []

      for (const item of plugins) {
        const rules = item.plugin?.rule || []
        for (const rule of rules) {
          const reg = rule.reg instanceof RegExp ? rule.reg : new RegExp(rule.reg)
          reg.lastIndex = 0
          const info = `${item.name || item.plugin?.name || item.key}:${reg}`
          if (reg.test(msg)) matched.push(info)
        }
      }

      Bot.makeLog('debug', ['全量消息规则诊断', {
        msg,
        plugin_count: plugins.length,
        matched
      }], data.self_id)
    } catch (err) {
      Bot.makeLog('debug', ['全量消息规则诊断失败', err.message], data.self_id)
    }
  }

  async makeDirectMessage (data, event) {
    data.sender = {
      ...data.bot.fl.get(`qg_${event.sender.user_id}`),
      ...event.sender,
      user_id: `qg_${event.sender.user_id}`,
      nickname: event.sender.user_name,
      avatar: event.author.avatar,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      src_guild_id: event.src_guild_id
    }
    Bot.makeLog('info', `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
    data.reply = msg => this.sendDirectMsg({
      ...data,
      user_id: event.user_id,
      guild_id: event.guild_id,
      channel_id: event.channel_id
    }, msg, { id: data.message_id })
    await this.setFriendMap(data)
  }

  async makeGuildMessage (data, event) {
    data.message_type = 'group'
    data.sender = {
      ...data.bot.fl.get(`qg_${event.sender.user_id}`),
      ...event.sender,
      user_id: `qg_${event.sender.user_id}`,
      nickname: event.sender.user_name,
      card: event.member.nick,
      avatar: event.author.avatar,
      src_guild_id: event.guild_id,
      src_channel_id: event.channel_id
    }
    if (getBotConfigValue(data.self_id, 'toQQUin') && Handler.has('ws.tool.findUserId')) {
      const user_id = await Handler.call('ws.tool.findUserId', { user_id: data.user_id })
      if (user_id?.custom) {
        userIdCache[user_id.custom] = data.user_id
        data.sender.user_id = user_id.custom
      }
    }
    data.group_id = `qg_${event.guild_id}-${event.channel_id}`
    Bot.makeLog('info', `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
    data.reply = msg => this.sendGuildMsg({
      ...data,
      guild_id: event.guild_id,
      channel_id: event.channel_id
    }, msg, { id: data.message_id })
    await this.setFriendMap(data)
    await this.setGroupMap(data)
  }

  async setFriendMap (data) {
    if (!data.user_id) return
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.sender
    })
  }

  async setGroupMap (data) {
    if (!data.group_id) return
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      ...data.sender
    })
  }

  isMessageAuditEvent (event) {
    return event?.constructor?.name === 'MessageAuditEvent' || event?.message_type === 'audit' || Reflect.has(event || {}, 'audit_id')
  }

  makeMessageAuditNotice (id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: 'notice',
      notice_type: 'message_audit',
      sub_type: event.is_passed ? 'pass' : 'reject',
      notice_id: event.audit_id || event.event_id || event.message_id,
      audit_id: event.audit_id,
      message_id: event.message_id || event.msg_id || '',
      audit_time: event.audit_time,
      create_time: event.create_time,
      is_passed: event.is_passed === true,
      group_id: event.group_id ? `${id}${this.sep}${event.group_id}` : event.group_id,
      user_id: event.user_id || event.author_id || event.member_openid || event.user_openid || ''
    }

    Bot.makeLog('debug', [`主动消息审核${data.sub_type === 'pass' ? '通过' : '未通过'}`, {
      audit_id: data.audit_id,
      message_id: data.message_id,
      group_id: data.group_id,
      user_id: data.user_id
    }], id)
    Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
  }

  async makeMessage (id, event) {
    if (Bot[id]?.readOnlyMode) return
    if (this.isMessageAuditEvent(event)) {
      this.makeMessageAuditNotice(id, event)
      return
    }

    const botNames = [event.bot?.nickname, event.bot?._qqbotNickname]
    const normalizedMessage = this.normalizeSdkMessage(event.message).map(seg => {
      if (seg?.type === 'text') return { ...seg, text: normalizeIncomingCommandText(seg.text, botNames) }
      return seg
    }).filter(seg => !(seg?.type === 'text' && !seg.text))

    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      message_id: event.message_id,
      get user_id () { return this.sender.user_id },
      message: normalizedMessage,
      raw_message: normalizeIncomingCommandText(event.raw_message, botNames)
    }

    for (const i of data.message) {
      switch (i.type) {
        case 'at':
          if (data.message_type == 'group') i.qq = `${data.self_id}${this.sep}${i.user_id}`
          else i.qq = `qg_${i.user_id}`
          break
      }
    }

    switch (data.message_type) {
      case 'private':
      case 'direct':
        if (data.sub_type == 'friend') {
          await this.makeFriendMessage(data, event)
        } else {
          await this.makeDirectMessage(data, event)
        }
        break
      case 'group':
        if (await this.makeGroupMessage(data, event) === false) return
        break
      case 'guild':
        await this.makeGuildMessage(data, event)
        if (data.message.length === 0) {
          data.message.push({ type: 'text', text: '' })
        }
        break
      default:
        Bot.makeLog('warn', ['未知消息', event], id)
        return
    }

    data.bot.stat.recv_msg_cnt++
    Bot[data.self_id].dau.setDau('receive_msg', data)
    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeCallback (id, event) {
    if (event.data?.type === 2001 || event.data?.type === 2002) {
      return this.makeClawConfigInteraction(id, event)
    }

    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        return await reply(...args)
      } catch (err) {
        Bot.makeLog('debug', ['回复按钮点击事件错误', err], data.self_id)
      }
    }

    const interactionEventId = event.notice_id?.startsWith?.('INTERACTION_CREATE:')
      ? event.notice_id
      : `INTERACTION_CREATE:${event.notice_id}`

    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: 'message',
      message_id: event.notice_id,
      message_type: event.notice_type,
      sub_type: 'callback',
      get user_id () { return this.sender.user_id },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: ''
    }

    const callback = data.bot.callback[event.data?.resolved?.button_id]
    if (callback) {
      if (!event.group_id && callback.group_id) { event.group_id = callback.group_id }
      data.message_id = callback.id
      if (callback.message_id.length) {
        for (const id of callback.message_id) { data.message.push({ type: 'reply', id }) }
        data.raw_message += `[回复：${callback.message_id}]`
      }
      data.message.push({ type: 'text', text: callback.message })
      data.raw_message += callback.message
    } else {
      if (event.data?.resolved?.button_id) {
        data.message.push({ type: 'reply', id: event.data?.resolved?.button_id })
        data.raw_message += `[回复：${event.data?.resolved?.button_id}]`
      }
      if (event.data?.resolved?.button_data) {
        data.message.push({ type: 'text', text: event.data?.resolved?.button_data })
        data.raw_message += event.data?.resolved?.button_data
      } else {
        event.reply(1)
      }
    }
    event.reply(0)

    const wrapWithEventId = (msg) => {
      msg = Array.isArray(msg) ? [...msg] : [msg]
      msg = msg.filter(item => !(item?.type === 'reply' && !String(item.id || '').startsWith('event_')))
      msg.unshift({ type: 'reply', id: `event_${interactionEventId}` })
      return msg
    }

    switch (data.message_type) {
      case 'direct':
      case 'friend':
        data.message_type = 'private'
        Bot.makeLog('info', [`好友按钮点击事件：[${data.user_id}]`, data.raw_message], data.self_id)
        data.reply = msg => this.sendFriendMsg(
          { ...data, user_id: event.operator_id },
          wrapWithEventId(msg)
        )
        await this.setFriendMap(data)
        break
      case 'group':
        data.group_id = `${id}${this.sep}${event.group_id}`
        Bot.makeLog('info', [`群按钮点击事件：[${data.group_id}, ${data.user_id}]`, data.raw_message], data.self_id)
        data.reply = msg => this.sendGroupMsg(
          { ...data, group_id: event.group_id },
          wrapWithEventId(msg)
        )
        await this.setGroupMap(data)
        break
      case 'guild':
        break
      default:
        Bot.makeLog('warn', ['未知按钮点击事件', event], data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeClawConfigInteraction (id, event) {
    const resolved = event.data?.resolved || {}
    const type = Number(event.data?.type)
    const claw = ensureClawConfig(id)
    const noticeData = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: 'notice',
      notice_type: 'claw_cfg',
      sub_type: type === 2002 ? 'update' : 'query',
      notice_id: event.notice_id,
      group_id: event.group_id ? `${id}${this.sep}${event.group_id}` : '',
      user_id: event.operator_id || event.user_id || '',
      interaction_type: type,
      resolved
    }

    Bot.em(`${noticeData.post_type}.${noticeData.notice_type}.${noticeData.sub_type}`, noticeData)

    if (!claw.online) {
      try {
        await event.reply(Number(claw.code) || 0)
      } catch (err) {
        Bot.makeLog('error', ['龙虾配置交互ACK失败', err.message, err.response?.data], id)
      }
      return
    }

    const body = {
      code: claw.code === '0' ? 0 : Number(claw.code) || 0,
      data: {
        claw_cfg: getClawCfg(id)
      }
    }

    try {
      await event.bot.request.put(`/interactions/${event.notice_id}`, body)
      Bot.makeLog('debug', ['龙虾配置交互响应成功', { type, body }], id)
    } catch (err) {
      Bot.makeLog('error', ['龙虾配置交互响应失败', err.message, err.response?.data], id)
    }
  }

  // ========== 破冰/邀请/召回辅助 ==========
  _makeInviteRaw (selfId, userOpenid) {
    const inv = inviteStore.getInvite(selfId, userOpenid)
    return {
      number: inv.number || 0,
      kick: inv.kick || 0,
      time: inv.time || '',
      kicktime: inv.kicktime || ''
    }
  }

  async _sendIcebreaker (selfId, type, targetId, eventId) {
    const bot = Bot[selfId]
    if (!bot || bot.disabledRuntime || bot.readOnlyMode) return

    const ib = ensureIcebreakerConfig(config, selfId)
    const isGroup = type === 'group'
    const enabled = isGroup ? ib.groupEnabled : ib.friendEnabled

    if (!enabled) return

    // 群聊黑名单检查
    if (isGroup && Array.isArray(ib.disabledGroups) && ib.disabledGroups.includes(targetId)) {
      Bot.makeLog('debug', [`[${selfId}] 群 ${targetId} 已在破冰黑名单中，跳过`], selfId)
      return
    }

    const mdContent = isGroup ? ib.groupMarkdown : ib.friendMarkdown
    const buttonEnabled = isGroup ? ib.groupButtonEnabled : ib.friendButtonEnabled
    const buttonData = isGroup ? ib.groupButton : ib.friendButton

    const isRaw = config.markdown?.[selfId] === 'raw'
    const urlBase = isGroup ? `/v2/groups/${targetId}` : `/v2/users/${targetId}`

    // 必须有 eventId 才能破冰
    if (!eventId) {
      Bot.makeLog('debug', [`[${selfId}] 破冰缺少 event_id，跳过`], selfId)
      return
    }

    // 构建消息体
    const payload = {
      msg_type: 0,
      content: mdContent || '你好~',
      msg_seq: Math.floor(Math.random() * 1000000) + 1,
      event_id: eventId
    }

    // 如果是 raw 模式且有 markdown 内容，用 markdown msg_type=2
    if (isRaw && mdContent) {
      payload.msg_type = 2
      payload.markdown = { content: mdContent }
      delete payload.content

      // 有 button 且 enabled
      if (buttonEnabled && buttonData) {
        payload.keyboard = {
          content: buttonData,
          bot_appid: Number(bot.info?.appid || 0)
        }
      }
    }

    try {
      const { data: result } = await bot.sdk.request.post(`${urlBase}/messages`, payload)
      Bot.makeLog('info', [`[${selfId}] ${isGroup ? '群聊' : '私聊'}破冰发送成功`, { targetId, id: result?.id }], selfId)
    } catch (err) {
      Bot.makeLog('warn', [`[${selfId}] ${isGroup ? '群聊' : '私聊'}破冰发送失败`, err.message, err.response?.data], selfId)
    }
  }

  async _sendWakeupMessage (selfId, userOpenid, mdOverride, buttonOverride, buttonEnabledOverride, force = false) {
    const bot = Bot[selfId]
    if (!bot || bot.disabledRuntime || bot.readOnlyMode) return { success: false, error: 'bot不可用' }

    // 周期检查（非强制模式）
    if (!force) {
      const periodCheck = inviteStore.isWakeupSentInPeriod(selfId, userOpenid)
      if (periodCheck.expired) {
        return { success: false, error: '用户超过30天，不可召回', skipped: true }
      }
      if (periodCheck.sent) {
        return { success: false, error: `当前周期(${periodCheck.period})已发送过召回`, skipped: true, period: periodCheck.period }
      }
    }

    const rc = ensureRecallConfig(config, selfId)
    const md = mdOverride || rc.markdown || ''
    const btnEnabled = typeof buttonEnabledOverride === 'boolean' ? buttonEnabledOverride : rc.buttonEnabled
    const btn = buttonOverride || rc.button
    const isRaw = config.markdown?.[selfId] === 'raw'

    const payload = {
      msg_type: 0,
      content: md || '。',
      msg_seq: Math.floor(Math.random() * 1000000) + 1,
      is_wakeup: true
    }

    if (isRaw && md) {
      payload.msg_type = 2
      payload.markdown = { content: md }
      delete payload.content

      if (btnEnabled && btn) {
        payload.keyboard = {
          content: btn,
          bot_appid: Number(bot.info?.appid || 0)
        }
      }
    }

    try {
      const attemptPeriod = inviteStore.getUserWakeupPeriod(selfId, userOpenid)
      if (attemptPeriod !== null) inviteStore.markWakeupAttempt(selfId, userOpenid, attemptPeriod)
      const { data: result } = await bot.sdk.request.post(`/v2/users/${userOpenid}/messages`, payload)
      Bot.makeLog('info', [`[${selfId}] 召回消息发送成功`, { userOpenid, id: result?.id }], selfId)
      // 记录周期
      const period = inviteStore.getUserWakeupPeriod(selfId, userOpenid)
      if (period !== null) {
        inviteStore.markWakeupSent(selfId, userOpenid, period, result?.timestamp || '')
      }
      return { success: true, data: result }
    } catch (err) {
      const errCode = err.response?.data?.err_code || err.response?.data?.code || 0
      const errMsg = err.response?.data?.message || err.message || ''
      Bot.makeLog('warn', [`[${selfId}] 召回消息发送失败`, userOpenid, errMsg, err.response?.data], selfId)

      const period = inviteStore.getUserWakeupPeriod(selfId, userOpenid)
      if (period !== null) {
        inviteStore.markWakeupFailed(selfId, userOpenid, period, errCode, errMsg)
      }

      // 记录特定错误
      if (errCode === 40034122 || errCode === 40054013) {
        inviteStore.markWakeupError(selfId, userOpenid, errCode, errMsg)
      }

      return {
        success: false,
        error: errMsg,
        errCode,
        blocked: errCode === 40054013,
        periodExceeded: errCode === 40034122,
        data: err.response?.data
      }
    }
  }

  makeNotice (id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
      group_id: event.group_id,
      user_id: event.user_id || event.operator_id
    }

    switch (data.sub_type) {
      case 'action':
        return this.makeCallback(id, event)
      case 'increase':
        Bot[data.self_id].dau.setDau('group_increase', data)
        if (event.notice_type === 'group') {
          // GROUP_ADD_ROBOT: 记录 invite + 破冰
          const inviterOpenid = event.operator_id || ''
          if (inviterOpenid) {
            inviteStore.recordGroupAdd(data.self_id, inviterOpenid, event.group_id, event._rawTimestamp || event.raw?._rawTimestamp || event.timestamp || event.time || '')
          }
          // 注入 raw.invite
          data.raw.invite = this._makeInviteRaw(data.self_id, inviterOpenid)
          // 破冰发送
          this._sendIcebreaker(data.self_id, 'group', event.group_id, event.raw?.event_id || event.event_id || '').catch(err => {
            Bot.makeLog('debug', ['群聊破冰发送失败', err.message], data.self_id)
          })
          const path = join(process.cwd(), 'plugins', 'QQBot-Plugin', 'Model', 'template', 'groupIncreaseMsg.js')
          if (fs.existsSync(path)) {
            import(`file://${path}`).then(i => i.default).then(async i => {
              let msg
              if (typeof i === 'function') {
                msg = await i(`${data.self_id}${this.sep}${event.group_id}`, `${data.self_id}${this.sep}${data.user_id}`, data.self_id)
              } else {
                msg = i
              }
              if (msg?.length > 0) {
                this.sendMsg(data, msg => data.bot.sdk.sendGroupMessage(event.group_id, msg), msg)
              }
            })
          }
        }
        if (event.notice_type === 'friend') {
          // FRIEND_ADD: 记录 c2c openid + 破冰
          const userOpenid = event.user_id || ''
          if (userOpenid) {
            inviteStore.recordC2cUser(data.self_id, userOpenid, event.raw?.event_id || event.event_id || '', event._rawTimestamp || event.raw?._rawTimestamp || event.timestamp || event.time || '')
          }
          // 注入 raw.invite
          data.raw.invite = this._makeInviteRaw(data.self_id, userOpenid)
          // 私聊破冰发送
          this._sendIcebreaker(data.self_id, 'friend', userOpenid, event.raw?.event_id || event.event_id || '').catch(err => {
            Bot.makeLog('debug', ['私聊破冰发送失败', err.message], data.self_id)
          })
        }
        return
      case 'decrease':
        Bot[data.self_id].dau.setDau('group_decrease', data)
        if (event.notice_type === 'group') {
          // GROUP_DEL_ROBOT: 记录 kick
          const kickerOpenid = event.operator_id || ''
          if (kickerOpenid) {
            inviteStore.recordGroupDel(data.self_id, kickerOpenid, event.group_id, event._rawTimestamp || event.raw?._rawTimestamp || event.timestamp || event.time || '')
          }
          data.raw.invite = this._makeInviteRaw(data.self_id, kickerOpenid)
        }
        break
      case 'update':
      case 'member.increase':
      case 'member.decrease':
      case 'member.update':
      case 'add':
      case 'remove':
        break
      case 'receive_open':
      case 'receive_close':
        Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
        break
      default:
        Bot.makeLog('warn', ['未知通知', event], id)
    }
  }

  getFriendMap (id) {
    return Bot.getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap (id) {
    return Bot.getMap(`${this.path}${id}/Group`)
  }

  getMemberMap (id) {
    return Bot.getMap(`${this.path}${id}/Member`)
  }

  // ========== 掉线检测相关 ==========

  /**
   * 将毫秒格式化为 "X小时X分钟X秒"
   */
  _formatMs (ms) {
    let s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    s -= h * 3600
    const m = Math.floor(s / 60)
    s -= m * 60
    let result = ''
    if (h) result += `${h}小时`
    if (m) result += `${m}分钟`
    result += `${s}秒`
    return result || '0秒'
  }

  /**
   * 查询账号 Session 信息（remaining / reset_after）
   */
  async _getSessionInfo (id) {
    try {
      const { data } = await Bot[id].sdk.request.get('/gateway/bot')
      if (!data || !data.session_start_limit) return null
      return data.session_start_limit
    } catch (err) {
      Bot.makeLog('debug', [`[${id}] 获取 Session 信息失败`, err.message], id)
      return null
    }
  }

  /**
   * 启动指定 bot 的掉线检测定时器
   */
  startOfflineCheck (id) {
    if (Bot[id]?.disabledRuntime) return
    // 先清理旧定时器
    this.stopOfflineCheck(id)

    const offlineDetect = getOfflineDetectConfig(id)
    if (!offlineDetect.enabled) return

    const intervalMin = Math.max(1, Math.min(30, Number(offlineDetect.interval) || 5))
    const intervalMs = intervalMin * 60 * 1000

    Bot.makeLog('info', [`[${id}] 启动掉线检测，间隔 ${intervalMin} 分钟`], id)

    offlineCheckState.timers[id] = setInterval(async () => {
      await this._doOfflineCheck(id)
    }, intervalMs)
  }

  /**
   * 停止指定 bot 的掉线检测定时器
   */
  stopOfflineCheck (id) {
    if (offlineCheckState.timers[id]) {
      clearInterval(offlineCheckState.timers[id])
      delete offlineCheckState.timers[id]
    }
    // 同时取消等待重置的 timeout（如果有）
    if (offlineCheckState.waitingReset[id]) {
      clearTimeout(offlineCheckState.waitingReset[id])
      delete offlineCheckState.waitingReset[id]
    }
    // 清理心跳超时计时器
    if (Bot[id]?.heartbeatTimer) {
      clearTimeout(Bot[id].heartbeatTimer)
      Bot[id].heartbeatTimer = null
    }
  }

  disableBotRuntime (id, reason = '') {
    this.stopOfflineCheck(id)
    delete offlineCheckState.retrying[id]
    const bot = Bot[id]
    if (!bot) return
    if (bot.disabledRuntime) return
    bot.disabledRuntime = true
    bot.isReconnecting = false
    try { bot.sdk.sessionManager.getAccessToken = async () => ({ access_token: '', expires_in: '0' }) } catch {}
    try { bot.sdk.sessionManager.getWsUrl = async () => '' } catch {}
    try { bot.sdk.start = async () => false } catch {}
    try { bot.sdk.login = async () => false } catch {}
    try { bot.sdk.request.get = async () => ({ status: 204, data: {} }) } catch {}
    try { bot.sdk.sessionManager?.removeAllListeners?.() } catch {}
    try { clearRuntimeTimers(bot.sdk.sessionManager) } catch {}
    try { clearRuntimeTimers(bot.sdk) } catch {}
    try { bot.sdk?.ws?.removeAllListeners?.() } catch {}
    try { bot.sdk?.ws?.terminate?.() } catch {}
    try { bot.sdk?.ws?.close?.() } catch {}
    try { bot.sdk?.stop?.() } catch {}
    try { bot.sdk.logger = Object.fromEntries(['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal'].map(level => [level, () => {}])) } catch {}
    Bot.makeLog('error', [`[${id}] 已停止该机器人运行态${reason ? `：${reason}` : ''}，配置未删除，重启后会按配置重新尝试连接`], id)
  }

  /**
   * 执行一次掉线检测
   */
  async _doOfflineCheck (id) {
  // 正在重连或正在等待 reset_after，跳过本次检测
  if (Bot[id]?.disabledRuntime) return
  if (offlineCheckState.retrying[id] || offlineCheckState.waitingReset[id]) return
  if (!Bot[id]) return

  const offlineDetect = getOfflineDetectConfig(id)
  const sessionInfo = await this._getSessionInfo(id)

  if (!sessionInfo) {
    Bot.makeLog('debug', [`[${id}] 无法获取 Session 信息，跳过本次检测`], id)
    return
  }

  Bot.makeLog('debug', [`[${id}] Session 检测结果`, sessionInfo], id)

  if (sessionInfo.remaining === 0) {
    // remaining=0：配额耗尽，主动断开 ws 连接
    const resetMs = Number(sessionInfo.reset_after) || 0
    const resetStr = this._formatMs(resetMs)

    Bot.makeLog('warn', [`[${id}] Session remaining=0，主动断开连接，将在 ${resetStr} 后自动重连`], id)

    // 主动 logout，避免 ws 占用但收不到消息
    try {
      await Bot[id].logout()
      Bot.makeLog('info', [`[${id}] 已主动断开连接`], id)
    } catch (err) {
      Bot.makeLog('debug', [`[${id}] 主动断开连接失败（忽略）`, err.message], id)
    }

    // 发送掉线提醒
    if (offlineDetect.notify) {
      const notifyMsg = `[${id}] 账号下线：[下线通知]你的帐号当前登录已失效，请${resetStr}后重新登录。\n发送 /Bot上线${id} 重新登录`
      try {
        await Bot.sendMasterMsg(notifyMsg)
      } catch (err) {
        Bot.makeLog('error', ['发送掉线通知失败', err.message], id)
      }
    }

    // 等待 reset_after 到期后直接重连，无需再次检查 remaining
    if (offlineDetect.autoReconnect && resetMs > 0) {
      offlineCheckState.waitingReset[id] = setTimeout(async () => {
        delete offlineCheckState.waitingReset[id]
        await this._doReconnect(id)
      }, resetMs)
    }
  }
  // remaining > 0 说明连接正常，无需处理
}

  /**
   * reset_after 到期后，确认 remaining > 0 再重连
   */
  async _tryReconnectWhenReady (id) {
    if (offlineCheckState.retrying[id]) return
    if (!Bot[id]) return

    const offlineDetect = getOfflineDetectConfig(id)

    const sessionInfo = await this._getSessionInfo(id)
    if (!sessionInfo) {
      Bot.makeLog('warn', [`[${id}] reset_after 到期后无法获取 Session 信息，放弃本次重连`], id)
      return
    }

    if (sessionInfo.remaining <= 0) {
      // 仍然没有次数，继续等待下一轮检测
      Bot.makeLog('warn', [`[${id}] reset_after 到期但 remaining 仍为 0，等待下次检测`], id)
      return
    }

    // remaining > 0，可以重连
    Bot.makeLog('info', [`[${id}] Session remaining=${sessionInfo.remaining}，开始重连`], id)
    await this._doReconnect(id)
  }

  /**
   * 执行重连
   */
  async _doReconnect (id, retryCount = 0) {
  if (Bot[id]?.disabledRuntime) return
  // 如果已经在重连中，跳过（包括重试调用）
  if (offlineCheckState.retrying[id]) {
    Bot.makeLog('warn', [`[${id}] 已在重连中，跳过本次重连 (retryCount=${retryCount})`], id)
    return
  }
  offlineCheckState.retrying[id] = true
  Bot[id].isReconnecting = true  // 设置重连标志

  const offlineDetect = getOfflineDetectConfig(id)
  // 临时固定为10，忽略配置中的 maxRetry（调试完成后删除这行，恢复下面的注释）
  const maxRetries = 10
  // const configMaxRetry = config.bot?.maxRetry
  // let maxRetries = 10
  // if (configMaxRetry === '.inf' || configMaxRetry === Infinity) {
  //   maxRetries = Infinity
  // } else if (typeof configMaxRetry === 'number' && !isNaN(configMaxRetry)) {
  //   maxRetries = configMaxRetry
  // }
  const retryDelay = Math.min(30000, 5000 * (retryCount + 1))  // 5s, 10s, 15s... 最大30s

  Bot.makeLog('warn', [`[${id}] 开始自动重连... (第 ${retryCount + 1} 次尝试)`], id)

  try {
    const bot = Bot[id]
    if (!bot) {
      Bot.makeLog('error', [`[${id}] Bot 实例不存在，无法重连`], id)
      return
    }
    
    // 清理心跳超时计时器
    if (bot.heartbeatTimer) {
      clearTimeout(bot.heartbeatTimer)
      bot.heartbeatTimer = null
    }

    Bot.makeLog('warn', [`[${id}] 正在断开旧连接...`], id)
    try {
      await bot.logout()
      Bot.makeLog('warn', [`[${id}] 旧连接已断开`], id)
    } catch (err) {
      Bot.makeLog('warn', [`[${id}] 断开旧连接失败（忽略）`, err.message], id)
    }

    // 等待一小段时间确保旧连接完全关闭
    await new Promise(resolve => setTimeout(resolve, 1000))

    Bot.makeLog('warn', [`[${id}] 正在重新登录...`], id)
    await bot.login()
    Bot.makeLog('warn', [`[${id}] 重新登录成功`], id)

    // login 成功后重新拦截 sendWs 和绑定 ws 监听（sessionManager 和 ws 可能被重建）
    const heartbeatTimeoutMs = Number(getOfflineDetectConfig(id).heartbeatTimeout) || 30000
    const sessionManager = bot.sdk.sessionManager
    
    // 重新绑定 ws message 监听
    const onWsMessage = (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.op === 11) { // HEARTBEAT_ACK
          if (bot.heartbeatTimer) {
            clearTimeout(bot.heartbeatTimer)
            bot.heartbeatTimer = null
          }
        }
      } catch {}
    }
    if (bot.sdk.ws) {
      bot.sdk.ws.on('message', onWsMessage)
    }

    // 重新拦截 sendWs（总是重新拦截，确保闭包变量正确）
    if (sessionManager) {
      const originalSendWs = sessionManager._originalSendWs || sessionManager.sendWs.bind(sessionManager)
      sessionManager._originalSendWs = originalSendWs
      sessionManager.sendWs = function (msg) {
        // 检查 WebSocket 状态，如果不是 OPEN 状态，跳过发送
        if (!bot.sdk.ws || bot.sdk.ws.readyState !== 1) {
          Bot.makeLog('debug', [`[${id}] WebSocket 未就绪 (readyState=${bot.sdk.ws?.readyState})，跳过发送`], id)
          return
        }
        if (msg?.op === 1) {
          if (bot.heartbeatTimer) {
            clearTimeout(bot.heartbeatTimer)
          }
          bot.lastHeartbeatTime = Date.now()  // 记录发送心跳的时间
          // 如果正在重连中，不设置新的计时器
          if (bot.isReconnecting) {
            return originalSendWs(msg)
          }
          bot.heartbeatTimer = setTimeout(async () => {
            bot.heartbeatTimer = null
            // 检查是否有新的心跳正在发送
            if (bot.lastHeartbeatTime > Date.now() - heartbeatTimeoutMs) {
              Bot.makeLog('debug', [`[${id}] 检测到 SDK 仍在发送心跳，跳过掉线判定`], id)
              return
            }
            // 立即设置重连标志，防止重复触发
            if (bot.isReconnecting) return
            bot.isReconnecting = true
            bot.reconnectCount = (bot.reconnectCount || 0) + 1
            Bot.makeLog('warn', [`[${id}] 心跳超时 (${heartbeatTimeoutMs / 1000}s 无ACK)，判定为掉线`], id)
            if (offlineDetect.notify) {
              try {
                await Bot.sendMasterMsg(`[${id}] 账号下线：[下线通知]你的帐号当前心跳包已失效，正在重连(已经${bot.reconnectCount}次)`)
              } catch (err) {
                Bot.makeLog('error', ['发送心跳超时通知失败', err.message], id)
              }
            }
            if (offlineDetect.autoReconnect) {
              await adapter._doReconnect(id)
            }
          }, heartbeatTimeoutMs)
        }
        return originalSendWs(msg)
      }
      sessionManager._heartbeatHooked = true
    }

    // 重连成功，重置计数和状态
    bot.reconnectCount = 0
    offlineCheckState.retrying[id] = false
    bot.isReconnecting = false
    Bot.makeLog('warn', [`[${id}] 自动重连成功`], id)

    if (offlineDetect.notify) {
      try {
        await Bot.sendMasterMsg(`[${id}] 账号重连成功！`)
      } catch (err) {
        Bot.makeLog('error', ['发送重连成功通知失败', err.message], id)
      }
    }
  } catch (err) {
    Bot.makeLog('error', [`[${id}] 自动重连失败 (第 ${retryCount + 1} 次)`, err.message], id)
    
    // 判断是否还有重试次数（Infinity 永远为 true）
    if (retryCount + 1 < maxRetries) {
      // 还有重试次数，延迟后重试
      Bot.makeLog('warn', [`[${id}] 将在 ${retryDelay / 1000}s 后重试...`], id)
      
      offlineCheckState.waitingReset[id] = setTimeout(async () => {
        delete offlineCheckState.waitingReset[id]
        // 不在这里设置 retrying = false，直接调用 _doReconnect
        await this._doReconnect(id, retryCount + 1)
      }, retryDelay)
      
      return  // 不执行 finally，保持 retrying 状态
    } else {
      // 达到最大重试次数，彻底失败
      Bot.makeLog('error', [`[${id}] 重连失败次数已达上限 (${maxRetries})，停止重试`], id)
      
      if (offlineDetect.notify) {
        try {
          await Bot.sendMasterMsg(`[${id}] 自动重连失败：已达最大重试次数 (${maxRetries === Infinity ? '无限制' : maxRetries})，请手动处理`)
        } catch (e) {
          Bot.makeLog('error', ['发送重连失败通知失败', e.message], id)
        }
      }
    }
  } finally {
    // 只有彻底成功或彻底失败时才清除 retrying 状态
    if (!offlineCheckState.waitingReset[id]) {
      offlineCheckState.retrying[id] = false
      Bot[id].isReconnecting = false  // 清除重连标志
    }
  }
}

  // ========== 掉线检测结束 ==========

async connect (token) {
  token = token.split(':')
  const id = token[0]
  const opts = {
    ...config.bot,
    real_self_id: id,
    appid: token[1],
    token: token[2],
    secret: token[3],
    intents: [
      'GUILDS',
      'GUILD_MEMBERS',
      'GUILD_MESSAGE_REACTIONS',
      'DIRECT_MESSAGE',
      'INTERACTION',
      'MESSAGE_AUDIT'
    ],
    mode: 'websocket'
  }

  if (Number(token[4])) opts.intents.push('GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE')
  if (Number(token[5])) opts.intents.push('GUILD_MESSAGES')
  else opts.intents.push('PUBLIC_GUILD_MESSAGES')

  let sdk = new QQBot(opts)
  const enterReadOnlyMode = (detail) => {
    Bot[id].readOnlyMode = true
    Bot.makeLog('error', [`[${id}] 当前机器人为只读模式，只接收消息，不处理任何指令`, detail], id)
    return {
      status: 200,
      data: {
        url: 'wss://api.sgroup.qq.com/websocket',
        shards: 1
      }
    }
  }

  const enterDefaultWsMode = (detail) => {
    Bot[id].defaultWsMode = true
    Bot.makeLog('warn', [`[${id}] 机器人已注销，使用默认 websocket 地址继续处理消息`, detail], id)
    return {
      status: 200,
      data: {
        url: 'wss://api.sgroup.qq.com/websocket',
        shards: 1
      }
    }
  }

  const originalRequestGet = sdk.request.get.bind(sdk.request)
  sdk.request.get = async function (url, ...args) {
    try {
      return await originalRequestGet(url, ...args)
    } catch (err) {
      if (url === '/gateway/bot' && isQQBotCanceledError(err)) {
        return enterDefaultWsMode(err.message)
      }
      if (url === '/gateway/bot' && isQQBotReadOnlyError(err)) {
        return enterReadOnlyMode(err.message)
      }
      throw err
    }
  }

  sdk.request.interceptors.response.use(res => res, err => {
    if (isQQBotReadOnlyError(err.response?.data)) {
      return Promise.resolve(enterReadOnlyMode(err.response?.data))
    }
    return Promise.reject(err)
  })
  const originalGetWsUrl = sdk.sessionManager.getWsUrl.bind(sdk.sessionManager)
  sdk.sessionManager.getWsUrl = async function () {
    try {
      return await originalGetWsUrl()
    } catch (err) {
      if (isQQBotCanceledError(err)) {
        enterDefaultWsMode(err.message)
        this.wsUrl = 'wss://api.sgroup.qq.com/websocket'
        this.shards = 1
        return this.wsUrl
      }
      if (!isQQBotReadOnlyError(err)) throw err
      enterReadOnlyMode(err.message)
      this.wsUrl = 'wss://api.sgroup.qq.com/websocket'
      this.shards = 1
      return this.wsUrl
    }
  }
   
  if (config.bus?.[id]) {
    let keys = Object.keys(config.bus)
    const { sandbox, appid } = opts
    const base = sandbox
      ? `https://${config.bus[id]}/proxy?url=https://sandbox.api.sgroup.qq.com`
      : `https://${config.bus[id]}/proxy?url=https://api.sgroup.qq.com`
    sdk.request.defaults.baseURL = base
    const { SessionManager } = require('qq-official-bot/lib/sessionManager.js')
    Object.assign(SessionManager.prototype, {
      getWsUrl: async function () {
        return new Promise((resolve) => {
          this.bot.request
            .get('/gateway/bot', {
              headers: {
                Accept: '*/*',
                'Accept-Encoding': 'utf-8',
                'Accept-Language': 'zh-CN,zh;q=0.8',
                Connection: 'keep-alive',
                'User-Agent': 'v1',
                Authorization: ''
              }
            })
            .then((res) => {
              if (!res.data) throw new Error('获取ws连接信息异常')
              this.wsUrl = keys.some(i => i == this.bot.config.real_self_id) 
                ? `wss://${config.bus[id]}/ws?url=${res.data.url}&appid=${appid}` 
                : res.data.url
              logger.info(`WebSocket URL 已更新: ${this.wsUrl}`)
              resolve(this.wsUrl)
            })
        })
      }
    })
  }

  Bot[id] = {
    adapter: this,
    sdk,
    login () {
      return new Promise((resolve, reject) => {
        if (this.disabledRuntime) {
          resolve(false)
          return
        }
        // 清理旧的心跳超时计时器和重连标志
        if (this.heartbeatTimer) {
          clearTimeout(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        this.isReconnecting = false

        const timer = setTimeout(() => {
          if (this.disabledRuntime) {
            resolve(false)
            return
          }
          reject(new Error('login timeout after 60s'))
        }, 60000)
        
        this.sdk.sessionManager.once('READY', () => {
          clearTimeout(timer)
          this.reconnectCount = 0  // 登录成功，重置重连计数
          resolve()
        })
        
        this.sdk.sessionManager.once('DEAD', (data) => {
          clearTimeout(timer)
          const authError = getQQBotAuthError(data)
          if (authError) {
            Bot.makeLog('error', [`[${id}] ${authError}，中断连接`, data], id)
            reject(new Error(authError))
            return
          }
          if (isQQBotReadOnlyError(data)) {
            this.readOnlyMode = true
            Bot.makeLog('error', [`[${id}] 当前机器人为只读模式，只接收消息，不处理任何指令`, data], id)
            return
          }
          reject(new Error(data.msg || 'connection dead'))
        })
        
        // 捕获 start() 内部的异步错误（如 getAccessToken 失败）
        this.sdk.start().catch(err => {
          clearTimeout(timer)
          if (this.disabledRuntime) {
            resolve(false)
            return
          }
          if (isQQBotReadOnlyError(err)) {
            this.readOnlyMode = true
            Bot.makeLog('error', [`[${id}] 当前机器人为只读模式，只接收消息，不处理任何指令`, err.message], id)
            resolve()
            return
          }
          if (isQQBotCanceledError(err)) {
            Bot.makeLog('error', [`[${id}] 机器人已注销，尝试默认 websocket 地址`, err.message], id)
            resolve()
            return
          }
          Bot.makeLog('error', ['SDK start() 失败', err.message], id)
          reject(err)
        })
      })
    },
    logout () {
      return new Promise((resolve) => {
        // 清理心跳超时计时器
        if (this.heartbeatTimer) {
          clearTimeout(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        // 如果 ws 已经关闭或不存在，直接返回
        if (!this.sdk.ws || this.sdk.ws.readyState !== 1) {
          try { this.sdk.stop() } catch {}
          resolve()
          return
        }
        // 设置超时，避免永远等待
        const timer = setTimeout(() => {
          resolve()
        }, 5000)
        this.sdk.ws.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          this.sdk.stop()
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    },

    uin: id,
    info: { id, ...opts },
    get nickname () { return this.sdk.nickname },
    get avatar () { return `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}` },

    version: {
      id: this.id,
      name: this.name,
      version: this.version
    },
    stat: {
      start_time: Date.now() / 1000,
      recv_msg_cnt: 0
    },

    pickFriend: user_id => this.pickFriend(id, user_id),
    get pickUser () { return this.pickFriend },
    getFriendMap () { return this.fl },
    fl: await this.getFriendMap(id),

    pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
    pickGroup: group_id => this.pickGroup(id, group_id),
    getGroupMap () { return this.gl },
    gl: await this.getGroupMap(id),
    gml: await this.getMemberMap(id),

    uploadImage: (file, opts = {}) => this.uploadImage(file, id, opts),

    dau: new Dau(id, this.sep, config.dauDB),

    callback: {}
  }

  Bot[id].sdk.logger = {}
  for (const i of ['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal']) {
    Bot[id].sdk.logger[i] = (...args) => {
      if (Bot[id]?.disabledRuntime) return
      const fatalWsErrorText = i === 'error'
        ? args.map(arg => getQQBotFatalWsErrorText(arg)).find(text => text && (text === '机器人停止服务(被回收)，请重新提审' || Bot[id]?.readOnlyMode))
        : ''
      if (fatalWsErrorText) {
        Bot.makeLog('error', [`[${id}] ${fatalWsErrorText}`, args], id)
        this.disableBotRuntime(id, `只读模式且${fatalWsErrorText}`)
        return
      }
      if (config.simplifiedSdkLog) {
        if (args?.[0]?.match?.(/^send to/)) {
          args[0] = args[0].replace(/<(.+?)(,.*?)>/g, (v, k1) => `<${k1}>`)
        } else if (args?.[0]?.match?.(/^recv from/)) {
          return
        }
      }
      Bot.makeLog(i, args, id)
    }
  }

   // ===== 拦截 sessionManager.start()，防止 SDK 内部重连抛出 unhandled rejection =====
  const smForStart = Bot[id].sdk.sessionManager
  const originalSmStart = smForStart.start.bind(smForStart)
  smForStart.start = async function () {
    try {
      return await originalSmStart()
    } catch (err) {
      Bot.makeLog('error', [`[${id}] SDK 内部重连失败 (已捕获)`, err.message], id)
      // 如果是 4009 或 timeout，交给我们自己的重连逻辑
      if (!Bot[id]?.disabledRuntime && !Bot[id]?.isReconnecting) {
        const offlineDetect = getOfflineDetectConfig(id)
        if (offlineDetect.autoReconnect || offlineDetect.enabled) {
          Bot.makeLog('warn', [`[${id}] 将由插件重连逻辑接管`], id)
          adapter._doReconnect(id).catch(e => Bot.makeLog('error', [`[${id}] 插件重连也失败`, e.message], id))
        }
      }
    }
  }

  // ===== 拦截 getAccessToken，添加重试机制和 token 过期检查 =====
  const tokenSessionManager = Bot[id].sdk.sessionManager
  const originalGetAccessToken = tokenSessionManager.getAccessToken.bind(tokenSessionManager)
  
  // 记录 token 过期时间
  Bot[id].tokenExpireTime = 0
  
  tokenSessionManager.getAccessToken = async function () {
    const retryDelays = [1, 3, 5, 7, 10]  // 第一轮重试延迟（秒）
    const maxRounds = 5  // 最大轮数（25次重试）
    const maxDelay = 60  // 最大延迟（秒）

    let totalFailures = 0

    const getTokenWithRetry = async (round = 0) => {
      const delays = retryDelays.map(d => d + round * 10)  // 每轮增加10s

      for (let i = 0; i < delays.length; i++) {
        try {
          const token = await new Promise((resolve, reject) => {
            const { secret, appid } = this.bot.config
            axios.post("https://bots.qq.com/app/getAppAccessToken", {
              appId: appid,
              clientSecret: secret
            }).then(res => {
              if (res.status === 200 && res.data && typeof res.data === "object" && res.data.access_token) {
                resolve(res.data)
              } else {
                const authError = getQQBotAuthError(res.data)
                const err = new Error(authError || 'Invalid response')
                err.response = res
                reject(err)
              }
            }).catch(reject)
          })

          this.bot.logger.warn("getAccessToken", token)
          this.access_token = token.access_token
          // 记录过期时间（提前60秒刷新，留出缓冲时间）
          const expiresIn = parseInt(token.expires_in)
          Bot[id].tokenExpireTime = Date.now() + (expiresIn - 60) * 1000
          this.bot.logger.warn(`[TOKEN] access_token 已刷新，过期时间: ${expiresIn}秒，将在 ${Math.round((expiresIn - 60) / 60)} 分钟后刷新`)
          return token
        } catch (err) {
          const authError = getQQBotAuthError(err.response?.data)
          if (authError) {
            this.bot.logger.error(`[TOKEN] ${authError}，中断连接`, err.response?.data)
            throw new Error(authError)
          }

          totalFailures++
          this.bot.logger.warn(`[TOKEN] 获取 access_token 失败 (${totalFailures}次): ${err.message}`)

          // 每5次失败发送通知
          if (totalFailures % 5 === 0) {
            const offlineDetect = getOfflineDetectConfig(id)
            if (offlineDetect.notify) {
              try {
                await Bot.sendMasterMsg(`[${id}] 账号下线：[下线通知]你的帐号当前token已失效，(已经${totalFailures}次失败)，${Math.min(delays[i] + 2, maxDelay)}s后继续`)
              } catch {}
            }
          }

          // 检查是否达到最大重试次数
          if (totalFailures >= maxRounds * retryDelays.length) {
            this.bot.logger.error(`[TOKEN] 获取 access_token 失败已达上限 (${totalFailures}次)，放弃连接`)
            if (getOfflineDetectConfig(id).notify) {
              try {
                await Bot.sendMasterMsg(`[${id}] 获取token失败已达上限 (${totalFailures}次)，请手动处理`)
              } catch {}
            }
            throw new Error(`getAccessToken failed after ${totalFailures} retries`)
          }

          // 等待后重试
          const delay = Math.min(delays[i], maxDelay)
          this.bot.logger.warn(`[TOKEN] ${delay}s 后重试...`)
          await new Promise(resolve => setTimeout(resolve, delay * 1000))
        }
      }

      // 当前轮失败，递归进入下一轮
      return getTokenWithRetry(round + 1)
    }

    return getTokenWithRetry()
  }
  
  // 添加 axios 请求拦截器，在请求前检查 token 是否过期
  Bot[id].sdk.request.interceptors.request.use(async (config) => {
    // 如果 token 即将过期（60秒内），先刷新
    if (Bot[id].tokenExpireTime && Date.now() > Bot[id].tokenExpireTime) {
      Bot.makeLog('warn', [`[${id}] Token 即将过期，正在刷新...`], id)
      try {
        await tokenSessionManager.getAccessToken()
      } catch (err) {
        Bot.makeLog('error', [`[${id}] 刷新 Token 失败`, err.message], id)
      }
    }
    return config
  })
  // ===== getAccessToken 拦截结束 =====

  // 捕获初次登录失败，不抛出错误，交由掉线检测处理
  try {
    await Bot[id].login()
  } catch (err) {
    if (Bot[id]?.disabledRuntime) return false
    Bot.makeLog('error', [`[${id}] 初次登录失败`, err.message], id)
    // 不返回 false，继续初始化其他部分
  }
  if (Bot[id]?.disabledRuntime) return false
  
  await Bot[id].dau.init()

  Bot[id].sdk.on('message', event => this.makeMessage(id, event))
  Bot[id].sdk.on('notice', event => this.makeNotice(id, event))

  // ===== 心跳超时检测 =====
  const heartbeatTimeoutMs = Number(getOfflineDetectConfig(id).heartbeatTimeout) || 60000  // 默认60秒
  Bot[id].heartbeatTimer = null
  Bot[id].reconnectCount = 0  // 重连次数计数
  Bot[id].isReconnecting = false  // 是否正在重连中
  Bot[id].lastHeartbeatTime = 0  // 最后一次发送心跳的时间

  const clearHeartbeatTimer = () => {
    if (Bot[id].heartbeatTimer) {
      clearTimeout(Bot[id].heartbeatTimer)
      Bot[id].heartbeatTimer = null
    }
  }

  // 收到ACK时清除计时器
  const onWsMessage = (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.op === 11) { // HEARTBEAT_ACK
        clearHeartbeatTimer()
      }
    } catch {}
  }

  // 绑定 ws message 事件
  if (Bot[id].sdk.ws) {
    Bot[id].sdk.ws.on('message', onWsMessage)
  }

  // 拦截 sendWs，在发送心跳时启动计时器
  const sessionManager = Bot[id].sdk.sessionManager
  const originalSendWs = sessionManager.sendWs.bind(sessionManager)
  sessionManager.sendWs = function (msg) {
    // 检查 WebSocket 状态，如果不是 OPEN 状态，跳过发送
    if (!Bot[id].sdk.ws || Bot[id].sdk.ws.readyState !== 1) {
      Bot.makeLog('debug', [`[${id}] WebSocket 未就绪 (readyState=${Bot[id].sdk.ws?.readyState})，跳过发送`], id)
      return
    }
    if (msg?.op === 1) { // HEARTBEAT
      clearHeartbeatTimer()
      Bot[id].lastHeartbeatTime = Date.now()  // 记录发送心跳的时间
      // 如果正在重连中，不设置新的计时器
      if (Bot[id].isReconnecting) {
        return originalSendWs(msg)
      }
      Bot[id].heartbeatTimer = setTimeout(async () => {
        Bot[id].heartbeatTimer = null
        // 检查是否有新的心跳正在发送（如果 lastHeartbeatTime 更新了，说明 SDK 还在发心跳）
        if (Bot[id].lastHeartbeatTime > Date.now() - heartbeatTimeoutMs) {
          Bot.makeLog('debug', [`[${id}] 检测到 SDK 仍在发送心跳，跳过掉线判定`], id)
          return
        }
        // 立即设置重连标志，防止重复触发
        if (Bot[id].isReconnecting) return
        Bot[id].isReconnecting = true
        Bot[id].reconnectCount = (Bot[id].reconnectCount || 0) + 1
        Bot.makeLog('warn', [`[${id}] 心跳超时 (${heartbeatTimeoutMs / 1000}s 无ACK)，判定为掉线`], id)
        const offlineDetect = getOfflineDetectConfig(id)
        if (offlineDetect.notify) {
          try {
            await Bot.sendMasterMsg(`[${id}] 账号下线：[下线通知]你的帐号当前心跳包已失效，正在重连(已经${Bot[id].reconnectCount}次)`)
          } catch (err) {
            Bot.makeLog('error', ['发送心跳超时通知失败', err.message], id)
          }
        }
        if (offlineDetect.autoReconnect) {
          await adapter._doReconnect(id)
        }
      }, heartbeatTimeoutMs)
    }
    return originalSendWs(msg)
  }
  sessionManager._heartbeatHooked = true

  // SDK 重连成功后重新绑定 ws 监听和 sendWs 拦截
  sessionManager.on('READY', () => {
    if (Bot[id]?.sdk?.ws) {
      Bot[id].sdk.ws.on('message', onWsMessage)
    }
    // 重连成功，重置计数和标志
    Bot[id].reconnectCount = 0
    Bot[id].isReconnecting = false
    // 重新拦截 sendWs（总是重新拦截，确保闭包变量正确）
    const newSessionManager = Bot[id].sdk.sessionManager
    if (newSessionManager) {
      const newOriginalSendWs = newSessionManager._originalSendWs || newSessionManager.sendWs.bind(newSessionManager)
      newSessionManager._originalSendWs = newOriginalSendWs
      newSessionManager.sendWs = function (msg) {
        // 检查 WebSocket 状态，如果不是 OPEN 状态，跳过发送
        if (!Bot[id].sdk.ws || Bot[id].sdk.ws.readyState !== 1) {
          Bot.makeLog('debug', [`[${id}] WebSocket 未就绪 (readyState=${Bot[id].sdk.ws?.readyState})，跳过发送`], id)
          return
        }
        if (msg?.op === 1) {
          clearHeartbeatTimer()
          Bot[id].lastHeartbeatTime = Date.now()  // 记录发送心跳的时间
          // 如果正在重连中，不设置新的计时器
          if (Bot[id].isReconnecting) {
            return newOriginalSendWs(msg)
          }
          Bot[id].heartbeatTimer = setTimeout(async () => {
            Bot[id].heartbeatTimer = null
            // 检查是否有新的心跳正在发送
            if (Bot[id].lastHeartbeatTime > Date.now() - heartbeatTimeoutMs) {
              Bot.makeLog('debug', [`[${id}] 检测到 SDK 仍在发送心跳，跳过掉线判定`], id)
              return
            }
            // 立即设置重连标志，防止重复触发
            if (Bot[id].isReconnecting) return
            Bot[id].isReconnecting = true
            Bot[id].reconnectCount = (Bot[id].reconnectCount || 0) + 1
            Bot.makeLog('warn', [`[${id}] 心跳超时 (${heartbeatTimeoutMs / 1000}s 无ACK)，判定为掉线`], id)
            const offlineDetect = getOfflineDetectConfig(id)
            if (offlineDetect.notify) {
              try {
                await Bot.sendMasterMsg(`[${id}] 账号下线：[下线通知]你的帐号当前心跳包已失效，正在重连(已经${Bot[id].reconnectCount}次)`)
              } catch (err) {
                Bot.makeLog('error', ['发送心跳超时通知失败', err.message], id)
              }
            }
            if (offlineDetect.autoReconnect) {
              await adapter._doReconnect(id)
            }
          }, heartbeatTimeoutMs)
        }
        return newOriginalSendWs(msg)
      }
      newSessionManager._heartbeatHooked = true
    }
  })
  // ===== 心跳超时检测结束 =====

  // 启动掉线检测
  this.startOfflineCheck(id)

  Bot.makeLog('mark', `${this.name}(${this.id}) ${this.version} 已连接`, id)
  Bot.em(`connect.${id}`, { self_id: id })
  return true
}

  async load () {
    for (const token of config.token) {
      await new Promise(resolve => {
        adapter.connect(token).then(resolve)
        setTimeout(resolve, 5000)
      })
    }
  }
}()

Bot.adapter.push(adapter)

const cleanedBotConfig = migrateLegacyBotConfig()

initFullMessageStore(config).then(cleanedConfig => {
  if (cleanedConfig || cleanedBotConfig) configSave()
})

initInviteStore(config).catch(err => {
  Bot.makeLog?.('error', ['inviteStore 初始化失败', err.message], 'QQBot-Plugin')
})

const setMap = {
  二维码: 'toQRCode',
  按钮回调: 'toCallback',
  强制silk: 'forceSilk',
  转换: 'toQQUin',
  转图片: 'toImg',
  调用统计: 'callStats',
  用户统计: 'userStats'
}

export class QQBotAdapter extends plugin {
  constructor () {
    super({
      name: 'QQBotAdapter',
      dsc: 'QQBot 适配器设置',
      event: 'message',
      rule: [
        {
          reg: /^#q+bot(帮助|help)$/i,
          fnc: 'help',
          permission: config.permission
        },
        {
          reg: /^#q+bot账号$/i,
          fnc: 'List',
          permission: config.permission
        },
        {
          reg: /^#q+bot设置[0-9]+:[0-9]+:.+:.+:[01]:[01]$/i,
          fnc: 'Token',
          permission: config.permission
        },
        {
          reg: /^#q+botm(ark)?d(own)?[0-9]+:/i,
          fnc: 'Markdown',
          permission: config.permission
        },
        {
          reg: new RegExp(`^#q+bot设置(${Object.keys(setMap).join('|')})\\s*(开启|关闭)$`, 'i'),
          fnc: 'Setting',
          permission: config.permission
        },
        {
          reg: /^#q+botdau/i,
          fnc: 'DAUStat',
          permission: config.permission
        },
        {
          reg: /^#q+bot调用统计$/i,
          fnc: 'callStat',
          permission: config.permission
        },
        {
          reg: /^#q+bot用户统计$/i,
          fnc: 'userStat',
          permission: config.permission
        },
        {
          reg: /^#q+bot刷新co?n?fi?g$/i,
          fnc: 'refConfig',
          permission: config.permission
        },
        {
          reg: /^#q+bot(添加|删除)过滤日志/i,
          fnc: 'filterLog',
          permission: config.permission
        },
        {
          reg: /^#q+bot一键群发$/i,
          fnc: 'oneKeySendGroupMsg',
          permission: config.permission
        },
        {
          reg: /^#q+bot账号掉线检测\s*(开启|关闭)$/i,
          fnc: 'setOfflineDetect',
          permission: config.permission
        },
        {
          reg: /^#q+bot账号掉线提醒\s*(开启|关闭)$/i,
          fnc: 'setOfflineNotify',
          permission: config.permission
        },
        {
          reg: /^#q+bot账号掉线自动重连\s*(开启|关闭)$/i,
          fnc: 'setOfflineAutoReconnect',
          permission: config.permission
        },
        {
          reg: /^#q+bot账号掉线检测时间设置\s*(\d+)\s*分钟$/i,
          fnc: 'setOfflineInterval',
          permission: config.permission
        },
        {
          reg: /^#q+bot普通设置(?:\s*强制silk\s*(开启|关闭))?$/i,
          fnc: 'normalSetting',
          permission: config.permission
        },
        {
          reg: /^#q+bot高级设置(?:\s*(龙虾在线|龙虾json|龙虾code)(?:\s+(.+))?)?$/i,
          fnc: 'advancedSetting',
          permission: config.permission
        },
        {
          reg: /^#q+bot全量消息设置(?:\s*(配置限制|配置bot限制\s*(?:开启|关闭)|bot限制设置\s*\d+条\d+分钟|忽略其他机器人(?:总开关|正常@)?\s*(?:开启|关闭)|仅回复isyou\s*(?:开启|关闭)|处理无isyou\s*(?:开启|关闭)|忽略全体isyou\s*(?:开启|关闭)|isyou严判\s*(?:开启|关闭)|仅回复@机器人\s*(?:开启|关闭)|处理非@消息\s*(?:开启|关闭)|忽略@全体的指令\s*(?:开启|关闭)|全体通知\s*(?:开启|关闭)|@机器人严判\s*(?:开启|关闭)|记录群\s*(?:开启|关闭)))?$/i,
          fnc: 'fullMessageSetting',
          permission: config.permission
        },
        {
          reg: /^#q+bot全量查看(?:\s+(\d+))?$/i,
          fnc: 'fullMessageRecords',
          permission: config.permission
        },
        {
          reg: /^#q+bot全量清空(确认)?$/i,
          fnc: 'fullMessageClear',
          permission: config.permission
        },
        {
          reg: /^#q+bot全量存储\s*(json|level)$/i,
          fnc: 'fullMessageDB',
          permission: config.permission
        },
        {
          reg: /^#q+bot破冰(菜单|设置)(?:\s+([\s\S]+))?$/i,
          fnc: 'icebreakerSetting',
          permission: config.permission
        },
        {
          reg: /^#q+bot召回菜单$/i,
          fnc: 'recallMenu',
          permission: config.permission
        },
        {
          reg: /^#q+bot(可|不可)召回列表(?:\s+(\d+))?$/i,
          fnc: 'recallList',
          permission: config.permission
        },
        {
          reg: /^#q+bot召回查看$/i,
          fnc: 'recallOverview',
          permission: config.permission
        },
        {
          reg: /^#q+bot单独召回\s+(\S+)(?:\s+强制)?$/i,
          fnc: 'recallSingle',
          permission: config.permission
        },
        {
          reg: /^#q+bot全部召回设置数量\s+(\d+)$/i,
          fnc: 'recallBatchSetCount',
          permission: config.permission
        },
        {
          reg: /^#q+bot全部召回修改\s+(\d+)$/i,
          fnc: 'recallBatchModify',
          permission: config.permission
        },
        {
          reg: /^#q+bot全部召回确认(?:\s+强制)?$/i,
          fnc: 'recallBatchConfirm',
          permission: config.permission
        },
        {
          reg: /^#q+bot召回设置(?:\s+([\s\S]+))?$/i,
          fnc: 'recallSetting',
          permission: config.permission
        },
        {
          reg: /^#q+bot召回预览$/i,
          fnc: 'recallPreview',
          permission: config.permission
        },
        {
          reg: /^#q+bot召回发送预览$/i,
          fnc: 'recallSendPreview',
          permission: config.permission
        }
      ]
    })
  }

  // ==================== 官方机器人检测 (ICQQ无法登录官方机器人) ====================
  isOfficialBot (number) {
    number = Number(number)
    return Number.isFinite(number) && (
      (number >= 2854000000 && number <= 2855000000) ||
      (number >= 2854196301 && number <= 2854216399) ||
      (number >= 3889000000 && number <= 3890000000) ||
      number === 3328144510 ||
      number === 66600000 ||
      (number >= 4010000000 && number <= 4019999999)
    )
  }

  isOfficialBotEvent () {
    return this.isOfficialBot(this.e?.self_id)
  }

  guardOfficialBot () {
    if (this.isOfficialBotEvent()) return true
    this.e.reply(`[${this.e.msg || ''}]\n你是人机吗？\n请检查适配器是否是QQbot。\n反正群主一定是人机。`)
    return false
  }

  help () {
  if (!this.guardOfficialBot()) return true
  const botConfig = ensureBotConfig(this.e.self_id)
  const od = getOfflineDetectConfig(this.e.self_id)
  const isRawMarkdown = config.markdown?.[this.e.self_id] === 'raw'
  
  if (isRawMarkdown) {
    // Markdown 模式（带参数指令和按钮）
    this.reply([
      '📊 查询统计\n\n' +
      '<qqbot-cmd-input text="#QQBotdau" show="DAU查询" />\n' +
      '<qqbot-cmd-input text="#QQBot全量消息设置" show="全量消息设置" />\n' +
      '<qqbot-cmd-input text="#QQBot调用统计" show="调用统计查询" />\n' +
      '<qqbot-cmd-input text="#QQBot用户统计" show="用户统计查询" />\n' +
      '<qqbot-cmd-input text="#QQBot账号" show="账号列表查询" />\n\n' +
      '⚙️ 功能开关\n\n' +
      `<qqbot-cmd-input text="#QQBot设置按钮回调${botConfig.toCallback ? '关闭' : '开启'}" show="${botConfig.toCallback ? '关闭' : '开启'}按钮回调" />\n` +
      `<qqbot-cmd-input text="#QQBot设置调用统计${botConfig.callStats ? '关闭' : '开启'}" show="${botConfig.callStats ? '关闭' : '开启'}调用统计" />\n` +
      `<qqbot-cmd-input text="#QQBot设置用户统计${botConfig.userStats ? '关闭' : '开启'}" show="${botConfig.userStats ? '关闭' : '开启'}用户统计" />\n` +
      `<qqbot-cmd-input text="#QQBot设置转图片${botConfig.toImg ? '关闭' : '开启'}" show="${botConfig.toImg ? '关闭' : '开启'}转图片" />\n` +
      `<qqbot-cmd-input text="#QQBot设置二维码${botConfig.toQRCode ? '关闭' : '开启'}" show="${botConfig.toQRCode ? '关闭' : '开启'}二维码" />\n` +
      `<qqbot-cmd-input text="#QQBot设置转换${botConfig.toQQUin ? '关闭' : '开启'}" show="${botConfig.toQQUin ? '关闭' : '开启'}QQ转换" />`,
      segment.button(
        [
          { text: 'DAU', callback: '#QQBotdau' },
          { text: '全量设置', callback: '#QQBot全量消息设置' }
        ],
        [
          { text: '调用统计', callback: '#QQBot调用统计' },
          { text: '用户统计', callback: '#QQBot用户统计' }
        ],
        [
          { text: '账号列表', callback: '#QQBot账号' },
          { text: `${botConfig.toCallback ? '关' : '开'}回调`, callback: `#QQBot设置按钮回调${botConfig.toCallback ? '关闭' : '开启'}` }
        ],
        [
          { text: `${botConfig.toImg ? '关' : '开'}转图`, callback: `#QQBot设置转图片${botConfig.toImg ? '关闭' : '开启'}` },
          { text: `${botConfig.toQRCode ? '关' : '开'}二维码`, callback: `#QQBot设置二维码${botConfig.toQRCode ? '关闭' : '开启'}` }
        ],
        [
          { text: `${botConfig.toQQUin ? '关' : '开'}QQ转换`, callback: `#QQBot设置转换${botConfig.toQQUin ? '关闭' : '开启'}` },
          { text: '刷新配置', callback: '#QQBot刷新config' }
        ]
      )
    ])
    
    this.reply([
      '🔌 掉线检测\n\n' +
      `<qqbot-cmd-input text="#QQBot账号掉线检测${od.enabled ? '关闭' : '开启'}" show="${od.enabled ? '关闭' : '开启'}掉线检测" />\n` +
      `<qqbot-cmd-input text="#QQBot账号掉线提醒${od.notify ? '关闭' : '开启'}" show="${od.notify ? '关闭' : '开启'}掉线提醒" />\n` +
      `<qqbot-cmd-input text="#QQBot账号掉线自动重连${od.autoReconnect ? '关闭' : '开启'}" show="${od.autoReconnect ? '关闭' : '开启'}自动重连" />\n` +
      '<qqbot-cmd-input text="#QQBot普通设置" show="普通设置" />\n' +
      '<qqbot-cmd-input text="#QQBot账号掉线检测时间设置 5分钟" show="检测间隔5分钟" />\n' +
      '<qqbot-cmd-input text="#QQBot账号掉线检测时间设置 10分钟" show="检测间隔10分钟" />\n\n' +
      '🛠️ 管理功能\n\n' +
      '<qqbot-cmd-input text="#QQBot添加过滤日志 " show="添加过滤日志" />\n' +
      '<qqbot-cmd-input text="#QQBot删除过滤日志 " show="删除过滤日志" />\n' +
      '<qqbot-cmd-input text="#QQBot破冰菜单" show="破冰菜单" />\n' +
      '<qqbot-cmd-input text="#QQBot高级设置" show="高级设置" />',
      segment.button(
        [
          { text: `${od.enabled ? '关' : '开'}检测`, callback: `#QQBot账号掉线检测${od.enabled ? '关闭' : '开启'}` },
          { text: `${od.notify ? '关' : '开'}提醒`, callback: `#QQBot账号掉线提醒${od.notify ? '关闭' : '开启'}` }
        ],
        [
          { text: `${od.autoReconnect ? '关' : '开'}重连`, callback: `#QQBot账号掉线自动重连${od.autoReconnect ? '关闭' : '开启'}` },
          { text: '普通设置', callback: '#QQBot普通设置' }
        ],
        [
          { text: '间隔5分钟', callback: '#QQBot账号掉线检测时间设置5分钟' },
          { text: '间隔10分钟', callback: '#QQBot账号掉线检测时间设置10分钟' }
        ],
        [
          { text: '添加过滤', input: '#QQBot添加过滤日志 ' },
          { text: '删除过滤', input: '#QQBot删除过滤日志 ' }
        ],
        [
          { text: '破冰菜单', callback: '#QQBot破冰菜单' },
          { text: '高级设置', callback: '#QQBot高级设置' }
        ]
      )
    ])
  } else {
    // 普通文本模式（纯文本帮助）
    this.reply(
      '━ QQBot 帮助菜单━\n' +
      '📊 查询统计\n' +
      '#QQBotdau - DAU统计\n' +
      '#QQBot全量消息设置 - 查看/修改全量消息设置\n' +
      '#QQBot全量存储 <json|level> - 切换全量消息记录存储方式\n' +
      '#QQBot调用统计 - 查看调用统计\n' +
      '#QQBot用户统计 - 查看用户统计\n' +
      '#QQBot账号 - 查看账号列表\n\n' +
      '⚙️ 功能开关\n' +
      `#QQBot设置按钮回调开启/关闭 [当前: ${botConfig.toCallback ? '开启' : '关闭'}]\n` +
      `#QQBot设置调用统计开启/关闭 [当前: ${botConfig.callStats ? '开启' : '关闭'}]\n` +
      `#QQBot设置用户统计开启/关闭 [当前: ${botConfig.userStats ? '开启' : '关闭'}]\n` +
      `#QQBot设置转图片开启/关闭 [当前: ${botConfig.toImg ? '开启' : '关闭'}]\n` +
      `#QQBot设置二维码开启/关闭 [当前: ${botConfig.toQRCode ? '开启' : '关闭'}]\n` +
      `#QQBot设置转换开启/关闭 [当前: ${botConfig.toQQUin ? '开启' : '关闭'}]\n\n` +
      '🔌 掉线检测\n' +
      `#QQBot账号掉线检测开启/关闭 [当前: ${od.enabled ? '开启' : '关闭'}]\n` +
      `#QQBot账号掉线提醒开启/关闭 [当前: ${od.notify ? '开启' : '关闭'}]\n` +
      `#QQBot账号掉线自动重连开启/关闭 [当前: ${od.autoReconnect ? '开启' : '关闭'}]\n` +
      '#QQBot账号掉线检测时间设置 X分钟 (1-30分钟)\n\n' +
      '🛠️ 管理功能\n' +
      '#QQBot添加过滤日志 <消息内容>\n' +
      '#QQBot删除过滤日志 <消息内容>\n' +
      '#QQBot破冰菜单 - 破冰/一键群发设置\n' +
      '#QQBot高级设置 - 查看/修改高级设置\n' +
      '#QQBot刷新config - 刷新配置文件\n\n' +
      '━━━━━━━', 
      true
    )
  }
}

  refConfig () {
    if (!this.guardOfficialBot()) return true
    refConfig()
    ensureFullMessageConfig(config, this.e.self_id)
  }

  List () {
    if (!this.guardOfficialBot()) return true
    const accounts = config.token.map(token => String(token).split(':')[0]).filter(Boolean)
    this.reply(`共${config.token.length}个账号：\n${accounts.join('\n')}`, true)
  }

  async Token () {
    if (!this.guardOfficialBot()) return true
    const token = this.e.msg.replace(/^#q+bot设置/i, '').trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item != token)
      this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await adapter.connect(token)) {
        config.token.push(token)
        this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        this.reply('账号连接失败', true)
        return false
      }
    }
    await configSave()
  }

  async Markdown () {
    if (!this.guardOfficialBot()) return true
    let token = this.e.msg.replace(/^#q+botm(ark)?d(own)?/i, '').trim().split(':')
    const bot_id = token.shift()
    token = token.join(':')
    this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${token}`, true)
    config.markdown[bot_id] = token
    await configSave()
  }

  async Setting () {
    if (!this.guardOfficialBot()) return true
    const reg = /^#q+bot设置(.+)\s*(开启|关闭)$/i
    const regRet = reg.exec(this.e.msg)
    const state = regRet[2] == '开启'
    setBotConfigValue(this.e.self_id, setMap[regRet[1]], state)
    this.reply('设置成功,已' + (state ? '开启' : '关闭'), true)
    await configSave()
  }

  async DAUStat () {
    if (!this.guardOfficialBot()) return true
    const pro = this.e.msg.includes('pro')
    const uin = this.e.msg.replace(/^#q+botdau(pro)?/i, '') || this.e.self_id
    const dau = Bot[uin]?.dau
    if (!dau || !dau.dauDB) return false
    const msg = await dau.getDauStatsMsg(this.e, pro)
    if (msg.length) this.reply(msg, true)
  }

  async callStat () {
    if (!this.guardOfficialBot()) return true
    if (!getBotConfigValue(this.e.self_id, 'callStats')) return false
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) return false
    const msg = dau.getCallStatsMsg(this.e)
    if (msg.length) this.reply(msg, true)
  }

  async userStat () {
    if (!this.guardOfficialBot()) return true
    if (!getBotConfigValue(this.e.self_id, 'userStats')) return false
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) return false
    if (dau.dauDB === 'redis') {
      return this.reply('用户统计只适配了level,,,', true)
    }
    const msg = await dau.getUserStatsMsg(this.e)
    if (msg.length) this.reply(msg, true)
  }

  async filterLog () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot(添加|删除)过滤日志(.*)/i.exec(this.e.msg)
    let msg = _.trim(match[2]) || ''
    if (!msg) return false

    let isAdd = match[1] === '添加'
    const filterLog = config.filterLog[this.e.self_id] || []
    const has = filterLog.includes(msg)

    if (has && isAdd) return false
    else if (!has && !isAdd) return false
    else if (!has && isAdd) {
      filterLog.push(msg)
      msg = `【${msg}】添加成功， info日志已过滤该消息`
    } else {
      _.pull(filterLog, msg)
      msg = `【${msg}】删除成功， info日志已恢复打印该消息`
    }
    config.filterLog[this.e.self_id] = filterLog
    await configSave()
    this.reply(msg, true)
  }

  async oneKeySendGroupMsg () {
    if (!this.guardOfficialBot()) return true
    if (this.e.adapter_name !== 'QQBot') return false
    const msg = await importJS('Model/template/oneKeySendGroupMsg.js', 'default')
    if (msg === false) {
      this.reply('请先设置模版哦', true)
    } else {
      const groupList = this.e.bot.dau.dauDB === 'level' ? Object.keys(this.e.bot.dau.all_group) : [...this.e.bot.gl.keys()]
      const getMsg = typeof msg === 'function' ? msg : () => msg
      const errGroupList = []
      for (const key of groupList) {
        if (key === 'total') continue
        const id = this.e.bot.dau.dauDB === 'level' ? `${this.e.self_id}${this.e.bot.adapter.sep}${key}` : key
        const sendMsg = await getMsg(id)
        if (!sendMsg?.length) continue
        const sendRet = await this.e.bot.pickGroup(id).sendMsg(sendMsg)
        if (sendRet.error.length) {
          for (const i of sendRet.error) {
            if (i.message.includes('机器人非群成员')) {
              errGroupList.push(key)
              break
            }
          }
        }
      }
      if (errGroupList.length) await this.e.bot.dau.deleteNotExistGroup(errGroupList)
      logger.info(logger.green(`QQBot ${this.e.self_id} 群消息一键发送完成，共${groupList.length - 1}个群，失败${errGroupList.length}个`))
    }
  }

  // ========== 掉线检测命令 ==========

  async setOfflineDetect () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot账号掉线检测\s*(开启|关闭)$/i.exec(this.e.msg)
    const state = match[1] === '开启'

    const offlineDetect = getOfflineDetectConfig(this.e.self_id)
    offlineDetect.enabled = state

    if (state) {
      if (Bot[this.e.self_id]?.adapter === adapter) adapter.startOfflineCheck(this.e.self_id)
      const intervalMin = Math.max(1, Math.min(30, Number(offlineDetect.interval) || 5))
      this.reply(`账号掉线检测已开启，检测间隔 ${intervalMin} 分钟`, true)
    } else {
      if (Bot[this.e.self_id]?.adapter === adapter) adapter.stopOfflineCheck(this.e.self_id)
      this.reply('账号掉线检测已关闭', true)
    }

    await configSave()
  }

  async setOfflineNotify () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot账号掉线提醒\s*(开启|关闭)$/i.exec(this.e.msg)
    const state = match[1] === '开启'

    getOfflineDetectConfig(this.e.self_id).notify = state

    this.reply(`账号掉线提醒已${state ? '开启' : '关闭'}${state ? '（需先开启掉线检测总开关）' : ''}`, true)
    await configSave()
  }

  async setOfflineAutoReconnect () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot账号掉线自动重连\s*(开启|关闭)$/i.exec(this.e.msg)
    const state = match[1] === '开启'

    getOfflineDetectConfig(this.e.self_id).autoReconnect = state

    this.reply(`账号掉线自动重连已${state ? '开启' : '关闭'}${state ? '（需先开启掉线检测总开关）' : ''}`, true)
    await configSave()
  }

  async setOfflineInterval () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot账号掉线检测时间设置\s*(\d+)\s*分钟$/i.exec(this.e.msg)
    let minutes = parseInt(match[1])

    if (isNaN(minutes) || minutes < 1) minutes = 1
    if (minutes > 30) minutes = 30

    const offlineDetect = getOfflineDetectConfig(this.e.self_id)
    offlineDetect.interval = minutes

    await configSave()

    // 如果总开关已开，重启定时器使新间隔生效
    if (offlineDetect.enabled) {
      if (Bot[this.e.self_id]?.adapter === adapter) adapter.startOfflineCheck(this.e.self_id)
      this.reply(`掉线检测时间已设置为 ${minutes} 分钟，定时器已重启`, true)
    } else {
      this.reply(`掉线检测时间已设置为 ${minutes} 分钟（开启检测后生效）`, true)
    }
  }

  normalSetting () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot普通设置(?:\s*强制silk\s*(开启|关闭))?$/i.exec(this.e.msg)
    const botConfig = ensureBotConfig(this.e.self_id)

    if (!match?.[1]) {
      const msg = [
        ` [${this.e.self_id}] QQBot普通设置`,
        '',
        '>语音设置',
        '',
        `强制silk：${botConfig.forceSilk ? '开启' : '关闭'}`,
        '',
        `><qqbot-cmd-input text="#QQBot普通设置 强制silk ${botConfig.forceSilk ? '关闭' : '开启'}" show="${botConfig.forceSilk ? '关闭' : '开启'} 强制silk"/>`,
        '',
        '>召回设置',
        '',
        '><qqbot-cmd-input text="#QQBot召回菜单" show="打开召回菜单"/>',
        '',
        '```text',
        '开启：所有语音按原逻辑转为 silk 后上传。',
        '关闭：silk/wav/mp3/flac 直接上传为语音；其他后缀仍转 silk。',
        '关闭后如果直传失败，会自动转 silk 重试一次。',
        '并非能发送出来对应格式文件(实际官方帮你转换为silk)',
        '实际关闭强制slik增加发送速度，取得的wav:384.0 kbits，24000 Hz',
        '```'
      ].join('\n')
      this.reply([
        msg,
        segment.button(
          [
            { text: `${botConfig.forceSilk ? '关闭' : '开启'}silk`, callback: `#QQBot普通设置 强制silk ${botConfig.forceSilk ? '关闭' : '开启'}` },
            { text: '召回菜单', callback: '#QQBot召回菜单' }
          ],
          [
            { text: '返回', callback: '#QQBot帮助' }
          ]
        )
      ], true)
      return
    }

    const state = match[1] === '开启'
    setBotConfigValue(this.e.self_id, 'forceSilk', state)
    this.reply(`[${this.e.self_id}] 强制silk已${state ? '开启' : '关闭'}`, true)
    return configSave()
  }

  getAdvancedSettingMsg () {
    if (!this.guardOfficialBot()) return ''
    const selfId = this.e.self_id || this.e.bot?.uin || this.e.bot?.self_id || ''
    const claw = ensureClawConfig(selfId)
    const clawCfg = getClawCfg(selfId)
    const quote = text => ['', '', `>${text}`, '']
    const codeBlock = text => ['', '', '```text', '', text, '```', '']
    return [
      `#[${selfId}]高级设置`,
      ...quote(`龙虾在线: ${claw.online ? '开启' : '关闭'}`),
      `><qqbot-cmd-input text="#QQBot高级设置 龙虾在线 ${claw.online ? '关闭' : '开启'}" show="${claw.online ? '关闭' : '开启'}龙虾在线"/>`,
      ...quote(`龙虾code: ${claw.code || '0'}`),
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾code 0" show="设置龙虾code"/>',
      ...quote('已设置参数:'),
      ...codeBlock(Object.keys(claw.json || {}).length ? Object.keys(claw.json).join(', ') : '无'),
      ...quote('可用参数:'),
      ...quote('channel_type: 自定义，默认 qqbot'),
      ...quote('channel_ver: 自定义，默认 1.7.1'),
      ...quote('claw_type: 自定义，默认 openclaw'),
      ...quote('claw_ver: 自定义，默认 2026.3.24'),
      ...quote('require_mention:'),
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json require_mention mention" show="mention"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json require_mention always" show="always"/>',
      ...quote('group_policy:'),
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json group_policy open" show="open"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json group_policy allowlist" show="allowlist"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json group_policy disabled" show="disabled"/>',
      ...quote('mention_patterns: 自定义，多个关键词用英文逗号分隔'),
      ...quote('online_state:'),
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json online_state online" show="online"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json online_state offline" show="offline"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json online_state loading" show="loading"/>',
      ...quote('自定义参数:'),
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json channel_type qqbot" show="设置channel_type"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json channel_ver 1.7.1" show="设置channel_ver"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json claw_type openclaw" show="设置claw_type"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json claw_ver 2026.3.24" show="设置claw_ver"/>',
      '><qqbot-cmd-input text="#QQBot高级设置 龙虾json mention_patterns 机器人, 助手" show="设置mention_patterns"/>',
      ...quote('当前生效:'),
      ...codeBlock(JSON.stringify(clawCfg, null, 2)),
      ...quote('参数参考: claw_cfg.md')
    ].join('\n')
  }

  getAdvancedSettingButtons () {
    if (!this.guardOfficialBot()) return false
    const selfId = this.e.self_id || this.e.bot?.uin || this.e.bot?.self_id || ''
    const claw = ensureClawConfig(selfId)
    return segment.button(
      [
        { text: `${claw.online ? '关' : '开'}龙虾`, callback: `#QQBot高级设置 龙虾在线 ${claw.online ? '关闭' : '开启'}` },
        { text: 'code=0', callback: '#QQBot高级设置 龙虾code 0' }
      ],
      [
        { text: 'mention', callback: '#QQBot高级设置 龙虾json require_mention mention' },
        { text: 'always', callback: '#QQBot高级设置 龙虾json require_mention always' }
      ],
      [
        { text: 'open', callback: '#QQBot高级设置 龙虾json group_policy open' },
        { text: 'allowlist', callback: '#QQBot高级设置 龙虾json group_policy allowlist' }
      ],
      [
        { text: 'disabled', callback: '#QQBot高级设置 龙虾json group_policy disabled' },
        { text: 'online', callback: '#QQBot高级设置 龙虾json online_state online' }
      ],
      [
        { text: 'offline', callback: '#QQBot高级设置 龙虾json online_state offline' },
        { text: '自定义参数', input: '#QQBot高级设置 龙虾json ' }
      ]
    )
  }

  async advancedSetting () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot高级设置(?:\s*(龙虾在线|龙虾json|龙虾code)(?:\s+(.+))?)?$/i.exec(this.e.msg)
    const action = match?.[1]
    const args = (match?.[2] || '').trim()
    const selfId = this.e.self_id || this.e.bot?.uin || this.e.bot?.self_id || ''
    const claw = ensureClawConfig(selfId)

    if (!action) {
      this.reply([this.getAdvancedSettingMsg(), this.getAdvancedSettingButtons()], true)
      return
    }

    if (action === '龙虾在线') {
      const state = /开启/i.test(args)
      if (!/(开启|关闭)/i.test(args)) {
        this.reply('请使用：#QQBot高级设置 龙虾在线 开启/关闭', true)
        return
      }
      claw.online = state
      await configSave()
      this.reply(`龙虾在线已${state ? '开启' : '关闭'}`, true)
      return
    }

    if (action === '龙虾code') {
      claw.code = args || '0'
      await configSave()
      this.reply(`龙虾code已设置为 ${claw.code}\n\n>常用: 0成功 1失败 2不支持 3权限不足 4参数错误 5超时`, true)
      return
    }

    if (action === '龙虾json') {
      const [key, ...valueParts] = args.split(/\s+/)
      const value = valueParts.join(' ').trim()
      if (!key || !value) {
        this.reply('请使用：#QQBot高级设置 龙虾json 参数 值\n\n>示例：#QQBot高级设置 龙虾json require_mention always', true)
        return
      }
      claw.json[key] = value
      await configSave()
      this.reply(`龙虾json已设置\n\n>${key}: ${value}`, true)
    }
  }

  async fullMessageSetting () {
    if (!this.guardOfficialBot()) return true
    const msg = String(this.e.msg || '')
    const args = msg.replace(/^#q+bot全量消息设置/i, '').trim()
    if (!args) {
      this.reply([getFullMessageStatusMsg(config, this.e.self_id), segment.button(...getFullMessageStatusButtons(config, this.e.self_id))], true)
      return
    }

    if (args === '配置限制') {
      this.reply([getFullMessageBotLimitMsg(config, this.e.self_id), segment.button(...getFullMessageBotLimitButtons(config, this.e.self_id))], true)
      return
    }

    let match = /^配置bot限制\s*(开启|关闭)$/i.exec(args)
    if (match) {
      const ret = await setFullMessageBotLimitEnabled(config, configSave, match[1] === '开启', this.e.self_id)
      this.reply(`[${this.e.self_id}] ${ret}`, true)
      return
    }

    match = /^bot限制设置\s*(\d+)条(\d+)分钟$/i.exec(args)
    if (match) {
      const ret = await setFullMessageBotLimitConfig(config, configSave, match[1], match[2], this.e.self_id)
      this.reply(`[${this.e.self_id}] ${ret}`, true)
      return
    }

    match = /^忽略其他机器人正常@\s*(开启|关闭)$/i.exec(args)
    if (match) {
      const ret = await setFullMessageIgnoreBotAt(config, configSave, match[1] === '开启', this.e.self_id)
      this.reply(`[${this.e.self_id}] ${ret}`, true)
      return
    }

    match = /^忽略其他机器人总开关\s*(开启|关闭)$/i.exec(args)
    if (match) {
      const ret = await setFullMessageIgnoreBotMaster(config, configSave, match[1] === '开启', this.e.self_id)
      this.reply(`[${this.e.self_id}] ${ret}`, true)
      return
    }

    match = /^(仅回复isyou|处理无isyou|忽略全体isyou|isyou严判|仅回复@机器人|处理非@消息|忽略@全体的指令|全体通知|忽略其他机器人|@机器人严判|记录群)\s*(开启|关闭)$/i.exec(args)
    const ret = match ? await setFullMessageOption(config, configSave, match[1], match[2] === '开启', this.e.self_id) : false
    if (ret) this.reply(`[${this.e.self_id}] ${ret}`, true)
  }

  fullMessageRecords () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot全量查看(?:\s+(\d+))?$/i.exec(this.e.msg)
    this.reply([
      getFullMessageRecordsMsg(config, match?.[1], 20, this.e.self_id),
      segment.button(...getFullMessageRecordsButtons(config, match?.[1], 20, this.e.self_id))
    ], true)
  }

  async fullMessageClear () {
    if (!this.guardOfficialBot()) return true
    if (!/^#q+bot全量清空确认$/i.test(this.e.msg)) {
      this.reply([
        getFullMessageClearConfirmMsg(config, this.e.self_id),
        segment.button(...getFullMessageClearConfirmButtons())
      ], true)
      return
    }

    this.reply(await clearFullMessageRecords(config, configSave, this.e.self_id), true)
  }

  async fullMessageDB () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot全量存储\s*(json|level)$/i.exec(this.e.msg)
    if (!match?.[1]) return
    const msg = await switchFullMessageDB(config, configSave, match[1])
    this.reply(msg, true)
  }

  // ========== 破冰设置 ==========
  async icebreakerSetting () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot破冰(菜单|设置)(?:\s+([\s\S]+))?$/i.exec(this.e.msg)
    const action = match?.[1]
    const argsRaw = (match?.[2] || '').trim()
    const selfId = this.e.self_id

    // 菜单或无参数设置
    if (action === '菜单' || !argsRaw) {
      this.reply([
        getIcebreakerMenuMsg(config, selfId),
        segment.button(...getIcebreakerMenuButtons(config, selfId))
      ], true)
      return
    }

    const ib = ensureIcebreakerConfig(config, selfId)

    // 群聊总开关
    let m = /^群聊总开关\s*(开启|关闭)$/i.exec(argsRaw)
    if (m) {
      ib.groupEnabled = m[1] === '开启'
      await configSave()
      this.reply(`[${selfId}] 群聊破冰已${m[1]}`, true)
      return
    }

    // 私聊总开关
    m = /^私聊总开关\s*(开启|关闭)$/i.exec(argsRaw)
    if (m) {
      ib.friendEnabled = m[1] === '开启'
      await configSave()
      this.reply(`[${selfId}] 私聊破冰已${m[1]}`, true)
      return
    }

    // 禁用单独群
    m = /^禁用单独群\s+(\S+)$/i.exec(argsRaw)
    if (m) {
      const groupOpenid = m[1]
      if (!ib.disabledGroups.includes(groupOpenid)) {
        ib.disabledGroups.push(groupOpenid)
        await configSave()
        this.reply(`[${selfId}] 已禁用群 ${groupOpenid} 的破冰`, true)
      } else {
        this.reply(`[${selfId}] 该群已在禁用列表中`, true)
      }
      return
    }

    // 开启单独群
    m = /^开启单独群\s+(\S+)$/i.exec(argsRaw)
    if (m) {
      const groupOpenid = m[1]
      const idx = ib.disabledGroups.indexOf(groupOpenid)
      if (idx !== -1) {
        ib.disabledGroups.splice(idx, 1)
        await configSave()
        this.reply(`[${selfId}] 已开启群 ${groupOpenid} 的破冰`, true)
      } else {
        this.reply(`[${selfId}] 该群不在禁用列表中`, true)
      }
      return
    }

    // 群聊/私聊 button 开启/关闭
    m = /^(群聊|私聊)\s*button\s*(开启|关闭)$/i.exec(argsRaw)
    if (m) {
      const target = m[1] === '群聊' ? 'group' : 'friend'
      const state = m[2] === '开启'
      const mdKey = target === 'group' ? 'groupMarkdown' : 'friendMarkdown'
      const btnKey = target === 'group' ? 'groupButtonEnabled' : 'friendButtonEnabled'
      const btnDataKey = target === 'group' ? 'groupButton' : 'friendButton'
      if (state && !ib[mdKey]) {
        this.reply(`[${selfId}] 请先设置${m[1]}Markdown，平台禁止单发按钮`, true)
        return
      }
      if (state && !ib[btnDataKey]) {
        this.reply(`[${selfId}] 请先配置${m[1]}按钮数据，再开启`, true)
        return
      }
      ib[btnKey] = state
      await configSave()
      this.reply(`[${selfId}] ${m[1]}破冰按钮已${m[2]}`, true)
      return
    }

    // 群聊/私聊 button JSON
    m = /^(群聊|私聊)\s*button\s*(\{[\s\S]+\})$/i.exec(argsRaw)
    if (m) {
      const target = m[1] === '群聊' ? 'group' : 'friend'
      const mdKey = target === 'group' ? 'groupMarkdown' : 'friendMarkdown'
      const btnKey = target === 'group' ? 'groupButton' : 'friendButton'
      if (!ib[mdKey]) {
        this.reply(`[${selfId}] 请先设置${m[1]}Markdown，平台禁止单发按钮`, true)
        return
      }
      try {
        const parsed = JSON.parse(m[2].replace(/\n/g, '').replace(/\r/g, ''))
        ib[btnKey] = parsed
        const btnEnabledKey = target === 'group' ? 'groupButtonEnabled' : 'friendButtonEnabled'
        ib[btnEnabledKey] = true
        await configSave()
        this.reply(`[${selfId}] ${m[1]}破冰按钮已设置并开启`, true)
      } catch (err) {
        this.reply(`[${selfId}] JSON解析失败: ${err.message}`, true)
      }
      return
    }

    // 群聊/私聊 Markdown
    m = /^(群聊|私聊)\s*[Mm]arkdown\s+([\s\S]+)$/i.exec(argsRaw)
    if (m) {
      const target = m[1] === '群聊' ? 'group' : 'friend'
      const mdKey = target === 'group' ? 'groupMarkdown' : 'friendMarkdown'
      const content = m[2].trim()
      if (content === '清空') {
        const btnKey = target === 'group' ? 'groupButtonEnabled' : 'friendButtonEnabled'
        const btnDataKey = target === 'group' ? 'groupButton' : 'friendButton'
        ib[mdKey] = ''
        ib[btnKey] = false
        ib[btnDataKey] = null
        await configSave()
        this.reply(`[${selfId}] ${m[1]}破冰Markdown已清空，按钮已关闭并清除，需重新配置`, true)
        return
      }
      ib[mdKey] = content
      await configSave()
      this.reply(`[${selfId}] ${m[1]}破冰Markdown已设置`, true)
      return
    }

    this.reply(`[${selfId}] 未知破冰设置参数，请使用 #QQBot破冰菜单 查看可用命令`, true)
  }

  // ========== 召回菜单 ==========
  recallMenu () {
    if (!this.guardOfficialBot()) return true
    this.reply([
      getRecallMenuMsg(config, this.e.self_id),
      segment.button(...getRecallMenuButtons(config, this.e.self_id))
    ], true)
  }

  recallList () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot(可|不可)召回列表(?:\s+(\d+))?$/i.exec(this.e.msg)
    const type = match[1] === '可' ? 'can' : 'cannot'
    const page = match?.[2] ? Number(match[2]) : 1
    this.reply([
      getRecallListMsg(config, this.e.self_id, type, page, 20),
      segment.button(...getRecallListButtons(config, this.e.self_id, type, page, 20))
    ], true)
  }

  recallOverview () {
    if (!this.guardOfficialBot()) return true
    this.reply([
      getRecallOverviewMsg(config, this.e.self_id),
      segment.button(...getRecallOverviewButtons(config, this.e.self_id))
    ], true)
  }

  async recallSingle () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot单独召回\s+(\S+)(?:\s+(强制))?$/i.exec(this.e.msg)
    if (!match?.[1]) return
    const openid = match[1]
    const force = match[2] === '强制'
    // 校验 openid 是否存在
    const user = inviteStore.getC2cUser(this.e.self_id, openid)
    if (!user) {
      this.reply(`[${this.e.self_id}] openid 不存在于记录中: ${openid}`, true)
      return
    }
    const result = await adapter._sendWakeupMessage(this.e.self_id, openid, undefined, undefined, undefined, force)
    if (result.success) {
      this.reply(`[${this.e.self_id}] 召回消息已发送: ${openid}`, true)
    } else if (result.skipped) {
      this.reply(`[${this.e.self_id}] 跳过: ${openid}\n${result.error}\n使用 #QQBot单独召回 ${openid} 强制 可强制发送`, true)
    } else if (result.blocked) {
      this.reply(`[${this.e.self_id}] 用户拒收(拉黑): ${openid}`, true)
    } else if (result.periodExceeded) {
      this.reply(`[${this.e.self_id}] 召回消息已达区间上限: ${openid}`, true)
    } else {
      this.reply(`[${this.e.self_id}] 召回失败: ${openid}\n${result.error || ''}`, true)
    }
  }

  async recallBatchSetCount () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot全部召回设置数量\s+(\d+)$/i.exec(this.e.msg)
    if (!match?.[1]) return
    const count = Number(match[1])
    const { canRecall } = inviteStore.getRecallableList(this.e.self_id)
    const maxCount = canRecall.length
    const actualCount = Math.min(count, maxCount)

    if (count > maxCount) {
      this.reply(`[${this.e.self_id}] 输入数量(${count})超过可召回最大数量(${maxCount})，已设置为${maxCount}`, true)
    }

    const rc = ensureRecallConfig(config, this.e.self_id)
    rc.batchCount = actualCount
    await configSave()

    this.reply([
      `[${this.e.self_id}] 全部召回数量已设置为 ${actualCount}\n\n>确认后将向 ${actualCount} 个用户发送召回消息`,
      '',
      `><qqbot-cmd-input text="#QQBot全部召回确认" show="确认执行"/>`,
      '',
      `><qqbot-cmd-input text="#QQBot全部召回修改 ${actualCount}" show="修改数量"/>`,
      segment.button(
        [
          { text: '确认执行', callback: '#QQBot全部召回确认' },
          { text: '强制执行', callback: '#QQBot全部召回确认 强制' }
        ],
        [
          { text: '修改数量', input: '#QQBot全部召回修改 ' },
          { text: '返回', callback: '#QQBot召回查看' }
        ]
      )
    ], true)
  }

  async recallBatchModify () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot全部召回修改\s+(\d+)$/i.exec(this.e.msg)
    if (!match?.[1]) return
    const count = Number(match[1])
    const { canRecall } = inviteStore.getRecallableList(this.e.self_id)
    const maxCount = canRecall.length
    const actualCount = Math.min(count, maxCount)

    if (count > maxCount) {
      this.reply(`[${this.e.self_id}] 输入数量(${count})超过最大(${maxCount})，已设置为${maxCount}`, true)
    }

    const rc = ensureRecallConfig(config, this.e.self_id)
    rc.batchCount = actualCount
    await configSave()

    this.reply([
      `[${this.e.self_id}] 全部召回数量已修改为 ${actualCount}\n\n>确认后将向 ${actualCount} 个用户发送召回消息`,
      segment.button(
        [
          { text: '确认执行', callback: '#QQBot全部召回确认' },
          { text: '强制执行', callback: '#QQBot全部召回确认 强制' }
        ],
        [
          { text: '修改数量', input: '#QQBot全部召回修改 ' },
          { text: '返回', callback: '#QQBot召回查看' }
        ]
      )
    ], true)
  }

  async recallBatchConfirm () {
    if (!this.guardOfficialBot()) return true
    const selfId = this.e.self_id
    const rc = ensureRecallConfig(config, selfId)
    const batchCount = rc.batchCount || 0
    const force = /强制$/i.test(this.e.msg)

    if (!batchCount) {
      this.reply(`[${selfId}] 未设置召回数量，请先使用 #QQBot全部召回设置数量`, true)
      return
    }

    const { canRecall } = inviteStore.getRecallableList(selfId)
    if (canRecall.length === 0) {
      this.reply(`[${selfId}] 当前无可召回用户`, true)
      return
    }

    const targets = canRecall.slice(0, batchCount)
    const startTime = Date.now()

    let success = 0
    let fail = 0
    let skipped = 0
    let blocked = 0
    let periodExceeded = 0

    for (const user of targets) {
      const result = await adapter._sendWakeupMessage(selfId, user.openid, undefined, undefined, undefined, force)
      if (result.success) {
        success++
      } else if (result.skipped) {
        skipped++
      } else if (result.blocked) {
        blocked++
        fail++
      } else if (result.periodExceeded) {
        periodExceeded++
        fail++
      } else {
        fail++
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    rc.batchCount = 0
    await configSave()

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const summary = [
      `[${selfId}] 全部召回完成`,
      `成功: ${success}`,
      `失败: ${fail}`,
      skipped ? `跳过(已发过): ${skipped}` : '',
      blocked ? `拉黑: ${blocked}` : '',
      periodExceeded ? `区间上限: ${periodExceeded}` : '',
      `耗时: ${elapsed}秒`
    ].filter(Boolean).join('\n')

    // 被动消息5分钟超时，超时则通知主人
    if (elapsed > 280) {
      try {
        await Bot.sendMasterMsg(`${summary}`)
      } catch (err) {
        Bot.makeLog('error', ['全部召回结果通知主人失败', err.message], selfId)
      }
    } else {
      this.reply(summary, true)
    }
  }

  async recallSetting () {
    if (!this.guardOfficialBot()) return true
    const match = /^#q+bot召回设置(?:\s+([\s\S]+))?$/i.exec(this.e.msg)
    const argsRaw = (match?.[1] || '').trim()
    const selfId = this.e.self_id
    const rc = ensureRecallConfig(config, selfId)

    if (!argsRaw) {
      // 显示召回设置菜单
      this.reply([
        getRecallMenuMsg(config, selfId),
        segment.button(...getRecallMenuButtons(config, selfId))
      ], true)
      return
    }

    // Markdown
    let m = /^[Mm]arkdown\s+([\s\S]+)$/i.exec(argsRaw)
    if (m) {
      const content = m[1].trim()
      if (content === '清空') {
        rc.markdown = ''
        rc.buttonEnabled = false
        rc.button = null
        await configSave()
        this.reply(`[${selfId}] 召回Markdown已清空，按钮已关闭并清除，需重新配置`, true)
        return
      }
      rc.markdown = content
      await configSave()
      this.reply(`[${selfId}] 召回Markdown已设置`, true)
      return
    }

    // button 开启/关闭
    m = /^button\s*(开启|关闭)$/i.exec(argsRaw)
    if (m) {
      const state = m[1] === '开启'
      if (state && !rc.markdown) {
        this.reply(`[${selfId}] 请先设置召回Markdown，平台禁止单发按钮`, true)
        return
      }
      if (state && !rc.button) {
        this.reply(`[${selfId}] 请先配置召回按钮数据，再开启`, true)
        return
      }
      rc.buttonEnabled = state
      await configSave()
      this.reply(`[${selfId}] 召回按钮已${m[1]}`, true)
      return
    }

    // button JSON
    m = /^button\s*(\{[\s\S]+\})$/i.exec(argsRaw)
    if (m) {
      if (!rc.markdown) {
        this.reply(`[${selfId}] 请先设置召回Markdown，平台禁止单发按钮`, true)
        return
      }
      try {
        const parsed = JSON.parse(m[1].replace(/\n/g, '').replace(/\r/g, ''))
        rc.button = parsed
        rc.buttonEnabled = true
        await configSave()
        this.reply(`[${selfId}] 召回按钮已设置并开启`, true)
      } catch (err) {
        this.reply(`[${selfId}] JSON解析失败: ${err.message}`, true)
      }
      return
    }

    // 存储切换
    m = /^存储\s*(json|level)$/i.exec(argsRaw)
    if (m) {
      const msg = await switchInviteDB(config, configSave, m[1].toLowerCase())
      this.reply(`[${selfId}] ${msg}`, true)
      return
    }

    this.reply(`[${selfId}] 未知召回设置参数`, true)
  }

  async recallPreview () {
    if (!this.guardOfficialBot()) return true
    const selfId = this.e.self_id
    const rc = ensureRecallConfig(config, selfId)
    const isRaw = config.markdown?.[selfId] === 'raw'

    const md = rc.markdown || ''
    const btnEnabled = rc.buttonEnabled
    const btn = rc.button

    const btnStatus = btn ? (btnEnabled ? '已开启' : '已配置(未开启)') : '未配置'
    const lines = [
      `#[${selfId}] 召回预览菜单`,
      '',
      `>Markdown模式: ${isRaw ? 'raw(富文本)' : '纯文本'}`,
      '',
      `>Markdown内容: ${md ? '已设置' : '未设置'}`,
      '',
      `>按钮: ${btnStatus}`,
      '',
      `><qqbot-cmd-input text="#QQBot召回发送预览" show="发送预览到当前会话"/>`,
      '',
      '```text',
      '点击"发送预览"会在当前会话发送一条',
      '与召回消息完全相同的Markdown+按钮消息',
      '用于确认实际渲染效果(不带is_wakeup)',
      '```'
    ]

    this.reply([
      lines.join('\n'),
      segment.button(
        [
          { text: '发送预览', callback: '#QQBot召回发送预览' },
          { text: '设置MD', input: '#QQBot召回设置 Markdown ' }
        ],
        [
          { text: 'MD清空', callback: '#QQBot召回设置 Markdown 清空' },
          { text: `${btnEnabled ? '关' : '开'}按钮`, callback: `#QQBot召回设置 button ${btnEnabled ? '关闭' : '开启'}` }
        ],
        [
          { text: '返回', callback: '#QQBot召回菜单' }
        ]
      )
    ], true)
  }

  async recallSendPreview () {
    if (!this.guardOfficialBot()) return true
    const selfId = this.e.self_id
    const rc = ensureRecallConfig(config, selfId)
    const isRaw = config.markdown?.[selfId] === 'raw'
    const bot = Bot[selfId]

    const md = rc.markdown || ''
    const btnEnabled = rc.buttonEnabled
    const btn = rc.button

    if (!md) {
      this.reply(`[${selfId}] 未设置召回Markdown，无法预览`, true)
      return
    }

    // 用 SDK 直接 POST 到当前会话，保证 markdown + keyboard 正确渲染
    const isGroup = !!this.e.group_id
    const rawGroupId = this.e.raw?.group_id || this.e.group_id?.replace?.(`${selfId}${adapter.sep}`, '') || ''
    const rawUserId = this.e.raw?.sender?.user_id || this.e.user_id?.replace?.(`${selfId}${adapter.sep}`, '') || ''
    const targetUrl = isGroup ? `/v2/groups/${rawGroupId}` : `/v2/users/${rawUserId}`

    const payload = {
      msg_type: 0,
      content: md,
      msg_seq: Math.floor(Math.random() * 1000000) + 1,
      msg_id: this.e.message_id || undefined
    }

    if (isRaw) {
      payload.msg_type = 2
      payload.markdown = { content: md }
      delete payload.content

      if (btnEnabled && btn) {
        payload.keyboard = {
          content: btn,
          bot_appid: Number(bot.info?.appid || 0)
        }
      }
    }

    try {
      await bot.sdk.request.post(`${targetUrl}/messages`, payload)
      Bot.makeLog('info', [`[${selfId}] 召回预览消息已发送`], selfId)
    } catch (err) {
      this.reply(`[${selfId}] 预览发送失败: ${err.response?.data?.message || err.message}`, true)
    }
  }
}

const endTime = new Date()
logger.info(logger.green(`- QQBot 适配器插件 加载完成! 耗时：${endTime - startTime}ms`))
