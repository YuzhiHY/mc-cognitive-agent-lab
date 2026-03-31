/**
 * Tests for 4 architectural fixes:
 * 1. gameKnowledge reachableCraftables (P0)
 * 2. chainExecutor abortAwareWrap (P1)
 * 3. feeler compensation reporting (P3)
 * 4. centralReasoning snapshotDelta (P2)
 */

const assert = require('assert')

// ─── P0: reachableCraftables ───────────────────────────────────────

function testReachableCraftablesFromLogs() {
  const { buildGameKnowledge } = require('../src/runtime/gameKnowledge')
  const snapshot = {
    nearby: { blocks: [{ name: 'oak_log' }], entities: [] },
    inventory: { summary: [{ name: 'oak_log' }] },
  }
  const skills = { list: () => [], get: () => null }
  const gk = buildGameKnowledge(snapshot, skills)

  // With only oak_log, direct craftables should include planks
  assert.ok(gk.craftableItems.includes('oak_planks'), 'planks should be directly craftable from log')
  // But not wooden_pickaxe directly
  assert.ok(!gk.craftableItems.includes('wooden_pickaxe'), 'pickaxe should NOT be directly craftable')
  // reachableCraftables should include tools reachable through intermediate steps
  assert.ok(gk.reachableCraftables.includes('wooden_pickaxe'), 'pickaxe should be reachable')
  assert.ok(gk.reachableCraftables.includes('wooden_axe'), 'axe should be reachable')
  assert.ok(gk.reachableCraftables.includes('crafting_table'), 'crafting_table should be reachable')
  console.log('  ✓ reachableCraftables from logs only')
}

function testReachableCraftablesFromPlanks() {
  const { buildGameKnowledge } = require('../src/runtime/gameKnowledge')
  const snapshot = {
    nearby: { blocks: [], entities: [] },
    inventory: { summary: [{ name: 'oak_planks' }] },
  }
  const skills = { list: () => [], get: () => null }
  const gk = buildGameKnowledge(snapshot, skills)

  // With planks, stick and crafting_table are directly craftable
  assert.ok(gk.craftableItems.includes('stick'), 'stick should be directly craftable')
  assert.ok(gk.craftableItems.includes('crafting_table'), 'crafting_table should be directly craftable')
  // Tools should be reachable (planks → stick → tool)
  assert.ok(gk.reachableCraftables.includes('wooden_pickaxe'), 'pickaxe should be reachable from planks')
  // crafting_table already in directCraftable, should NOT be in reachable
  assert.ok(!gk.reachableCraftables.includes('crafting_table'), 'crafting_table should not duplicate in reachable')
  console.log('  ✓ reachableCraftables from planks')
}

function testReachableCraftablesNoDuplicates() {
  const { buildGameKnowledge } = require('../src/runtime/gameKnowledge')
  const snapshot = {
    nearby: { blocks: [], entities: [] },
    inventory: { summary: [{ name: 'oak_planks' }, { name: 'stick' }] },
  }
  const skills = { list: () => [], get: () => null }
  const gk = buildGameKnowledge(snapshot, skills)

  // With planks + stick, tools are directly craftable
  assert.ok(gk.craftableItems.includes('wooden_pickaxe'), 'pickaxe should be directly craftable')
  // Should NOT also appear in reachable
  assert.ok(!gk.reachableCraftables.includes('wooden_pickaxe'), 'no duplication between direct and reachable')
  console.log('  ✓ no duplicates between craftable and reachable')
}

function testReachableCraftingChainsIncluded() {
  const { buildGameKnowledge } = require('../src/runtime/gameKnowledge')
  const snapshot = {
    nearby: { blocks: [], entities: [] },
    inventory: { summary: [{ name: 'oak_log' }] },
  }
  const skills = { list: () => [], get: () => null }
  const gk = buildGameKnowledge(snapshot, skills)

  // craftingChains should include entries for reachable items
  assert.ok(gk.craftingChains.wooden_pickaxe, 'crafting chain for reachable wooden_pickaxe should exist')
  assert.ok(gk.craftingChains.crafting_table, 'crafting chain for reachable crafting_table should exist')
  console.log('  ✓ crafting chains include reachable items')
}

