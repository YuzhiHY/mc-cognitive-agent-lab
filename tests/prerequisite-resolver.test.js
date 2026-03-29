const assert = require('node:assert')
const { resolvePrerequisites, getRequiredToolTier, TOOL_REQUIREMENTS, TOOL_TIER_SATISFIERS } = require('../src/runtime/gameKnowledge')

function testNoToolNeededForDirt() {
  const result = resolvePrerequisites({ target: 'dirt' }, { heldItem: null, inventory: { summary: [] } })
  assert.strictEqual(result.length, 0, 'dirt needs no tool')
}

function testNoToolNeededForOakLog() {
  const result = resolvePrerequisites({ target: 'oak_log' }, { heldItem: null, inventory: { summary: [] } })
  assert.strictEqual(result.length, 0, 'oak_log needs no tool')
}

function testStoneRequiresWoodenPickaxe() {
  assert.strictEqual(getRequiredToolTier('stone'), 'wooden_pickaxe')
  assert.strictEqual(getRequiredToolTier('coal_ore'), 'wooden_pickaxe')
}

function testIronOreRequiresStonePickaxe() {
  assert.strictEqual(getRequiredToolTier('iron_ore'), 'stone_pickaxe')
}

function testDiamondOreRequiresIronPickaxe() {
  assert.strictEqual(getRequiredToolTier('diamond_ore'), 'iron_pickaxe')
}

function testStoneWithPickaxeHeld() {
  const result = resolvePrerequisites(
    { target: 'stone' },
    { heldItem: 'wooden_pickaxe', inventory: { summary: [{ name: 'wooden_pickaxe', count: 1 }] } },
  )
  assert.strictEqual(result.length, 0, 'already holding wooden_pickaxe — no prerequisites')
}

function testStoneWithPickaxeInInventoryNotHeld() {
  const result = resolvePrerequisites(
    { target: 'stone' },
    { heldItem: null, inventory: { summary: [{ name: 'wooden_pickaxe', count: 1 }] } },
  )
  assert.strictEqual(result.length, 1, 'need to equip')
  assert.strictEqual(result[0].step, 'equip')
  assert.strictEqual(result[0].item, 'wooden_pickaxe')
}

function testStoneWithHigherTierPickaxe() {
  const result = resolvePrerequisites(
    { target: 'stone' },
    { heldItem: 'iron_pickaxe', inventory: { summary: [{ name: 'iron_pickaxe', count: 1 }] } },
  )
  assert.strictEqual(result.length, 0, 'iron_pickaxe satisfies wooden_pickaxe tier')
}

function testStoneNoPickaxeNeedsCraft() {
  const result = resolvePrerequisites(
    { target: 'stone' },
    {
      heldItem: null,
      inventory: { summary: [{ name: 'oak_planks', count: 8 }, { name: 'stick', count: 4 }] },
      nearby: { blocks: [] },
    },
  )
  // Should include: craft crafting_table, craft wooden_pickaxe, equip wooden_pickaxe
  assert.ok(result.length >= 2, `expected at least 2 steps, got ${result.length}: ${JSON.stringify(result)}`)
  const steps = result.map((r) => r.step)
  assert.ok(steps.includes('craft'), 'should include craft step')
  assert.ok(steps.includes('equip'), 'should include equip step')
  const equipStep = result.find((r) => r.step === 'equip')
  assert.strictEqual(equipStep.item, 'wooden_pickaxe')
}

function testIronOreWithOnlyWoodenPickaxe() {
  const result = resolvePrerequisites(
    { target: 'iron_ore' },
    { heldItem: 'wooden_pickaxe', inventory: { summary: [{ name: 'wooden_pickaxe', count: 1 }] } },
  )
  // wooden_pickaxe doesn't satisfy stone_pickaxe tier
  assert.ok(result.length >= 1, 'should need upgrade to stone_pickaxe')
}

function testNearestPrefixStripped() {
  const result = resolvePrerequisites(
    { target: 'nearest_stone' },
    { heldItem: 'wooden_pickaxe', inventory: { summary: [{ name: 'wooden_pickaxe', count: 1 }] } },
  )
  assert.strictEqual(result.length, 0, 'nearest_ prefix should be stripped')
}

function testToolTierSatisfiers() {
  // iron_pickaxe should satisfy all tiers
  assert.ok(TOOL_TIER_SATISFIERS.wooden_pickaxe.has('iron_pickaxe'))
  assert.ok(TOOL_TIER_SATISFIERS.stone_pickaxe.has('iron_pickaxe'))
  assert.ok(TOOL_TIER_SATISFIERS.iron_pickaxe.has('iron_pickaxe'))
  // wooden_pickaxe should NOT satisfy stone or iron tier
  assert.ok(!TOOL_TIER_SATISFIERS.stone_pickaxe.has('wooden_pickaxe'))
  assert.ok(!TOOL_TIER_SATISFIERS.iron_pickaxe.has('wooden_pickaxe'))
}

function testEmptyTargetReturnsEmpty() {
  const result = resolvePrerequisites({ target: '' }, {})
  assert.strictEqual(result.length, 0)
  const result2 = resolvePrerequisites({}, {})
  assert.strictEqual(result2.length, 0)
}

// --- Run all ---
async function run() {
  testNoToolNeededForDirt()
  testNoToolNeededForOakLog()
  testStoneRequiresWoodenPickaxe()
  testIronOreRequiresStonePickaxe()
  testDiamondOreRequiresIronPickaxe()
  testStoneWithPickaxeHeld()
  testStoneWithPickaxeInInventoryNotHeld()
  testStoneWithHigherTierPickaxe()
  testStoneNoPickaxeNeedsCraft()
  testIronOreWithOnlyWoodenPickaxe()
  testNearestPrefixStripped()
  testToolTierSatisfiers()
  testEmptyTargetReturnsEmpty()
  // eslint-disable-next-line no-console
  console.log('prerequisite resolver tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
