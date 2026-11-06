export async function initializeWsAccounts (accounts, load, log) {
  const failures = new Map()
  for (const account of accounts) {
    try { await load(account.selfId) } catch (error) {
      failures.set(account.selfId, error)
      log(account.selfId, error)
    }
  }
  return failures
}
