const assert = require('node:assert')
const { createFingerprint, classifyFailure, FAILURE_CLASSES } = require('../src/runtime/contracts/failureFingerprint')
const { deriveAvoidanceHints } = require('../src/runtime/memoryHint')

function testCreateFingerprint() {
  const fp = createFingerprint({
    actionType: 'navigate',
    skillName: 'approach_target',
    failureClass: 'path_blocked',
    reason: 'no path found',
    location: { x: 10, y: 64, z: 10 },
    retryable: true,
  })
  assert.strictEqual(fp.actionType, 'navigate')
  assert.strictEqual(fp.failureClass, 'path_blocked')
  assert.strictEqual(fp.retryable, true)
  assert.ok(typeof fp.timestamp === 'number')
  assert.ok(Object.isFrozen(fp))
}

function testCreateFingerprintUnknownClass() {
  const fp = createFingerprint({ actionType: 'test', failureClass: 'not_a_real_class' })
  assert.strictEqual(fp.failureClass, 'unknown')
}

function testClassifyFailureTimeout() {
  const fp = classifyFailure({ status: 'timeout', actionType: 'navigate', reason: 'took too long' })
  assert.strictEqual(fp.failureClass, 'timeout')
}

function testClassifyFailurePath() {
  const fp = classifyFailure({ status: 'failure', reason: 'No path found to target', actionType: 'navigate' })
  assert.strictEqual(fp.failureClass, 'path_blocked')
}

function testClassifyFailureDig() {
  const fp = classifyFailure({ status: 'failure', reason: 'Block not in view range', actionType: 'dig' })
  assert.strictEqual(fp.failureClass, 'dig_failed')
}

function testClassifyFailureCraft() {
  const fp = classifyFailure({ status: 'failure', reason: 'Missing materials for recipe', actionType: 'craft' })
  assert.strictEqual(fp.failureClass, 'craft_missing_materials')
}

function testClassifyFailureStuck() {
  const fp = classifyFailure({ status: 'failure', reason: 'Stuck collision detected', actionType: 'navigate' })
  assert.strictEqual(fp.failureClass, 'stuck_collision')
}

function testFailureClassesExist() {
  assert.ok(FAILURE_CLASSES.includes('path_blocked'))
  assert.ok(FAILURE_CLASSES.includes('timeout'))
  assert.ok(FAILURE_CLASSES.includes('hostile_interrupt'))
  assert.ok(FAILURE_CLASSES.includes('craft_missing_materials'))
  assert.ok(FAILURE_CLASSES.length >= 10)
}

function testAvoidanceHints() {
  const now = Date.now()
  const entries = [
    { failureClass: 'path_blocked', actionType: 'navigate', timestamp: now - 1000 },
    { failureClass: 'path_blocked', actionType: 'navigate', timestamp: now - 2000 },
    { failureClass: 'path_blocked', actionType: 'navigate', timestamp: now - 3000 },
    { failureClass: 'dig_failed', actionType: 'dig', timestamp: now - 1000 },
  ]
  const hints = deriveAvoidanceHints(entries, 60000, 3)
  assert.strictEqual(hints.length, 1)
  assert.strictEqual(hints[0].failureClass, 'path_blocked')
  assert.strictEqual(hints[0].count, 3)
  assert.ok(hints[0].hint.includes('Avoid'))
}

function testAvoidanceHintsNoneWhenBelowThreshold() {
  const now = Date.now()
  const entries = [
    { failureClass: 'path_blocked', actionType: 'navigate', timestamp: now - 1000 },
    { failureClass: 'path_blocked', actionType: 'navigate', timestamp: now - 2000 },
  ]
  const hints = deriveAvoidanceHints(entries, 60000, 3)
  assert.strictEqual(hints.length, 0)
}

testCreateFingerprint()
testCreateFingerprintUnknownClass()
testClassifyFailureTimeout()
testClassifyFailurePath()
testClassifyFailureDig()
testClassifyFailureCraft()
testClassifyFailureStuck()
testFailureClassesExist()
testAvoidanceHints()
testAvoidanceHintsNoneWhenBelowThreshold()
console.log('failure fingerprint tests passed')
