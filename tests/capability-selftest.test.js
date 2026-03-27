const assert = require('node:assert')
const { createApi } = require('../src/runtime/api')
const { createChainExecutor } = require('../src/runtime/chainExecutor')

class Vec {
  constructor(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
  }

  offset(dx, dy, dz) {
    return new Vec(this.x + dx, this.y + dy, this.z + dz)
  }

  floored() {
    return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))
  }

  distanceTo(other) {
    const dx = this.x - other.x
    const dy = this.y - other.y
    const dz = this.z - other.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
}

function buildSmeltBotMock() {
  const inv = [
    { name: 'raw_iron', count: 3, type: 1001 },
    { name: 'coal', count: 2, type: 1002 },
  ]
  const furnaceOutput = { name: 'iron_ingot', count: 3 }
  const furnace = {
    putInput: async () => {},
    putFuel: async () => {},
    outputItem: () => furnaceOutput,
    takeOutput: async () => {},
    close: () => {},
  }

  const bot = {
    version: '1.20.1',
    username: 'selftest',
    health: 20,
    food: 20,
    inventory: { items: () => inv },
    entity: { id: 1, position: new Vec(0, 64, 0) },
    time: { isDay: false },
    pathfinder: { setMovements: () => {}, setGoal: () => {} },
    loadPlugin: () => {},
    findBlock: ({ matching }) => (matching ? { name: 'furnace', position: new Vec(1, 63, 0) } : null),
    openFurnace: async () => furnace,
    blockAt: () => ({ name: 'stone', position: new Vec(0, 63, 0) }),
    equip: async () => {},
    placeBlock: async () => {},
    dig: async () => {},
    on: () => {},
    off: () => {},
    setControlState: () => {},
    lookAt: async () => {},
    swingArm: () => {},
    activateItem: () => {},
    deactivateItem: () => {},
    attack: () => {},
    recipesFor: () => [{ requiresTable: false }],
    craft: async () => {},
    entities: {},
  }

  return bot
}

async function testSmeltMapping() {
  const bot = buildSmeltBotMock()
  const api = createApi(bot)
  const result = await api.smeltItem('iron_ingot', { count: 2 })
  assert.strictEqual(result.smeltedInput, 'raw_iron')
  assert.strictEqual(result.output, 'iron_ingot')
  assert.ok(result.outputCount >= 1)
}

async function testTorchPlacement() {
  let placed = 0
  const inv = [{ name: 'torch', count: 8, type: 2001 }]
  const origin = new Vec(0, 64, 0)

  const bot = {
    version: '1.20.1',
    username: 'selftest',
    health: 20,
    food: 20,
    inventory: { items: () => inv },
    entity: { id: 1, position: origin },
    time: { isDay: false },
    pathfinder: { setMovements: () => {}, setGoal: () => {} },
    loadPlugin: () => {},
    blockAt: (p) => {
      if (p.y <= 63) return { name: 'stone', position: p }
      return { name: 'air', position: p }
    },
    equip: async () => {},
    placeBlock: async () => { placed += 1 },
    findBlock: () => null,
    openFurnace: async () => { throw new Error('unused') },
    dig: async () => {},
    on: () => {},
    off: () => {},
    setControlState: () => {},
    lookAt: async () => {},
    swingArm: () => {},
    activateItem: () => {},
    deactivateItem: () => {},
    attack: () => {},
    recipesFor: () => [{ requiresTable: false }],
    craft: async () => {},
    entities: {},
  }

  const api = createApi(bot)
  const result = await api.placeTorchSmart({ count: 2, force: true })
  assert.strictEqual(result.item, 'torch')
  assert.ok(placed >= 1)
}

async function testChainExecutorNewActions() {
  const executor = createChainExecutor()
  const bot = {
    inventory: { items: () => [{ name: 'wooden_pickaxe' }] },
    entity: { position: new Vec(0, 64, 0), id: 1 },
    blockAt: () => ({ name: 'stone', position: new Vec(0, 63, 0) }),
    time: { isDay: false },
    entities: {},
    on: () => {},
    off: () => {},
    setControlState: () => {},
    equip: async () => {},
    placeBlock: async () => {},
    attack: () => {},
    lookAt: async () => {},
    dig: async () => {},
  }
  const api = {
    smeltItem: async () => ({ output: 'iron_ingot', outputCount: 1 }),
    placeTorchSmart: async () => ({ placed: 1 }),
    smartCraft: async () => ({ crafted: 'torch', count: 4 }),
    craft: async () => ({ crafted: 'torch', count: 4 }),
    navigateTo: async () => ({ arrived: true }),
    clearControlStates: () => {},
    placeBlock: async () => {},
    attackNearest: async () => ({ attacked: 'zombie', id: 9 }),
    collectNearbyDrops: async () => ({ collected: 0 }),
  }
  const ctx = { snapshot: { threat_level: 'none', nearby: { blocks: [], entities: [] } } }

  const smeltRes = await executor.executeStep(
    { type: 'smelt', item: 'iron_ingot', count: 1 },
    { api, bot, ctx, state: { confirmedPlaced: {} } }
  )
  assert.strictEqual(smeltRes.ok, true)
  assert.strictEqual(smeltRes.status, 'success')

  const torchRes = await executor.executeStep(
    { type: 'torch', item: 'torch', count: 1, force: true },
    { api, bot, ctx, state: { confirmedPlaced: {} } }
  )
  assert.strictEqual(torchRes.ok, true)
  assert.strictEqual(torchRes.status, 'success')

  const craftRes = await executor.executeStep(
    { type: 'craft', item: 'torch', count: 4 },
    { api, bot, ctx, state: { confirmedPlaced: {} } }
  )
  assert.strictEqual(craftRes.ok, true)
  assert.strictEqual(craftRes.status, 'success')
}

async function run() {
  await testSmeltMapping()
  await testTorchPlacement()
  await testChainExecutorNewActions()
  console.log('capability selftest passed')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})

