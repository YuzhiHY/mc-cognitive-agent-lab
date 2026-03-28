const assert = require('node:assert')

const { createSharedState } = require('../src/runtime/daemon/sharedState')
const { createTaskStateHelper } = require('../src/runtime/daemon/taskStateHelper')
const { evaluateInterruptGate } = require('../src/runtime/daemon/interruptGate')
const { evaluateReflexGate } = require('../src/runtime/daemon/reflexGate')
const { evaluatePlannerGate } = require('../src/runtime/daemon/plannerGate')
const { createInterruptExecutor } = require('../src/runtime/daemon/interruptExecutor')
const { createVoiceController } = require('../src/runtime/daemon/voiceController')
const { createTaskStateMachine } = require('../src/runtime/taskStateMachine')
const { systemInterrupt, noInterrupt } = require('../src/runtime/contracts/interruptDecision')

function makeLogger() {
  const entries = []
  return { log: async (e) => entries.push(e), entries, close: async () => {} }
}

function makeBot() {
  return {
    username: 'test-bot',
    health: 20,
    entity: { position: { x: 0, y: 64, z: 0, clone: () => ({ x: 0, y: 64, z: 0 }) } },
    pathfinder: { goal: null, setGoal: () => {} },
    chat: () => {},
    on: () => {},
    off: () => {},
  }
}

// --- sharedState ---

function testSharedStateDefaults() {
  const s = createSharedState()
  assert.strictEqual(s.cycleCount, 0)
  assert.strictEqual(s.reflexTakeoverInFlight, false)
  assert.strictEqual(s.currentChainRunControl, null)
  assert.ok(Array.isArray(s.stateTransitionTrace))
  assert.ok(Array.isArray(s.playerMessageQueue))
}

// --- taskStateHelper ---

async function testTaskStateHelper() {
  const taskSm = createTaskStateMachine()
  const logger = makeLogger()
  const shared = createSharedState()
  const { setTaskState } = createTaskStateHelper({ taskSm, logger, shared })

  await setTaskState('assessing', { reason: 'test', cycle: 1 })
  assert.strictEqual(taskSm.getState().state, 'assessing')
  assert.ok(shared.stateTransitionTrace.length > 0)
  assert.strictEqual(shared.stateTransitionTrace[0].to, 'assessing')
  assert.ok(shared.activeTask !== null)
}

async function testTaskStateHelperSkipsDuplicate() {
  const taskSm = createTaskStateMachine()
  const logger = makeLogger()
  const shared = createSharedState()
  const { setTaskState } = createTaskStateHelper({ taskSm, logger, shared })

  await setTaskState('assessing', { reason: 'first' })
  const traceBefore = shared.stateTransitionTrace.length
  await setTaskState('assessing', { reason: 'duplicate' })
  assert.strictEqual(shared.stateTransitionTrace.length, traceBefore)
}

// --- interruptGate ---

function testInterruptGateNoInterrupt() {
  const taskSm = createTaskStateMachine()
  const shared = createSharedState()
  const result = evaluateInterruptGate({
    snapshot: { threat_level: 'none', status: { health: 20 } },
    cycleCount: 1,
    queuedDecision: null,
    worldChangeDecision: noInterrupt({ source: 'world_change', reason: 'no_change' }),
    taskSm,
    shared,
  })
  assert.strictEqual(result.topDecision.shouldInterrupt, false)
  assert.strictEqual(result.holdExecution, false)
}

function testInterruptGateDangerWindow() {
  const taskSm = createTaskStateMachine()
  const shared = createSharedState()
  const result = evaluateInterruptGate({
    snapshot: { close_threat: true, status: { health: 10, recentDamageMs: 500 } },
    cycleCount: 1,
    queuedDecision: null,
    worldChangeDecision: noInterrupt({ source: 'world_change', reason: 'no_change' }),
    taskSm,
    shared,
  })
  assert.strictEqual(result.topDecision.shouldInterrupt, true)
  assert.strictEqual(result.topDecision.priority, 'high')
}

function testInterruptGateQueuePriority() {
  const taskSm = createTaskStateMachine()
  const shared = createSharedState()
  const queued = systemInterrupt({
    source: 'damage', priority: 'high',
    interruptReason: 'damage_event',
  })
  const worldChange = systemInterrupt({
    source: 'world_change', priority: 'medium',
    interruptReason: 'world_change',
  })
  const result = evaluateInterruptGate({
    snapshot: { threat_level: 'none', status: { health: 20 } },
    cycleCount: 1,
    queuedDecision: queued,
    worldChangeDecision: worldChange,
    taskSm,
    shared,
  })
  assert.strictEqual(result.topDecision.source, 'damage')
}

// --- reflexGate ---

function testReflexGateNoReflex() {
  const taskSm = createTaskStateMachine()
  const shared = createSharedState()
  const result = evaluateReflexGate({
    reflexLayer: { arbitrate: () => ({ decision: { shouldInterrupt: false }, matchedRule: null }) },
    snapshot: {},
    ctx: {},
    taskSm,
    shared,
  })
  assert.strictEqual(result, null)
}

