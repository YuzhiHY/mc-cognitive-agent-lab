/**
 * Phase 11 — Scenario-based behavior tests (TDD: tests written first).
 *
 * These test multi-cycle behavioral invariants, not individual module outputs.
 * Each scenario uses the real daemon with mocked dependencies.
 */

const assert = require('node:assert')
const { createDaemon } = require('../src/runtime/daemon')

// --- Helpers ---

function makeVec3(x = 0, y = 64, z = 0) {
  return {
    x, y, z,
    clone() { return makeVec3(this.x, this.y, this.z) },
    offset(dx, dy, dz) { return makeVec3(this.x + dx, this.y + dy, this.z + dz) },
    floored() { return makeVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) },
    distanceTo(v) {
      const dx = this.x - v.x; const dy = this.y - v.y; const dz = this.z - v.z
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    },
  }
}

function makeBot(overrides = {}) {
  const listeners = new Map()
  return {
    username: 'test-bot',
    health: 20,
    food: 20,
    time: { isDay: true, timeOfDay: 1000 },
    game: { dimension: 'overworld' },
    experience: { level: 0 },
    isSleeping: false,
    entity: {
      id: 1,
      position: makeVec3(0, 64, 0),
      yaw: 0, pitch: 0, onGround: true,
    },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { goal: null, setGoal: () => {}, movements: {} },
    blockAt: () => ({ name: 'stone', position: makeVec3(0, 63, 0) }),
    findBlock: () => null,
    chat: () => {},
    lookAt: async () => {},
    look: async () => {},
    setControlState: () => {},
    equip: async () => {},
    placeBlock: async () => {},
    dig: async () => {},
    stopDigging: () => {},
    attack: () => {},
    on: (name, cb) => {
      const arr = listeners.get(name) || []
      arr.push(cb)
      listeners.set(name, arr)
    },
    off: (name, cb) => {
      const arr = listeners.get(name) || []
      listeners.set(name, arr.filter((x) => x !== cb))
    },
    targetDigBlock: null,
    ...overrides,
  }
}

function makeMemory() {
  const db = new Map()
  return {
    get: (k) => db.get(k),
    set: async (k, v) => db.set(k, v),
    delete: async (k) => db.delete(k),
    getAll: () => ({}),
  }
}

// ============================================================
// Scenario 1: Stable execution without replanning
// ============================================================
// When a skill is actively executing (execution lock held),
// subsequent cycles must NOT invoke the planner. They should
// return 'executing_hold' until the skill completes.
async function scenario_stableExecutionWithoutReplan() {
  process.env.LOG_TO_FILE = 'false'
  let thinkCount = 0
  let releaseChain = null
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => {
        thinkCount += 1
        return {
          thought: 'gather wood',
          actionChain: [{ type: 'skill_ref', skillName: 'mine_named_block' }],
          memoryUpdates: [],
        }
      },
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: () => new Promise((resolve) => { releaseChain = resolve }),
    },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })

  // Cycle 1: planner invoked, chain starts executing (blocks)
  const p1 = daemon.runSingleCycleForTest()
  await new Promise((r) => setTimeout(r, 20))
  assert.strictEqual(thinkCount, 1, 'Planner should be invoked exactly once on first cycle')

  // Cycles 2-4: should all return hold, planner NOT re-invoked
  for (let i = 0; i < 3; i++) {
    const holdResult = await daemon.runSingleCycleForTest()
    assert.strictEqual(holdResult.type, 'executing_hold', `Cycle ${i + 2} should be executing_hold`)
  }
  assert.strictEqual(thinkCount, 1, 'Planner must NOT be reinvoked while execution lock is held')

  // Release the chain
  releaseChain({
    completed: 1, total: 1, interrupted: false, failedStep: null,
    results: [{ status: 'success', ok: true }],
  })
  await p1

  // Cycle 5: after completion, planner should be invoked again
  await daemon.runSingleCycleForTest()
  assert.strictEqual(thinkCount, 2, 'Planner should be invoked again after chain completes')
}

