// Transitional legacy helper:
// - kept for craft/smelt/torch stability during Phase 3.5
// - new behavior logic should be added as modular skills under src/runtime/skills/*
// - TODO(phase4): split this file into dedicated skill-facing modules and keep API primitive-only

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeItemName(name) {
  return String(name || '').trim().toLowerCase().replace(/ /g, '_')
}

function listGroundCandidates(bot) {
  const pos = bot.entity?.position?.floored?.()
  if (!pos) return []
  return [
    pos.offset(1, -1, 0), pos.offset(-1, -1, 0),
    pos.offset(0, -1, 1), pos.offset(0, -1, -1),
    pos.offset(1, -1, 1), pos.offset(-1, -1, -1),
    pos.offset(1, -1, -1), pos.offset(-1, -1, 1),
    pos.offset(0, -1, 0),
    pos.offset(2, -1, 0), pos.offset(-2, -1, 0),
    pos.offset(0, -1, 2), pos.offset(0, -1, -2),
    pos.offset(2, -1, 1), pos.offset(-2, -1, -1),
    pos.offset(1, -1, 2), pos.offset(-1, -1, -2),
    pos.offset(1, -2, 0), pos.offset(-1, -2, 0),
    pos.offset(0, -2, 1), pos.offset(0, -2, -1),
    pos.offset(0, -2, 0),
  ]
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

async function ensureCraftingTable(bot, mcData) {
  const tableType = mcData.blocksByName.crafting_table
  if (!tableType) return null
  let table = bot.findBlock({ matching: tableType.id, maxDistance: 4 })
  if (table) return table

  const planksInInv = bot.inventory.items().find((i) => i.name.endsWith('_planks'))
  if (!planksInInv || planksInInv.count < 4) {
    throw new Error('skillOps.smartCraft: need crafting table but not enough planks')
  }
  const tableItem = mcData.itemsByName.crafting_table
  if (!tableItem) return null
  const tableRecipe = bot.recipesFor(tableItem.id, null, 1, null)[0]
  if (!tableRecipe) throw new Error('skillOps.smartCraft: cannot find recipe for crafting_table')
  await bot.craft(tableRecipe, 1, null)

  const { Vec3 } = require('vec3')
  for (const p of listGroundCandidates(bot).slice(0, 8)) {
    const ground = bot.blockAt(p)
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (!isStablePlacementGround(ground)) continue
    if (!above || above.name !== 'air') continue
    const tableInv = bot.inventory.items().find((i) => i.name === 'crafting_table')
    if (!tableInv) continue
    try {
      await bot.equip(tableInv, 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      await sleep(300)
      table = bot.findBlock({ matching: tableType.id, maxDistance: 5 })
      if (table) return table
    } catch { /* try next */ }
  }
  throw new Error('skillOps.smartCraft: crafted crafting_table but failed to place')
}

async function ensurePlacedUtilityBlock(bot, mcData, blockName) {
  const blockType = mcData.blocksByName[blockName]
  if (!blockType) throw new Error(`skillOps.ensurePlacedUtilityBlock: unknown block '${blockName}'`)
  let found = bot.findBlock({ matching: blockType.id, maxDistance: 5 })
  if (found) return found

  const item = bot.inventory.items().find((i) => i.name === blockName)
  if (!item && blockName === 'furnace') {
    const furnaceItem = mcData.itemsByName.furnace
    if (!furnaceItem) throw new Error('skillOps.ensurePlacedUtilityBlock: furnace item missing')
    const table = await ensureCraftingTable(bot, mcData)
    const recipe = bot.recipesFor(furnaceItem.id, null, 1, table)[0]
    if (!recipe) throw new Error('skillOps.ensurePlacedUtilityBlock: cannot craft furnace')
    await bot.craft(recipe, 1, table)
  }

  const utility = bot.inventory.items().find((i) => i.name === blockName)
  if (!utility) throw new Error(`skillOps.ensurePlacedUtilityBlock: '${blockName}' missing`)
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
    } catch { /* continue */ }
  }
  throw new Error(`skillOps.ensurePlacedUtilityBlock: failed to place '${blockName}'`)
}

