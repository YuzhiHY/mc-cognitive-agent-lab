const assert = require('node:assert')
const { createSkillRegistry } = require('../src/runtime/skillRegistry')

async function testRegistryListsStableSkills() {
  const registry = createSkillRegistry({ enabled: true })
  const all = await registry.listSkills({ source: 'stable' })
  assert.ok(Array.isArray(all))
  assert.ok(all.length >= 12)
  const names = new Set(all.map((s) => s.name))
  assert.ok(names.has('mine_named_block'))
  assert.ok(names.has('place_torch_safely'))
}

async function testRegistryFindByName() {
  const registry = createSkillRegistry({ enabled: true })
  const hit = await registry.findSkillByName('attack_nearest_hostile')
  assert.ok(hit)
  assert.strictEqual(hit.source, 'stable')
  assert.strictEqual(hit.name, 'attack_nearest_hostile')
}

async function testRegistryFindBestStableSkill() {
  const registry = createSkillRegistry({ enabled: true })
  const pick = registry.findBestStableSkill({
    goal: 'collect wood from nearby tree',
    snapshot: { threat_level: 'none', inventory: { summary: [] } },
  })
  assert.ok(pick)
  assert.strictEqual(pick.source, 'stable')
  assert.strictEqual(pick.name, 'mine_named_block')
}

async function run() {
  await testRegistryListsStableSkills()
  await testRegistryFindByName()
  await testRegistryFindBestStableSkill()
  // eslint-disable-next-line no-console
  console.log('skill registry tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

