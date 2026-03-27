/** Cooperative cancellation for in-flight action chains (reflex / stuck / user). */

function createChainRunControl() {
  const signal = {
    aborted: false,
    reason: null,
    at: null,
  }
  return {
    signal,
    abort(reason = 'aborted') {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = String(reason || 'aborted')
      signal.at = Date.now()
    },
  }
}

module.exports = { createChainRunControl }
