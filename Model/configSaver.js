// Ordinary settings coalesce; credential writes immediately enter the atomic
// writer so its one-use credential-removal authorization is captured in time.
export function createConfigSaver ({ snapshot, write, credentials = value => JSON.stringify(value.token || []), setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 150 }) {
  let credentialKey = credentials(snapshot())
  let waiting = []
  let timer
  let inFlight = Promise.resolve()
  function submit () {
    clearTimer(timer)
    timer = undefined
    const listeners = waiting
    waiting = []
    let work
    try { work = Promise.resolve(write(snapshot())) } catch (error) { work = Promise.reject(error) }
    inFlight = Promise.all([inFlight.catch(() => {}), work]).then(() => {})
    inFlight.catch(() => {})
    work.then(() => listeners.forEach(item => item.resolve()), error => listeners.forEach(item => item.reject(error)))
    return work
  }
  function save ({ immediate = false } = {}) {
    const key = credentials(snapshot())
    const changedCredentials = key !== credentialKey
    credentialKey = key
    const promise = new Promise((resolve, reject) => waiting.push({ resolve, reject }))
    if (immediate || changedCredentials) void submit().catch(() => {})
    else {
      clearTimer(timer)
      timer = setTimer(() => { void submit().catch(() => {}) }, delayMs)
    }
    return promise
  }
  save.flush = () => waiting.length ? submit() : inFlight
  return save
}
