import _ from 'lodash'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { join } from 'node:path'
import imageSize from 'image-size'
import { randomUUID } from 'node:crypto'
import { encode as encodeSilk } from 'silk-wasm'
import crypto from 'node:crypto'
import {
  Dau,
  importJS,
  Runtime,
  Handler,
  config,
  configSave,
  refConfig,
  splitMarkDownTemplate,
  getMustacheTemplating
} from './Model/index.js'
import { createRequire } from 'module'
import { Bot as QQBot } from 'qq-official-bot'
const require = createRequire(import.meta.url)

const startTime = new Date()
logger.info(logger.yellow('- 正在加载 QQBot 适配器插件'))

const userIdCache = {}
const markdown_template = await importJS('Model/template/markdownTemplate.js', 'default')
const TmplPkg = await importJS('templates/index.js')

// ========== 扩展 segment.file 支持 force_chunk 参数 ==========
const originalSegmentFile = segment.file.bind(segment)
segment.file = function(file, name, forceChunk) {
  // 调用原始方法
  let result
  if (typeof file === 'object' && file !== null && !Buffer.isBuffer(file)) {
    // segment.file({ file, name, force_chunk })
    result = originalSegmentFile(file)
    if (typeof file.force_chunk !== 'undefined') {
      result.force_chunk = file.force_chunk
    }
  } else {
    // segment.file(url, name) 或 segment.file(url, name, forceChunk)
    result = originalSegmentFile(file, name)
    if (typeof forceChunk !== 'undefined') {
      result.force_chunk = forceChunk
    }
  }
  
  return result
}
// ========== 扩展结束 ==========

