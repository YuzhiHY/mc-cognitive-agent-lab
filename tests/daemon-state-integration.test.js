const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createDaemon } = require('../src/runtime/daemon')
const { systemInterrupt } = require('../src/runtime/contracts/interruptDecision')

function makeVec3(x = 0, y = 64, z = 0) {
  return {
    x, y, z,
    clone() { return makeVec3(this.x, this.y, this.z) },
    offset(dx, dy, dz) { return makeVec3(this.x + dx, this.y + dy, this.z + dz) },
    floored() { return makeVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) },
    distanceTo(v) {
      const dx = this.x - v.x
      const dy = this.y - v.y
      const dz = this.z - v.z
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    },
  }
}

function makeBot() {
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
      yaw: 0,
      pitch: 0,
      onGround: true,
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

async function testNoReplanWhileExecuting() {
  process.env.LOG_TO_FILE = 'false'
  let thinkCalls = 0
  let release = null
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => {
        thinkCalls += 1
        return { thought: 'x', actionChain: [{ type: 'wait', timeoutMs: 1 }], memoryUpdates: [] }
      },
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async () => new Promise((resolve) => { release = resolve }),
    },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })

  const p1 = daemon.runSingleCycleForTest()
  await new Promise((r) => setTimeout(r, 10))
  const p2 = daemon.runSingleCycleForTest()
  const second = await p2
  assert.strictEqual(second.type, 'executing_hold')
  assert.strictEqual(thinkCalls, 1)
  release({ completed: 1, total: 1, interrupted: false, failedStep: null, results: [{ status: 'success', ok: true }] })
  await p1
}

async function testReflexInterruptStateTransitions() {
  process.env.LOG_TO_FILE = 'false'
  let thinkCalls = 0
  const bot = makeBot()
  const reflexAction = { name: 'flee_burst', reason: 'danger', execute: async () => {} }
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => { thinkCalls += 1; return { actionChain: [] } },
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: { run: async () => ({ completed: 0, total: 0, interrupted: false, failedStep: null, results: [] }) },
    reflexLayer: {
      check: () => reflexAction,
      execute: async () => ({ ok: true, status: 'success', actionType: 'flee_burst' }),
      isCombatMode: () => false,
    },
  })
  const out = await daemon.runSingleCycleForTest()
  assert.strictEqual(out.type, 'reflex')
  assert.strictEqual(thinkCalls, 0)
  const trace = daemon.getStateTransitionTrace()
  assert.ok(trace.some((t) => t.to === 'interrupted'))
  assert.ok(trace.some((t) => t.to === 'recovering'))
}

async function testCompletionReallowsPlanning() {
  process.env.LOG_TO_FILE = 'false'
  let thinkCalls = 0
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => {
        thinkCalls += 1
        return { thought: 'ok', actionChain: [{ type: 'wait', timeoutMs: 1 }], memoryUpdates: [] }
      },
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async () => ({ completed: 1, total: 1, interrupted: false, failedStep: null, results: [{ status: 'success', ok: true }] }),
    },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })
  await daemon.runSingleCycleForTest()
  await daemon.runSingleCycleForTest()
  assert.ok(thinkCalls >= 2)
}

async function testFailureStaysFailedForPlannerReassessment() {
  // Per CLAUDE.md: failure does NOT auto-transition to 'recovering'.
  // The planner reassesses in the next cycle.
  process.env.LOG_TO_FILE = 'false'
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => ({ thought: 'x', actionChain: [{ type: 'wait', timeoutMs: 1 }], memoryUpdates: [] }),
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async () => ({ completed: 0, total: 1, interrupted: false, failedStep: { error: { message: 'boom' } }, results: [{ status: 'failure', ok: false }] }),
    },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })
  await daemon.runSingleCycleForTest()
  const trace1 = daemon.getStateTransitionTrace()
  assert.ok(trace1.some((t) => t.to === 'failed'), 'chain failure sets state to failed')
  // No auto-recovering — planner handles it in the next cycle
  await daemon.runSingleCycleForTest()
  const trace2 = daemon.getStateTransitionTrace()
  assert.ok(trace2.some((t) => t.to === 'assessing'), 'next cycle re-enters planning')
}

