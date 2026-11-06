import { isWsC2cPrivate, wsPrivateRecipient } from './wsNotifications.js'

const toggle = value => value ? '关闭' : '开启'
const state = value => value ? '开启' : '关闭'
const hint = (command, title) => `><qqbot-cmd-input text="${command}" show="${title}"/>`

export async function handleWsCommand ({ event, store, reply, buttons, runtime, allStatus, currentStatus, separator = ':', changed = async () => {} }) {
  const id = String(event.self_id)
  await store.loadAccount(id)
  const settings = store.settings(id)
  const msg = String(event.msg || '').trim()
  const result = (message, callback = '#QQBotws配置') => reply([
    message, buttons([{ text: '返回', callback }])
  ], true)
  let match
  if (/^#q+botws配置$/i.test(msg)) {
    const od = settings.offline
    const rows = [
      [{ text: '连接次数', callback: '#QQBotWS连接次数' }, { text: '全部机器人', callback: '#QQBotWS全部连接次数' }],
      [{ text: '通知配置', callback: '#QQBotWS通知配置' }, { text: `${toggle(settings.sessionSave)}保存`, callback: `#QQBotSession保存 ${toggle(settings.sessionSave)}` }],
      [{ text: `${toggle(od.autoReconnect)}重连`, callback: `#QQBot账号掉线自动重连${toggle(od.autoReconnect)}` }, { text: `${toggle(od.enabled)}检测`, callback: `#QQBot账号掉线检测${toggle(od.enabled)}` }],
      [{ text: '正式环境', callback: '#QQBot开启正式环境' }, { text: '沙箱环境', callback: '#QQBot开启沙箱环境' }],
      [{ text: '掉线设置', callback: '#QQBotWS掉线配置' }, { text: '返回', callback: '#QQBot其他菜单' }]
    ]
    return reply([
      [
        `#[${id}] QQBot WS配置`, '',
        `>Session持久保存：${state(settings.sessionSave)}（默认关闭，仅影响进程重启；运行中断线优先Resume）`, '',
        `>通知总开关：${state(settings.notifications.enabled)}，方式：${settings.notifications.method}`, '',
        `>当前运行环境：${runtime ? runtime.wsEnvironment ? '沙箱' : '正式' : '未运行'}`, '',
        `>下次启动环境：${settings.sandbox ? '沙箱' : '正式'}（忽略全局sandbox，重启生效）`, '',
        hint('#QQBotWS连接次数', '本机器人连接次数'), '', hint('#QQBotWS全部连接次数', '查看本地所有机器人'), '',
        hint('#QQBotWS通知配置', '通知配置'), '', hint('#QQBotWS掉线配置', '掉线设置'), '',
        hint(`#QQBotSession保存 ${toggle(settings.sessionSave)}`, `${toggle(settings.sessionSave)}Session保存`), '',
        hint('#QQBot开启正式环境', '开启正式环境'), '', hint('#QQBot开启沙箱环境', '开启沙箱环境')
      ].join('\n'), buttons(...rows)
    ], true)
  }
  if (/^#q+botws通知配置$/i.test(msg)) {
    const options = settings.notifications
    return reply([
      [
        `#[${id}] WS通知配置`, '',
        `>总开关：${state(options.enabled)}；默认全部关闭，独立开关需总开关开启才生效。`, '',
        `>零次数：${state(options.zero)}；大量消耗：${state(options.consumption)}（滚动5分钟≥10次）；掉线：${state(options.offline)}`, '',
        `>通知方式：${options.method}${options.method === '本号' ? '（已绑定C2C私聊接收人）' : ''}`, '',
        '>本号方式只能在此机器人的C2C私聊设置；群聊、频道及频道私信拒绝绑定。发送失败不切换方式，也不阻塞重连。', '',
        hint(`#QQBotWS通知 ${toggle(options.enabled)}`, `${toggle(options.enabled)}总开关`), '',
        hint(`#QQBotWS零次数通知 ${toggle(options.zero)}`, `${toggle(options.zero)}零次数通知`), '',
        hint(`#QQBotWS大量消耗通知 ${toggle(options.consumption)}`, `${toggle(options.consumption)}大量消耗通知`), '',
        hint(`#QQBotWS掉线通知 ${toggle(options.offline)}`, `${toggle(options.offline)}掉线通知`), '',
        hint('#QQBotWS通知方式 本号', '设置本号通知'), '', hint('#QQBotWS通知方式 sendmastermsg', '设置sendmastermsg通知')
      ].join('\n'), buttons(
        [{ text: `${toggle(options.enabled)}总开关`, callback: `#QQBotWS通知 ${toggle(options.enabled)}` }, { text: `${toggle(options.zero)}零次数`, callback: `#QQBotWS零次数通知 ${toggle(options.zero)}` }],
        [{ text: `${toggle(options.consumption)}消耗`, callback: `#QQBotWS大量消耗通知 ${toggle(options.consumption)}` }, { text: `${toggle(options.offline)}掉线`, callback: `#QQBotWS掉线通知 ${toggle(options.offline)}` }],
        [{ text: '本号通知', callback: '#QQBotWS通知方式 本号' }, { text: '主人通知', callback: '#QQBotWS通知方式 sendmastermsg' }],
        [{ text: '返回', callback: '#QQBotws配置' }]
      )
    ], true)
  }
  if (/^#q+botws掉线配置$/i.test(msg)) {
    const od = settings.offline
    return reply([
      [`#[${id}] WS掉线配置`, '',
        `>基础自动重连：${state(od.autoReconnect)}；定时兜底检测：${state(od.enabled)}；间隔：${od.interval}分钟`, '',
        '>心跳超时优先Resume，Session失效才Identify。基础恢复不依赖定时检测；掉线提醒还受通知总开关控制。', '',
        hint(`#QQBot账号掉线自动重连${toggle(od.autoReconnect)}`, `${toggle(od.autoReconnect)}自动重连`), '',
        hint(`#QQBot账号掉线检测${toggle(od.enabled)}`, `${toggle(od.enabled)}定时检测`), '',
        hint('#QQBot账号掉线检测时间设置 5分钟', '设置5分钟'), '', hint('#QQBot账号掉线检测时间设置 10分钟', '设置10分钟'), '',
        hint('#QQBotWS通知配置', '通知配置')].join('\n'),
      buttons(
        [{ text: `${toggle(od.autoReconnect)}重连`, callback: `#QQBot账号掉线自动重连${toggle(od.autoReconnect)}` }, { text: `${toggle(od.enabled)}检测`, callback: `#QQBot账号掉线检测${toggle(od.enabled)}` }],
        [{ text: '间隔5分钟', callback: '#QQBot账号掉线检测时间设置5分钟' }, { text: '间隔10分钟', callback: '#QQBot账号掉线检测时间设置10分钟' }],
        [{ text: '通知配置', callback: '#QQBotWS通知配置' }, { text: '返回', callback: '#QQBotws配置' }]
      )
    ], true)
  }
  if ((match = /^#q+botws全部(?:连接|链接)次数(?:\s+(\d+))?$/i.exec(msg))) return allStatus(Number(match[1]) || 1)
  if (/^#q+bot(?:ws)?(?:可用)?(?:连接|链接)次数(?:\s+\d+)?$/i.test(msg)) return currentStatus()
  if ((match = /^#q+botSession保存\s*(开启|关闭)$/i.exec(msg))) {
    const enabled = match[1] === '开启'
    await store.update(id, record => { record.settings.sessionSave = enabled })
    await changed('session', enabled)
    return result(`本机器人Session持久保存已${state(enabled)}；${enabled ? '重启时优先恢复已保存Session' : '已清除持久化Session，重启使用Identify'}。运行中断线仍优先Resume。`)
  }
  if ((match = /^#q+bot开启(正式|沙箱)环境$/i.exec(msg))) {
    await store.update(id, record => { record.settings.sandbox = match[1] === '沙箱' })
    return result(`本机器人已设置为${match[1]}环境，重启生效；当前连接环境不变，忽略全局sandbox。`)
  }
  if ((match = /^#q+botWS(零次数|大量消耗|掉线)?通知\s*(开启|关闭)$/i.exec(msg))) {
    const key = { 零次数: 'zero', 大量消耗: 'consumption', 掉线: 'offline' }[match[1]] || 'enabled'
    await store.update(id, record => { record.settings.notifications[key] = match[2] === '开启' })
    await changed('notifications')
    return result(`本机器人WS${match[1] || '总'}通知已${match[2]}${key !== 'enabled' && !store.settings(id).notifications.enabled ? '（通知总开关仍关闭）' : ''}`, '#QQBotWS通知配置')
  }
  if ((match = /^#q+botWS通知方式\s+(本号|sendmastermsg)$/i.exec(msg))) {
    const method = match[1].toLowerCase()
    const recipient = method === '本号' ? wsPrivateRecipient(event, separator) : ''
    if (method === '本号' && (!isWsC2cPrivate(event) || !recipient)) return result('拒绝设置：本号通知只能在当前机器人的C2C私聊绑定有效openid；群聊、频道和频道私信不可使用。', '#QQBotWS通知配置')
    await store.update(id, record => {
      record.settings.notifications.method = method
      record.settings.notifications.recipient = recipient
    })
    await changed('notifications')
    return result(`本机器人WS通知方式已设为${method}，通知开关保持不变。`, '#QQBotWS通知配置')
  }
  return result('WS命令无效。环境和配置命令只操作本机器人，不接受QQ参数，请使用 #QQBotws配置。')
}
