const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createWorkingMemory } = require('../src/runtime/memory2/workingMemory')
const { createLongTermMemory } = require('../src/runtime/memory2/longTermMemory')
const { createPromotionEngine, textSimilarity } = require('../src/runtime/memory2/promotionEngine')
const { createMemoryProjection } = require('../src/runtime/memory2/memoryProjection')

// --- Working Memory tests ---

function testRingBuffer() {
  const wm = createWorkingMemory({ maxExecutions: 5 })
  for (let i = 0; i < 10; i++) {
    wm.recordExecution({ cycle: i, skill: `skill_${i}`, success: true })
  }
  const all = wm.getAll()
  assert.strictEqual(all.executionLog.length, 5, 'ring buffer should keep only last 5')
  assert.strictEqual(all.executionLog[0].skill, 'skill_5')
  assert.strictEqual(all.executionLog[4].skill, 'skill_9')
}

function testDecay() {
  const wm = createWorkingMemory({ maxExecutions: 10, maxCycleAge: 15 })
  wm.recordExecution({ cycle: 1, skill: 'a', success: true })
  wm.recordExecution({ cycle: 5, skill: 'b', success: true })
  wm.recordExecution({ cycle: 10, skill: 'c', success: true })
  wm.decay(20)
  const execs = wm.getRecentExecutions(10)
  assert.strictEqual(execs.length, 2, 'cycle-1 entry should be decayed (age 19 > 15)')
  assert.strictEqual(execs[0].skill, 'b')
  assert.strictEqual(execs[1].skill, 'c')
}

function testUnansweredMessages() {
  const wm = createWorkingMemory()
  wm.recordPlayerMessage({ from: 'Alice', text: 'hello', ts: 1000, cycle: 1 })
  wm.recordPlayerMessage({ from: 'Alice', text: 'craft?', ts: 2000, cycle: 2 })
  wm.recordPlayerMessage({ from: 'Bob', text: 'hi', ts: 3000, cycle: 3 })
  wm.markMessageAnswered(2000) // mark 'craft?' as answered
  const unanswered = wm.getUnansweredMessages()
  assert.strictEqual(unanswered.length, 2, 'should have 2 unanswered')
  assert.ok(unanswered.every((m) => !m.answered))
}

function testUnansweredSurviveLonger() {
  const wm = createWorkingMemory({ maxCycleAge: 5 })
  wm.recordPlayerMessage({ from: 'A', text: 'old answered', ts: 1000, cycle: 1 })
  wm.recordPlayerMessage({ from: 'B', text: 'old unanswered', ts: 5000, cycle: 1 })
  // Mark first as answered (use markAllAnsweredFrom for precision)
  wm.markAllAnsweredFrom('A')
  // Decay at cycle 10 (age = 9 > maxCycleAge=5 for answered, but < 10 for unanswered)
  wm.decay(10)
  const all = wm.getAllMessages(10)
  assert.strictEqual(all.length, 1, 'answered old message decayed, unanswered survives')
  assert.strictEqual(all[0].text, 'old unanswered')
}

function testMarkAllAnsweredFrom() {
  const wm = createWorkingMemory()
  wm.recordPlayerMessage({ from: 'Alice', text: 'msg1', ts: 1000, cycle: 1 })
  wm.recordPlayerMessage({ from: 'Alice', text: 'msg2', ts: 2000, cycle: 2 })
  wm.recordPlayerMessage({ from: 'Bob', text: 'msg3', ts: 3000, cycle: 3 })
  const count = wm.markAllAnsweredFrom('Alice')
  assert.strictEqual(count, 2)
  const unanswered = wm.getUnansweredMessages()
  assert.strictEqual(unanswered.length, 1)
  assert.strictEqual(unanswered[0].from, 'Bob')
}

function testGoalContext() {
  const wm = createWorkingMemory()
  assert.strictEqual(wm.getGoalContext(), null)
  wm.setGoalContext({ selfGoal: 'mine iron', goalType: 'gather', cycle: 5 })
  const gc = wm.getGoalContext()
  assert.strictEqual(gc.selfGoal, 'mine iron')
  assert.strictEqual(gc.goalType, 'gather')
}

