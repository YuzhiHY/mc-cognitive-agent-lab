const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { parseJsonLoose } = require('../src/runtime/llm/json')
const { withTimeout } = require('../src/runtime/sandbox')
const { createMemory } = require('../src/runtime/memory')

async function testJsonLoose() {
  const raw = 'noise... {"a":1,"b":{"ok":true}} trailing'
  const parsed = parseJsonLoose(raw)
  assert.equal(parsed.a, 1)
  assert.equal(parsed.b.ok, true)
}

async function testTimeoutCleanupHook() {
  let cleaned = false
  const slow = new Promise((resolve) => setTimeout(resolve, 200))
  try {
    await withTimeout(slow, 40, async () => { cleaned = true })
    assert.fail('expected timeout')
  } catch (err) {
    assert.equal(err.code, 'HARD_TIMEOUT')
  }
  assert.equal(cleaned, true)
}

async function testMemoryExpectationBound() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-'))
  process.env.MEMORY_EXPECTATION_KEEP = '30'
  const mem = createMemory({ memoryDir: dir })
  for (let i = 1; i <= 80; i++) {
    mem.set(`knowledge:expectation:last:${i}`, { i })
  }
  const all = mem.getAll()
  const keys = Object.keys(all.knowledge).filter((k) => k.startsWith('knowledge:expectation:last:'))
  assert.ok(keys.length <= 30, `expected <=30, got ${keys.length}`)
}

async function run() {
  await testJsonLoose()
  await testTimeoutCleanupHook()
  await testMemoryExpectationBound()
  // eslint-disable-next-line no-console
  console.log('hardening tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