function testResolveCraftPrerequisites() {
  const { resolvePrerequisites } = require('../src/runtime/gameKnowledge')
  // Goal: craft wooden_pickaxe, inventory: only oak_log
  const prereqs = resolvePrerequisites(
    { craftItem: 'wooden_pickaxe' },
    { inventory: { summary: [{ name: 'oak_log' }] }, nearby: { blocks: [] } },
  )
  // Should have steps: craft planks, craft stick, craft crafting_table, craft wooden_pickaxe
  assert.ok(prereqs.length >= 3, `should have at least 3 steps, got ${prereqs.length}`)
  const items = prereqs.map((s) => s.item)
  assert.ok(items.includes('oak_planks') || items.includes('planks'), 'should include planks crafting')
  assert.ok(items.includes('stick'), 'should include stick crafting')
  assert.ok(items.includes('wooden_pickaxe'), 'should include target item')
  console.log('  ✓ resolvePrerequisites for crafting goals')
}

function testResolvePrerequisitesWithExistingMaterials() {
  const { resolvePrerequisites } = require('../src/runtime/gameKnowledge')
  // Goal: craft wooden_pickaxe, inventory: has planks + stick + crafting_table nearby
  const prereqs = resolvePrerequisites(
    { craftItem: 'wooden_pickaxe' },
    {
      inventory: { summary: [{ name: 'oak_planks' }, { name: 'stick' }] },
      nearby: { blocks: [{ name: 'crafting_table' }] },
    },
  )
  // Should only need the final craft step since all materials present
  assert.ok(prereqs.length <= 2, `should need at most 2 steps, got ${prereqs.length}`)
  assert.ok(prereqs.some((s) => s.item === 'wooden_pickaxe'), 'should include final craft')
  console.log('  ✓ resolvePrerequisites skips when materials present')
}

// ─── P1: abortAwareWrap ────────────────────────────────────────────

async function testAbortAwareWrapNormal() {
  const { abortAwareWrap } = require('../src/runtime/chainExecutor')
  const result = await abortAwareWrap(
    Promise.resolve({ value: 42 }),
    null, // no signal
  )
  assert.deepStrictEqual(result, { value: 42 }, 'should pass through normal result')
  console.log('  ✓ abortAwareWrap passes through normal result')
}

async function testAbortAwareWrapPreAborted() {
  const { abortAwareWrap } = require('../src/runtime/chainExecutor')
  const signal = { aborted: true, reason: 'test_abort', at: Date.now() }
  let cleanupCalled = false
  const result = await abortAwareWrap(
    new Promise(() => {}), // never resolves
    signal,
    () => { cleanupCalled = true },
  )
  assert.ok(result._aborted, 'should be aborted')
  assert.strictEqual(result.reason, 'test_abort')
  assert.ok(cleanupCalled, 'cleanup should be called')
  console.log('  ✓ abortAwareWrap handles pre-aborted signal')
}

async function testAbortAwareWrapMidFlight() {
  const { abortAwareWrap } = require('../src/runtime/chainExecutor')
  const signal = { aborted: false, reason: null, at: null }
  let cleanupCalled = false

  const slowPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ value: 'slow' }), 2000)
  })

  // Abort after 100ms
  setTimeout(() => {
    signal.aborted = true
    signal.reason = 'mid_flight_abort'
    signal.at = Date.now()
  }, 100)

  const result = await abortAwareWrap(
    slowPromise, signal,
    () => { cleanupCalled = true },
    50, // poll every 50ms for faster test
  )
  assert.ok(result._aborted, 'should be aborted mid-flight')
  assert.strictEqual(result.reason, 'mid_flight_abort')
  assert.ok(cleanupCalled, 'cleanup should be called on mid-flight abort')
  console.log('  ✓ abortAwareWrap aborts mid-flight')
}

