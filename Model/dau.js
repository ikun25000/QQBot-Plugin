import _ from 'lodash'
import fs from 'node:fs'
import moment from 'moment'
import Level from './level.js'
import { join } from 'node:path'
import schedule from 'node-schedule'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

//! 需顺序
const dauAttr = {
  receive_msg_count: '上行消息量',
  receive_msg_full_count: '上行消息量(全量)',
  receive_msg_at_count: '上行消息量(非全量)',
  send_msg_count: '下行消息量',
  user_count: '上行消息人数',
  user_full_count: '上行消息人数(全量)',
  user_at_count: '上行消息人数(非全量)',
  group_count: '上行消息群数',
  group_full_count: '上行消息群数(全量)',
  group_at_count: '上行消息群数(非全量)',
  group_increase_count: '新增群数',
  group_decrease_count: '减少群数',
  friend_add_count: '新增好友数',
  friend_delete_count: '删除好友数'
}

const numToChinese = {
  /* eslint-disable object-property-newline */
  1: '一', 2: '二', 3: '三', 4: '四', 5: '五',
  6: '六', 7: '七', 8: '八', 9: '九', 10: '十',
  11: '十一', 12: '十二', 13: '十三', 14: '十四', 15: '十五',
  16: '十六', 17: '十七', 18: '十八', 19: '十九', 20: '二十',
  21: '二十一', 22: '二十二', 23: '二十三', 24: '二十四', 25: '二十五',
  26: '二十六', 27: '二十七', 28: '二十八', 29: '二十九', 30: '三十',
  31: '三十一'
}

const _path = process.cwd()
// DAU follows node-schedule's local business day. Production runs in Asia/Shanghai.
const getDauDate = (offset = 0) => moment().add(offset, 'day').format('YYYY-MM-DD')
const dauRedisErrorAt = new Map()

function logDauRedisError (selfId, error) {
  const now = Date.now()
  const last = dauRedisErrorAt.get(String(selfId)) || 0
  if (now - last < 60000) return
  dauRedisErrorAt.set(String(selfId), now)
  logger.error(`[QQBot-Plugin] DAU Redis计数失败(${selfId})`, error)
}

export default class Dau {
  constructor (self_id, sep, dauDB) {
    this.self_id = String(self_id)
    this.sep = sep
    this.dauDB = dauDB
  }

  /**
   * 对数据初始化
   */
  async init () {
    // 时间
    this.today = getDauDate()
    this.yesterday = getDauDate(-1)
    switch (this.dauDB) {
      case 'redis': {
        const prefix = `QQBot:${this.self_id}:`
        const normalizeRedisKey = key => {
          const params = String(key).split(':')
          if (params.length < 2) params.push(this.today)
          return `${prefix}${params.join(':')}`
        }
        const incrementRedisKeys = async (keys = []) => {
          const redisKeys = [...new Set(keys.filter(Boolean).map(normalizeRedisKey))]
          if (!redisKeys.length) return []
          if (typeof redis.multi === 'function') {
            const batch = redis.multi()
            for (const redisKey of redisKeys) batch.incr(redisKey)
            return batch.exec()
          }
          if (typeof redis.incr === 'function') return Promise.all(redisKeys.map(redisKey => redis.incr(redisKey)))
          throw new Error('Redis client does not support incr or multi')
        }
        this.db = {
          get: async (key) => {
            const data = await redis.get(normalizeRedisKey(key))
            switch (typeof data) {
              case 'number':
                return data
              case 'string':
                try {
                  return JSON.parse(data)
                } catch (error) {
                  return data
                }
              default:
                return data
            }
          },
          set: (key, data, expire) => {
            const params = key.split(':')
            if (params.length < 2) params.push(this.today)
            key = params.join(':')
            switch (params[0]) {
              case 'call_stats':
              case 'group_decrease':
              case 'group_increase':
              case 'friend_add':
              case 'friend_delete':
                redis.set(`${prefix}${key}`, JSON.stringify(data), expire ? { EX: expire * 24 * 60 * 60 } : undefined)
                break
              case 'dau_stats':
              case 'all_user':
              case 'all_group':
              case 'all_group_member':
              case 'user_group_stats':
                break
              case 'receive_msg_count':
              case 'receive_msg_full_count':
              case 'receive_msg_at_count':
              case 'send_msg_count':
                redis.incr(`${prefix}${key}`)
                break
              default:
                break
            }
          },
          increment: incrementRedisKeys
        }
        break
      }
      case 'level': {
        const path = join(process.cwd(), 'plugins', 'QQBot-Plugin', 'db', this.self_id)
        this.db = new Level(path)
        await this.db.open({ cleanup: false })
        break
      }
      default:
        this.dauDB = false
        this.db = {
          get: () => { },
          set: () => { }
        }
        return false
    }
    await this.initData()

    // 定时任务
    this.job = this.setScheduleJob()
  }

