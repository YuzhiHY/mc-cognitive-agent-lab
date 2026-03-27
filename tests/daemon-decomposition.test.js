const assert = require('node:assert')

// Test that all daemon sub-modules can be imported independently
const pacingPolicy = require('../src/runtime/daemon/pacingPolicy')
const skillPromotion = require('../src/runtime/daemon/skillPromotion')
const expectationEvaluator = require('../src/runtime/daemon/expectationEvaluator')
const worldStateInterrupt = require('../src/runtime/daemon/worldStateInterrupt')
const executionMetadata = require('../src/runtime/daemon/executionMetadata')
const barrel = require('../src/runtime/daemon/index')

// --- pacingPolicy ---

function testCurrentThreatFromSnapshot() {
  assert.strictEqual(pacingPolicy.currentThreat({ threat_level: 'high' }), 'high')
  assert.strictEqual(pacingPolicy.currentThreat({ threat_level: 'low' }), 'low')
  assert.strictEqual(pacingPolicy.currentThreat({ threat_level: 'none' }), 'none')
  assert.strictEqual(pacingPolicy.currentThreat(null), 'none')
}

function testShouldSpeakVoice() {
  assert.strictEqual(pacingPolicy.shouldSpeakVoice({ voice: '', snapshot: {} }), false)
  assert.strictEqual(pacingPolicy.shouldSpeakVoice({ voice: 'hello', snapshot: { threat_level: 'high' } }), false)
  assert.strictEqual(pacingPolicy.shouldSpeakVoice({ voice: 'hello', snapshot: { threat_level: 'none' }, isExecuting: false, recentVoices: [] }), true)
  assert.strictEqual(pacingPolicy.shouldSpeakVoice({ voice: 'hello', snapshot: { threat_level: 'none' }, isExecuting: false, recentVoices: ['hello'] }), false)
}

function testVoiceCooldown() {
  assert.strictEqual(pacingPolicy.voiceCooldownMs({ threat_level: 'high' }), 8000)
  assert.strictEqual(pacingPolicy.voiceCooldownMs({ threat_level: 'low' }), 5200)
  assert.strictEqual(pacingPolicy.voiceCooldownMs({ threat_level: 'none' }), 3200)
}

function testFormatVoiceOutput() {
  assert.strictEqual(pacingPolicy.formatVoiceOutput('hello world'), 'hello world')
  assert.strictEqual(pacingPolicy.formatVoiceOutput('短句。后面的', { taskBusy: true }), '短句')
}

// --- skillPromotion ---

function testCompactChainSignature() {
  const sig = skillPromotion.compactChainSignature([
    { type: 'dig', target: 'oak_log' },
    { type: 'craft', item: 'planks', count: 4 },
  ])
  assert.ok(sig.includes('dig:oak_log'))
  assert.ok(sig.includes('craft:planks#4'))
  assert.strictEqual(skillPromotion.compactChainSignature(null), 'empty')
}

function testChainSucceeded() {
  assert.strictEqual(skillPromotion.chainSucceeded(null), false)
  assert.strictEqual(skillPromotion.chainSucceeded({
    completed: 2, total: 2, failedStep: null, interrupted: false,
    results: [{ status: 'success' }, { status: 'success' }],
  }), true)
  assert.strictEqual(skillPromotion.chainSucceeded({
    completed: 1, total: 2, failedStep: { index: 1 }, interrupted: false,
    results: [{ status: 'success' }],
  }), false)
}

function testStepToCodeLine() {
  assert.ok(skillPromotion.stepToCodeLine({ type: 'chat', message: 'hi' }).includes('api.chat'))
  assert.ok(skillPromotion.stepToCodeLine({ type: 'dig', target: 'stone' }).includes('digByName'))
  assert.strictEqual(skillPromotion.stepToCodeLine({ type: 'unknown_type' }), null)
}

function testSynthesizeSkillCode() {
  const code = skillPromotion.synthesizeSkillCodeFromChain([
    { type: 'dig', target: 'oak_log' },
  ], 'test_skill')
  assert.ok(code.includes('module.exports.run'))
  assert.ok(code.includes('digByName'))
  assert.strictEqual(skillPromotion.synthesizeSkillCodeFromChain([]), null)
}

