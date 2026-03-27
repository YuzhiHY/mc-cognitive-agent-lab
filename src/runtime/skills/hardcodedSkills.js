const { clearObstacleInFront } = require('../obstacleNav')
const {
  successResult,
  failureResult,
} = require('../contracts/executionResult')
const { createBodyActions } = require('../actions/bodyActions')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'golden_apple',
  'apple', 'melon_slice', 'sweet_berries', 'carrot', 'beetroot', 'dried_kelp',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie', 'cookie',
  'golden_carrot', 'enchanted_golden_apple',
])

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton',
  'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'evoker', 'vex', 'hoglin', 'piglin_brute', 'warden',
  'zombified_piglin', 'guardian', 'elder_guardian', 'shulker',
])

function makeSkill({
  name, category, description, timeoutMs, canInterrupt, tags, riskLevel, preconditions, execute,
}) {
  return Object.freeze({
    name,
    category,
    description,
    timeoutMs,
    canInterrupt,
    tags,
    riskLevel,
    preconditions,
    execute,
  })
}

function findNearestHostile(bot) {
  const origin = bot.entity?.position
  if (!origin) return null
  return Object.values(bot.entities || {})
    .filter((e) => e?.position && e.id !== bot.entity?.id && HOSTILE_MOBS.has(String(e.name || '').toLowerCase()))
    .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))[0] || null
}

