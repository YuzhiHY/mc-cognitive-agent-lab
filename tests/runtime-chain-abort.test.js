const assert = require('node:assert')
const { createChainExecutor } = require('../src/runtime/chainExecutor')
const { createChainRunControl } = require('../src/runtime/chainRunControl')

async function testAbortStopsFurtherSteps() {
  const logs = []
  const logger = {
    async log(e) {
      logs.push(e)
    },
  }
  const api = {
    sleep: async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
    },
  }
  const bot = {}
  const exec = createChainExecutor()
  const rc = createChainRunControl()
  const p = exec.run({
    chain: [
      { type: 'wait', timeoutMs: 200 },
      { type: 'wait', timeoutMs: 200 },
      { type: 'wait', timeoutMs: 200 },
    ],
    api,
    bot,
    ctx: {},
    logger,
    cycle: 9,
    runControl: rc,
  })
  setTimeout(() => rc.abort('test_takeover'), 40)
  const out = await p
  assert.strictEqual(out.interrupted, true)
  assert.ok(logs.some((l) => l.type === 'chain_aborted'), 'expected chain_aborted log')
  const starts = logs.filter((l) => l.type === 'chain_step_start')
  assert.ok(starts.length < 3, 'should not start all steps')
  assert.ok(out.results.some((r) => r.type === 'external_abort' || String(r.reason || '').includes('abort')))
}

async function testAbortAwareWaitResolvesFast() {
  const exec = createChainExecutor()
  const rc = createChainRunControl()
  const start = Date.now()
  const p = exec.run({
    chain: [{ type: 'wait', timeoutMs: 10000 }],
    api: {},
    bot: {},
    ctx: {},
    logger: { async log() {} },
    cycle: 10,
    runControl: rc,
  })
  setTimeout(() => rc.abort('fast_abort'), 50)
  const out = await p
  const elapsed = Date.now() - start
  assert.ok(elapsed < 2000, `wait should resolve fast on abort, took ${elapsed}ms`)
  assert.strictEqual(out.interrupted, true)
}

async function testAbortSignalThreadedToNavigateStep() {
  const exec = createChainExecutor()
  const rc = createChainRunControl()
  // Pre-abort before running
  rc.abort('pre_aborted')
  const out = await exec.run({
    chain: [{ type: 'navigate', position: { x: 100, y: 64, z: 100 } }],
    api: { navigateTo: async () => { throw new Error('should not be called') } },
    bot: {},
    ctx: {},
    logger: { async log() {} },
    cycle: 11,
    runControl: rc,
  })
  assert.strictEqual(out.interrupted, true)
  assert.strictEqual(out.completed, 0)
}

async function run() {
  await testAbortStopsFurtherSteps()
  await testAbortAwareWaitResolvesFast()
  await testAbortSignalThreadedToNavigateStep()
  // eslint-disable-next-line no-console
  console.log('runtime chain abort tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