async function testAbortAwareWrapFastResolve() {
  const { abortAwareWrap } = require('../src/runtime/chainExecutor')
  const signal = { aborted: false }

  const result = await abortAwareWrap(
    Promise.resolve({ done: true }),
    signal,
    () => { throw new Error('should not cleanup') },
  )
  assert.deepStrictEqual(result, { done: true }, 'fast resolve should win over poll')
  console.log('  ✓ abortAwareWrap fast resolve wins')
}

// ─── P3: feeler compensation reporting ─────────────────────────────

function testFeelReturnsPositionDelta() {
  const { feel } = require('../src/runtime/feeler')
  // Test that feel() returns positionDelta and yawDelta fields even when not compensating
  // We can't easily mock bot here, but we test the no-probe case
  const result = feel(
    { entity: null }, // bot with no position
    null,
  )
  // feel returns a promise
  result.then((r) => {
    assert.strictEqual(r.probed, false, 'should not probe without position')
    assert.strictEqual(r.positionDelta, 0, 'positionDelta should be 0 when not probed')
    assert.strictEqual(r.yawDelta, 0, 'yawDelta should be 0 when not probed')
    console.log('  ✓ feel() returns delta fields when not probed')
  })
  return result
}

function testExpectationEvaluatorFeelerDrift() {
  const { evaluateExpectation } = require('../src/runtime/daemon/expectationEvaluator')

  // Test with no feeler compensation
  const result1 = evaluateExpectation({
    expectation: { expectedOutcome: 'mine_block', confidence: 0.8, fallbackHint: 'retry' },
    chainResult: { completed: 0, total: 1, interrupted: false, failedStep: { error: { message: 'path_blocked' } } },
    feelerCompensation: null,
  })
  assert.strictEqual(result1.feelerDrift, 0, 'feelerDrift should be 0 when no compensation')

  // Test with significant feeler drift
  const result2 = evaluateExpectation({
    expectation: { expectedOutcome: 'mine_block', confidence: 0.8, fallbackHint: 'retry' },
    chainResult: { completed: 0, total: 1, interrupted: false, failedStep: { error: { message: 'path_blocked' } } },
    feelerCompensation: { positionDelta: 3.5, yawDelta: 0.5 },
  })
  assert.strictEqual(result2.feelerDrift, 3.5, 'feelerDrift should reflect compensation')
  assert.ok(result2.deviation.includes('feeler_drift'), 'deviation should mention feeler drift')
  console.log('  ✓ expectationEvaluator accounts for feeler drift')
}

function testSharedStateHasFeelerField() {
  const { createSharedState } = require('../src/runtime/daemon/sharedState')
  const shared = createSharedState()
  assert.ok('lastFeelerCompensation' in shared, 'shared state should have lastFeelerCompensation')
  assert.strictEqual(shared.lastFeelerCompensation, null, 'initial value should be null')
  console.log('  ✓ sharedState includes lastFeelerCompensation')
}

// ─── P2: snapshotDelta ─────────────────────────────────────────────

function testSnapshotDeltaIdentical() {
  const { createCentralReasoning } = require('../src/runtime/centralReasoning')
  const cr = createCentralReasoning({
    llm: { plan: async () => ({}) },
    stableSkills: { list: () => [], get: () => null },
  })
  const snap = {
    status: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
    threat_level: 'none',
    nearby: { entities: [], blocks: [] },
    inventory: { summary: [{ name: 'oak_log' }] },
  }
  const delta = cr.snapshotDelta(snap, snap)
  assert.ok(delta < 0.01, `identical snapshots should have near-zero delta, got ${delta}`)
  console.log('  ✓ snapshotDelta: identical snapshots = 0')
}

