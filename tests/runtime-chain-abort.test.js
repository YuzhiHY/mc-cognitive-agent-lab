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

async function run() {
  await testAbortStopsFurtherSteps()
  // eslint-disable-next-line no-console
  console.log('runtime chain abort tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
