const assert = require('node:assert')
const {
  noInterrupt,
  interruptDecision,
  reflexInterrupt,
  systemInterrupt,
} = require('../src/runtime/contracts/interruptDecision')
const { createTaskStateMachine } = require('../src/runtime/taskStateMachine')

async function testConstructors() {
  const n = noInterrupt({ source: 'system', reason: 'none' })
  assert.strictEqual(n.shouldInterrupt, false)
  assert.strictEqual(n.priority, 'low')

  const i = interruptDecision({
    source: 'world_change',
    priority: 'medium',
    interruptReason: 'world_shift',
  })
  assert.strictEqual(i.shouldInterrupt, true)
  assert.strictEqual(i.source, 'world_change')
  assert.strictEqual(i.priority, 'medium')

  const r = reflexInterrupt({ priority: 'high', interruptReason: 'lava' })
  assert.strictEqual(r.source, 'reflex')
  assert.strictEqual(r.shouldInterrupt, true)

  const s = systemInterrupt({ source: 'damage', priority: 'high', interruptReason: 'hit' })
  assert.strictEqual(s.source, 'damage')
}

async function testTaskSmArbitrationWithContract() {
  const sm = createTaskStateMachine()
  sm.transition('assessing', { reason: 'start' })
  sm.transition('planning', { reason: 'plan' })
  sm.transition('executing', { reason: 'run' })

  const no = noInterrupt({ source: 'system', reason: 'none' })
  assert.strictEqual(sm.shouldInterruptExecution(no), false)

  const high = systemInterrupt({ source: 'damage', priority: 'high', interruptReason: 'damage_burst' })
  assert.strictEqual(sm.shouldInterruptExecution(high), true)
}

async function run() {
  await testConstructors()
  await testTaskSmArbitrationWithContract()
  // eslint-disable-next-line no-console
  console.log('interrupt contract tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