// ============================================================
// Scenario 2: Reflex takeover during active execution
// ============================================================
// When a hostile threat is detected during execution,
// the reflex layer should fire and interrupt the current skill.
// State should transition: executing → interrupted → recovering → idle/assessing
async function scenario_reflexTakeoverDuringExecution() {
  process.env.LOG_TO_FILE = 'false'
  let reflexCallCount = 0
  let reflexExecuteCount = 0
  const bot = makeBot()

  // Reflex fires on second cycle (simulating threat appearing mid-execution)
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => ({
        thought: 'gather',
        actionChain: [{ type: 'skill_ref', skillName: 'mine_named_block' }],
        memoryUpdates: [],
      }),
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async () => ({
        completed: 1, total: 1, interrupted: false, failedStep: null,
        results: [{ status: 'success', ok: true }],
      }),
    },
    reflexLayer: {
      check: () => {
        reflexCallCount += 1
        // First cycle: no threat. After first cycle: threat detected.
        if (reflexCallCount > 1) {
          return { name: 'retreat_from_threat', reason: 'hostile_close', execute: async () => ({}) }
        }
        return null
      },
      execute: async () => {
        reflexExecuteCount += 1
        return { ok: true, status: 'success', actionType: 'retreat_from_threat' }
      },
      isCombatMode: () => false,
    },
  })

  // Cycle 1: normal planning + execution
  const r1 = await daemon.runSingleCycleForTest()
  assert.strictEqual(r1.type, 'reasoning', 'First cycle should reason normally')

  // Cycle 2: reflex fires, should take over
  const r2 = await daemon.runSingleCycleForTest()
  assert.strictEqual(r2.type, 'reflex', 'Second cycle should be reflex takeover')
  assert.ok(reflexExecuteCount >= 1, 'Reflex execute should have been called')

  // Verify state trace includes interrupted
  const trace = daemon.getStateTransitionTrace()
  assert.ok(trace.some((t) => t.to === 'interrupted'), 'State should have transitioned to interrupted')
}

// ============================================================
// Scenario 3: Repeated failure leads to goal reassessment
// ============================================================
// When a skill fails multiple times, the planner is invoked each time
// (no silent task abandonment). The failure should be visible to the
// planner via the task state.
async function scenario_repeatedFailureReassessment() {
  process.env.LOG_TO_FILE = 'false'
  let thinkCount = 0
  const decisionsReceived = []
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async (ctx) => {
        thinkCount += 1
        decisionsReceived.push({ cycle: thinkCount, state: ctx?.snapshot?.status?.health })
        return {
          thought: `attempt ${thinkCount}`,
          actionChain: [{ type: 'skill_ref', skillName: 'mine_named_block' }],
          memoryUpdates: [],
        }
      },
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async () => ({
        completed: 0, total: 1, interrupted: false,
        failedStep: { status: 'failure', error: { message: 'path blocked' } },
        results: [{ status: 'failure', ok: false }],
      }),
    },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })

  // Run 3 cycles, each should fail and re-invoke planner
  for (let i = 0; i < 3; i++) {
    await daemon.runSingleCycleForTest()
  }

  assert.strictEqual(thinkCount, 3, 'Planner should be invoked on every cycle even after failures')
  const trace = daemon.getStateTransitionTrace()
  const failedTransitions = trace.filter((t) => t.to === 'failed')
  assert.strictEqual(failedTransitions.length, 3, 'Each failure should set state to failed')
}