function testReflexGateTriggered() {
  const taskSm = createTaskStateMachine()
  const shared = createSharedState()
  const reflexAction = { name: 'flee_burst', reason: 'danger' }
  const result = evaluateReflexGate({
    reflexLayer: {
      arbitrate: () => ({
        decision: { shouldInterrupt: true, priority: 'high', interruptReason: 'danger', metadata: {} },
        matchedRule: reflexAction,
      }),
    },
    snapshot: {},
    ctx: {},
    taskSm,
    shared,
  })
  assert.ok(result !== null)
  assert.strictEqual(result.interrupt.shouldInterrupt, true)
  assert.strictEqual(result.reflexAction.name, 'flee_burst')
  assert.strictEqual(result.holdExecution, false)
}

function testReflexGateLegacyCheck() {
  const taskSm = createTaskStateMachine()
  const shared = createSharedState()
  const reflexAction = { name: 'flee', reason: 'test' }
  const result = evaluateReflexGate({
    reflexLayer: { check: () => reflexAction },
    snapshot: {},
    ctx: {},
    taskSm,
    shared,
  })
  assert.ok(result !== null)
  assert.strictEqual(result.interrupt.priority, 'high')
  assert.strictEqual(result.reflexAction.name, 'flee')
}

// --- plannerGate ---

function testPlannerGateAllowed() {
  const taskSm = createTaskStateMachine()
  taskSm.transition('assessing', {})
  const result = evaluatePlannerGate({ taskSm, reflexLayer: null, snapshot: {}, cycleCount: 1 })
  assert.strictEqual(result.allowed, true)
}

function testPlannerGateLockedExecution() {
  const taskSm = createTaskStateMachine()
  taskSm.transition('assessing', {})
  taskSm.transition('planning', {})
  taskSm.transition('executing', {})
  taskSm.setExecutionLock(true, 'test')
  const result = evaluatePlannerGate({ taskSm, reflexLayer: null, snapshot: {}, cycleCount: 1 })
  assert.strictEqual(result.allowed, false)
}

function testPlannerGateCombatHold() {
  const taskSm = createTaskStateMachine()
  taskSm.transition('assessing', {})
  const result = evaluatePlannerGate({
    taskSm,
    reflexLayer: { isCombatMode: () => true },
    snapshot: { threat_level: 'high' },
    cycleCount: 1,
  })
  assert.strictEqual(result.allowed, false)
  assert.strictEqual(result.combatHold, true)
}

// --- interruptExecutor ---

async function testInterruptExecutorSuppressNoInterrupt() {
  const taskSm = createTaskStateMachine()
  const logger = makeLogger()
  const shared = createSharedState()
  const { setTaskState } = createTaskStateHelper({ taskSm, logger, shared })
  const executor = createInterruptExecutor({
    reflexLayer: {}, taskSm, api: {}, bot: makeBot(), logger, shared, setTaskState,
  })
  const result = await executor.executeTakeover({
    source: 'test',
    interrupt: { shouldInterrupt: false },
    reflexAction: null,
    snapshot: {},
    ctx: {},
  })
  assert.strictEqual(result, null)
}

async function testInterruptExecutorCooldown() {
  const taskSm = createTaskStateMachine()
  const logger = makeLogger()
  const shared = createSharedState()
  const { setTaskState } = createTaskStateHelper({ taskSm, logger, shared })
  const reflexAction = { name: 'flee_burst', reason: 'danger', execute: async () => ({}) }
  const reflexLayer = { execute: async () => ({ ok: true, status: 'success' }) }
  const bot = makeBot()
  const executor = createInterruptExecutor({
    reflexLayer, taskSm, api: {}, bot, logger, shared, setTaskState,
  })

  const interrupt = { shouldInterrupt: true, priority: 'high', interruptReason: 'test', metadata: {} }
  // First call succeeds
  const r1 = await executor.executeTakeover({ source: 'test', interrupt, reflexAction, snapshot: {}, ctx: {} })
  assert.ok(r1 !== null)
  // Second call within cooldown is suppressed
  const r2 = await executor.executeTakeover({ source: 'test', interrupt, reflexAction, snapshot: {}, ctx: {} })
  assert.strictEqual(r2, null)
  assert.ok(logger.entries.some((e) => e.reason === 'reflex_cooldown'))
}

// --- voiceController ---

function testVoiceControllerSuppressDuplicate() {
  const spoken = []
  const bot = { ...makeBot(), chat: (t) => spoken.push(t) }
  const personality = { isEnabled: () => true, getState: () => ({ voice: 'hello' }) }
  const shared = createSharedState()
  const vc = createVoiceController({ bot, personality, logger: makeLogger(), shared })

  const snap = { threat_level: 'none' }
  assert.strictEqual(vc.trySpeakVoice('hello', snap), true)
  assert.strictEqual(vc.trySpeakVoice('hello', snap), false) // dedup
  assert.strictEqual(spoken.length, 1)
}

// --- run all ---

async function run() {
  testSharedStateDefaults()
  await testTaskStateHelper()
  await testTaskStateHelperSkipsDuplicate()
  testInterruptGateNoInterrupt()
  testInterruptGateDangerWindow()
  testInterruptGateQueuePriority()
  testReflexGateNoReflex()
  testReflexGateTriggered()
  testReflexGateLegacyCheck()
  testPlannerGateAllowed()
  testPlannerGateLockedExecution()
  testPlannerGateCombatHold()
  await testInterruptExecutorSuppressNoInterrupt()
  await testInterruptExecutorCooldown()
  testVoiceControllerSuppressDuplicate()
  console.log('daemon orchestration tests passed')
}

run().catch((err) => { console.error(err); process.exit(1) })
