// A received cursor is not a processed cursor. Only advance across the oldest
// completed dispatch, including RESUMED after all replayed events have settled.
export function createSessionProgress (commit) {
  let epoch = 0
  let cursor = 0
  let entries = []
  let overflow
  const bySeq = new Map()

  function completion (entry, version) {
    let called = false
    return error => {
      if (called || version !== epoch) return
      called = true
      // A successful replay may heal an earlier failed attempt at this seq.
      if (!error) entry.done = true
      while (entries[0]?.done) {
        const head = entries.shift()
        bySeq.delete(head.seq)
        if (head.seq === overflow) overflow = undefined
        cursor = Math.max(cursor, head.seq)
        commit(cursor)
      }
    }
  }
  return {
    reset (seq) { epoch++; cursor = seq; entries = []; bySeq.clear(); overflow = undefined },
    get cursor () { return cursor },
    add (seq) {
      if (!Number.isSafeInteger(seq) || seq <= cursor || (overflow != null && seq > overflow)) return () => {}
      const existing = bySeq.get(seq)
      if (existing) return completion(existing, epoch)
      const entry = { seq, done: false }
      bySeq.set(seq, entry)
      const index = entries.findIndex(item => item.seq > seq)
      if (index < 0) entries.push(entry)
      else entries.splice(index, 0, entry)
      if (entries.length > 4096) {
        overflow = seq
        // A non-completing barrier bounds memory; only an explicit replay of
        // this first untracked seq may release it after the backlog drains.
        return () => {}
      }
      return completion(entry, epoch)
    }
  }
}