function getHardcodedSkills({ api, bot }) {
  const actions = createBodyActions({ api, bot })

  const skills = [
    makeSkill({
      name: 'approach_target',
      category: 'movement',
      description: 'Move toward a target position or nearest block target.',
      timeoutMs: 12000,
      canInterrupt: true,
      tags: ['movement', 'approach'],
      riskLevel: 'low',
      preconditions: ({ args }) => ({ ok: !!(args?.position || args?.target), reason: 'missing_target' }),
      execute: async ({ args, startedAt }) => {
        try {
          const result = args.position
            ? await api.navigateTo(args.position, { sprint: !!args.sprint, timeoutMs: args.timeoutMs || 9000 })
            : await api.navigateToNearestBlock(args.target, args.maxDistance || 32, { sprint: !!args.sprint })
          return successResult({
            source: 'skill',
            actionType: 'approach_target',
            skillName: 'approach_target',
            startedAt,
            endedAt: Date.now(),
            reason: result?.arrived === false ? 'navigate_timeout' : 'approach_done',
            details: { output: result },
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'approach_target',
            skillName: 'approach_target',
            startedAt,
            endedAt: Date.now(),
            reason: 'approach_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'face_target',
      category: 'movement',
      description: 'Rotate bot view to face target position.',
      timeoutMs: 2500,
      canInterrupt: true,
      tags: ['movement', 'look'],
      riskLevel: 'low',
      preconditions: ({ args }) => ({ ok: !!args?.position, reason: 'missing_position' }),
      execute: async ({ args, startedAt }) => {
        try {
          await actions.lookAt(args.position, true)
          return successResult({
            source: 'skill',
            actionType: 'face_target',
            skillName: 'face_target',
            startedAt,
            endedAt: Date.now(),
            reason: 'face_done',
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'face_target',
            skillName: 'face_target',
            startedAt,
            endedAt: Date.now(),
            reason: 'face_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'mine_named_block',
      category: 'gather',
      description: 'Mine a named block with navigation support.',
      timeoutMs: 18000,
      canInterrupt: true,
      tags: ['mine', 'gather'],
      riskLevel: 'medium',
      preconditions: ({ args }) => ({ ok: !!args?.block, reason: 'missing_block' }),
      execute: async ({ args, startedAt }) => {
        const r = await actions.digByName(args.block, { maxDistance: args.maxDistance || 20, navigate: true })
        return r.ok
          ? successResult({
            source: 'skill',
            actionType: 'mine_named_block',
            skillName: 'mine_named_block',
            startedAt,
            endedAt: Date.now(),
            reason: 'mine_done',
            details: { output: r },
          })
          : failureResult({
            source: 'skill',
            actionType: 'mine_named_block',
            skillName: 'mine_named_block',
            startedAt,
            endedAt: Date.now(),
            reason: r.reason || 'mine_failed',
            errorMessage: r.errorMessage || 'mine_failed',
          })
      },
    }),
    makeSkill({
      name: 'place_named_block',
      category: 'build',
      description: 'Place a named block via chain-compatible place operation.',
      timeoutMs: 12000,
      canInterrupt: true,
      tags: ['place', 'build'],
      riskLevel: 'medium',
      preconditions: ({ args }) => ({ ok: !!args?.item, reason: 'missing_item' }),
      execute: async ({ args, startedAt }) => {
        try {
          const item = bot.inventory.items().find((i) => i.name === args.item)
          if (!item) throw new Error(`Item not in inventory: ${args.item}`)
          const origin = bot.entity?.position?.floored?.()
          if (!origin) throw new Error('missing position')
          const { Vec3 } = require('vec3')
          const bases = [origin.offset(1, -1, 0), origin.offset(-1, -1, 0), origin.offset(0, -1, 1), origin.offset(0, -1, -1), origin.offset(0, -1, 0)]
          let placed = false
          for (const p of bases) {
            const ground = bot.blockAt(p)
            const above = bot.blockAt(p.offset(0, 1, 0))
            if (!ground || ground.name === 'air') continue
            if (!above || above.name !== 'air') continue
            try {
              await api.placeBlock(ground, new Vec3(0, 1, 0), item)
              placed = true
              break
            } catch { /* next */ }
          }
          if (!placed) throw new Error('no valid place spot')
          return successResult({
            source: 'skill',
            actionType: 'place_named_block',
            skillName: 'place_named_block',
            startedAt,
            endedAt: Date.now(),
            reason: 'place_done',
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'place_named_block',
            skillName: 'place_named_block',
            startedAt,
            endedAt: Date.now(),
            reason: 'place_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'equip_named_item',
      category: 'inventory',
      description: 'Equip a named item in hand.',
      timeoutMs: 2500,
      canInterrupt: true,
      tags: ['equip'],
      riskLevel: 'low',
      preconditions: ({ args }) => ({ ok: !!args?.item, reason: 'missing_item' }),
      execute: async ({ args, startedAt }) => {
        try {
          await api.equipByName(args.item, 'hand')
          return successResult({
            source: 'skill',
            actionType: 'equip_named_item',
            skillName: 'equip_named_item',
            startedAt,
            endedAt: Date.now(),
            reason: 'equip_done',
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'equip_named_item',
            skillName: 'equip_named_item',
            startedAt,
            endedAt: Date.now(),
            reason: 'equip_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'eat_best_food',
      category: 'survival',
      description: 'Eat best available food to recover hunger.',
      timeoutMs: 6000,
      canInterrupt: true,
      tags: ['eat', 'survival'],
      riskLevel: 'low',
      preconditions: () => ({ ok: true }),
      execute: async ({ startedAt }) => {
        try {
          const food = bot.inventory.items().find((i) => FOOD_ITEMS.has(i.name))
          if (!food) throw new Error('no_food')
          await bot.equip(food, 'hand')
          bot.activateItem()
          await sleep(1850)
          bot.deactivateItem()
          return successResult({
            source: 'skill',
            actionType: 'eat_best_food',
            skillName: 'eat_best_food',
            startedAt,
            endedAt: Date.now(),
            reason: 'eat_done',
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'eat_best_food',
            skillName: 'eat_best_food',
            startedAt,
            endedAt: Date.now(),
            reason: 'eat_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'attack_nearest_hostile',
      category: 'combat',
      description: 'Attack nearest hostile entity.',
      timeoutMs: 6000,
      canInterrupt: true,
      tags: ['combat', 'attack'],
      riskLevel: 'medium',
      preconditions: () => ({ ok: true }),
      execute: async ({ startedAt }) => {
        const r = await actions.attackNearest(undefined)
        return r.ok
          ? successResult({
            source: 'skill',
            actionType: 'attack_nearest_hostile',
            skillName: 'attack_nearest_hostile',
            startedAt,
            endedAt: Date.now(),
            reason: 'attack_done',
            details: { output: r },
          })
          : failureResult({
            source: 'skill',
            actionType: 'attack_nearest_hostile',
            skillName: 'attack_nearest_hostile',
            startedAt,
            endedAt: Date.now(),
            reason: r.reason || 'attack_failed',
            errorMessage: r.errorMessage || 'attack_failed',
          })
      },
    }),
    makeSkill({
      name: 'retreat_from_threat',
      category: 'combat',
      description: 'Retreat from nearest hostile threat.',
      timeoutMs: 3000,
      canInterrupt: true,
      tags: ['combat', 'retreat'],
      riskLevel: 'medium',
      preconditions: () => ({ ok: true }),
      execute: async ({ startedAt }) => {
        try {
          const target = findNearestHostile(bot)
          if (!target || !bot.entity?.position) throw new Error('no_hostile')
          const dx = bot.entity.position.x - target.position.x
          const dz = bot.entity.position.z - target.position.z
          const yaw = Math.atan2(-dx, -dz)
          await bot.look(yaw, bot.entity.pitch, true)
          bot.setControlState('sprint', true)
          bot.setControlState('forward', true)
          bot.setControlState('jump', true)
          await sleep(900)
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          bot.setControlState('jump', false)
          return successResult({
            source: 'skill',
            actionType: 'retreat_from_threat',
            skillName: 'retreat_from_threat',
            startedAt,
            endedAt: Date.now(),
            reason: 'retreat_done',
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'retreat_from_threat',
            skillName: 'retreat_from_threat',
            startedAt,
            endedAt: Date.now(),
            reason: 'retreat_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'collect_nearby_drop',
      category: 'gather',
      description: 'Collect nearby dropped items.',
      timeoutMs: 4500,
      canInterrupt: true,
      tags: ['loot', 'gather'],
      riskLevel: 'low',
      preconditions: () => ({ ok: true }),
      execute: async ({ args, startedAt }) => {
        const out = await api.collectNearbyDrops({
          maxDistance: args?.maxDistance || 5,
          timeoutMs: args?.timeoutMs || 2500,
          anchorPos: args?.anchorPos || null,
        })
        return successResult({
          source: 'skill',
          actionType: 'collect_nearby_drop',
          skillName: 'collect_nearby_drop',
          startedAt,
          endedAt: Date.now(),
          reason: 'collect_done',
          details: { output: out },
        })
      },
    }),
    makeSkill({
      name: 'recover_from_stuck',
      category: 'recovery',
      description: 'Try obstacle clearing and jump to recover from stuck state.',
      timeoutMs: 3500,
      canInterrupt: true,
      tags: ['recovery', 'stuck'],
      riskLevel: 'low',
      preconditions: () => ({ ok: true }),
      execute: async ({ startedAt }) => {
        try {
          await clearObstacleInFront(bot)
          bot.setControlState('jump', true)
          await sleep(220)
          bot.setControlState('jump', false)
          return successResult({
            source: 'skill',
            actionType: 'recover_from_stuck',
            skillName: 'recover_from_stuck',
            startedAt,
            endedAt: Date.now(),
            reason: 'recover_done',
          })
        } catch (err) {
          return failureResult({
            source: 'skill',
            actionType: 'recover_from_stuck',
            skillName: 'recover_from_stuck',
            startedAt,
            endedAt: Date.now(),
            reason: 'recover_failed',
            errorMessage: err?.message || String(err),
          })
        }
      },
    }),
    makeSkill({
      name: 'place_torch_safely',
      category: 'utility',
      description: 'Place torch using safe placement helper.',
      timeoutMs: 4500,
      canInterrupt: true,
      tags: ['torch', 'light'],
      riskLevel: 'low',
      preconditions: () => ({ ok: true }),
      execute: async ({ args, startedAt }) => {
        const r = await actions.placeTorchSmart({
          count: args?.count || 1,
          itemName: args?.item || 'torch',
          radius: args?.radius || 3,
          force: args?.force === true,
        })
        return r.ok
          ? successResult({
            source: 'skill',
            actionType: 'place_torch_safely',
            skillName: 'place_torch_safely',
            startedAt,
            endedAt: Date.now(),
            reason: 'torch_done',
            details: { output: r },
          })
          : failureResult({
            source: 'skill',
            actionType: 'place_torch_safely',
            skillName: 'place_torch_safely',
            startedAt,
            endedAt: Date.now(),
            reason: r.reason || 'torch_failed',
            errorMessage: r.errorMessage || 'torch_failed',
          })
      },
    }),
    makeSkill({
      name: 'simple_craft_item',
      category: 'craft',
      description: 'Craft an item through stable craftAny path.',
      timeoutMs: 12000,
      canInterrupt: true,
      tags: ['craft'],
      riskLevel: 'low',
      preconditions: ({ args }) => ({ ok: !!args?.item, reason: 'missing_item' }),
      execute: async ({ args, startedAt }) => {
        const r = await actions.craftAny(args.item, args.count || 1)
        return r.ok
          ? successResult({
            source: 'skill',
            actionType: 'simple_craft_item',
            skillName: 'simple_craft_item',
            startedAt,
            endedAt: Date.now(),
            reason: 'craft_done',
            details: { output: r },
          })
          : failureResult({
            source: 'skill',
            actionType: 'simple_craft_item',
            skillName: 'simple_craft_item',
            startedAt,
            endedAt: Date.now(),
            reason: r.reason || 'craft_failed',
            errorMessage: r.errorMessage || 'craft_failed',
          })
      },
    }),
  ]

  const map = new Map(skills.map((s) => [s.name, s]))
  return Object.freeze({
    list: () => skills.slice(),
    get: (name) => map.get(String(name || '')),
  })
}

module.exports = { getHardcodedSkills }