  _emptyStats () {
    return _.reduce(_.keys(dauAttr), (acc, key) => {
      acc[key] = 0
      return acc
    }, {})
  }

  async ensureCurrentDay () {
    const currentDay = getDauDate()
    if (currentDay === this.today) return
    if (this._dayRollover) return this._dayRollover
    this._dayRollover = (async () => {
      const previousDay = this.today
      const snapshot = this.dauDB === 'level' ? { ...(this.stats || this._emptyStats()), time: previousDay } : await this.getStats(previousDay)
      const path = join(_path, 'data', 'QQBotDAU', this.self_id)
      try {
        fs.mkdirSync(path, { recursive: true })
        const filePath = join(path, `${moment(previousDay).format('YYYY-MM')}.json`)
        const history = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : []
        const index = history.findIndex(item => String(item?.time || '').slice(0, 10) === previousDay)
        if (index >= 0) history[index] = snapshot
        else history.push(snapshot)
        fs.writeFileSync(filePath, JSON.stringify(history, null, '\t'), 'utf8')
      } catch (err) {
        logger.error('归档DAU数据出错,self_id: ' + this.self_id, err)
      }

      this.today = currentDay
      this.yesterday = moment(currentDay).subtract(1, 'day').format('YYYY-MM-DD')
      await this.initData()
    })().finally(() => { this._dayRollover = null })
    return this._dayRollover
  }

  async getStats (time = this.today) {
    if (String(time) !== String(this.today)) return this.getArchivedStats(time)
    if (this.dauDB === 'level') {
      return { ...this.stats }
    } else {
      return {
        receive_msg_count: await this.db.get(`receive_msg_count:${time}`) || 0,
        receive_msg_full_count: await this.db.get(`receive_msg_full_count:${time}`) || 0,
        receive_msg_at_count: await this.db.get(`receive_msg_at_count:${time}`) || 0,
        send_msg_count: await this.db.get(`send_msg_count:${time}`) || 0,
        user_count: (await this.scan(`Yz:count:receive:msg:user:${this.self_id}*:${moment(time).format('YYYY:MM:DD')}`)).length,
        user_full_count: 0,
        user_at_count: 0,
        group_count: (await this.scan(`Yz:count:receive:msg:group:${this.self_id}*:${moment(time).format('YYYY:MM:DD')}`)).length,
        group_full_count: 0,
        group_at_count: 0,
        group_increase_count: Object.keys(this.group_increase || {}).length,
        group_decrease_count: Object.keys(this.group_decrease || {}).length,
        friend_add_count: Object.keys(this.friend_add || {}).length,
        friend_delete_count: Object.keys(this.friend_delete || {}).length
      }
    }
  }

  getArchivedStats (date) {
    const text = String(date || '')
    const file = join(_path, 'data', 'QQBotDAU', this.self_id, `${text.slice(0, 7)}.json`)
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
      return rows.find(row => String(row?.time || '').slice(0, 10) === text.slice(0, 10)) || null
    } catch { return null }
  }

  async scan (MATCH) {
    let cursor = 0
    const arr = []
    do {
      const res = await redis.scan(cursor, { MATCH, COUNT: 10000 })
      cursor = res.cursor
      arr.push(...res.keys)
    } while (cursor != 0)
    return arr
  }

