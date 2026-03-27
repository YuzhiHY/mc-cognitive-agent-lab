function rankPriority(priority) {
  const p = String(priority || 'low')
  if (p === 'fatal_immediate') return 4
  if (p === 'high') return 3
  if (p === 'medium') return 2
  return 1
}

function createInterruptQueue() {
  const queue = []
  let _nextId = 1

  function enqueue(decision) {
    if (!decision || decision.shouldInterrupt !== true) return false
    queue.push({
      ...decision,
      _id: _nextId++,
      _enqueuedAt: Date.now(),
    })
    return true
  }

  function peekHighest() {
    if (queue.length === 0) return null
    return queue
      .slice()
      .sort((a, b) => (rankPriority(b.priority) - rankPriority(a.priority)) || (a._enqueuedAt - b._enqueuedAt))[0]
  }

  function popHighest() {
    const top = peekHighest()
    if (!top) return null
    const idx = queue.findIndex((x) => x._id === top._id)
    if (idx >= 0) queue.splice(idx, 1)
    return top
  }

  function clear() {
    queue.length = 0
  }

  function size() {
    return queue.length
  }

  return Object.freeze({
    enqueue,
    peekHighest,
    popHighest,
    clear,
    size,
  })
}

module.exports = { createInterruptQueue }

