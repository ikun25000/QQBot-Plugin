import { getTime } from './common.js'
import { Level } from 'level'
import schedule from 'node-schedule'

const CLEANUP_BATCH_SIZE = 500

export default class level {
  constructor (path) {
    this.db = new Level(path, { valueEncoding: 'json' })
    this.setSchedule()
  }

  async cleanup () {
    const today = getTime()
    let deletes = []
    const flush = async () => {
      if (!deletes.length) return
      const operations = []
      for (const candidate of deletes) {
        try {
          const current = await this.db.get(candidate.key)
          if (current?.expiredTime && new Date(current.expiredTime) < new Date(today)) operations.push({ type: 'del', key: candidate.key })
        } catch (error) { }
      }
      if (operations.length) await this.db.batch(operations)
      deletes = []
    }
    for await (const [key, value] of this.db.iterator()) {
      try {
        if (value.expiredTime && new Date(value.expiredTime) < new Date(today)) {
          deletes.push({ key })
          if (deletes.length >= CLEANUP_BATCH_SIZE) await flush()
        }
      } catch (error) { }
    }
    await flush()
  }

  setSchedule () {
    // 每天00:00删除所有过期的key
    this.job = schedule.scheduleJob('0 0 0 * * ?', async () => {
      await this.cleanup()
    })
  }

  async open (options = {}) {
    await this.db.open()
    if (options.cleanup !== false) await this.cleanup()
  }

  /**
   * 存储一个值
   * @param {string} key
   * @param {any} value
   * @param {number} time 几天之后过期(包含今天),为0时不会过期
   * @returns
   */
  async set (key, value, time = 0) {
    if (!value) return
    let storedValue = value
    // 要存储的值不是object时，转换为object
    if (typeof storedValue !== 'object') {
      storedValue = {
        __originalValue: value
      }
    }

    // 如果有过期时间，则设置过期时间
    if (time > 0) {
      storedValue.expiredTime = getTime(time - 1)
    }

    await this.db.put(key, storedValue)
    delete storedValue.expiredTime
  }

  async get (key) {
    try {
      let value = await this.db.get(key)
      if (!value) return null
      // const expiredTime = value.expiredTime;
      // 检查是否需要转换回原始类型
      if (value.__originalValue) {
        value = value.__originalValue
      }
      if (value?.expiredTime) {
        // if (new Date(expiredTime) < new Date(getTime())) {
        //     // 如果当前日期晚于过期日期，则删除key
        //     await this.db.del(key);
        //     return null;
        // }
        // 过期时间不返回
        delete value.expiredTime
      }
      return value
    } catch (err) {
      // 不存在key
      if (err.notFound) {
        return null
      }
      // 其他错误
      logger.error('[QQBot-Plugin] level', err)
      return null
    }
  }

  close () {
    try { this.job?.cancel() } catch {}
    return this.db.close()
  }
}
