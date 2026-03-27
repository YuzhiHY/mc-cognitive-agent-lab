const { clearObstacleInFront } = require('./obstacleNav')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeItemName(name) {
  return String(name || '').trim().toLowerCase().replace(/ /g, '_')
}

let pathfinderLoaded = false

function ensurePathfinder(bot) {
  if (pathfinderLoaded) return true
  try {
    const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
    if (!bot.pathfinder) {
      bot.loadPlugin(pathfinder)
    }
    const mcData = require('minecraft-data')(bot.version)
    const movements = new Movements(bot, mcData)
    movements.allowSprinting = true
    movements.canDig = true
    movements.allow1by1towers = true
    movements.scafoldingBlocks = []
    movements.maxDropDown = 4
    bot.pathfinder.setMovements(movements)
    pathfinderLoaded = true
    return true
  } catch {
    return false
  }
}

async function ensureCraftingTable(bot, mcData) {
  const tableType = mcData.blocksByName.crafting_table
  if (!tableType) return null

  let table = bot.findBlock({ matching: tableType.id, maxDistance: 4 })
  if (table) return table

  const planksInInv = bot.inventory.items().find(i => i.name.endsWith('_planks'))
  if (!planksInInv || planksInInv.count < 4) {
    throw new Error('api.smartCraft: need crafting table but not enough planks to make one (need 4)')
  }

  const tableItem = mcData.itemsByName.crafting_table
  if (!tableItem) return null
  const tableRecipe = bot.recipesFor(tableItem.id, null, 1, null)[0]
  if (!tableRecipe) throw new Error('api.smartCraft: cannot find recipe for crafting_table')
  await bot.craft(tableRecipe, 1, null)

  const pos = bot.entity.position.floored()
  const placeTargets = [
    pos.offset(1, -1, 0), pos.offset(-1, -1, 0),
    pos.offset(0, -1, 1), pos.offset(0, -1, -1),
  ]

  for (const target of placeTargets) {
    const ground = bot.blockAt(target)
    if (ground && ground.name !== 'air') {
      const tableInv = bot.inventory.items().find(i => i.name === 'crafting_table')
      if (tableInv) {
        try {
          await bot.equip(tableInv, 'hand')
          const { Vec3 } = require('vec3')
          await bot.placeBlock(ground, new Vec3(0, 1, 0))
          await sleep(300)
          table = bot.findBlock({ matching: tableType.id, maxDistance: 4 })
          if (table) return table
        } catch { /* try next position */ }
      }
    }
  }

  throw new Error('api.smartCraft: crafted a crafting_table but failed to place it')
}

function listGroundCandidates(bot) {
  const pos = bot.entity?.position?.floored?.()
  if (!pos) return []
  const candidates = [
    pos.offset(1, -1, 0), pos.offset(-1, -1, 0),
    pos.offset(0, -1, 1), pos.offset(0, -1, -1),
    pos.offset(1, -1, 1), pos.offset(-1, -1, -1),
    pos.offset(1, -1, -1), pos.offset(-1, -1, 1),
    pos.offset(0, -1, 0),
    // Fallback ring with a slightly larger radius.
    pos.offset(2, -1, 0), pos.offset(-2, -1, 0),
    pos.offset(0, -1, 2), pos.offset(0, -1, -2),
    pos.offset(2, -1, 1), pos.offset(-2, -1, -1),
    pos.offset(1, -1, 2), pos.offset(-1, -1, -2),
    // Fallback for uneven terrain (one block lower).
    pos.offset(1, -2, 0), pos.offset(-1, -2, 0),
    pos.offset(0, -2, 1), pos.offset(0, -2, -1),
    pos.offset(0, -2, 0),
  ]
  return candidates
}

function isStablePlacementGround(block) {
  if (!block || block.name === 'air') return false
  const n = String(block.name || '').toLowerCase()
  if (n.includes('leaves')) return false
  if (n.includes('vine')) return false
  if (n.includes('grass')) return false
  if (n.includes('fern')) return false
  if (n.includes('snow')) return false
  return true
}