function selectFuelItem(bot) {
  const items = bot.inventory.items()
  const fuelPriority = [
    'coal_block', 'coal', 'charcoal', 'blaze_rod', 'stick',
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
  const candidates = inputByOutput[req] || []
  if (!candidates.length && (allInputs.has(req) || mcData.itemsByName[req])) {
    return { input: req, requested: req, mappedFrom: null }
  }
  if (!candidates.length) return { input: req, requested: req, mappedFrom: null }
  const invSet = new Set(inventoryItems.map((i) => i.name))
  const picked = candidates.find((c) => invSet.has(c)) || candidates[0]
  return { input: picked, requested: req, mappedFrom: req }
}

function createStableSkillOps(bot) {
  return Object.freeze({
    async smartCraft(itemName, count = 1) {
      itemName = normalizeItemName(itemName)
      try {
        const { plugin: craftUtil } = require('mineflayer-crafting-util')
        if (craftUtil && !bot._craftUtilLoaded) {
          bot.loadPlugin(craftUtil)
          bot._craftUtilLoaded = true
        }
      } catch { /* plugin optional */ }
      const mcData = require('minecraft-data')(bot.version)
      const item = mcData.itemsByName[itemName]
      if (!item) throw new Error(`skillOps.smartCraft: unknown item '${itemName}'`)
      if (typeof bot.planCraft === 'function') {
        const plan = bot.planCraft(item.id, count)
        if (plan.success) {
          let table = null
          for (const step of plan.recipesToDo) {
            if (step.recipe.requiresTable && !table) table = await ensureCraftingTable(bot, mcData)
            await bot.craft(step.recipe, step.recipeApplications, table || null)
          }
          return { crafted: itemName, count, steps: plan.recipesToDo.length }
        }
      }
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
      throw new Error(`skillOps.smartCraft: no recipe for '${itemName}'`)
    },

    async smeltItem(itemName, {
      count = 1,
      fuelItemName = null,
      timeoutMs = 22000,
      ensureFurnace = true,
    } = {}) {
      const invItems = bot.inventory.items()
      const mcData = require('minecraft-data')(bot.version)
      const resolved = resolveSmeltInputTarget(mcData, itemName, invItems)
      itemName = resolved.input
      const item = mcData.itemsByName[itemName]
      if (!item) throw new Error(`skillOps.smeltItem: unknown item '${itemName}'`)
      let furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 5 })
      if (!furnaceBlock && ensureFurnace) {
        furnaceBlock = await ensurePlacedUtilityBlock(bot, mcData, 'furnace')
      }
      if (!furnaceBlock) throw new Error('skillOps.smeltItem: no furnace nearby')
      const input = bot.inventory.items().find((i) => i.name === itemName)
      if (!input || input.count <= 0) {
        const mappedHint = resolved.mappedFrom ? ` (mapped from '${resolved.mappedFrom}')` : ''
        throw new Error(`skillOps.smeltItem: no input item '${itemName}'${mappedHint}`)
      }
      let fuel = fuelItemName
        ? bot.inventory.items().find((i) => i.name === normalizeItemName(fuelItemName))
        : selectFuelItem(bot)
      if (!fuel) throw new Error('skillOps.smeltItem: no smelting fuel')
      const furnace = await bot.openFurnace(furnaceBlock)
      try {
        const toSmelt = Math.max(1, count)
        await furnace.putInput(input.type, null, Math.min(toSmelt, input.count))
        fuel = fuelItemName
          ? bot.inventory.items().find((i) => i.name === normalizeItemName(fuelItemName))
          : selectFuelItem(bot)
        if (!fuel) throw new Error('skillOps.smeltItem: fuel missing after putInput')
        await furnace.putFuel(fuel.type, null, 1)
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const outLoop = furnace.outputItem()
          if ((outLoop?.count || 0) >= Math.min(toSmelt, input.count)) break
          await sleep(350)
        }
        const out = furnace.outputItem()
        if (!out || out.count <= 0) throw new Error('skillOps.smeltItem: smelting timed out')
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

    async placeTorchSmart({
      count = 1,
      itemName = 'torch',
      radius = 3,
      force = false,
    } = {}) {
      const torchName = normalizeItemName(itemName)
      const inv = bot.inventory.items().find((i) => i.name === torchName)
      if (!inv) throw new Error(`skillOps.placeTorchSmart: no '${torchName}' in inventory`)
      const isNight = bot.time?.isDay === false
      if (!force && !isNight) return { placed: 0, reason: 'daytime_skip' }
      const { Vec3 } = require('vec3')
      const origin = bot.entity?.position?.floored?.()
      if (!origin) throw new Error('skillOps.placeTorchSmart: missing origin')
      let placed = 0
      const candidates = []
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) candidates.push(origin.offset(dx, -1, dz))
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
        } catch { /* continue */ }
      }
      return { placed, item: torchName }
    },
  })
}

module.exports = { createStableSkillOps }