function testValidatePromotableSkill() {
  assert.strictEqual(skillPromotion.validatePromotableSkill({ code: 'module.exports.run = async () => {}' }).ok, true)
  assert.strictEqual(skillPromotion.validatePromotableSkill({ code: 'no run export' }).ok, false)
}

// --- expectationEvaluator ---

function testEvaluateExpectationNull() {
  assert.strictEqual(expectationEvaluator.evaluateExpectation({ expectation: null, chainResult: {} }), null)
}

function testEvaluateExpectationSuccess() {
  const result = expectationEvaluator.evaluateExpectation({
    expectation: { expectedOutcome: 'gather wood' },
    chainResult: {
      completed: 1, total: 1, failedStep: null, interrupted: false,
      results: [{ status: 'success' }],
    },
  })
  assert.strictEqual(result.matched, true)
  assert.strictEqual(result.decision, 'keep_method')
}

function testEvaluateExpectationInterrupted() {
  const result = expectationEvaluator.evaluateExpectation({
    expectation: { expectedOutcome: 'gather wood' },
    chainResult: { interrupted: true },
  })
  assert.strictEqual(result.matched, false)
  assert.strictEqual(result.cause, 'reflex_interrupt')
}

// --- worldStateInterrupt ---

function testSignificantWorldStateChange() {
  assert.strictEqual(worldStateInterrupt.significantWorldStateChange(null, {}), false)
  assert.strictEqual(worldStateInterrupt.significantWorldStateChange(
    { threat_level: 'none', status: { health: 20 } },
    { threat_level: 'high', status: { health: 20 } },
  ), true)
  assert.strictEqual(worldStateInterrupt.significantWorldStateChange(
    { threat_level: 'none', status: { health: 20 } },
    { threat_level: 'none', status: { health: 20 } },
  ), false)
}

function testBuildWorldChangeInterrupt() {
  const noChange = worldStateInterrupt.buildWorldChangeInterrupt({ changed: false, cycle: 1, snapshot: {} })
  assert.strictEqual(noChange.shouldInterrupt, false)
  const changed = worldStateInterrupt.buildWorldChangeInterrupt({ changed: true, cycle: 1, snapshot: { threat_level: 'high' } })
  assert.strictEqual(changed.shouldInterrupt, true)
  assert.strictEqual(changed.priority, 'medium')
}

// --- executionMetadata ---

function testInferExecutionMeta() {
  const meta = executionMetadata.inferExecutionMetaFromChain([
    { type: 'dig', target: 'stone' },
  ])
  assert.strictEqual(meta.interruptible, true)
  assert.ok(meta.chainSignature.includes('dig:stone'))
}

function testInferExecutionMetaWait() {
  const meta = executionMetadata.inferExecutionMetaFromChain([
    { type: 'wait', timeoutMs: 5000 },
  ])
  assert.strictEqual(meta.interruptible, false)
  assert.strictEqual(meta.timeoutMs, 5000)
}

// --- barrel index ---

function testBarrelExports() {
  assert.strictEqual(typeof barrel.currentThreat, 'function')
  assert.strictEqual(typeof barrel.compactChainSignature, 'function')
  assert.strictEqual(typeof barrel.evaluateExpectation, 'function')
  assert.strictEqual(typeof barrel.significantWorldStateChange, 'function')
  assert.strictEqual(typeof barrel.inferExecutionMetaFromChain, 'function')
}

// Run all tests
testCurrentThreatFromSnapshot()
testShouldSpeakVoice()
testVoiceCooldown()
testFormatVoiceOutput()
testCompactChainSignature()
testChainSucceeded()
testStepToCodeLine()
testSynthesizeSkillCode()
testValidatePromotableSkill()
testEvaluateExpectationNull()
testEvaluateExpectationSuccess()
testEvaluateExpectationInterrupted()
testSignificantWorldStateChange()
testBuildWorldChangeInterrupt()
testInferExecutionMeta()
testInferExecutionMetaWait()
testBarrelExports()
console.log('daemon decomposition tests passed')
