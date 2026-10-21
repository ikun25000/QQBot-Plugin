import { AsyncLocalStorage } from 'node:async_hooks'

const tasks = new AsyncLocalStorage()
const optionalWork = new Map()
const warningTimes = new Map()
const OPTIONAL_PENDING_LIMIT = 8

function warn (id, stage, message, detail) {
  const key = `${id}:${stage}`
  const now = Date.now()
  if (now - (warningTimes.get(key) ?? -Infinity) < 60000) return
  warningTimes.set(key, now)
  if (warningTimes.size > 1000) warningTimes.delete(warningTimes.keys().next().value)
  globalThis.Bot?.makeLog?.('warn', [`[${id}] ${message}`, { stage, ...detail }], id)
}

export function createQQBotMessageTask ({ id, isCurrent, timeoutMs = 30000, optionalBudgetMs = 6000, onStage = () => {} }) {
  const abort = new AbortController()
  const task = {
    id,
    stage: 'entered',
    startedAt: Date.now(),
    optionalBudgetMs,
    signal: abort.signal,
    check () {
      abort.signal.throwIfAborted()
      if (!isCurrent()) throw new DOMException('消息所属连接已失效', 'AbortError')
    },
    cancel (message = '消息所属连接已失效') {
      if (!abort.signal.aborted) abort.abort(new DOMException(message, 'AbortError'))
    },
    onStage,
    async run (work) {
      let timer
      const cancelled = new Promise((resolve, reject) => {
        const stop = () => reject(abort.signal.reason)
        abort.signal.addEventListener('abort', stop, { once: true })
        task.removeAbortListener = () => abort.signal.removeEventListener('abort', stop)
      })
      timer = setTimeout(() => {
        warn(id, 'message-timeout', '消息处理超时，取消本条派发并释放处理槽', { stage: task.stage, elapsedMs: Date.now() - task.startedAt })
        task.cancel('消息处理超过时间上限')
      }, timeoutMs)
      try {
        task.check()
        return await Promise.race([tasks.run(task, async () => { task.check(); return work() }), cancelled])
      } finally {
        clearTimeout(timer)
        task.removeAbortListener()
      }
    }
  }
  return task
}

export function assertQQBotMessageTask () {
  tasks.getStore()?.check()
}

// Optional persistence may finish later. A timed-out stage is not started again
// until its outstanding work settles, so releasing a message slot cannot create
// an unbounded collection of hung database/Redis requests.
export async function runQQBotMessageStep (id, stage, work, {
  optional = false,
  timeoutMs = optional ? 2000 : 10000,
  fallback
} = {}) {
  const task = tasks.getStore()
  task?.check()
  if (task) {
    task.stage = stage
    task.onStage(stage)
  }
  const key = `${id}:${stage}`
  let entry = optionalWork.get(key)
  if (optional && (entry?.blocked || entry?.pending >= OPTIONAL_PENDING_LIMIT || task?.optionalBudgetMs <= 0)) {
    warn(id, stage, '可选消息步骤暂时跳过，继续处理命令', { pending: entry?.pending || 0 })
    return fallback
  }
  if (optional) {
    entry ||= { pending: 0, blocked: false }
    entry.pending++
    optionalWork.set(key, entry)
  }
  const startedAt = Date.now()
  let timer
  let stop
  const limit = optional && task ? Math.min(timeoutMs, task.optionalBudgetMs) : timeoutMs
  const operation = Promise.resolve().then(() => { task?.check(); return work() })
  if (optional) {
    operation.finally(() => {
      entry.pending--
      if (!entry.pending && optionalWork.get(key) === entry) optionalWork.delete(key)
    }).catch(() => {})
  }
  try {
    const result = await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (optional) entry.blocked = true
          reject(Object.assign(new Error(`消息步骤 ${stage} 超时`), { code: 'QQBOT_MESSAGE_STEP_TIMEOUT' }))
        }, limit)
        if (task) {
          stop = () => reject(task.signal.reason)
          task.signal.addEventListener('abort', stop, { once: true })
        }
      })
    ])
    task?.check()
    return result
  } catch (error) {
    task?.check()
    if (!optional) throw error
    warn(id, stage, '可选消息步骤失败，继续处理命令', { message: error?.message || String(error) })
    return fallback
  } finally {
    clearTimeout(timer)
    if (stop) task.signal.removeEventListener('abort', stop)
    if (optional && task) task.optionalBudgetMs = Math.max(0, task.optionalBudgetMs - (Date.now() - startedAt))
  }
}
