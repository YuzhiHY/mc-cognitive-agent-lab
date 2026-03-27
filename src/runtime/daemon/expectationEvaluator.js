const { chainSucceeded } = require('./skillPromotion')

function evaluateExpectation({ expectation, chainResult }) {
  if (!expectation) return null
  if (chainResult?.interrupted) {
    return {
      matched: false,
      deviation: 'interrupted_by_reflex',
      cause: 'reflex_interrupt',
      decision: 'replan',
      mood: 'cautious',
    }
  }
  const succeeded = chainSucceeded(chainResult)
  if (succeeded) {
    return {
      matched: true,
      deviation: null,
      cause: null,
      decision: 'keep_method',
      mood: 'calm',
    }
  }
  const failedMsg = chainResult?.failedStep?.error?.message || 'unknown_failure'
  return {
    matched: false,
    deviation: failedMsg,
    cause: 'execution_failed',
    decision: expectation.fallbackHint ? 'replan' : 'ask_user',
    mood: expectation.emotionIfFail || 'confused',
  }
}

module.exports = { evaluateExpectation }