// --- Long-term Memory tests ---

function testLongTermCapability() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  ltm.recordCapability({ key: 'craft:oak_planks', description: 'can craft planks' })
  const caps = ltm.getCapabilities()
  assert.ok(caps['craft:oak_planks'])
  assert.strictEqual(caps['craft:oak_planks'].successCount, 1)
  // Record again — should increment
  ltm.recordCapability({ key: 'craft:oak_planks' })
  assert.strictEqual(ltm.get('capabilities', 'craft:oak_planks').successCount, 2)
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testQueryRelevant() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  // Populate many items
  for (let i = 0; i < 10; i++) {
    ltm.recordCapability({ key: `mine:stone_${i}`, description: `mine stone ${i}` })
  }
  ltm.recordCapability({ key: 'craft:wooden_pickaxe', description: 'craft pickaxe from planks' })
  ltm.recordWorldRule({ key: 'rule_need_pickaxe', description: 'need pickaxe to mine stone', source: 'test' })
  const result = ltm.queryRelevant({ goal: 'craft pickaxe', limit: { capabilities: 3, worldRules: 2, social: 1, habits: 1 } })
  // Should prioritize craft:wooden_pickaxe (keyword match on "craft" and "pickaxe")
  assert.ok(result.capabilities['craft:wooden_pickaxe'], 'craft pickaxe should be in results')
  assert.ok(Object.keys(result.capabilities).length <= 3, 'should respect limit')
  assert.ok(result.worldRules['rule_need_pickaxe'], 'pickaxe rule should match')
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testLegacyMigration() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  const legacy = {
    'player_pause_request': 'Rinllo_ requested pause at cycle 3',
    'nearby_player': 'Rinllo_ at distance 2.59',
    'habit:workbench_retrieval': '用完工作台后敲掉并随身带走',
    'knowledge:habit_learned:some_habit': 'always pick up tools',
    'some_other_key': 'not relevant',
  }
  const count = ltm.importFromLegacy(legacy)
  assert.ok(count >= 2, `should import at least 2 items, got ${count}`)
  // Check social
  const social = ltm.getCategory('social')
  assert.ok(Object.keys(social).length > 0, 'should have social entries')
  // Check habits
  const habits = ltm.getCategory('habits')
  assert.ok(habits['workbench_retrieval'], 'workbench habit should be imported')
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// --- Promotion Engine tests ---

