const assert = require('node:assert')
const { canSynthesize, filterSynthesisSteps } = require('../src/runtime/synthesisPolicy')

function testNoSynthesisRequested() {
  const result = canSynthesize({
    plannerMeta: { requiresSynthesis: false },
    snapshot: {},
    stableSkills: new Map(),
  })
  assert.strictEqual(result.allowed, false)
  assert.strictEqual(result.reason, 'no_synthesis_requested')
}

function testSynthesisAllowed() {
  const result = canSynthesize({
    plannerMeta: { requiresSynthesis: true, goal: 'build a bridge', thought: 'bridge needed' },
    snapshot: { threat_level: 'none' },
    stableSkills: new Map(),
  })
  assert.strictEqual(result.allowed, true)
}

function testSynthesisBlockedByThreat() {
  const result = canSynthesize({
    plannerMeta: { requiresSynthesis: true, goal: 'build', thought: 'build' },
    snapshot: { threat_level: 'high' },
    stableSkills: new Map(),
  })
  assert.strictEqual(result.allowed, false)
  assert.ok(result.reason.includes('high_threat'))
}

function testSynthesisBlockedByStableSkill() {
  const skills = new Map([['mine_named_block', { name: 'mine_named_block' }]])
  const result = canSynthesize({
    plannerMeta: { requiresSynthesis: true, goal: 'mine named block for iron', thought: 'mining' },
    snapshot: { threat_level: 'none' },
    stableSkills: skills,
  })
  assert.strictEqual(result.allowed, false)
  assert.ok(result.reason.includes('stable_skill_available'))
}

function testFilterSynthesisSteps() {
  const chain = [
    { type: 'skill_ref', name: 'approach_target', args: {} },
    { type: 'skill', skillName: 'custom_thing', code: '...' },
    { type: 'navigate', target: 'nearest_stone' },
  ]
  const filtered = filterSynthesisSteps(chain, false)
  assert.strictEqual(filtered[0].type, 'skill_ref')
  assert.strictEqual(filtered[0].name, 'approach_target')
  assert.strictEqual(filtered[1].type, 'skill_ref')
  assert.strictEqual(filtered[1].name, 'recover_from_stuck')
  assert.strictEqual(filtered[2].type, 'navigate')
}

function testFilterSynthesisAllowed() {
  const chain = [{ type: 'skill', skillName: 'custom', code: '...' }]
  const filtered = filterSynthesisSteps(chain, true)
  assert.strictEqual(filtered[0].type, 'skill')
}

testNoSynthesisRequested()
testSynthesisAllowed()
testSynthesisBlockedByThreat()
testSynthesisBlockedByStableSkill()
testFilterSynthesisSteps()
testFilterSynthesisAllowed()
console.log('synthesis policy tests passed')
