/**
 * Phase 10 test — cycle logger observability enhancements.
 *
 * Validates that:
 * 1. Cycle summary includes failureFingerprint when present
 * 2. Cycle summary includes expectedOutcome when present
 * 3. Cycle summary includes candidatePromotion/candidateQuarantine when present
 * 4. Missing optional fields default to null (backward compatible)
 */

const assert = require('node:assert')
const { buildCycleSummary } = require('../src/runtime/daemon/cycleLogger')

// Test 1: failure fingerprint flows into cycle summary
function testFailureFingerprintInSummary() {
  const fp = { failureClass: 'path_blocked', reason: 'no path found', retryable: true }
  const summary = buildCycleSummary({
    cycleId: 10,
    state: 'failed',
    resultStatus: 'failure',
    failureFingerprint: fp,
  })
  assert.deepStrictEqual(summary.failureFingerprint, fp)
  assert.strictEqual(summary.cycleId, 10)
}

// Test 2: expected outcome flows into cycle summary
function testExpectedOutcomeInSummary() {
  const summary = buildCycleSummary({
    cycleId: 11,
    state: 'executing',
    resultStatus: 'success',
    expectedOutcome: 'should_have_oak_log_in_inventory',
  })
  assert.strictEqual(summary.expectedOutcome, 'should_have_oak_log_in_inventory')
}

// Test 3: candidate promotion/quarantine events in cycle summary
function testCandidateEventsInSummary() {
  const summary = buildCycleSummary({
    cycleId: 12,
    state: 'completed',
    resultStatus: 'success',
    candidatePromotion: 'synth_42',
    candidateQuarantine: null,
  })
  assert.strictEqual(summary.candidatePromotion, 'synth_42')
  assert.strictEqual(summary.candidateQuarantine, null)

  const summary2 = buildCycleSummary({
    cycleId: 13,
    state: 'failed',
    resultStatus: 'failure',
    candidateQuarantine: 'synth_bad',
  })
  assert.strictEqual(summary2.candidateQuarantine, 'synth_bad')
  assert.strictEqual(summary2.candidatePromotion, null)
}

// Test 4: backward compatibility — old callers without new fields still work
function testBackwardCompatibility() {
  const summary = buildCycleSummary({
    cycleId: 1,
    state: 'idle',
    goal: 'gather wood',
    chosenSkill: 'mine_named_block',
    resultStatus: 'success',
  })
  assert.strictEqual(summary.failureFingerprint, null)
  assert.strictEqual(summary.expectedOutcome, null)
  assert.strictEqual(summary.candidatePromotion, null)
  assert.strictEqual(summary.candidateQuarantine, null)
  // Existing fields still work
  assert.strictEqual(summary.goal, 'gather wood')
  assert.strictEqual(summary.chosenSkill, 'mine_named_block')
}

// Test 5: summary is frozen (immutable)
function testSummaryImmutable() {
  const summary = buildCycleSummary({ cycleId: 99, state: 'idle' })
  assert.ok(Object.isFrozen(summary), 'Cycle summary should be frozen')
}

testFailureFingerprintInSummary()
testExpectedOutcomeInSummary()
testCandidateEventsInSummary()
testBackwardCompatibility()
testSummaryImmutable()
console.log('cycle logger observability tests passed')
