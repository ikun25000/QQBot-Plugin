import { mediaErrorText } from './mediaImageApi.js'
import { mediaImageSettings, MEDIA_IMAGE_HARD_LIMIT, MEDIA_IMAGE_LIST_COOLDOWN_MS, MEDIA_IMAGE_PRESSURE_TARGET, MEDIA_IMAGE_PRESSURE_THRESHOLD } from './mediaImageManager.js'

const PREFIX = '#qqbot素材管理'
const CONVERT_PREFIX = '#qqbot图片转换'
const PAGE_SIZE = 10
const label = provider => ({ official: '官方素材管理', ci: '腾讯云 CI', cache: '官方素材缓存复用', failed: '上传失败' })[provider] || '暂无记录'
const quotaPolicyLabel = value => value === 'ci' ? '优先CI' : '清理最早5张'
const date = seconds => seconds ? new Date(Number(seconds) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知'
const safe = text => String(text ?? '').replace(/[\r\n<>`]/g, ' ').slice(0, 240)
const attr = text => String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cmd = (command, show) => `><qqbot-cmd-input text="${attr(command)}" show="${attr(show)}"/>`

// Kept separate from framework startup so commands can be exercised without a bot login.
export async function handleMediaImageCommand ({ event, reply, buttons, manager, getSettings, getImageConvert = () => false, saveSettings, customStatus, confirmations }) {
  const selfId = event.self_id, action = String(event.msg || '').replace(/^#q+bot素材管理/i, '').trim()
  const readOnly = /^(?:菜单|状态|查看(?:\s+\d+)?|详情\s+\S+|满额策略)$/.test(action)
  const back = [{ text: '素材菜单', callback: `${PREFIX}菜单` }]
  const respond = (text, ...rows) => reply([text, buttons(...rows, back)], true)
  const menuCommand = `\n\n${cmd(`${PREFIX}菜单`, '返回素材菜单')}`
  try {
    if (!readOnly) manager.writable()
    const settings = mediaImageSettings(getSettings(selfId))
    let match
    if ((match = /^满额策略(?:\s+(CI优先|清理最早5张))?$/i.exec(action))) {
      if (!match[1]) {
        return respond([
          `[${selfId}] 满额策略`,
          `当前：${quotaPolicyLabel(settings.quotaPolicy)}`,
          `仅在自动清理关闭且官方素材达到 ${MEDIA_IMAGE_HARD_LIMIT}/100 时生效。`,
          '',
          cmd(`${PREFIX}满额策略 CI优先`, '优先使用腾讯云CI'),
          cmd(`${PREFIX}满额策略 清理最早5张`, '优先清理最早的5张')
        ].join('\n'))
      }
      const policy = match[1] === '清理最早5张' ? 'cleanup' : 'ci'
      await saveSettings(selfId, { ...settings, quotaPolicy: policy })
      return respond(`[${selfId}] 满额策略已设置为${quotaPolicyLabel(policy)}${menuCommand}`)
    }
    if ((match = /^切换\s+(官方素材管理|腾讯云CI)$/i.exec(action))) {
      await saveSettings(selfId, { ...settings, provider: match[1] === '官方素材管理' ? 'official' : 'ci' })
      return respond(`[${selfId}] 内置兜底首选已切换为${label(match[1] === '官方素材管理' ? 'official' : 'ci')}${menuCommand}`)
    }
    if ((match = /^自动清理\s+(开启|关闭)$/.exec(action))) {
      await saveSettings(selfId, { ...settings, autoCleanup: match[1] === '开启' })
      return respond(`[${selfId}] 自动清理已${match[1]}${menuCommand}`)
    }
    if ((match = /^保留时间\s+(\d+)(天|小时)$/.exec(action))) {
      const days = Number(match[1]) / (match[2] === '小时' ? 24 : 1)
      if (days < 1 || days > 90) return respond('保留时间应在 1～90 天之间（24～2160 小时）。')
      await saveSettings(selfId, { ...settings, retentionDays: days })
      return respond(`[${selfId}] 闲置保留时间已设置为 ${days} 天${menuCommand}`)
    }
    if (/^(?:删除\s+\S+|清理|清空)(?:\s+确认)?$/.test(action)) {
      const confirmed = /\s+确认$/.test(action), operation = action.replace(/\s+确认$/, '')
      const ctx = manager.context(selfId)
      const operator = String(event.user_id || event.sender?.user_id || '')
      if (!operator) return respond('当前事件缺少操作者身份，无法确认素材删除。')
      const key = `${selfId}:${ctx.appid}:${operator}`
      for (const [id, value] of confirmations) if (value.expires <= Date.now()) confirmations.delete(id)
      if (!confirmed) {
        let description, candidates
        if (operation.startsWith('删除')) {
          const imageId = operation.split(/\s+/)[1], view = await manager.view(selfId)
          const image = view.images.find(item => item.image_id === imageId)
          if (!image) return respond('当前机器人不存在该素材。')
          if (image.protected) return respond('该素材正在发送或被固定配置引用，暂不能删除。')
          description = `删除素材 ${safe(imageId)}（${image.managed ? '本插件管理' : '其他来源'}）`
        } else {
          const result = await manager.cleanup(selfId, { dryRun: true, all: operation === '清空' })
          candidates = result.candidates
          description = `${operation}本插件管理的可删除素材，当前 ${result.candidates.length} 张。\n清理规则：闲置满 ${settings.retentionDays} 天；素材达到 ${MEDIA_IMAGE_PRESSURE_THRESHOLD}/${MEDIA_IMAGE_HARD_LIMIT} 张时，新上传前回收到 ${MEDIA_IMAGE_PRESSURE_TARGET} 张`
        }
        manager.writable()
        if (confirmations.size >= 1000) confirmations.delete(confirmations.keys().next().value)
        confirmations.set(key, { operation, candidates, expires: Date.now() + 120000 })
        return respond(`${description}。删除后不能再用于新消息，已发送消息不受影响。\n请在 2 分钟内确认：\n\n${cmd(`${PREFIX}${operation} 确认`, '确认执行')}`, [
          { text: '确认执行', callback: `${PREFIX}${operation} 确认` }
        ])
      }
      const pending = confirmations.get(key)
      confirmations.delete(key)
      if (!pending || pending.expires <= Date.now() || pending.operation !== operation) return respond('确认不存在或已过期，请重新发起操作。')
      manager.writable()
      if (operation.startsWith('删除')) {
        await manager.delete(selfId, operation.split(/\s+/)[1])
        return respond(`指定素材已删除。${menuCommand}`)
      }
      const result = await manager.cleanup(selfId, { all: operation === '清空', ids: pending.candidates })
      return respond(`素材${operation}完成：删除 ${result.deleted} 张，失败 ${result.failed} 张，跳过 ${result.skipped} 张。${result.error ? '\n' + safe(result.error) : ''}${menuCommand}`)
    }

    if (/^查看(?:\s+\d+)?$/.test(action)) {
      const view = await manager.view(selfId), pageCount = Math.max(1, Math.ceil(view.images.length / PAGE_SIZE))
      const page = Math.max(1, Math.min(pageCount, Number(action.split(/\s+/)[1]) || 1))
      const pageImages = view.images.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      const lines = [`[${selfId}] 官方素材列表 第 ${page}/${pageCount} 页，共 ${view.total}/${MEDIA_IMAGE_HARD_LIMIT} 张（每页 ${PAGE_SIZE} 张）`]
      if (pageImages.length) {
        lines.push('>点击文件名查看完整详情和删除命令')
        for (const image of pageImages) {
          const fileName = safe(image.file_name) || safe(image.image_id)
          const tags = `${image.managed ? '' : '（其他来源）'}${image.protected ? '（受保护）' : ''}`
          lines.push(cmd(`${PREFIX}详情 ${image.image_id}`, `${fileName}${tags}`))
        }
      } else lines.push('暂无有效图片。')
      const nav = []
      if (page > 1) {
        nav.push({ text: '上一页', callback: `${PREFIX}查看 ${page - 1}` })
        lines.push(cmd(`${PREFIX}查看 ${page - 1}`, '上一页'))
      }
      if (page < pageCount) {
        nav.push({ text: '下一页', callback: `${PREFIX}查看 ${page + 1}` })
        lines.push(cmd(`${PREFIX}查看 ${page + 1}`, '下一页'))
      }
      return respond(lines.join('\n'), ...(nav.length ? [nav] : []))
    }
    if ((match = /^详情\s+(\S+)$/.exec(action))) {
      const view = await manager.view(selfId), image = view.images.find(item => item.image_id === match[1])
      if (!image) return respond('当前机器人不存在该素材。')
      const record = { appid: view.appid, self_id: selfId, ...image }
      const preview = image.preview_url ? [[{ text: '预览图片', link: image.preview_url }]] : []
      return respond([
        `[${selfId}] 素材详情`, `ID：${safe(image.image_id)}`, `文件：${safe(image.file_name)}`,
        `归属：${image.managed ? '本插件管理' : '其他来源'}`, `保护：${image.protected ? '正在发送或固定配置引用' : '无'}`,
        `上传：${date(image.created_at)}`, `到期：${date(image.expires_at)}`, `最近使用：${date(image.lastUsed / 1000)}`,
        `预览：${image.preview_url ? '官方已返回，可点击下方按钮或查看 JSON' : '官方未返回'}`,
        '',
        image.protected
          ? '该素材当前受保护，暂不能删除。'
          : cmd(`${PREFIX}删除 ${image.image_id}`, '删除该素材'),
        '',
        '完整记录：',
        '```json',
        JSON.stringify(record, null, 2).replace(/`/g, '\\u0060'),
        '```'
      ].join('\n'), ...preview)
    }

    const custom = manager.customLoaded(), status = await customStatus(), health = manager.health.get(String(selfId))
    const imageConvert = !!getImageConvert(selfId)
    let inventory
    try {
      const view = await manager.view(selfId)
      const cleanup = view.lastCleanup
      inventory = `官方素材：${view.total}/${MEDIA_IMAGE_HARD_LIMIT} 张，本插件管理 ${view.images.filter(image => image.managed).length} 张\n最近清理：${cleanup ? `${date(cleanup.time / 1000)}，删除 ${cleanup.deleted}，失败 ${cleanup.failed}` : '暂无记录'}`
    } catch (error) { inventory = `官方素材查询失败：${safe(mediaErrorText(error))}` }
    const lines = [
      `[${selfId}] QQBot素材管理菜单`, `自定义图床：${safe(status)}`,
      `当前处理方式：${custom ? '自定义图床' : `内置兜底（${label(settings.provider)}优先）`}`,
      `最近实际上传：${label(health?.provider)}${health?.time ? '，' + date(health.time / 1000) : ''}`,
      ...(health?.reason ? [`最近回退或失败原因：${safe(health.reason)}`] : []), inventory,
      `自动清理：${custom ? '暂停（已加载自定义图床）' : settings.autoCleanup ? '开启' : '关闭'}；闲置满 ${settings.retentionDays} 天清理`,
      `清理触发：上传前检查（官方列表冷却 ${MEDIA_IMAGE_LIST_COOLDOWN_MS / 1000} 秒）；素材达到 ${MEDIA_IMAGE_PRESSURE_THRESHOLD}/${MEDIA_IMAGE_HARD_LIMIT} 张时回收至 ${MEDIA_IMAGE_PRESSURE_TARGET} 张`,
      `满额策略（自动清理关闭时）：${quotaPolicyLabel(settings.quotaPolicy)}；达到 ${MEDIA_IMAGE_HARD_LIMIT}/100 后执行`,
      `Markdown网络图片二次转换：${imageConvert ? '开启' : '关闭'}${custom ? '（自定义图床已加载，设置不生效）' : '（关闭时直接使用原始公网链接）'}`,
      '自动清理仅管理本插件上传的图片，发送中和固定配置引用的图片受保护。',
      custom ? '已加载自定义图床，内置图床上传、设置、删除和清理操作均已停用。' : '满足原有兜底条件时生效；官方失败、超出 10MiB 或格式不支持时使用腾讯云 CI。',
      '',
      '>素材查询',
      cmd(`${PREFIX}查看`, '查看素材（第一页）'),
      cmd(`${PREFIX}查看 2`, '查看第二页'),
      cmd(`${PREFIX}详情 image_id`, '查看素材详情'),
      ...(!custom ? [
        '',
        '>素材设置',
        cmd(`${PREFIX}切换 官方素材管理`, '官方素材优先，CI 兜底'),
        cmd(`${PREFIX}切换 腾讯云CI`, '直接使用腾讯云CI'),
        cmd(`${PREFIX}自动清理 ${settings.autoCleanup ? '关闭' : '开启'}`, `${settings.autoCleanup ? '关闭' : '开启'}自动清理`),
        cmd(`${PREFIX}保留时间 3天`, '设置闲置保留时间'),
        cmd(`${PREFIX}满额策略 CI优先`, '满额时优先使用腾讯云CI'),
        cmd(`${PREFIX}满额策略 清理最早5张`, '满额时优先清理最早的5张'),
        cmd(`${CONVERT_PREFIX} ${imageConvert ? '关闭' : '开启'}`, `${imageConvert ? '关闭' : '开启'}网络图片二次转换`),
        '',
        '>素材清理',
        cmd(`${PREFIX}删除 image_id`, '删除指定素材'),
        cmd(`${PREFIX}清理`, '清理闲置素材'),
        cmd(`${PREFIX}清空`, '清空本插件管理的素材')
      ] : [])
    ]
    const rows = [[{ text: '查看素材', callback: `${PREFIX}查看` }, { text: '刷新状态', callback: `${PREFIX}状态` }]]
    if (!custom) rows.push(
      [{ text: '官方素材优先', callback: `${PREFIX}切换 官方素材管理` }, { text: '腾讯云CI', callback: `${PREFIX}切换 腾讯云CI` }],
      [{ text: `${settings.autoCleanup ? '关闭' : '开启'}自动清理`, callback: `${PREFIX}自动清理 ${settings.autoCleanup ? '关闭' : '开启'}` }, { text: '保留时间', input: `${PREFIX}保留时间 ` }],
      [{ text: '满额优先CI', callback: `${PREFIX}满额策略 CI优先` }, { text: '满额清5张', callback: `${PREFIX}满额策略 清理最早5张` }],
      [{ text: `${imageConvert ? '关闭' : '开启'}网络转换`, callback: `${CONVERT_PREFIX} ${imageConvert ? '关闭' : '开启'}` }],
      [{ text: '清理闲置', callback: `${PREFIX}清理` }, { text: '清空托管', callback: `${PREFIX}清空` }]
    )
    rows.push([{ text: '返回其他菜单', callback: '#QQBot其他菜单' }])
    return reply([lines.join('\n\n'), buttons(...rows)], true)
  } catch (error) { return respond(`[${selfId}] 素材管理操作失败：${safe(mediaErrorText(error))}`) }
}