function testSnapshotDeltaThreatChange() {
  const { createCentralReasoning } = require('../src/runtime/centralReasoning')
  const cr = createCentralReasoning({
    llm: { plan: async () => ({}) },
    stableSkills: { list: () => [], get: () => null },
  })
  const prev = { status: { health: 20 }, threat_level: 'none', nearby: { entities: [] }, inventory: { summary: [] } }
  const curr = { status: { health: 20 }, threat_level: 'high', nearby: { entities: [] }, inventory: { summary: [] } }
  const delta = cr.snapshotDelta(prev, curr)
  assert.ok(delta >= 0.4, `threat change should produce delta >= 0.4, got ${delta}`)
  console.log('  ✓ snapshotDelta: threat change = high delta')
}

function testSnapshotDeltaHostileAppears() {
  const { createCentralReasoning } = require('../src/runtime/centralReasoning')
  const cr = createCentralReasoning({
    llm: { plan: async () => ({}) },
    stableSkills: { list: () => [], get: () => null },
  })
  const prev = { status: { health: 20 }, threat_level: 'none', nearby: { entities: [] }, inventory: { summary: [] } }
  const curr = { status: { health: 20 }, threat_level: 'none', nearby: { entities: [{ name: 'zombie', hostile: true }] }, inventory: { summary: [] } }
  const delta = cr.snapshotDelta(prev, curr)
  assert.ok(delta >= 0.5, `hostile appearing should produce delta >= 0.5, got ${delta}`)
  console.log('  ✓ snapshotDelta: hostile appears = high delta')
}

function testSnapshotDeltaNoSnapshot() {
  const { createCentralReasoning } = require('../src/runtime/centralReasoning')
  const cr = createCentralReasoning({
    llm: { plan: async () => ({}) },
    stableSkills: { list: () => [], get: () => null },
  })
  const delta = cr.snapshotDelta(null, { status: { health: 20 } })
  assert.strictEqual(delta, 1.0, 'null previous snapshot should return 1.0')
  console.log('  ✓ snapshotDelta: null prev = 1.0')
}

function testSnapshotDeltaHealthDamage() {
  const { createCentralReasoning } = require('../src/runtime/centralReasoning')
  const cr = createCentralReasoning({
    llm: { plan: async () => ({}) },
    stableSkills: { list: () => [], get: () => null },
  })
  const prev = { status: { health: 20 }, threat_level: 'none', nearby: { entities: [] }, inventory: { summary: [] } }
  const curr = { status: { health: 10 }, threat_level: 'none', nearby: { entities: [] }, inventory: { summary: [] } }
  const delta = cr.snapshotDelta(prev, curr)
  assert.ok(delta >= 0.3, `health drop should produce delta >= 0.3, got ${delta}`)
  console.log('  ✓ snapshotDelta: health damage = medium delta')
}

// ─── Run all ───────────────────────────────────────────────────────

async function main() {
  console.log('\n=== P0: gameKnowledge reachableCraftables ===')
  testReachableCraftablesFromLogs()
  testReachableCraftablesFromPlanks()
  testReachableCraftablesNoDuplicates()
  testReachableCraftingChainsIncluded()
  testResolveCraftPrerequisites()
  testResolvePrerequisitesWithExistingMaterials()

  console.log('\n=== P1: chainExecutor abortAwareWrap ===')
  await testAbortAwareWrapNormal()
  await testAbortAwareWrapPreAborted()
  await testAbortAwareWrapMidFlight()
  await testAbortAwareWrapFastResolve()

  console.log('\n=== P3: feeler compensation reporting ===')
  await testFeelReturnsPositionDelta()
  testExpectationEvaluatorFeelerDrift()
  testSharedStateHasFeelerField()

  console.log('\n=== P2: centralReasoning snapshotDelta ===')
  testSnapshotDeltaIdentical()
  testSnapshotDeltaThreatChange()
  testSnapshotDeltaHostileAppears()
  testSnapshotDeltaNoSnapshot()
  testSnapshotDeltaHealthDamage()

  console.log('\n✓ All architectural fix tests passed')
}

main().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