const adapter = new class QQBotAdapter {
  constructor () {
    this.id = 'QQBot'
    this.name = 'QQBot'
    this.path = 'data/QQBot/'
    this.version = 'qq-group-bot v11.45.14'

    if (typeof config.toQRCode == 'boolean') {
      this.toQRCodeRegExp = config.toQRCode ? /(?<!\[(.*?)\]\()https?:\/\/[-\w_]+(\.[-\w_]+)+([-\w.,@?^=%&:/~+#]*[-\w@?^=%&/~+#])?/g : false
    } else {
      this.toQRCodeRegExp = new RegExp(config.toQRCode, 'g')
    }

    this.sep = config.sep || ((process.platform == 'win32') && '') || ':'
  }

  async makeRecord (file) {
    if (config.toBotUpload) {
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

  async makeQRCode (data) {
    return (await QRCode.toDataURL(data)).replace('data:image/png;base64,', 'base64://')
  }

  async makeRawMarkdownText (data, text, button) {
    const match = text.match(this.toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        const img = await this.makeMarkdownImage(data, await this.makeQRCode(url), '二维码')
        text = text.replace(url, `${img.des}${img.url}`)
      }
    }
    return text.replace(/@/g, '@​')
  }

  async makeBotImage (file) {
    if (config.toBotUpload) {
      for (const i of Bot.uin) {
        if (!Bot[i].uploadImage) continue
        try {
          const image = await Bot[i].uploadImage(file)
          if (image.url) return image
        } catch (err) {
          Bot.makeLog('error', ['Bot', i, '图片上传错误', file, err])
        }
      }
    }
  }

  async makeMarkdownImage (data, file, summary = '图片') {
    const buffer = await Bot.Buffer(file)
    const image =
      await this.makeBotImage(buffer) ||
      { url: await Bot.fileToUrl(file) }

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
 * 上传文件到QQ官方API
 * @param {Object} data - 消息数据
 * @param {string} target_id - 目标ID（群号或用户ID）
 * @param {string} target_type - 目标类型 'group' 或 'user'
 * @param {Buffer|string} file_data - 文件数据
 * @param {string} file_name - 文件名
 * @param {boolean} force_chunk - 强制使用分片上传
 */
async uploadFileToQQ(data, target_id, target_type, file_data, file_name, force_chunk = false) {
  // 如果是网络 URL 且未强制分片，先尝试直传
  if (typeof file_data === 'string' && file_data.startsWith('http') && !force_chunk) {
    // 检查文件大小
    let fileSizeMB = 0
    try {
      const headResponse = await fetch(file_data, { method: 'HEAD' })
      const contentLength = headResponse.headers.get('content-length')
      fileSizeMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0
      Bot.makeLog('info', [`网络文件大小: ${fileSizeMB.toFixed(2)} MB`], data.self_id)
    } catch (err) {
      Bot.makeLog('debug', ['无法获取文件大小，尝试直传', err.message], data.self_id)
    }
    
    // 尝试 URL 直传
    Bot.makeLog('info', ['检测到网络 URL，使用直传（不下载文件）', { url: file_data.substring(0, 100), file_name }], data.self_id)
    
    try {
      const filesUrl = `/v2/${target_type}s/${target_id}/files`
      const filesData = {
        file_type: 4,
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
      
      // 如果文件 > 10MB，切换为分片上传
      if (fileSizeMB > 10) {
        Bot.makeLog('info', [`文件大于 10MB (${fileSizeMB.toFixed(2)} MB)，降级为分片上传`], data.self_id)
        force_chunk = true  // 强制使用分片上传
      } else {
        Bot.makeLog('info', [`文件较小 (${fileSizeMB.toFixed(2)} MB)，降级为 base64 上传`], data.self_id)
      }
      
    }
  }
  // ===== URL 直传优化结束 =====

  // 获取文件Buffer的通用函数
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

  // 从 URL 或路径提取文件名的函数
  const extractFileName = (file_data, fileBuffer) => {
    let name = ''
    let ext = ''

    // 1. 从路径或 URL 提取
    if (typeof file_data === 'string') {
      if (file_data.startsWith('http')) {
        try {
          const url = new URL(file_data)
          const pathname = url.pathname
          const segments = pathname.split('/')
          const lastSegment = segments[segments.length - 1]
          
          // 去除 URL 参数
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
        // 普通路径
        name = file_data.split('/').pop() || file_data.split('\\').pop()
        if (name && name.includes('.')) {
          ext = name.substring(name.lastIndexOf('.'))
        }
      }
    }

    // 2. 如果没有扩展名，从文件头识别
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
      
      // 特殊处理 RIFF 格式（WAV/WEBP）
      if (header.startsWith('52494646')) {
        const riffType = fileBuffer.toString('hex', 8, 12).toUpperCase()
        if (riffType === '57454250') {
          ext = '.webp'
        } else {
          ext = '.wav'
        }
      }
    }

    // 3. 生成最终文件名
    if (!name || !name.includes('.')) {
      const timestamp = Date.now().toString(36)
      const random = Math.random().toString(36).substring(2, 8)
      name = `file_${timestamp}_${random}${ext || '.bin'}`
    }

    // 4. 确保文件名不超过合理长度
    if (name.length > 100) {
      const extension = name.substring(name.lastIndexOf('.'))
      const baseName = name.substring(0, name.lastIndexOf('.'))
      name = baseName.substring(0, 80) + '...' + extension
    }

    return name
  }

  try {
    // 获取文件Buffer
    const fileBuffer = await getFileBuffer(file_data)
    const file_size = fileBuffer.length

    // 提取或生成文件名
    if (!file_name) {
      file_name = extractFileName(file_data, fileBuffer)
    }

    // 决定上传方式
    const shouldUseChunk = force_chunk || target_type === 'user'
    
    Bot.makeLog('debug', ['上传方式判断', { force_chunk, target_type, shouldUseChunk, file_size_mb: (file_size / 1024 / 1024).toFixed(2) }], data.self_id)

    if (!shouldUseChunk && target_type === 'group') {
      // 群聊非强制分片：尝试 base64 直传
      Bot.makeLog('debug', ['群聊使用 base64 直传', { target_id, file_name, size: file_size }], data.self_id)
      
      const filesUrl = `/v2/${target_type}s/${target_id}/files`
      const base64Data = fileBuffer.toString('base64')
      const filesData = {
        file_type: 4,
        srv_send_msg: false,
        file_data: base64Data,
        file_name: file_name
      }
      
      Bot.makeLog('debug', ['使用 base64 直传', filesUrl, { file_name, size: file_size }], data.self_id)
      
      const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)
      
      Bot.makeLog('debug', ['群聊 base64 直传成功', result], data.self_id)
      
      return result
    }

    // 使用分片上传（私聊默认 / 强制分片 / 群聊大文件降级）
    const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex')
    const sha1Hash = crypto.createHash('sha1').update(fileBuffer).digest('hex')
    const md5_10m = crypto.createHash('md5').update(fileBuffer.slice(0, Math.min(10 * 1024 * 1024, file_size))).digest('hex')

    Bot.makeLog('debug', ['准备分片上传', { target_id, target_type, file_name, file_size }], data.self_id)

    // 1. 调用 upload_prepare
    const prepareUrl = `/v2/${target_type}s/${target_id}/upload_prepare`
    const prepareData = {
      file_type: 4,
      file_name,
      file_size,
      md5: md5Hash,
      sha1: sha1Hash,
      md5_10m
    }

    Bot.makeLog('debug', ['调用 upload_prepare', prepareUrl, prepareData], data.self_id)

    const { data: prepareResult } = await data.bot.sdk.request.post(prepareUrl, prepareData)

    Bot.makeLog('debug', ['upload_prepare 返回', prepareResult], data.self_id)

    const { upload_id, parts, block_size } = prepareResult

    // 2. 用返回的 presigned_url 执行 PUT
    const axios = await import('axios').then(m => m.default)
    for (const part of parts) {
      const { index, presigned_url } = part
      const start = (index - 1) * block_size
      const end = Math.min(start + block_size, file_size)
      const partBuffer = fileBuffer.slice(start, end)

      Bot.makeLog('debug', [`上传分片 ${index}/${parts.length}`, { start, end, size: partBuffer.length }], data.self_id)

      await axios.put(presigned_url, partBuffer, {
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      })

      // 3. 调用 upload_part_finish
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

    // 4. 最后调 /files 提交 upload_id
    const filesUrl = `/v2/${target_type}s/${target_id}/files`
    const filesData = { upload_id }

    Bot.makeLog('debug', ['调用 /files 提交', filesUrl, filesData], data.self_id)

    const { data: filesResult } = await data.bot.sdk.request.post(filesUrl, filesData)

    Bot.makeLog('debug', ['分片上传成功', filesResult], data.self_id)

    return filesResult

  } catch (error) {
    Bot.makeLog('error', ['文件上传失败，尝试最终降级', error.message, error.response?.data], data.self_id)
    
    // 最终降级方案
    try {
      const fileBuffer = await getFileBuffer(file_data)
      
      // 确定文件名
      let finalFileName = file_name
      if (!finalFileName) {
        finalFileName = extractFileName(file_data, fileBuffer)
      }
      
      const filesUrl = `/v2/${target_type}s/${target_id}/files`
      let filesData
      
      // 如果原始数据是 URL，尝试 URL 直传
      if (typeof file_data === 'string' && file_data.startsWith('http')) {
        filesData = {
          file_type: 4,
          srv_send_msg: false,
          url: file_data,
          file_name: finalFileName
        }
        Bot.makeLog('debug', ['最终降级为 URL 直传', filesUrl, filesData], data.self_id)
      } else {
        // 否则降级为 base64
        const base64Data = fileBuffer.toString('base64')
        filesData = {
          file_type: 4,
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
extractFileNameFromUrl(url) {
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

/**
 * 发送文件消息（直接调用API）
 */
async sendFileMessage(data, target_id, target_type, fileInfo) {
  try {
    // 解析文件信息，处理嵌套对象
    let actualFile, actualName, actualForceChunk
    
    // 检查 fileInfo.file 是否是嵌套对象
    if (typeof fileInfo.file === 'object' && fileInfo.file !== null && fileInfo.file.file) {
      // 嵌套情况：{ file: { file: url, name: xx, force_chunk: 0 }, name: null, force_chunk: false }
      actualFile = fileInfo.file.file
      actualName = fileInfo.file.name || fileInfo.name
      actualForceChunk = !!(fileInfo.file.force_chunk || fileInfo.force_chunk)
    } else {
      // 正常情况：{ file: url, name: xx, force_chunk: true }
      actualFile = fileInfo.file
      actualName = fileInfo.name
      actualForceChunk = !!(fileInfo.force_chunk)
    }
    
    Bot.makeLog('debug', ['解析后的文件信息', { 
      actualFile: typeof actualFile === 'string' ? actualFile : 'Buffer',
      actualName, 
      actualForceChunk 
    }], data.self_id)
    
    const result = await this.uploadFileToQQ(
      data, 
      target_id, 
      target_type, 
      actualFile, 
      actualName,
      actualForceChunk
    )
    
    // 构造文件消息
    const messageUrl = `/v2/${target_type}s/${target_id}/messages`
    const messageData = {
      msg_type: 7, // 富媒体消息
      media: {
        file_info: result.file_info
      }
    }

    // 如果有回复消息
    if (data.message_id) {
      messageData.msg_id = data.message_id
    }

    Bot.makeLog('debug', ['发送文件消息', messageUrl, messageData], data.self_id)

    const { data: sendResult } = await data.bot.sdk.request.post(messageUrl, messageData)

    Bot.makeLog('debug', ['文件消息发送成功', sendResult], data.self_id)

    return { id: sendResult.id }
  } catch (error) {
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
      if (config.toCallback) {
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
          enter: true,
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
          if (config.toQQUin && userIdCache[id]) id = userIdCache[id]
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

  async makeRawMarkdownMsg (data, msg) {
    const messages = []
    const button = []
    const files = [] // 收集文件消息
    let content = ''
    let reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') { i = { ...i } } else { i = { type: 'text', text: i } }

      switch (i.type) {
        case 'record':
          i.type = 'audio'
          i.file = await this.makeRecord(i.file)
        case 'video':
        case 'face':
        case 'ark':
        case 'embed':
          messages.push([i])
          content += ''
          break
        case 'file':
  // 临时调试
  Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
  
  let fileData = {
    file: null,
    name: null,
    force_chunk: false
  }
  
  // 情况1: i.file 是字符串（URL）
  if (typeof i.file === 'string') {
    fileData.file = i.file
    
    if (typeof i.name === 'object' && i.name !== null) {
      fileData.name = i.name.name || null
      fileData.force_chunk = typeof i.name.force_chunk !== 'undefined' ? !!i.name.force_chunk : false
    } else {
      fileData.name = i.name || null
      
      // 尝试多种可能的第三参数位置
      let thirdParam = undefined
      
      if (typeof i.force_chunk !== 'undefined') {
        thirdParam = i.force_chunk
      }
      else if (typeof i.data !== 'undefined' && typeof i.data !== 'object') {
        thirdParam = i.data
      }
      else if (typeof i[2] !== 'undefined') {
        thirdParam = i[2]
      }
      else if (typeof i['2'] !== 'undefined') {
        thirdParam = i['2']
      }
      else if (Array.isArray(i.args) && i.args.length > 0) {
        thirdParam = i.args[0]
      }
      
      fileData.force_chunk = typeof thirdParam !== 'undefined' ? !!thirdParam : false
      
      Bot.makeLog('debug', ['第三参数检测', { thirdParam, force_chunk: fileData.force_chunk }], data.self_id)
    }
  } 
  // 情况2: i.file 是对象
  else if (typeof i.file === 'object' && i.file !== null) {
    if (i.file.file) {
      fileData.file = i.file.file
      fileData.name = i.file.name || i.name || null
      fileData.force_chunk = typeof i.file.force_chunk !== 'undefined' 
        ? !!i.file.force_chunk 
        : (typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false)
    } else {
      fileData.file = i.file
      fileData.name = i.name || null
      fileData.force_chunk = typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false
    }
  }
  
  // 如果 name 为 null，尝试从 URL 提取
  if (!fileData.name && typeof fileData.file === 'string') {
    if (fileData.file.startsWith('http')) {
      try {
        const url = new URL(fileData.file)
        const pathname = url.pathname
        const lastSegment = pathname.split('/').pop()
        const fileNameWithoutParams = lastSegment.split('?')[0]
        if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
          fileData.name = decodeURIComponent(fileNameWithoutParams)
        }
      } catch {}
    }
  }
  
  files.push(fileData)
  Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
  content += ''
  break
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
        } case 'markdown':
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
          for (const { message } of i.data) { messages.push(...(await this.makeRawMarkdownMsg(data, message))) }
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

    // 将文件信息附加到 data 中，供外层处理
    if (files.length) {
      data._files = files
    }

    return messages
  }

  makeMarkdownText (data, text, button) {
    const match = text.match(this.toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        text = text.replace(url, '[链接(请点击按钮查看)]')
      }
    }
    return text.replace(/\n/g, '\r').replace(/@/g, '@​')
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

  async makeMarkdownMsg (data, msg) {
    const messages = []
    const button = []
    const files = [] // 收集文件消息
    let template = []
    let content = ''
    let reply
    const length = markdown_template?.params?.length || config.customMD?.[data.self_id]?.keys?.length || config.markdown.template.length

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') i = { ...i }
      else i = { type: 'text', text: i }

      switch (i.type) {
        case 'record':
          i.type = 'audio'
          i.file = await this.makeRecord(i.file)
        case 'video':
        case 'face':
        case 'ark':
        case 'embed':
          messages.push([i])
          content += ''
          break
        case 'file':
  // 临时调试
  Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
  
  let fileData = {
    file: null,
    name: null,
    force_chunk: false
  }
  
  // 情况1: i.file 是字符串（URL）
  if (typeof i.file === 'string') {
    fileData.file = i.file
    
    if (typeof i.name === 'object' && i.name !== null) {
      fileData.name = i.name.name || null
      fileData.force_chunk = typeof i.name.force_chunk !== 'undefined' ? !!i.name.force_chunk : false
    } else {
      fileData.name = i.name || null
      
      // 尝试多种可能的第三参数位置
      let thirdParam = undefined
      
      if (typeof i.force_chunk !== 'undefined') {
        thirdParam = i.force_chunk
      }
      else if (typeof i.data !== 'undefined' && typeof i.data !== 'object') {
        thirdParam = i.data
      }
      else if (typeof i[2] !== 'undefined') {
        thirdParam = i[2]
      }
      else if (typeof i['2'] !== 'undefined') {
        thirdParam = i['2']
      }
      else if (Array.isArray(i.args) && i.args.length > 0) {
        thirdParam = i.args[0]
      }
      
      fileData.force_chunk = typeof thirdParam !== 'undefined' ? !!thirdParam : false
      
      Bot.makeLog('debug', ['第三参数检测', { thirdParam, force_chunk: fileData.force_chunk }], data.self_id)
    }
  } 
  // 情况2: i.file 是对象
  else if (typeof i.file === 'object' && i.file !== null) {
    if (i.file.file) {
      fileData.file = i.file.file
      fileData.name = i.file.name || i.name || null
      fileData.force_chunk = typeof i.file.force_chunk !== 'undefined' 
        ? !!i.file.force_chunk 
        : (typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false)
    } else {
      fileData.file = i.file
      fileData.name = i.name || null
      fileData.force_chunk = typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false
    }
  }
  
  // 如果 name 为 null，尝试从 URL 提取
  if (!fileData.name && typeof fileData.file === 'string') {
    if (fileData.file.startsWith('http')) {
      try {
        const url = new URL(fileData.file)
        const pathname = url.pathname
        const lastSegment = pathname.split('/').pop()
        const fileNameWithoutParams = lastSegment.split('?')[0]
        if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
          fileData.name = decodeURIComponent(fileNameWithoutParams)
        }
      } catch {}
    }
  }
  
  files.push(fileData)
  Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
  content += ''
  break
        case 'at':
          if (i.qq == 'all') content += '@everyone'
          else {
            if (config.toQQUin && userIdCache[i.qq]) i.qq = userIdCache[i.qq]
            content += `<@${i.qq?.replace?.(`${data.self_id}${this.sep}`, '')}>`
          }
          break
        case 'text':
          content += this.makeMarkdownText(data, i.text, button)
          break
        case 'node':
          if (Handler.has('ws.tool.toImg') && config.toImg) {
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
              reply: (msg) => {
                i = msg
              },
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
            messages.push(...(await this.makeMarkdownMsg(data, TmplPkg.nodeMsg(i.data))))
            continue
          } else {
            for (const { message } of i.data) {
              messages.push(...(await this.makeMarkdownMsg(data, message)))
            }
            continue
          }
        case 'image': {
          const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
          const limit = template.length % (length - 1)

          // 图片数量超过模板长度时
          if (template.length && !limit) {
            if (content) template.push(content)
            template.push(des)
          } else template.push(content + des)

          content = url
          break
        } case 'markdown':
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

    // 将文件信息附加到 data 中
    if (files.length) {
      data._files = files
    }

    return messages
  }

  async makeMsg (data, msg) {
    const sendType = ['audio', 'image', 'video', 'file']
    const messages = []
    const button = []
    const files = [] // 收集文件消息
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
          i.type = 'audio'
          i.file = await this.makeRecord(i.file)
        case 'video':
        case 'image':
          if (message.some(s => sendType.includes(s.type))) {
            messages.push(message)
            message = []
          }
          break
        case 'file':
  // 临时调试
  Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
  
  // segment.file 的参数解析
  let fileData = {
    file: null,
    name: null,
    force_chunk: false
  }
  
  // 情况1: i.file 是字符串（URL）
  if (typeof i.file === 'string') {
    fileData.file = i.file
    
    // 检查 i.name 是否是对象（segment.file(url, { name, force_chunk })）
    if (typeof i.name === 'object' && i.name !== null) {
      fileData.name = i.name.name || null
      fileData.force_chunk = typeof i.name.force_chunk !== 'undefined' ? !!i.name.force_chunk : false
    } else {
      // segment.file(url, name, force_chunk) 形式
      fileData.name = i.name || null
      
      // 尝试多种可能的第三参数位置
      let thirdParam = undefined
      
      // 检查 i.force_chunk
      if (typeof i.force_chunk !== 'undefined') {
        thirdParam = i.force_chunk
      }
      // 检查 i.data（可能是第三参数）
      else if (typeof i.data !== 'undefined' && typeof i.data !== 'object') {
        thirdParam = i.data
      }
      // 检查数字索引 i[2] 或 i['2']
      else if (typeof i[2] !== 'undefined') {
        thirdParam = i[2]
      }
      else if (typeof i['2'] !== 'undefined') {
        thirdParam = i['2']
      }
      // 检查 i.args 数组
      else if (Array.isArray(i.args) && i.args.length > 0) {
        thirdParam = i.args[0]
      }
      
      fileData.force_chunk = typeof thirdParam !== 'undefined' ? !!thirdParam : false
      
      Bot.makeLog('debug', ['第三参数检测', { thirdParam, force_chunk: fileData.force_chunk }], data.self_id)
    }
  } 
  // 情况2: i.file 是对象
  else if (typeof i.file === 'object' && i.file !== null) {
    if (i.file.file) {
      fileData.file = i.file.file
      fileData.name = i.file.name || i.name || null
      fileData.force_chunk = typeof i.file.force_chunk !== 'undefined' 
        ? !!i.file.force_chunk 
        : (typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false)
    } else {
      fileData.file = i.file
      fileData.name = i.name || null
      fileData.force_chunk = typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false
    }
  }
  
  // 如果 name 为 null，尝试从 URL 提取
  if (!fileData.name && typeof fileData.file === 'string') {
    if (fileData.file.startsWith('http')) {
      try {
        const url = new URL(fileData.file)
        const pathname = url.pathname
        const lastSegment = pathname.split('/').pop()
        const fileNameWithoutParams = lastSegment.split('?')[0]
        if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
          fileData.name = decodeURIComponent(fileNameWithoutParams)
        }
      } catch {}
    }
  }
  
  files.push(fileData)
  Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
  continue
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
          if (Handler.has('ws.tool.toImg') && config.toImg) {
            const e = {
              reply: (msg) => {
                i = msg
              },
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
              messages.push(...(await this.makeMsg(data, message)))
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
        const match = i.text.match(this.toQRCodeRegExp)
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

    // 将文件信息附加到 data 中
    if (files.length) {
      data._files = files
    }

    return messages
  }

  async sendMsg (data, send, msg) {
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

      if (msg.type === 'node') data.wsids = { toImg: config.toImg }

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
        
        // 发送文件
        if (data._files && data._files.length) {
          await this.sendFiles(data, data._files)
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

    // 发送文件
    if (data._files && data._files.length) {
      await this.sendFiles(data, data._files)
    }

    if (Array.isArray(data._ret_id)) { data._ret_id.push(...rets.message_id) }
    return rets
  }

  /**
   * 发送文件列表
   */
  /**
 * 发送文件列表
 */
async sendFiles(data, files) {
  // 判断目标类型
  let target_type, target_id
  
  if (data.group_id) {
    // 群聊消息
    target_type = 'group'
    target_id = data.raw?.group_id || data.group_id.replace(`${data.self_id}${this.sep}`, '')
  } else {
    // 私聊消息
    target_type = 'user'
    target_id = data.raw?.sender?.user_id || data.user_id.replace(`${data.self_id}${this.sep}`, '')
  }

  Bot.makeLog('debug', ['准备发送文件列表', { target_type, target_id, count: files.length }], data.self_id)

  for (const fileInfo of files) {
    try {
      await this.sendFileMessage(data, target_id, target_type, fileInfo)
      Bot.makeLog('info', ['文件发送成功', { target_type, target_id, file: fileInfo.name, force_chunk: fileInfo.force_chunk }], data.self_id)
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
        const match = i.text.match(this.toQRCodeRegExp)
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
    if (config.toQQUin && userIdCache[user_id]) user_id = userIdCache[user_id]
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
    if (config.toQQUin && userIdCache[user_id]) {
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
  }

  async makeGroupMessage (data, event) {
    data.sender = {
      user_id: `${data.self_id}${this.sep}${event.sender.user_id}`
    }
    data.group_id = `${data.self_id}${this.sep}${event.group_id}`
    if (config.toQQUin && Handler.has('ws.tool.findUserId')) {
      const user_id = await Handler.call('ws.tool.findUserId', { user_id: data.user_id })
      if (user_id?.custom) {
        userIdCache[user_id.custom] = data.user_id
        data.sender.user_id = user_id.custom
      }
    }

    // 自定义消息过滤前台日志防刷屏(自欺欺人大法)
    const filterLog = config.filterLog?.[data.self_id] || []
    let logStat = filterLog.includes(_.trim(data.raw_message)) ? 'debug' : 'info'
    Bot.makeLog(logStat, `群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`, data.self_id)

    data.reply = msg => this.sendGroupMsg({
      ...data, group_id: event.group_id
    }, msg, { id: data.message_id })
    // data.message.unshift({ type: "at", qq: data.self_id })
    await this.setGroupMap(data)
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
    if (config.toQQUin && Handler.has('ws.tool.findUserId')) {
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

  async makeMessage (id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      message_id: event.message_id,
      get user_id () { return this.sender.user_id },
      message: event.message,
      raw_message: event.raw_message
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
        await this.makeGroupMessage(data, event)
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
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        return await reply(...args)
      } catch (err) {
        Bot.makeLog('debug', ['回复按钮点击事件错误', err], data.self_id)
      }
    }

    // 构造 INTERACTION_CREATE event_id，用于回复按钮点击事件
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

    // 将 event_id 以 reply 元素注入到发送消息中
    // SDK 不支持通过 source 参数传 event_id，但支持从消息数组的 reply 元素中提取 event_id
    // makeMsg/makeMarkdownMsg/makeRawMarkdownMsg 中已有 'event_' 前缀处理逻辑：
    //   { type: 'reply', id: 'event_INTERACTION_CREATE:xxx' }
    //   → { type: 'reply', event_id: 'INTERACTION_CREATE:xxx' }
    // SDK 的 sendMsg 处理 reply 元素时会设置 body.event_id
    const wrapWithEventId = (msg) => {
      msg = Array.isArray(msg) ? [...msg] : [msg]
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
        return
      case 'decrease':
        Bot[data.self_id].dau.setDau('group_decrease', data)
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
        // console.log('event', event)
        Bot.makeLog('warn', ['未知通知', event], id)
    }

    // Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
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
                this.wsUrl = keys.some(i => i == this.bot.config.real_self_id) ? `wss://${config.bus[id]}/ws?url=${res.data.url}&appid=${appid}` : res.data.url
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
        return new Promise(resolve => {
          this.sdk.sessionManager.once('READY', resolve)
          this.sdk.start()
        })
      },
      logout () {
        return new Promise(resolve => {
          this.sdk.ws.once('close', resolve)
          this.sdk.stop()
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

      dau: new Dau(id, this.sep, config.dauDB),

      callback: {}
    }

    Bot[id].sdk.logger = {}
    for (const i of ['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal']) {
      Bot[id].sdk.logger[i] = (...args) => {
        if (config.simplifiedSdkLog) {
          if (args?.[0]?.match?.(/^send to/)) {
            args[0] = args[0].replace(/<(.+?)(,.*?)>/g, (v, k1, k2) => {
              return `<${k1}>`
            })
          } else if (args?.[0]?.match?.(/^recv from/)) {
            return
          }
        }
        Bot.makeLog(i, args, id)
      }
    }

    await Bot[id].login()
    await Bot[id].dau.init()

    Bot[id].sdk.on('message', event => this.makeMessage(id, event))
    Bot[id].sdk.on('notice', event => this.makeNotice(id, event))

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

const setMap = {
  二维码: 'toQRCode',
  按钮回调: 'toCallback',
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
        }
      ]
    })
  }

  help () {
    this.reply([' ', segment.button(
      [
        { text: 'dau', callback: '#QQBotdau' },
        { text: 'daupro', callback: '#QQBotdaupro' },
        { text: '调用统计', callback: '#QQBot调用统计' },
        { text: '用户统计', callback: '#QQBot用户统计' }
      ],
      [
        { text: `${config.toCallback ? '关闭' : '开启'}按钮回调`, callback: `#QQBot设置按钮回调${config.toCallback ? '关闭' : '开启'}` },
        { text: `${config.callStats ? '关闭' : '开启'}调用统计`, callback: `#QQBot设置调用统计${config.callStats ? '关闭' : '开启'}` }
      ],
      [
        { text: `${config.userStats ? '关闭' : '开启'}用户统计`, callback: `#QQBot设置用户统计${config.userStats ? '关闭' : '开启'}` }
      ]
    )])
  }

  refConfig () {
    refConfig()
  }

  List () {
    this.reply(`共${config.token.length}个账号：\n${config.token.join('\n')}`, true)
  }

  async Token () {
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
    let token = this.e.msg.replace(/^#q+botm(ark)?d(own)?/i, '').trim().split(':')
    const bot_id = token.shift()
    token = token.join(':')
    this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${token}`, true)
    config.markdown[bot_id] = token
    await configSave()
  }

  async Setting () {
    const reg = /^#q+bot设置(.+)\s*(开启|关闭)$/i
    const regRet = reg.exec(this.e.msg)
    const state = regRet[2] == '开启'
    config[setMap[regRet[1]]] = state
    this.reply('设置成功,已' + (state ? '开启' : '关闭'), true)
    await configSave()
  }

  async DAUStat () {
    const pro = this.e.msg.includes('pro')
    const uin = this.e.msg.replace(/^#q+botdau(pro)?/i, '') || this.e.self_id
    const dau = Bot[uin]?.dau
    if (!dau || !dau.dauDB) return false
    const msg = await dau.getDauStatsMsg(this.e, pro)
    if (msg.length) this.reply(msg, true)
  }

  async callStat () {
    if (!config.callStats) return false
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) return false
    const msg = dau.getCallStatsMsg(this.e)
    if (msg.length) this.reply(msg, true)
  }

  async userStat () {
    if (!config.userStats) return false
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) return false
    if (dau.dauDB === 'redis') {
      return this.reply('用户统计只适配了level,,,', true)
    }
    const msg = await dau.getUserStatsMsg(this.e)
    if (msg.length) this.reply(msg, true)
  }

  // 自欺欺人大法
  async filterLog () {
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
}

const endTime = new Date()
logger.info(logger.green(`- QQBot 适配器插件 加载完成! 耗时：${endTime - startTime}ms`))