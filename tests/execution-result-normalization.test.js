const assert = require('node:assert')
const {
  successResult,
  failureResult,
  timeoutResult,
  interruptedResult,
  invalidResult,
} = require('../src/runtime/contracts/executionResult')
const { runSkillInSandbox } = require('../src/runtime/sandbox')
const { createApi } = require('../src/runtime/api')

async function testConstructors() {
  const s = successResult({ source: 'api', actionType: 'navigate', reason: 'ok' })
  assert.strictEqual(s.ok, true)
  assert.strictEqual(s.status, 'success')
  assert.strictEqual(s.source, 'api')

  const f = failureResult({ source: 'chain', actionType: 'dig', reason: 'failed', errorMessage: 'x' })
  assert.strictEqual(f.ok, false)
  assert.strictEqual(f.status, 'failure')
  assert.strictEqual(f.errorMessage, 'x')

  const t = timeoutResult({ source: 'sandbox', actionType: 'skill' })
  assert.strictEqual(t.status, 'timeout')

  const i = interruptedResult({ source: 'reflex', actionType: 'flee', interruptReason: 'danger' })
  assert.strictEqual(i.status, 'interrupted')
  assert.strictEqual(i.interruptReason, 'danger')

  const inv = invalidResult({ source: 'chain', actionType: 'craft' })
  assert.strictEqual(inv.status, 'invalid')
}

async function testSandboxNormalization() {
  const okCode = `
module.exports.run = async ({ api, ctx }) => {
  return { done: true, note: 'ok' }
}
`
  const ok = await runSkillInSandbox({ code: okCode, ctx: {}, api: {}, timeoutMs: 1000 })
  assert.strictEqual(ok.ok, true)
  assert.strictEqual(ok.status, 'success')
  assert.strictEqual(ok.source, 'sandbox')
  assert.strictEqual(ok.actionType, 'skill')

  const badCode = `
module.exports.run = async ({ api, ctx }) => {
  throw new Error('boom')
}
`
  const bad = await runSkillInSandbox({ code: badCode, ctx: {}, api: {}, timeoutMs: 1000 })
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(bad.status, 'failure')
  assert.strictEqual(bad.source, 'sandbox')
  assert.ok(bad.error?.message.includes('boom'))
}

async function testApiExecuteActionNormalization() {
  const bot = {
    version: '1.20.1',
    username: 'test',
    health: 20,
    food: 20,
    inventory: { items: () => [] },
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    setControlState: () => {},
    swingArm: () => {},
    activateItem: () => {},
    deactivateItem: () => {},
    lookAt: async () => {},
    equip: async () => {},
    dig: async () => {},
    placeBlock: async () => {},
    findBlock: () => null,
    blockAt: () => null,
    on: () => {},
    off: () => {},
    entities: {},
    pathfinder: { setMovements: () => {}, setGoal: () => {} },
    loadPlugin: () => {},
  }
  const api = createApi(bot)
  const invalid = await api.executeAction('craftAny', {})
  assert.strictEqual(invalid.ok, false)
  assert.strictEqual(invalid.status, 'invalid')
  const unknown = await api.executeAction('no_such_action', {})
  assert.strictEqual(unknown.ok, false)
  assert.strictEqual(unknown.status, 'invalid')
}

async function run() {
  await testConstructors()
  await testSandboxNormalization()
  await testApiExecuteActionNormalization()
  // eslint-disable-next-line no-console
  console.log('execution result normalization tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

