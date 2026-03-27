const assert = require('node:assert')
const { createTaskStateMachine } = require('../src/runtime/taskStateMachine')

async function testDirectAssessingTwiceStillSingleTransition() {
  const events = []
  const sm = createTaskStateMachine({
    onTransition: (e) => {
      if (e.ok) events.push(`${e.from}->${e.to}`)
    },
    initialState: 'idle',
  })
  sm.transition('assessing', { reason: 'a' })
  const r2 = sm.transition('assessing', { reason: 'b' })
  assert.strictEqual(r2.ok, false)
  assert.strictEqual(events.length, 1)
}

async function run() {
  await testDirectAssessingTwiceStillSingleTransition()
  // eslint-disable-next-line no-console
  console.log('task state idempotent tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