// ============================================================
// Scenario 4: Existing skill preferred over synthesis
// ============================================================
// When the planner returns a skill_ref action (referencing an existing skill),
// synthesis should NOT be triggered. This tests the scheduling-first invariant.
async function scenario_skillPreferredOverSynthesis() {
  process.env.LOG_TO_FILE = 'false'
  let synthesisAttempted = false
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => ({
        thought: 'use existing skill',
        actionChain: [{ type: 'skill_ref', skillName: 'mine_named_block' }],
        memoryUpdates: [],
      }),
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async (chain) => {
        // Check if any step has synthesized code
        for (const step of (chain || [])) {
          if (step.type === 'skill' && step.code) {
            synthesisAttempted = true
          }
        }
        return {
          completed: 1, total: 1, interrupted: false, failedStep: null,
          results: [{ status: 'success', ok: true }],
        }
      },
    },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })

  await daemon.runSingleCycleForTest()
  assert.strictEqual(synthesisAttempted, false, 'Synthesis must not be triggered when skill_ref is used')
}

// ============================================================
// Scenario 5: Candidate skill promotion after threshold
// ============================================================
// Tests the candidateSkillManager integration: after N successes,
// a skill gets promoted.
async function scenario_candidateSkillPromotion() {
  const { createCandidateSkillManager } = require('../src/runtime/candidateSkillManager')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-promo-'))

  const mgr = createCandidateSkillManager({
    experimentalDir: path.join(base, 'experimental'),
    promotedDir: path.join(base, 'promoted'),
  })

  // Register experimental skill
  mgr.registerExperimental('gather_oak', {
    code: 'module.exports.run = async () => {}',
    intent: 'gather oak wood',
    tags: ['wood'],
  })

  // Verify NOT approved yet
  assert.strictEqual(mgr.isApproved('gather_oak'), false, 'Should not be approved before threshold')

  // Record successes up to threshold
  mgr.recordOutcome('gather_oak', { ok: true })
  mgr.recordOutcome('gather_oak', { ok: true })
  const meta = mgr.recordOutcome('gather_oak', { ok: true })

  assert.strictEqual(meta.promotionEligible, true, 'Should be promotion eligible after 3 successes')

  // Promote
  const result = mgr.promote('gather_oak')
  assert.strictEqual(result.ok, true, 'Promotion should succeed')
  assert.strictEqual(mgr.isApproved('gather_oak'), true, 'Should be approved after promotion')
  assert.strictEqual(mgr.getMeta('gather_oak').tier, 'promoted')

  // Verify file physically moved
  assert.ok(fs.existsSync(path.join(base, 'promoted', 'gather_oak.js')))
  assert.ok(!fs.existsSync(path.join(base, 'experimental', 'gather_oak.js')))
}

// ============================================================
// Scenario 6: Quarantine of unstable candidate skill
// ============================================================
// After consecutive failures, a candidate skill gets quarantined
// and must not be returned by the registry.
async function scenario_candidateSkillQuarantine() {
  const { createCandidateSkillManager } = require('../src/runtime/candidateSkillManager')
  const { createSkillRegistry } = require('../src/runtime/skillRegistry')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-quar-'))
  const skillsDir = path.join(base, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })

  const mgr = createCandidateSkillManager({
    experimentalDir: path.join(base, 'experimental'),
    promotedDir: path.join(base, 'promoted'),
  })

  mgr.registerExperimental('bad_skill', {
    code: 'module.exports.run = async () => { throw new Error("fail") }',
    intent: 'mine diamond ore underground',
    tags: ['mine', 'diamond'],
  })

  // Fail 3 times consecutively
  mgr.recordOutcome('bad_skill', { ok: false })
  mgr.recordOutcome('bad_skill', { ok: false })
  mgr.recordOutcome('bad_skill', { ok: false })

  assert.strictEqual(mgr.getMeta('bad_skill').quarantined, true, 'Skill should be quarantined after 3 consecutive failures')
  assert.strictEqual(mgr.isApproved('bad_skill'), false, 'Quarantined skill must not be approved')

  // Registry should not return it
  const registry = createSkillRegistry({
    skillsDir,
    enabled: true,
    minScore: 0.01,
    candidateSkillMgr: mgr,
  })
  const result = await registry.findReusableSkillWithDiagnostics({ taskGoal: 'mine diamond ore' })
  const found = result?.diagnostics?.topCandidates?.find(
    (c) => c.skillName === 'bad_skill' && c.reason === 'eligible',
  )
  assert.strictEqual(found, undefined, 'Quarantined skill must not be eligible in registry')
}

