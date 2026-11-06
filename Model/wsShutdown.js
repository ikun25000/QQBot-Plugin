// The framework's signal handler calls process.exit(), skipping beforeExit.
// Bound orderly exit flushing; fatal exits and second requests stay immediate.
export function installWsShutdown ({ process: target = process, flush, timeoutMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const key = Symbol.for('QQBotPlugin.wsShutdown')
  if (target[key]) { target[key].flush = flush; return target[key] }
  const original = target.exit
  const state = { flush, exiting: false }
  const exit = function (code) {
    if (Number(code ?? target.exitCode ?? 0) !== 0 || state.exiting) return original.call(target, code)
    state.exiting = true
    let timer
    void Promise.race([
      Promise.resolve().then(() => state.flush()),
      new Promise(resolve => { timer = setTimer(resolve, timeoutMs) })
    ]).catch(() => {}).finally(() => { clearTimer(timer); original.call(target, code) })
  }
  target.exit = exit
  const beforeExit = () => { if (!state.exiting) void Promise.resolve().then(() => state.flush()).catch(() => {}) }
  target.on('beforeExit', beforeExit)
  state.uninstall = () => {
    if (target.exit === exit) target.exit = original
    target.off('beforeExit', beforeExit)
    delete target[key]
  }
  target[key] = state
  return state
}
