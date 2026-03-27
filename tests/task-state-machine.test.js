const assert = require('node:assert')
const { createTaskStateMachine } = require('../src/runtime/taskStateMachine')
const { systemInterrupt, noInterrupt } = require('../src/runtime/contracts/interruptDecision')

async function testNoReplanningWhileExecuting() {
  const sm = createTaskStateMachine()
  sm.transition('assessing', { reason: 'start' })
  sm.transition('planning', { reason: 'plan' })
  sm.transition('executing', { reason: 'run_chain' })
  assert.strictEqual(sm.isExecutionLocked(), true)
  assert.strictEqual(sm.canPlan(), false)
}

async function testReflexTakeoverInterruptsExecution() {
  const sm = createTaskStateMachine()
  sm.transition('assessing', { reason: 'start' })
  sm.transition('planning', { reason: 'plan' })
  sm.transition('executing', { reason: 'run_chain' })
  const shouldInterrupt = sm.shouldInterruptExecution(systemInterrupt({
    source: 'reflex',
    priority: 'high',
    interruptReason: 'reflex_takeover',
  }))
  assert.strictEqual(shouldInterrupt, true)
  sm.transition('interrupted', { reason: 'reflex_takeover' })
  assert.strictEqual(sm.getState().state, 'interrupted')
  assert.strictEqual(sm.isExecutionLocked(), false)
}

async function testFailedGoesToRecoveryOrReassess() {
  const sm = createTaskStateMachine()
  sm.transition('assessing', { reason: 'start' })
  sm.transition('planning', { reason: 'plan' })
  sm.transition('executing', { reason: 'run_chain' })
  sm.transition('failed', { reason: 'exec_failed' })
  assert.strictEqual(sm.getState().state, 'failed')
  assert.strictEqual(sm.isExecutionLocked(), false)
  sm.transition('recovering', { reason: 'recover' })
  assert.strictEqual(sm.getState().state, 'recovering')
  sm.transition('assessing', { reason: 'reassess' })
  assert.strictEqual(sm.getState().state, 'assessing')
}

async function testCompletionUnlocksPlanning() {
  const sm = createTaskStateMachine()
  sm.transition('assessing', { reason: 'start' })
  sm.transition('planning', { reason: 'plan' })
  sm.transition('executing', { reason: 'run_chain' })
  sm.transition('completed', { reason: 'done' })
  assert.strictEqual(sm.isExecutionLocked(), false)
  assert.strictEqual(sm.canPlan(), true)
  sm.transition('cooling_down', { reason: 'cooldown' })
  sm.transition('assessing', { reason: 'next_cycle' })
  assert.strictEqual(sm.getState().state, 'assessing')
}

async function run() {
  await testNoReplanningWhileExecuting()
  await testReflexTakeoverInterruptsExecution()
  await testFailedGoesToRecoveryOrReassess()
  await testCompletionUnlocksPlanning()
  const sm = createTaskStateMachine()
  sm.transition('assessing', { reason: 'x' })
  sm.transition('planning', { reason: 'x' })
  sm.transition('executing', { reason: 'x' })
  assert.strictEqual(sm.shouldInterruptExecution(noInterrupt({ source: 'system' })), false)
  assert.strictEqual(sm.shouldInterruptExecution({
    decision: systemInterrupt({ source: 'damage', priority: 'high', interruptReason: 'x' }),
    currentExecutionMeta: { interruptible: false },
    currentSkillMeta: { canInterrupt: false },
    currentState: 'executing',
  }), false)
  assert.strictEqual(sm.shouldInterruptExecution({
    decision: systemInterrupt({ source: 'world_change', priority: 'medium', interruptReason: 'x' }),
    currentExecutionMeta: { interruptible: true },
    currentSkillMeta: { canInterrupt: true },
    currentState: 'executing',
  }), true)
  assert.strictEqual(sm.shouldInterruptExecution({
    decision: systemInterrupt({ source: 'planner', priority: 'low', interruptReason: 'x' }),
    currentExecutionMeta: { interruptible: true },
    currentSkillMeta: { canInterrupt: true },
    currentState: 'executing',
  }), false)
  // eslint-disable-next-line no-console
  console.log('task state machine tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

