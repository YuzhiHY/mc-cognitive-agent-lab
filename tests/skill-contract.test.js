const assert = require('node:assert')
const { validateSkillContract, runSkillWithContract } = require('../src/runtime/contracts/skillContract')
const { getHardcodedSkills } = require('../src/runtime/skills/hardcodedSkills')
const { createChainExecutor } = require('../src/runtime/chainExecutor')

async function testContractValidation() {
  const bad = validateSkillContract({ name: 'x' })
  assert.strictEqual(bad.ok, false)
  const good = validateSkillContract({
    name: 'demo',
    category: 'test',
    description: 'd',
    preconditions: () => ({ ok: true }),
    execute: async () => ({ ok: true, status: 'success', source: 'skill', actionType: 'demo' }),
    canInterrupt: true,
    timeoutMs: 1000,
    tags: [],
    riskLevel: 'low',
  })
  assert.strictEqual(good.ok, true)
}

async function testHardcodedSkillRun() {
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'torch', count: 2, type: 1 }] },
    blockAt: () => ({ name: 'stone' }),
    entities: {},
    setControlState: () => {},
    look: async () => {},
    lookAt: async () => {},
    equip: async () => {},
    placeBlock: async () => {},
    attack: () => {},
  }
  const api = {
    executeAction: async () => ({ ok: true, status: 'success', source: 'api', actionType: 'x' }),
    placeTorchSmart: async () => ({ placed: 1, item: 'torch' }),
    equipByName: async () => {},
    placeBlock: async () => {},
  }
  const repo = getHardcodedSkills({ api, bot })
  const skill = repo.get('place_torch_safely')
  const result = await runSkillWithContract({ skill, api, bot, ctx: {}, args: { count: 1 } })
  assert.strictEqual(result.status, 'success')
}

async function testChainSkillRef() {
  const executor = createChainExecutor()
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0, floored: () => ({}) } },
    inventory: { items: () => [{ name: 'torch', count: 2, type: 1 }] },
    blockAt: () => ({ name: 'stone', position: { x: 0, y: 63, z: 0 }, offset: () => ({}) }),
    entities: {},
    setControlState: () => {},
    look: async () => {},
    lookAt: async () => {},
    equip: async () => {},
    placeBlock: async () => {},
    attack: () => {},
  }
  const api = {
    executeAction: async () => ({ ok: true, status: 'success', source: 'api', actionType: 'x' }),
    placeTorchSmart: async () => ({ placed: 1, item: 'torch' }),
    equipByName: async () => {},
    placeBlock: async () => {},
  }
  const res = await executor.executeStep(
    { type: 'skill_ref', name: 'place_torch_safely', args: { count: 1 } },
    { api, bot, ctx: { snapshot: {} }, state: { confirmedPlaced: {} } }
  )
  assert.strictEqual(res.status, 'success')
}

async function run() {
  await testContractValidation()
  await testHardcodedSkillRun()
  await testChainSkillRef()
  // eslint-disable-next-line no-console
  console.log('skill contract tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