/**
 * dau统计
 * @param {*} pro
 * @returns
 */
  async getDauStatsMsg (e, pro, queryDate = '') {
  const normalizeDauRow = (row = {}) => _.reduce(_.keys(dauAttr), (acc, key) => {
    acc[key] = Number(row?.[key]) || 0
    return acc
  }, {})

   const selectedDate = queryDate || this.today
   const selected = await this.getStats(selectedDate)
   if (!selected) return false
   let msg = [selectedDate, ...this.toDauMsg(normalizeDauRow(selected)), '']
   if (queryDate) return [msg.join('\n'), this.getButton(e.user_id, e.message_type === 'group', queryDate)]

  const path = join(_path, 'data', 'QQBotDAU', this.self_id)
  const yearMonth = moment(this.today).format('YYYY-MM')
  
  // 昨日DAU
  let yesterdayDau
  try {
    const day = this.today.slice(-2)
    const yestodayMonth = day == '01' ? moment(this.today).subtract(1, 'days').format('YYYY-MM') : yearMonth
    yesterdayDau = JSON.parse(fs.readFileSync(join(path, `${yestodayMonth}.json`), 'utf8'))
    yesterdayDau = _.find(yesterdayDau, v => moment(v.time).isSame(moment(this.today).subtract(1, 'd')))
    if (yesterdayDau) msg.push(...[yesterdayDau.time, ...this.toDauMsg(normalizeDauRow(yesterdayDau)), ''])
  } catch (error) { }

  // 最近30天平均
  let totalDAU = _.reduce(_.keys(dauAttr), (acc, key) => {
    acc[key] = 0
    return acc
  }, {})
  let days = 0
  try {
    // 获取当前月和上个月的文件
    const months = [yearMonth, moment(yearMonth, 'YYYY-MM').subtract(1, 'month').format('YYYY-MM')]
    let days30 = []
    for (const m of months) {
      const file = join(path, `${m}.json`)
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        // 数据按时间正序存储，需要反转后取最近的
        days30.push(...data.reverse())
      }
    }
    // 只取最近30天
    days30 = days30.slice(0, 30)
    days = days30.length
    if (days > 0) {
      totalDAU = _.mapValues(totalDAU, (v, k) => _.floor(_.meanBy(days30, item => Number(item?.[k]) || 0)))
    }
  } catch (error) {
    logger.error('[QQBot-Plugin] getDauStatsMsg 读取历史DAU数据出错:', error)
  }

  const daysText = numToChinese[days] || days
  msg.push(...[`最近${daysText}天平均`, ...this.toDauMsg(totalDAU)])
  msg = msg.join('\n')

  if (pro) {
    if (!fs.existsSync(path)) return false
    let daus = fs.readdirSync(path)
    if (_.isEmpty(daus)) return false
    let data = _.fromPairs(daus.map(v => [v.replace('.json', ''), JSON.parse(fs.readFileSync(`${path}/${v}`))]))
    data = this.monthlyDau(Object.values(data).flat().slice(-30))

    totalDAU.days = daysText
    const arr = _.toPairs(this.call_stats).sort((a, b) => b[1] - a[1])
    let renderdata = {
      ...await this.callStat(arr, true),
      daus: JSON.stringify(data),
      totalDAU,
      yesterdayDau: yesterdayDau || {},
      todayDAU: await this.getStats(),
      monthly: data.time,
       groupNum: e.bot.gl.size,
       userNum: e.bot.fl.size,
      nickname: Bot[this.self_id].nickname,
      avatar: Bot[this.self_id].avatar,
      tplFile: `${_path}/plugins/QQBot-Plugin/resources/html/DAU/DAU.html`,
      pluResPath: `${_path}/plugins/QQBot-Plugin/resources/`,
      _res_Path: `${_path}/plugins/genshin/resources/`
    }

    let img = await puppeteer.screenshot('DAU', renderdata)
    if (!img) return false
    msg = img
  }

   return [msg, this.getButton(e.user_id, e.message_type === 'group')]
}

  getCallStatsMsg (e) {
    const arr = _.toPairs(this.call_stats).sort((a, b) => b[1] - a[1])
    const msg = [this.today, '数据可能不准确,请自行识别']
    for (let i = 0; i < 10; i++) {
      if (!arr[i]) break
      const s = arr[i]
      msg.push(`${i + 1}: ${s[0]}\t\t${s[1]}次`)
    }
     return [msg.join('\n'), this.getButton(e.user_id, e.message_type === 'group')]
  }

  async callStat (arr, isall = false) {
    const group = []
    const color = []
    let all = 0
    const colorArr = ['#FFD700', '#73a9c6', '#d56565', '#70b2b4', '#1E90FF', '#bd9a5a', '#739970', '#7a6da7', '#597ea0', '#FC0AD3', '#989598']
    const AllNum = arr.reduce((acc, cur) => {
      if (typeof cur[1] === 'number') return acc + cur[1]
      return acc
    }, 0)

    for (let i = 0; i < 10; i++) {
      if (!arr[i]) break
      const s = arr[i]
      const percent = Number((s[1] / AllNum * 100).toFixed(0))
      if (percent < 1) continue
      group.push({
        name: s[0],
        num: s[1],
        percent: percent + '%'
      })
      all += s[1]
    }

    if (all !== AllNum) {
      group.push({
        name: '其他',
        num: AllNum - all,
        percent: ((AllNum - all) / AllNum * 100).toFixed(0) + '%'
      })
    }
    group.sort((a, b) => b.num - a.num)
    for (const i in group) {
      group[i].color = colorArr[i]
      color.push(colorArr[i])
    }
    if (isall) {
      return {
        group,
        color: JSON.stringify(color),
        group_by: JSON.stringify(group)
      }
    }
    let renderdata = {
      group,
      color: JSON.stringify(color),
      group_by: JSON.stringify(group),
      tplFile: `${_path}/plugins/QQBot-Plugin/resources/html/Stat/Stat.html`,
      pluResPath: `${_path}/plugins/QQBot-Plugin/resources/`,
      _res_Path: `${_path}/plugins/genshin/resources/`
    }

    let img = await puppeteer.screenshot('DAU', renderdata)
    if (!img) return false
    return img
  }

  async getUserStatsMsg (e) {
    let user_same_count
    let yesterday_user_count
    let userCount
    let groupCount
    let todayActiveUserCount = 0
    let todayActiveGroupCount = 0
    let allUserScope = { full: '未知', at: '未知' }
    let allGroupScope = { full: '未知', at: '未知' }
    if (this.dauDB === 'level') {
      userCount = e.bot?.fl?.size || 0
      groupCount = e.bot?.gl?.size || 0
      todayActiveUserCount = Object.keys(this.today_user_data.user || {}).length
      todayActiveGroupCount = Object.keys(this.today_user_data.group || {}).length
      allUserScope = {
        full: this.today_user_data.user_scope_available ? Object.keys(this.today_user_data.user_full || {}).length : '未知',
        at: this.today_user_data.user_scope_available ? Object.keys(this.today_user_data.user_at || {}).length : '未知'
      }
      allGroupScope = {
        full: this.today_user_data.group_scope_available ? Object.keys(this.today_user_data.group_full || {}).length : '未知',
        at: this.today_user_data.group_scope_available ? Object.keys(this.today_user_data.group_at || {}).length : '未知'
      }
      yesterday_user_count = _.size(this.yestoday_user_data.user)
      user_same_count = _.intersection(_.keys(this.today_user_data.user), _.keys(this.yestoday_user_data.user)).length
    } else {
      userCount = e.bot.fl.size
      groupCount = e.bot.gl.size
      const todayStats = await this.getStats()
      todayActiveUserCount = Number(todayStats?.user_count) || 0
      todayActiveGroupCount = Number(todayStats?.group_count) || 0
      const m = moment()
      const data = []
      for (let i = 0; i < 2; i++) {
        const day = m.format('YYYY:MM:DD')
        const reg = new RegExp(`Yz:count:receive:msg:user:${this.self_id}:(.+):${day}`)
        const dayUser = await this.scan(`Yz:count:receive:msg:user:${this.self_id}:*:${day}`)
        data.push(dayUser.map(i => {
          try {
            return reg.exec(i)[1]
          } catch (error) {
            return false
          }
        }).filter(Boolean))
        m.add(-86400000)
      }
      yesterday_user_count = data[1].length
      user_same_count = _.intersection(data[0], data[1]).length
    }
    const msg = [
      '当前数据:',
      '当前用户量: ' + userCount,
      `今日活跃用户(全量/非全量): ${allUserScope.full}/${allUserScope.at}`,
      '当前群聊量: ' + groupCount,
      `今日活跃群聊(全量/非全量): ${allGroupScope.full}/${allGroupScope.at}`,
      '',
      '今日数据:',
      `今日活跃用户: ${todayActiveUserCount}`,
      `今日活跃群聊: ${todayActiveGroupCount}`,
      `新增群数: ${_.size(this.group_increase)}`,
      `减少群数: ${_.size(this.group_decrease)}`,
      '',
      '相较昨日:',
      `相同用户: ${user_same_count}`,
      `减少用户: ${yesterday_user_count - user_same_count}`
    ]
     return [msg.join('\r'), this.getButton(e.user_id, e.message_type === 'group')]
  }

  getButton (user_id, restricted = true, date = '') {
    const permission = restricted ? { permission: user_id } : {}
    const suffix = date ? ` ${String(date).slice(5)}` : ''
    return segment.button([
      { text: 'dau', callback: `#QQBotdau${suffix}`, ...permission },
      { text: 'daupro', callback: `#QQBotdaupro${suffix}`, ...permission }
    ], [
      { text: '调用统计', callback: '#QQBot调用统计', ...permission },
      { text: '用户统计', callback: '#QQBot用户统计', ...permission }
    ])
  }

  setScheduleJob () {
    return schedule.scheduleJob('0 0 0 * * ?', async () => {
      try {
        await this.ensureCurrentDay()
      } catch (error) {
        logger.error('清除DAU数据出错,self_id: ' + this.self_id, error)
      }
    })
  }

  /**
   * 月度统计
   * @param {object} dat
   * @returns
   */
  monthlyDau (data) {
    const convertChart = (type, day, prefix = '') => {
      let chartData = []
      for (const i of type) {
        chartData.push({
          time: day.time,
          [`${prefix}name`]: dauAttr[`${i}_count`],
          [`${prefix}count`]: day[`${i}_count`]
        })
      }
      return chartData
    }
    let coldata = []
    let linedata = []
    data.forEach(day => {
      coldata.push(convertChart(['user', 'group'], day))
      linedata.push(convertChart(['receive_msg', 'send_msg'], day, 'line'))
    })

    return { coldata: [[], coldata.flat()], linedata: [linedata.flat(), []], time: coldata[0][0].time.slice(5) + ' - ' + coldata.pop()[0].time.slice(5) }
  }

  async initData () {
    if (this.dauDB == 'level') {
      // 用户和群统计
      const normalizeDailyData = data => ({
        ...(data && typeof data === 'object' ? data : {}),
        user: data?.user && typeof data.user === 'object' ? data.user : {},
        group: data?.group && typeof data.group === 'object' ? data.group : {},
        user_full: data?.user_full && typeof data.user_full === 'object' ? data.user_full : {},
        user_at: data?.user_at && typeof data.user_at === 'object' ? data.user_at : {},
        group_full: data?.group_full && typeof data.group_full === 'object' ? data.group_full : {},
        group_at: data?.group_at && typeof data.group_at === 'object' ? data.group_at : {},
        user_scope_available: data?.user_scope_available === true || Object.prototype.hasOwnProperty.call(data || {}, 'user_full') || Object.prototype.hasOwnProperty.call(data || {}, 'user_at'),
        group_scope_available: data?.group_scope_available === true || Object.prototype.hasOwnProperty.call(data || {}, 'group_full') || Object.prototype.hasOwnProperty.call(data || {}, 'group_at')
      })
      this.today_user_data = normalizeDailyData(await this.getDB('user_group_stats'))
      this.yestoday_user_data = normalizeDailyData(await this.getDB('user_group_stats', this.yesterday))

      // DAU统计
      this.stats = await this.getDB('dau_stats') || _.reduce(_.keys(dauAttr), (acc, key) => {
        acc[key] = 0
        return acc
      }, {})
      for (const key of _.keys(dauAttr)) if (typeof this.stats[key] !== 'number') this.stats[key] = 0

      // 调用统计
      this.call_stats = await this.getDB('call_stats') || {}

      // 新增群, 减少群, 新增用户 列表
      this.group_increase = await this.getDB('group_increase') || {}
      this.group_decrease = await this.getDB('group_decrease') || {}
      this.friend_add = await this.getDB('friend_add') || {}
      this.friend_delete = await this.getDB('friend_delete') || {}

      // 保留旧的 all_* key，但不再把历史明细加载到内存。
      // 当前统计使用实时好友/群列表和 user_group_stats，避免大对象常驻及整对象写回。
      this.all_user = { total: 0 }
      this.all_group = { total: 0 }
      this.all_group_member = {}
    } else {
      this.group_decrease = await this.getDB('group_decrease') || {}
      this.group_increase = await this.getDB('group_increase') || {}
      this.friend_add = await this.getDB('friend_add') || {}
      this.friend_delete = await this.getDB('friend_delete') || {}
      this.call_stats = await this.getDB('call_stats') || {}
    }
    this.message_id_cache = new Map()
  }

  toDauMsg (data, num = 0) {
    const msg = []
    _.each(dauAttr, (v, k) => {
      msg.push(`${v}：${Number(data?.[k]) || 0}`)
    })
    return num ? _.take(msg, num) : msg
  }

  getReceiveMsgScope (data = {}) {
    return data.raw?._qqbotRawEvent === 'GROUP_MESSAGE_CREATE' ? 'full' : 'at'
  }

  ensureReceiveScopeStats (target) {
    if (!target) return
    if (typeof target.receive_msg_full_count !== 'number') target.receive_msg_full_count = 0
    if (typeof target.receive_msg_at_count !== 'number') target.receive_msg_at_count = 0
  }

  getReceiveScopeCounts (items = {}) {
    const values = Object.entries(items || {}).filter(([key, item]) => key !== 'total' && item && typeof item === 'object')
    return {
      full: values.filter(([, item]) => Number(item.receive_msg_full_count) > 0).length,
      at: values.filter(([, item]) => Number(item.receive_msg_at_count) > 0).length
    }
  }

  /**
   * @param {'send_msg'|'receive_msg'|'group_increase'|'group_decrease'|'friend_add'|'friend_delete'} type
   */
  async setDau (type, data) {
    if (!this.dauDB) return
    await this.ensureCurrentDay()
    const user_id = data.user_id?.replace?.(this.self_id + this.sep, '')
    const group_id = data.group_id?.replace?.(this.self_id + this.sep, '')
    const key = `${type}_count`
    switch (type) {
      case 'send_msg':
        if (this.dauDB === 'redis') {
          try {
            await this.db.increment(['send_msg_count'])
          } catch (error) {
            logDauRedisError(this.self_id, error)
          }
        } else {
          this.stats[key]++
        }
        await this.setLogFnc(user_id, group_id, data.logFnc, data.message_id)
        break
      case 'receive_msg':
        const scope = this.getReceiveMsgScope(data)
        if (this.dauDB === 'redis') {
          try {
            await this.db.increment([
              'receive_msg_count',
              scope === 'full' ? 'receive_msg_full_count' : 'receive_msg_at_count'
            ])
          } catch (error) {
            logDauRedisError(this.self_id, error)
          }
        } else {
          this.stats[key]++
          this.stats[scope === 'full' ? 'receive_msg_full_count' : 'receive_msg_at_count']++
          await this.setUserOrGroupStats(user_id, group_id, scope)
        }
        break
      case 'group_decrease':
        if (!group_id) break
        if (this.dauDB === 'level') {
          if (!this.group_decrease[group_id]) {
            this.group_decrease[group_id] = 1
            this.stats[key]++
            await this.setDB('group_decrease', this.group_decrease, 2)
          }
        } else {
          if (!this.group_decrease[group_id]) {
            this.group_decrease[group_id] = 0
          }
          this.group_decrease[group_id]++
          await this.setDB('group_decrease', this.group_decrease, 2)
        }
        break
      case 'group_increase':
        if (this.dauDB === 'level') {
          if (!this.group_increase[group_id]) {
            this.stats[key]++
            this.group_increase[group_id] = 0
          }
          this.group_increase[group_id]++
          this.setDB(type, this.group_increase, 2)
        } else {
          if (!this.group_increase[group_id]) {
            this.group_increase[group_id] = 0
          }
          this.group_increase[group_id]++
          await this.setDB('group_increase', this.group_increase, 2)
        }
        break
      case 'friend_add':
        if (this.dauDB === 'level') {
          this.stats[key]++
          if (!this.friend_add[user_id]) this.friend_add[user_id] = 0
          this.friend_add[user_id]++
          await this.setDB('friend_add', this.friend_add, 2)
        } else {
          if (!this.friend_add[user_id]) this.friend_add[user_id] = 0
          this.friend_add[user_id]++
          await this.setDB('friend_add', this.friend_add, 2)
        }
        break
      case 'friend_delete':
        if (this.dauDB === 'level') {
          this.stats[key]++
          if (!this.friend_delete[user_id]) this.friend_delete[user_id] = 0
          this.friend_delete[user_id]++
          await this.setDB('friend_delete', this.friend_delete, 2)
        } else {
          if (!this.friend_delete[user_id]) this.friend_delete[user_id] = 0
          this.friend_delete[user_id]++
          await this.setDB('friend_delete', this.friend_delete, 2)
        }
        break
    }
    if (this.dauDB === 'level') await this.setDB('dau_stats', this.stats)
  }

  async close () {
    try { this.job?.cancel() } catch {}
    if (this.db?.close) await this.db.close().catch(() => {})
  }

  async setLogFnc (user_id, group_id, logFnc, message_id) {
    if (!logFnc) return
    const logReg = /\[.*?\[(.*?\))\]/
    if (logReg.test(logFnc)) logFnc = `[${logFnc.match(logReg)[1]}]`

    // 每个消息只记录一次
    const cacheKey = message_id || `${user_id || ''}:${group_id || ''}:${logFnc}`
    const now = Date.now()
    const cachedAt = this.message_id_cache.get(cacheKey)
    if (cachedAt && now - cachedAt < 5 * 60 * 1000) return
    if (this.message_id_cache.size >= 10000) {
      for (const [id, time] of this.message_id_cache) {
        if (now - time >= 5 * 60 * 1000 || this.message_id_cache.size > 9000) this.message_id_cache.delete(id)
      }
    }
    this.message_id_cache.set(cacheKey, now)
    if (!this.call_stats[logFnc]) this.call_stats[logFnc] = 0
    this.call_stats[logFnc]++
    await this.setDB('call_stats', this.call_stats, 2)
  }

  async setUserOrGroupStats (user_id, group_id, scope = 'at') {
    const isFull = scope === 'full'
    this.today_user_data.user_scope_available = true
    this.today_user_data.group_scope_available = true
    this.today_user_data.user_full ||= {}
    this.today_user_data.user_at ||= {}
    this.today_user_data.group_full ||= {}
    this.today_user_data.group_at ||= {}

    if (user_id) {
      const user = this.today_user_data.user
      if (!user[user_id]) {
        user[user_id] = 0
        this.stats.user_count++
      }
      user[user_id]++

      const scopeUser = isFull ? this.today_user_data.user_full : this.today_user_data.user_at
      const scopeUserKey = isFull ? 'user_full_count' : 'user_at_count'
      if (!scopeUser[user_id]) {
        scopeUser[user_id] = 0
        this.stats[scopeUserKey]++
      }
      scopeUser[user_id]++

    }

    if (group_id) {
      const group = this.today_user_data.group
      if (!group[group_id]) {
        group[group_id] = 0
        this.stats.group_count++
      }
      group[group_id]++

      const scopeGroup = isFull ? this.today_user_data.group_full : this.today_user_data.group_at
      const scopeGroupKey = isFull ? 'group_full_count' : 'group_at_count'
      if (!scopeGroup[group_id]) {
        scopeGroup[group_id] = 0
        this.stats[scopeGroupKey]++
      }
      scopeGroup[group_id]++

    }

    await this.setDB('user_group_stats', this.today_user_data, 2)
  }

  async getDB (key, date = this.today) {
    return await this.db.get(`${key}${date ? `:${date}` : ''}`)
  }

  /**
   * 计算过期时间存入level
   * @param {string} key
   * @param {*} data
   */
  async setDB (key, data, time = 1, date = this.today) {
    await this.db.set(`${key}${time ? `:${date}` : ''}`, data, time)
  }
}
