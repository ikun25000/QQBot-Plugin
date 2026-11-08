import makeConfig from '../../../lib/plugins/config.js'
import fs from 'node:fs/promises'
import YAML from 'yaml'
import { wsStore } from './wsStore.js'
import { fixedConfigValue } from './fixedConfigSerializer.js'
import { createConfigSaver } from './configSaver.js'
import { createWsYamlSettings } from './wsSettings.js'
import { botOptionDefaults } from './configMigration.js'
import { allowNextQQBotCredentialRemoval as authorizeCredentialRemoval, flushQQBotCredentialLossNotification, installQQBotConfigSafetyHook, prepareQQBotConfig, readQQBotConfigRevision, reloadSafeQQBotConfig, setQQBotCredentialLossNotifier, setQQBotCredentialLossSync, startQQBotConfigBackupCheck, stopQQBotConfigBackupCheck } from './configSafety.js'

installQQBotConfigSafetyHook()
await prepareQQBotConfig()

let { config } = await makeConfig('QQBot', {
  tips: '',
  permission: 'master',
  ...botOptionDefaults(),
  hideGuildRecall: false,
  markdown: {
    template: 'abcdefghij'
  },
  sendButton: true,
  customMD: {},
  messageSuffix: {
    bots: {}
  },
  messageProtection: {
    bots: {}
  },
  filterLog: {},
  simplifiedSdkLog: false,
  markdownImgScale: 1.0,
  sep: '',
  bus: {},
  bots: {},
  apiMode: 'old',
  selfOpenid: {},
  claw: {
    bots: {}
  },
  fullMessage: {
    bots: {}
  },
  icebreaker: {
    bots: {}
  },
  recall: {
    bots: {}
  },
  advancedWelcome: {
    bots: {}
  },
  userManage: {
    bots: {}
  },
  fullMessageDB: 'level',
  inviteDB: 'level',
  dauDB: 'redis',
  // dau: {
  //   enable: true,
  //   user_count: true,  // 上行消息人数
  //   group_count: true, // 上行消息群数
  //   msg_count: true,      // 上行消息量
  //   send_count: true,     // 下行消息量
  //   all_user_count: true, // 所有用户数
  //   all_group_count: true, // 所有群组数
  //   group_increase_count: true, // 新增群数量
  //   group_decrease_count: true, // 减少群数量
  // 新增用户数量
  // 消息数量最多的用户
  // 消息数量最多的群聊
  // 昨日数据
  // 平均数据
  // },
  bot: {
    sandbox: false,
    maxRetry: Infinity,
    timeout: 30000
  },
  token: []
}, {
  tips: [
    '欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空 & 小叶',
    '参考：https://github.com/XasYer/Yunzai-QQBot-Plugin'
  ]
}, {
  replacer: text => YAML.stringify(fixedConfigValue(YAML.parse(text), wsStore))
})

// Credential changes must await the actual serialized atomic write, not the
// framework debounce callback. The safety hook below handles no-op writes.
let configRevision = await readQQBotConfigRevision()
const configSave = createConfigSaver({
  snapshot: () => fixedConfigValue(config, wsStore),
  write: (value, { credentialUpsert }) => fs.writeFile('config/QQBot.yaml', YAML.stringify(value), {
    encoding: 'utf8', credentialUpsert, expectedRevision: () => configRevision, onCommitted: revision => { configRevision = revision }
  })
})
const allowNextQQBotCredentialRemoval = next => authorizeCredentialRemoval(YAML.stringify(fixedConfigValue(typeof next === 'string' ? YAML.parse(next) : next, wsStore)))
const wsYamlSettings = createWsYamlSettings({ config, save: configSave })
wsStore.useSettings(wsYamlSettings)

startQQBotConfigBackupCheck()

async function refConfig () {
  return wsYamlSettings.exclusive(async () => {
    await configSave.flush().catch(error => { if (error.code !== 'QQBOT_CONFIG_EDITED') throw error })
    const { config: next, revision } = await reloadSafeQQBotConfig({ withRevision: true })
    wsYamlSettings.validate(next)
    for (const key of Object.keys(config)) delete config[key]
    Object.assign(config, next)
    configRevision = revision
    config.selfOpenid ||= {}
    for (const [id, record] of wsStore.accounts) if (record.selfOpenid) config.selfOpenid[id] = record.selfOpenid
  })
}

export {
  config,
  configSave,
  refConfig,
  stopQQBotConfigBackupCheck,
  allowNextQQBotCredentialRemoval,
  setQQBotCredentialLossNotifier,
  setQQBotCredentialLossSync,
  flushQQBotCredentialLossNotification
}
