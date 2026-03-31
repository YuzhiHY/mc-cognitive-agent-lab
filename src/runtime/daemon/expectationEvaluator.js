const { chainSucceeded } = require('./skillPromotion')

function evaluateExpectation({ expectation, chainResult, feelerCompensation }) {
  if (!expectation) return null
  if (chainResult?.interrupted) {
    return {
      matched: false,
      deviation: 'interrupted_by_reflex',
      cause: 'reflex_interrupt',
      decision: 'replan',
      mood: 'cautious',
      feelerDrift: feelerCompensation?.positionDelta || 0,
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
      feelerDrift: feelerCompensation?.positionDelta || 0,
    }
  }
  const failedMsg = chainResult?.failedStep?.error?.message || 'unknown_failure'
  // If feeler caused significant drift (>2 blocks), note it as contributing factor
  const feelerDrift = feelerCompensation?.positionDelta || 0
  const feelerContributed = feelerDrift > 2
  return {
    matched: false,
    deviation: feelerContributed ? `${failedMsg} (feeler_drift=${feelerDrift.toFixed(1)})` : failedMsg,
    cause: 'execution_failed',
    decision: expectation.fallbackHint ? 'replan' : 'ask_user',
    mood: expectation.emotionIfFail || 'confused',
    feelerDrift,
  }
}

module.exports = { evaluateExpectation }