async function testTransitionTraceHasStructuredFields() {
  process.env.LOG_TO_FILE = 'false'
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => ({ thought: 'x', actionChain: [], memoryUpdates: [] }),
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: { run: async () => ({ completed: 0, total: 0, interrupted: false, failedStep: null, results: [] }) },
    reflexLayer: { check: () => null, isCombatMode: () => false },
  })
  await daemon.runSingleCycleForTest()
  const trace = daemon.getStateTransitionTrace()
  assert.ok(trace.length > 0)
  const t = trace[0]
  assert.ok(Object.prototype.hasOwnProperty.call(t, 'from'))
  assert.ok(Object.prototype.hasOwnProperty.call(t, 'to'))
  assert.ok(Object.prototype.hasOwnProperty.call(t, 'reason'))
  assert.ok(Object.prototype.hasOwnProperty.call(t, 'executionLock'))
  assert.ok(Object.prototype.hasOwnProperty.call(t, 'cycle'))
}

async function testDamageInterruptUsesNormalizedPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-dmg-'))
  process.env.LOG_TO_FILE = 'true'
  process.env.LOG_DIR = dir
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => ({ thought: 'x', actionChain: [], memoryUpdates: [] }),
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: { run: async () => ({ completed: 0, total: 0, interrupted: false, failedStep: null, results: [] }) },
    reflexLayer: {
      arbitrate: () => ({ decision: { shouldInterrupt: false, source: 'reflex', priority: 'low', interruptReason: 'none' }, matchedRule: null }),
      check: () => ({ name: 'flee_burst', reason: 'danger', execute: async () => {} }),
      execute: async () => ({ ok: true, status: 'success', actionType: 'flee_burst' }),
      isCombatMode: () => false,
    },
  })
  daemon.enqueueInterruptForTest(systemInterrupt({
    source: 'damage',
    priority: 'high',
    interruptReason: 'damage_test_interrupt',
  }))
  await daemon.runSingleCycleForTest()
  const logFile = path.join(dir, 'agent_daemon.jsonl')
  const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  assert.ok(raw.includes('"type":"interrupt_decision"'))
  assert.ok(raw.includes('"source":"damage"'))
  assert.ok(raw.includes('damage_test_interrupt'))
}

async function testInterruptLogsIncludePolicyReason() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-'))
  process.env.LOG_TO_FILE = 'true'
  process.env.LOG_DIR = dir
  const bot = makeBot()
  const daemon = createDaemon({
    bot,
    memory: makeMemory(),
    centralReasoning: {
      think: async () => ({ thought: 'x', actionChain: [{ type: 'wait', timeoutMs: 5000 }], memoryUpdates: [] }),
      setLastChainResult: () => {},
      evaluateLearnProgress: async () => {},
    },
    chainExecutor: {
      run: async () => new Promise(() => {}), // keep lock path
    },
    reflexLayer: { check: () => null, isCombatMode: () => false, arbitrate: () => ({ decision: { shouldInterrupt: false, source: 'reflex', priority: 'low', interruptReason: 'none' }, matchedRule: null }) },
  })
  const first = daemon.runSingleCycleForTest()
  await new Promise((r) => setTimeout(r, 10))
  await daemon.runSingleCycleForTest()
  daemon.stop()
  const logFile = path.join(dir, 'agent_daemon.jsonl')
  const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  assert.ok(raw.includes('policyReason'))
  first.catch(() => {})
}

async function run() {
  await testNoReplanWhileExecuting()
  await testReflexInterruptStateTransitions()
  await testCompletionReallowsPlanning()
  await testFailureStaysFailedForPlannerReassessment()
  await testTransitionTraceHasStructuredFields()
  await testDamageInterruptUsesNormalizedPath()
  await testInterruptLogsIncludePolicyReason()
  // eslint-disable-next-line no-console
  console.log('daemon state integration tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

