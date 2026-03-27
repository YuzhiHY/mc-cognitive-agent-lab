const assert = require('node:assert')
const { chooseHardcodedSkill } = require('../src/runtime/planning/skillSelector')
const { createCentralReasoning } = require('../src/runtime/centralReasoning')

function makeLlmReturningEmptyChain() {
  return {
    plan: async ({ _systemPromptOverride }) => {
      const prompt = String(_systemPromptOverride || '')
      if (prompt.includes('中枢分析模块')) {
        return {
          situationAnalysis: 'near trees',
          personalityBrief: '',
          selfGoal: 'collect wood',
          severity: 'normal',
          rankedGoals: [],
          longTermLearnProposals: [],
          memoryUpdates: [],
        }
      }
      if (prompt.includes('中枢决策模块')) {
        return {
          thought: 'prefer stable',
          actionChain: [],
          memoryUpdates: [],
          nextGoalHint: 'wood',
        }
      }
      return {}
    },
  }
}

async function testSelector() {
  const selected = chooseHardcodedSkill({ goal: 'collect wood from tree', snapshot: { threat_level: 'none' } })
  assert.ok(selected)
  assert.strictEqual(selected.name, 'mine_named_block')
}

async function testSelectorCombatPriority() {
  const selected = chooseHardcodedSkill({
    goal: 'continue current task',
    snapshot: {
      threat_level: 'high',
      close_threat: true,
      status: { health: 16, recentDamageMs: 400 },
      inventory: { summary: [] },
    },
  })
  assert.ok(selected)
  assert.strictEqual(selected.name, 'attack_nearest_hostile')
}

async function testSelectorEatWhenLowHealth() {
  const selected = chooseHardcodedSkill({
    goal: 'stay alive first',
    snapshot: {
      threat_level: 'none',
      status: { health: 7, food: 8 },
      inventory: { summary: [{ name: 'bread', count: 1 }] },
    },
  })
  assert.ok(selected)
  assert.strictEqual(selected.name, 'eat_best_food')
}

async function testSelectorTorchAtNight() {
  const selected = chooseHardcodedSkill({
    goal: 'light up area',
    snapshot: {
      threat_level: 'none',
      isNight: true,
      status: { health: 20, food: 20 },
      inventory: { summary: [{ name: 'torch', count: 4 }] },
    },
  })
  assert.ok(selected)
  assert.strictEqual(selected.name, 'place_torch_safely')
}

async function testCentralReasoningSkillRefFallback() {
  const llm = makeLlmReturningEmptyChain()
  const central = createCentralReasoning({ llm, personalityLlm: null })
  const decision = await central.think({
    ctx: {
      snapshot: {
        status: { health: 20, recentDamageMs: null },
        threat_level: 'none',
        close_threat: false,
        nearby: { blocks: [], entities: [] },
        inventory: { summary: [] },
      },
      playerMessages: [],
    },
    bot: null,
    memory: { getAll: () => ({}), get: () => null, set: async () => {}, delete: async () => {} },
    personality: { isEnabled: () => false },
    logger: null,
    cycle: 1,
  })
  assert.ok(Array.isArray(decision.actionChain))
  assert.strictEqual(decision.actionChain[0].type, 'skill_ref')
}

async function run() {
  await testSelector()
  await testSelectorCombatPriority()
  await testSelectorEatWhenLowHealth()
  await testSelectorTorchAtNight()
  await testCentralReasoningSkillRefFallback()
  // eslint-disable-next-line no-console
  console.log('planning skill_ref tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