// ============================================================
// Scenario 7: Perception tier isolation
// ============================================================
// Reflex tier fields must be isolated from decision tier fields.
// The tiered snapshot must have distinct frozen objects per tier.
async function scenario_perceptionTierIsolation() {
  const { buildTieredSnapshot } = require('../src/runtime/contracts/perceptionSnapshot')

  const mockBot = {
    entity: {
      position: makeVec3(10, 64, 10),
      velocity: makeVec3(0, 0, 0),
      isInWater: false,
      isOnFire: false,
      isInLava: false,
      onGround: true,
    },
    health: 18,
    food: 15,
  }

  const tiered = buildTieredSnapshot({
    bot: mockBot,
    status: { health: 18, food: 15, position: mockBot.entity.position, isNight: false },
    inventory: { items: [], slotsUsed: 5 },
    blocks: [],
    entities: [],
    farResources: [],
    threat: 'none',
    closeThreat: false,
    nearestHostileDist: Infinity,
    bands: {},
    resources: [],
    obstacles: [],
  })

  // Reflex tier must exist and be frozen
  assert.ok(tiered.reflex, 'Reflex tier must exist')
  assert.ok(Object.isFrozen(tiered.reflex), 'Reflex tier must be frozen')

  // Execution tier must exist and be frozen
  assert.ok(tiered.execution, 'Execution tier must exist')
  assert.ok(Object.isFrozen(tiered.execution), 'Execution tier must be frozen')

  // Decision tier must exist and be frozen
  assert.ok(tiered.decision, 'Decision tier must exist')
  assert.ok(Object.isFrozen(tiered.decision), 'Decision tier must be frozen')

  // Semantic tier must exist and be frozen
  assert.ok(tiered.semantic, 'Semantic tier must exist')
  assert.ok(Object.isFrozen(tiered.semantic), 'Semantic tier must be frozen')

  // Cross-tier isolation: reflex tier should NOT contain decision-level fields
  assert.strictEqual(tiered.reflex.threatBands, undefined, 'Reflex tier must not contain threatBands')
  assert.strictEqual(tiered.reflex.inventorySummary, undefined, 'Reflex tier must not contain inventorySummary')
  assert.strictEqual(tiered.reflex.opportunityHints, undefined, 'Reflex tier must not contain opportunityHints')

  // Decision tier should NOT contain reflex-only boolean flags that are internal to reflex
  // (though it may have threat-level summaries)
  assert.ok(tiered.decision.threatLevel !== undefined || tiered.decision.threatBands !== undefined,
    'Decision tier should have threat analysis')

  // Tiers must be distinct objects
  assert.notStrictEqual(tiered.reflex, tiered.execution, 'Reflex and execution must be distinct')
  assert.notStrictEqual(tiered.execution, tiered.decision, 'Execution and decision must be distinct')
  assert.notStrictEqual(tiered.decision, tiered.semantic, 'Decision and semantic must be distinct')
}

// ============================================================
// Run all scenarios
// ============================================================
async function run() {
  await scenario_stableExecutionWithoutReplan()
  await scenario_reflexTakeoverDuringExecution()
  await scenario_repeatedFailureReassessment()
  await scenario_skillPreferredOverSynthesis()
  await scenario_candidateSkillPromotion()
  await scenario_candidateSkillQuarantine()
  await scenario_perceptionTierIsolation()
  console.log('scenario behavior tests passed (7/7)')
}

run().catch((err) => {
  console.error('scenario behavior tests FAILED:', err)
  process.exit(1)
})