function testPromotionFirstSuccess() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  const pe = createPromotionEngine({ workingMemory: wm, longTermMemory: ltm })
  const promoted = pe.evaluateAfterExecution({
    skill: 'craft',
    args: { item: 'oak_planks' },
    success: true,
    failReason: null,
  })
  assert.strictEqual(promoted.length, 1, 'should promote first success')
  assert.strictEqual(promoted[0].category, 'capabilities')
  // Second success should not re-promote (just update count)
  const promoted2 = pe.evaluateAfterExecution({
    skill: 'craft',
    args: { item: 'oak_planks' },
    success: true,
  })
  assert.strictEqual(promoted2.length, 0, 'should not re-promote existing capability')
  assert.strictEqual(ltm.get('capabilities', 'craft:oak_planks').successCount, 2)
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testPromotionCausalFailureNoLongerAutoPromotes() {
  // Causal failure detection moved to LLM analyze phase (per CLAUDE.md).
  // promotionEngine no longer does keyword matching.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  const pe = createPromotionEngine({ workingMemory: wm, longTermMemory: ltm })
  const promoted = pe.evaluateAfterExecution({
    skill: 'mine',
    args: { block: 'stone' },
    success: false,
    failReason: 'need pickaxe to mine stone',
  })
  assert.strictEqual(promoted.length, 0, 'causal failures no longer auto-promoted')
  assert.strictEqual(Object.keys(ltm.getCategory('worldRules')).length, 0)
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testPromotionPlayerMessageOnlySocial() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  const pe = createPromotionEngine({ workingMemory: wm, longTermMemory: ltm })
  const promoted = pe.evaluatePlayerMessage({ from: 'Alice', text: '以后都要带着工作台' })
  assert.strictEqual(promoted.length, 0, 'player messages no longer auto-promote habits')
  assert.strictEqual(Object.keys(ltm.getCategory('habits')).length, 0, 'no habits created')
  // But social should be updated
  const social = ltm.getCategory('social')
  assert.ok(social['player:Alice'], 'social record should be created')
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testPromotionSkipsWait() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  const pe = createPromotionEngine({ workingMemory: wm, longTermMemory: ltm })
  const promoted = pe.evaluateAfterExecution({
    skill: 'wait',
    args: {},
    success: true,
  })
  assert.strictEqual(promoted.length, 0, 'wait should never be promoted')
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// --- Memory Projection tests ---

function testPersonalityProjection() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  wm.recordExecution({ cycle: 1, skill: 'mine', args: { block: 'oak_log' }, success: true })
  wm.recordExecution({ cycle: 2, skill: 'craft', args: { item: 'oak_planks' }, success: true })
  ltm.recordCapability({ key: 'craft:oak_planks', description: 'can craft planks' })
  const proj = createMemoryProjection({ workingMemory: wm, longTermMemory: ltm })
  const result = proj.forPersonality({})
  assert.strictEqual(result.recentActions.length, 2)
  assert.ok(result.knownCapabilities.includes('craft:oak_planks'))
  // Token budget check: serialized should be under ~500 chars (~300 tokens)
  const serialized = JSON.stringify(result)
  assert.ok(serialized.length < 800, `personality projection too large: ${serialized.length} chars`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testDecideProjectionIncludesUnanswered() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  wm.recordPlayerMessage({ from: 'Rinllo_', text: 'make a pickaxe', ts: 1000, cycle: 1 })
  wm.recordPlayerMessage({ from: 'Rinllo_', text: 'hurry up', ts: 2000, cycle: 2 })
  wm.markMessageAnswered(1000) // answer first
  const proj = createMemoryProjection({ workingMemory: wm, longTermMemory: ltm })
  const result = proj.forDecide({})
  assert.strictEqual(result.unansweredPlayerMessages.length, 1)
  assert.strictEqual(result.unansweredPlayerMessages[0].text, 'hurry up')
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testFormatRecentActionsForBrief() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
  const wm = createWorkingMemory()
  const ltm = createLongTermMemory({ memoryDir: tmpDir })
  wm.recordExecution({ cycle: 1, skill: 'craft', args: { item: 'oak_planks' }, success: true })
  wm.recordExecution({ cycle: 2, skill: 'mine', args: { block: 'stone' }, success: false, failReason: 'need pickaxe' })
  const proj = createMemoryProjection({ workingMemory: wm, longTermMemory: ltm })
  const brief = proj.formatRecentActionsForBrief()
  assert.ok(brief.includes('craft(oak_planks): 成功'))
  assert.ok(brief.includes('mine(stone): 失败'))
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function testTextSimilarity() {
  // Word-overlap works for space-separated text
  assert.ok(textSimilarity('make a crafting table', 'craft a table please') > 0.2)
  assert.ok(textSimilarity('hello world', 'goodbye moon') < 0.2)
  assert.strictEqual(textSimilarity('', 'anything'), 0)
  // Same text = 1.0
  assert.strictEqual(textSimilarity('craft pickaxe', 'craft pickaxe'), 1)
}

// --- Run all ---

async function run() {
  testRingBuffer()
  testDecay()
  testUnansweredMessages()
  testUnansweredSurviveLonger()
  testMarkAllAnsweredFrom()
  testGoalContext()
  testLongTermCapability()
  testQueryRelevant()
  testLegacyMigration()
  testPromotionFirstSuccess()
  testPromotionCausalFailureNoLongerAutoPromotes()
  testPromotionPlayerMessageOnlySocial()
  testPromotionSkipsWait()
  testPersonalityProjection()
  testDecideProjectionIncludesUnanswered()
  testFormatRecentActionsForBrief()
  testTextSimilarity()
  // eslint-disable-next-line no-console
  console.log('memory2 tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