export async function handleImageConvertCommand ({ event, reply, buttons, getValue, setValue, save, customLoaded }) {
  const selfId = event.self_id
  const action = String(event.msg || '').replace(/^#q+bot(?:网络)?图片转换/i, '').trim()
  const current = !!getValue(selfId)
  const custom = customLoaded()
  const back = [{ text: '素材菜单', callback: `${PREFIX}菜单` }]
  const note = custom ? '\n\n已加载自定义图床，Markdown 图片由自定义图床处理，此设置暂不生效。' : ''
  const status = `[${selfId}] Markdown网络图片二次转换：${current ? '开启' : '关闭'}${note}`
  if (!action) {
    return reply([
      [
        status,
        '',
        '>关闭时，公网 http/https 图片链接直接写入 Markdown，不再上传到官方素材或腾讯云 CI。',
        '>开启后恢复原有转存流程。',
        '>非 Markdown 图片消息不受影响，仍按原方式下载上传。',
        '',
        cmd(`${CONVERT_PREFIX} ${current ? '关闭' : '开启'}`, `${current ? '关闭' : '开启'}网络图片二次转换`)
      ].join('\n'),
      buttons([{ text: `${current ? '关闭' : '开启'}二次转换`, callback: `${CONVERT_PREFIX} ${current ? '关闭' : '开启'}` }], back)
    ], true)
  }
  if (!/^(开启|关闭)$/.test(action)) {
    return reply([`[${selfId}] 用法：${CONVERT_PREFIX} 开启/关闭`, buttons(back)], true)
  }
  setValue(selfId, action === '开启')
  await save()
  return reply([
    `[${selfId}] Markdown网络图片二次转换已${action}${note}`,
    buttons([{ text: `${action === '开启' ? '关闭' : '开启'}二次转换`, callback: `${CONVERT_PREFIX} ${action === '开启' ? '关闭' : '开启'}` }])
  ], true)
}