async function ensurePlacedUtilityBlock(bot, mcData, blockName) {
  const blockType = mcData.blocksByName[blockName]
  if (!blockType) throw new Error(`api.ensurePlacedUtilityBlock: unknown block '${blockName}'`)
  let found = bot.findBlock({ matching: blockType.id, maxDistance: 5 })
  if (found) return found

  const item = bot.inventory.items().find((i) => i.name === blockName)
  if (!item) {
    if (blockName === 'furnace') {
      // try crafting furnace if possible
      const furnaceItem = mcData.itemsByName.furnace
      if (!furnaceItem) throw new Error('api.ensurePlacedUtilityBlock: furnace item data missing')
      const table = await ensureCraftingTable(bot, mcData)
      const recipe = bot.recipesFor(furnaceItem.id, null, 1, table)[0]
      if (!recipe) throw new Error('api.ensurePlacedUtilityBlock: cannot craft furnace (missing cobblestone?)')
      await bot.craft(recipe, 1, table)
    } else {
      throw new Error(`api.ensurePlacedUtilityBlock: '${blockName}' not in inventory`)
    }
  }

  const utility = bot.inventory.items().find((i) => i.name === blockName)
  if (!utility) throw new Error(`api.ensurePlacedUtilityBlock: '${blockName}' still missing after craft`)
  const { Vec3 } = require('vec3')
  for (const p of listGroundCandidates(bot)) {
    const ground = bot.blockAt(p)
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (!isStablePlacementGround(ground)) continue
    if (!above || above.name !== 'air') continue
    try {
      await bot.equip(utility, 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      await sleep(300)
      found = bot.findBlock({ matching: blockType.id, maxDistance: 6 })
      if (found) return found
    } catch { /* try next */ }
  }
  throw new Error(`api.ensurePlacedUtilityBlock: failed to place '${blockName}'`)
}

function selectFuelItem(bot) {
  const items = bot.inventory.items()
  const fuelPriority = [
    'coal_block', 'coal', 'charcoal',
    'blaze_rod',
    'stick',
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  ]
  for (const f of fuelPriority) {
    const found = items.find((i) => i.name === f && i.count > 0)
    if (found) return found
  }
  return null
}

function resolveSmeltInputTarget(mcData, requestedName, inventoryItems = []) {
  const req = normalizeItemName(requestedName)
  const inputByOutput = {
    iron_ingot: ['iron_ore', 'deepslate_iron_ore', 'raw_iron'],
    gold_ingot: ['gold_ore', 'deepslate_gold_ore', 'raw_gold'],
    copper_ingot: ['copper_ore', 'deepslate_copper_ore', 'raw_copper'],
    glass: ['sand', 'red_sand'],
    charcoal: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'],
    smooth_stone: ['stone'],
    stone: ['cobblestone'],
    cracked_stone_bricks: ['stone_bricks'],
    dried_kelp: ['kelp'],
    brick: ['clay_ball'],
  }

  const allInputs = new Set()
  Object.values(inputByOutput).forEach((arr) => arr.forEach((v) => allInputs.add(v)))
  // If user passes a smelt output keyword (e.g. iron_ingot), map to best available input first.
  const candidates = inputByOutput[req] || []
  if (!candidates.length && (allInputs.has(req) || mcData.itemsByName[req])) {
    return { input: req, requested: req, mappedFrom: null }
  }
  if (!candidates.length) return { input: req, requested: req, mappedFrom: null }
  const invSet = new Set(inventoryItems.map((i) => i.name))
  const picked = candidates.find((c) => invSet.has(c)) || candidates[0]
  return { input: picked, requested: req, mappedFrom: req }
}

function createApi(bot) {
  const hasPathfinder = () => {
    ensurePathfinder(bot)
    return !!bot.pathfinder
  }

  const api = {
    sleep,

    chat: (message) => bot.chat(String(message)),

    lookAt: async (pos, force = true) => {
      if (!pos) throw new Error('api.lookAt: missing pos')
      await bot.lookAt(pos, force)
    },

    setControlState: (control, state) => {
      bot.setControlState(control, !!state)
    },

    clearControlStates: () => {
      const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
      for (const c of controls) bot.setControlState(c, false)
    },

    swingArm: (hand = 'right') => bot.swingArm(hand),

    equip: async (item, destination = 'hand') => bot.equip(item, destination),
    equipByName: async (itemName, destination = 'hand') => {
      const item = bot.inventory.items().find((i) => i.name === itemName)
      if (!item) throw new Error(`api.equipByName: item not in inventory: ${itemName}`)
      await bot.equip(item, destination)
      return { equipped: itemName, destination }
    },

    activateItem: () => bot.activateItem(),
    deactivateItem: () => bot.deactivateItem(),

    dig: async (block, forceLook = true) => {
      if (!block) throw new Error('api.dig: missing block')
      await bot.dig(block, 'raycast', 'raycast')
    },
    digByName: async (blockName, { maxDistance = 16, navigate = true } = {}) => {
      const mcData = require('minecraft-data')(bot.version)
      const blockType = mcData.blocksByName[blockName]
      if (!blockType) throw new Error(`api.digByName: unknown block '${blockName}'`)
      const found = bot.findBlock({ matching: blockType.id, maxDistance })
      if (!found) throw new Error(`api.digByName: no '${blockName}' found within ${maxDistance}`)
      const origin = bot.entity?.position
      if (navigate && origin && found.position && origin.distanceTo(found.position) > 4.5) {
        await api.navigateTo({ x: found.position.x, y: found.position.y, z: found.position.z }, { sprint: false, timeoutMs: 12_000 })
      }
      await bot.dig(found, 'raycast', 'raycast')
      return { dug: blockName, pos: { x: found.position.x, y: found.position.y, z: found.position.z } }
    },

    placeBlock: async (referenceBlock, faceVector, item) => {
      if (!referenceBlock) throw new Error('api.placeBlock: missing referenceBlock')
      if (!faceVector) throw new Error('api.placeBlock: missing faceVector')
      if (item) await bot.equip(item, 'hand')
      await bot.placeBlock(referenceBlock, faceVector)
    },

    getBotState: () => ({
      username: bot.username,
      health: bot.health,
      food: bot.food,
      position: bot.entity?.position ?? null,
    }),

    findBlock: (matching, maxDistance = 16) =>
      bot.findBlock({ matching, maxDistance }),
    navigateToNearestBlock: async (blockName, maxDistance = 32, options = {}) => {
      const mcData = require('minecraft-data')(bot.version)
      const blockType = mcData.blocksByName[blockName]
      if (!blockType) throw new Error(`api.navigateToNearestBlock: unknown block '${blockName}'`)
      const found = bot.findBlock({ matching: blockType.id, maxDistance })
      if (!found?.position) throw new Error(`api.navigateToNearestBlock: no '${blockName}' found within ${maxDistance}`)
      await api.navigateTo({ x: found.position.x, y: found.position.y, z: found.position.z }, options)
      return { block: blockName, position: { x: found.position.x, y: found.position.y, z: found.position.z } }
    },

    navigateTo: async (pos, { sprint = false, timeoutMs = 15_000 } = {}) => {
      if (!pos) throw new Error('api.navigateTo: missing pos')
      if (!hasPathfinder()) {
        throw new Error('api.navigateTo: pathfinder plugin not available')
      }
      const { goals } = require('mineflayer-pathfinder')
      const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 1)
      if (sprint && bot.pathfinder.movements) {
        bot.pathfinder.movements.allowSprinting = true
      }
      bot.pathfinder.setGoal(goal)

      let stuckChecks = 0
      let lastCheckPos = bot.entity?.position?.clone()

      const stuckInterval = setInterval(async () => {
        if (bot.targetDigBlock) return
        const curPos = bot.entity?.position
        if (!curPos || !lastCheckPos) { lastCheckPos = curPos?.clone(); return }
        const moved = lastCheckPos.distanceTo(curPos)
        lastCheckPos = curPos.clone()
        if (moved < 0.3) {
          stuckChecks++
          if (stuckChecks >= 2) {
            try { await clearObstacleInFront(bot) } catch { /* */ }
            stuckChecks = 0
          }
        } else {
          stuckChecks = 0
        }
      }, 2000)

      return await new Promise((resolve, reject) => {
        let timer = null
        let reached = false
        const onArrived = () => { reached = true; cleanup(); resolve({ arrived: true, reason: 'goal_reached' }) }
        const onPathStopped = () => {
          cleanup()
          if (reached) resolve({ arrived: true, reason: 'path_stopped_after_goal' })
          else reject(new Error('Path stopped before goal reached'))
        }
        const onPathUpdate = (r) => {
          const status = String(r?.status || '').toLowerCase()
          if (status.includes('nopath') || status.includes('no_path')) {
            cleanup()
            reject(new Error('No path found'))
          }
        }
        const onTimeout = () => {
          cleanup()
          try { bot.pathfinder.setGoal(null) } catch { /* */ }
          const controls = ['forward','back','left','right','jump','sprint','sneak']
          for (const c of controls) bot.setControlState(c, false)
          resolve({ arrived: false, reason: 'timeout' })
        }
        const cleanup = () => {
          clearInterval(stuckInterval)
          if (timer) clearTimeout(timer)
          bot.off('goal_reached', onArrived)
          bot.off('path_stopped', onPathStopped)
          bot.off('path_update', onPathUpdate)
        }
        timer = setTimeout(onTimeout, timeoutMs)
        bot.on('goal_reached', onArrived)
        bot.on('path_stopped', onPathStopped)
        bot.on('path_update', onPathUpdate)
      })
    },

    moveForward: async (ms = 1000) => {
      bot.setControlState('forward', true)
      await sleep(ms)
      bot.setControlState('forward', false)
    },

    attackNearest: async (entityType) => {
      const origin = bot.entity?.position
      if (!origin) throw new Error('api.attackNearest: bot has no position')
      const candidates = Object.values(bot.entities || {})
        .filter((e) => {
          if (!e || !e.position || e.id === bot.entity.id) return false
          if (entityType && e.name !== entityType && e.kind !== entityType) return false
          return true
        })
        .sort((a, b) => {
          const dA = a.position.distanceTo(origin)
          const dB = b.position.distanceTo(origin)
          return dA - dB
        })
      if (candidates.length === 0) {
        throw new Error(`api.attackNearest: no entity found${entityType ? ` of type '${entityType}'` : ''}`)
      }
      const target = candidates[0]
      await bot.lookAt(target.position.offset(0, target.height || 1, 0))
      bot.attack(target)
      return { attacked: target.name || target.kind || target.type, id: target.id }
    },

    collectNearbyDrops: async ({ maxDistance = 5, timeoutMs = 2500, anchorPos = null } = {}) => {
      const origin = bot.entity?.position
      if (!origin) return { collected: 0, reason: 'no_origin' }
      const drops = Object.values(bot.entities || {})
        .filter((e) => {
          if (!e?.position) return false
          const t = String(e.type || '').toLowerCase()
          const n = String(e.name || '').toLowerCase()
          if (t === 'object') return true
          // Some servers/protocol versions expose dropped items as "other"/"unknown".
          if (t === 'other' || n === 'item' || n === 'unknown') {
            if (e.username) return false
            return true
          }
          return false
        })
        .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))
      let collected = 0
      const deadline = Date.now() + Math.max(400, timeoutMs)
      let attemptedAnchor = false
      for (const d of drops) {
        if (Date.now() >= deadline) break
        const cur = bot.entity?.position
        if (!cur || !d?.position) continue
        const dist = cur.distanceTo(d.position)
        if (dist > maxDistance) continue
        try {
          const result = await api.navigateTo(
            { x: d.position.x, y: d.position.y, z: d.position.z },
            { sprint: true, timeoutMs: Math.min(1500, Math.max(700, deadline - Date.now())) },
          )
          if (!result?.arrived) {
            try { await clearObstacleInFront(bot) } catch { /* best effort */ }
            try { bot.setControlState('jump', true); await sleep(220) } finally { bot.setControlState('jump', false) }
          }
          collected += 1
        } catch { /* continue next drop */ }
      }
      // Fallback: if no drop recognized but dig just happened, push to anchor and hop once.
      if (collected === 0 && anchorPos && !attemptedAnchor && Date.now() < deadline) {
        attemptedAnchor = true
        try {
          await api.navigateTo(
            { x: anchorPos.x, y: anchorPos.y, z: anchorPos.z },
            { sprint: true, timeoutMs: Math.min(1200, Math.max(500, deadline - Date.now())) },
          )
          bot.setControlState('jump', true)
          await sleep(240)
          bot.setControlState('jump', false)
        } catch { /* best effort */ }
      }
      return { collected }
    },

    craft: async (itemName, count = 1, useCraftingTable = false) => {
      itemName = normalizeItemName(itemName)
      const mcData = require('minecraft-data')(bot.version)
      const item = mcData.itemsByName[itemName]
      if (!item) throw new Error(`api.craft: unknown item '${itemName}'`)

      let craftingTable = null
      if (useCraftingTable) {
        craftingTable = bot.findBlock({
          matching: mcData.blocksByName.crafting_table?.id,
          maxDistance: 4,
        })
        if (!craftingTable) throw new Error('api.craft: no crafting_table within reach (place one first)')
      }

      const recipe = bot.recipesFor(item.id, null, count, craftingTable)[0]
      if (!recipe) throw new Error(`api.craft: no recipe for '${itemName}' with current inventory`)
      await bot.craft(recipe, count, craftingTable)
      return { crafted: itemName, count }
    },

    smartCraft: async (itemName, count = 1) => {
      itemName = normalizeItemName(itemName)
      try {
        const { plugin: craftUtil } = require('mineflayer-crafting-util')
        if (craftUtil && !bot._craftUtilLoaded) {
          bot.loadPlugin(craftUtil)
          bot._craftUtilLoaded = true
        }
      } catch { /* plugin not available */ }

      const mcData = require('minecraft-data')(bot.version)
      const item = mcData.itemsByName[itemName]
      if (!item) throw new Error(`api.smartCraft: unknown item '${itemName}'`)

      // Try mineflayer-crafting-util recursive planner first
      if (typeof bot.planCraft === 'function') {
        const plan = bot.planCraft(item.id, count)
        if (plan.success) {
          let table = null
          for (const step of plan.recipesToDo) {
            if (step.recipe.requiresTable && !table) {
              table = await ensureCraftingTable(bot, mcData)
            }
            await bot.craft(step.recipe, step.recipeApplications, table || null)
          }
          return { crafted: itemName, count, steps: plan.recipesToDo.length }
        }
      }

      // Robust fallback: try inventory and crafting-table recipes, choose any valid plan.
      const invRecipe = bot.recipesFor(item.id, null, count, null)[0]
      if (invRecipe) {
        await bot.craft(invRecipe, count, null)
        return { crafted: itemName, count, mode: 'inv_recipe' }
      }
      const table = await ensureCraftingTable(bot, mcData)
      const tableRecipe = bot.recipesFor(item.id, null, count, table)[0]
      if (tableRecipe) {
        await bot.craft(tableRecipe, count, table)
        return { crafted: itemName, count, mode: 'table_recipe' }
      }
      throw new Error(`api.smartCraft: no recipe for '${itemName}' (checked recursive/inventory/table)`)
    },
    craftItem: async (itemName, count = 1) => api.smartCraft(itemName, count),
    craftAny: async (itemName, count = 1) => api.smartCraft(itemName, count),

    smeltItem: async (itemName, {
      count = 1,
      fuelItemName = null,
      timeoutMs = 22000,
      ensureFurnace = true,
    } = {}) => {
      const invItems = bot.inventory.items()
      const mcData = require('minecraft-data')(bot.version)
      const resolved = resolveSmeltInputTarget(mcData, itemName, invItems)
      itemName = resolved.input
      const item = mcData.itemsByName[itemName]
      if (!item) throw new Error(`api.smeltItem: unknown item '${itemName}'`)
      let furnaceBlock = bot.findBlock({
        matching: mcData.blocksByName.furnace?.id,
        maxDistance: 5,
      })
      if (!furnaceBlock && ensureFurnace) {
        furnaceBlock = await ensurePlacedUtilityBlock(bot, mcData, 'furnace')
      }
      if (!furnaceBlock) throw new Error('api.smeltItem: no furnace nearby')

      const input = bot.inventory.items().find((i) => i.name === itemName)
      if (!input || input.count <= 0) {
        const mappedHint = resolved.mappedFrom ? ` (mapped from '${resolved.mappedFrom}')` : ''
        throw new Error(`api.smeltItem: no input item '${itemName}' in inventory${mappedHint}`)
      }
      let fuel = fuelItemName
        ? bot.inventory.items().find((i) => i.name === normalizeItemName(fuelItemName))
        : selectFuelItem(bot)
      if (!fuel) throw new Error('api.smeltItem: no smelting fuel available')

      const furnace = await bot.openFurnace(furnaceBlock)
      try {
        const toSmelt = Math.max(1, count)
        await furnace.putInput(input.type, null, Math.min(toSmelt, input.count))
        fuel = fuelItemName
          ? bot.inventory.items().find((i) => i.name === normalizeItemName(fuelItemName))
          : selectFuelItem(bot)
        if (!fuel) throw new Error('api.smeltItem: fuel missing after putInput')
        await furnace.putFuel(fuel.type, null, 1)

        const deadline = Date.now() + timeoutMs
        let outputCount = 0
        while (Date.now() < deadline) {
          const out = furnace.outputItem()
          outputCount = out?.count || 0
          if (outputCount >= Math.min(toSmelt, input.count)) break
          await sleep(350)
        }
        const out = furnace.outputItem()
        if (!out || out.count <= 0) throw new Error('api.smeltItem: smelting timed out or no output')
        await furnace.takeOutput()
        return {
          requested: resolved.requested,
          smeltedInput: itemName,
          output: out.name || null,
          outputCount: out.count || 0,
          mappedFrom: resolved.mappedFrom,
        }
      } finally {
        try { furnace.close() } catch { /* noop */ }
      }
    },

    placeTorchSmart: async ({
      count = 1,
      itemName = 'torch',
      radius = 3,
      force = false,
    } = {}) => {
      const torchName = normalizeItemName(itemName)
      const inv = bot.inventory.items().find((i) => i.name === torchName)
      if (!inv) throw new Error(`api.placeTorchSmart: no '${torchName}' in inventory`)
      const isNight = bot.time?.isDay === false
      if (!force && !isNight) {
        return { placed: 0, reason: 'daytime_skip' }
      }
      const { Vec3 } = require('vec3')
      const origin = bot.entity?.position?.floored?.()
      if (!origin) throw new Error('api.placeTorchSmart: missing origin position')
      let placed = 0
      const candidates = []
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const base = origin.offset(dx, -1, dz)
          candidates.push(base)
        }
      }
      candidates.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))
      for (const p of candidates) {
        if (placed >= count) break
        const ground = bot.blockAt(p)
        const above = bot.blockAt(p.offset(0, 1, 0))
        if (!ground || ground.name === 'air') continue
        if (!above || above.name !== 'air') continue
        try {
          await bot.equip(inv, 'hand')
          await bot.placeBlock(ground, new Vec3(0, 1, 0))
          placed += 1
          await sleep(120)
        } catch { /* try next candidate */ }
      }
      return { placed, item: torchName }
    },

    getCapabilities: () => ({
      canNavigate: hasPathfinder(),
      canAttack: true,
      canDig: true,
      canPlace: true,
      canCraft: true,
      canSmelt: true,
      canTorch: true,
    }),
  }

  return Object.freeze(api)
}

module.exports = { createApi }

