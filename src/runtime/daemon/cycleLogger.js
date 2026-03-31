/**
 * Cycle Logger — structured per-cycle summary for observability (Phase 10).
 *
 * Produces a compact summary object at the end of each daemon cycle,
 * capturing the key decision points and outcome for debugging/replay.
 */

const AGENT_DEBUG = String(process.env.AGENT_DEBUG || '').trim() === '1'

/**
 * Build a structured cycle summary.
 */
function buildCycleSummary({
  cycleId,
  state,
  goal,
  chosenSkill,
  resultStatus,
  reflexTriggered,
  interruptReason,
  planningInvoked,
  synthesisInvoked,
  durationMs,
  memoryHintsUsed,
  threat,
  health,
  chainSignature,
  error,
  failureFingerprint,
  expectedOutcome,
  candidatePromotion,
  candidateQuarantine,
}) {
  return Object.freeze({
    type: 'cycle_summary',
    cycleId: cycleId ?? 0,
    timestamp: Date.now(),
    state: state || 'unknown',
    goal: goal || null,
    chosenSkill: chosenSkill || null,
    resultStatus: resultStatus || 'unknown',
    reflexTriggered: !!reflexTriggered,
    interruptReason: interruptReason || null,
    planningInvoked: !!planningInvoked,
    synthesisInvoked: !!synthesisInvoked,
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    memoryHintsUsed: typeof memoryHintsUsed === 'number' ? memoryHintsUsed : 0,
    threat: threat || null,
    health: typeof health === 'number' ? health : null,
    chainSignature: chainSignature || null,
    error: error || null,
    failureFingerprint: failureFingerprint || null,
    expectedOutcome: expectedOutcome || null,
    candidatePromotion: candidatePromotion || null,
    candidateQuarantine: candidateQuarantine || null,
  })
}

/**
 * Print compact debug line to console when AGENT_DEBUG=1.
 */
function debugPrint(summary) {
  if (!AGENT_DEBUG) return
  const parts = [
    `#${summary.cycleId}`,
    summary.state,
    summary.resultStatus,
  ]
  if (summary.goal) parts.push(`goal=${summary.goal}`)
  if (summary.chosenSkill) parts.push(`skill=${summary.chosenSkill}`)
  if (summary.reflexTriggered) parts.push('REFLEX')
  if (summary.interruptReason) parts.push(`int=${summary.interruptReason}`)
  if (summary.threat && summary.threat !== 'none') parts.push(`threat=${summary.threat}`)
  if (summary.health !== null) parts.push(`hp=${summary.health}`)
  if (summary.durationMs !== null) parts.push(`${summary.durationMs}ms`)
  if (summary.error) parts.push(`ERR=${summary.error}`)
  if (summary.chainSignature) parts.push(`chain=${summary.chainSignature}`)
  if (summary.failureFingerprint) parts.push(`fp=${summary.failureFingerprint.failureClass}`)
  if (summary.expectedOutcome) parts.push(`expect=${summary.expectedOutcome}`)
  if (summary.candidatePromotion) parts.push(`PROMOTED=${summary.candidatePromotion}`)
  if (summary.candidateQuarantine) parts.push(`QUARANTINE=${summary.candidateQuarantine}`)
  // eslint-disable-next-line no-console
  console.log(`[AGENT] ${parts.join(' | ')}`)
}

/**
 * Log cycle summary to jsonl logger and optionally debug-print.
 */
async function logCycleSummary(logger, summaryParams) {
  const summary = buildCycleSummary(summaryParams)
  if (logger && typeof logger.log === 'function') {
    await logger.log(summary)
  }
  debugPrint(summary)
  return summary
}

function isDebugEnabled() {
  return AGENT_DEBUG
}

module.exports = { buildCycleSummary, debugPrint, logCycleSummary, isDebugEnabled }
