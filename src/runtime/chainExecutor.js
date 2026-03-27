const { sense } = require('./sense')
const { clearObstacleInFront } = require('./obstacleNav')
const { runSkillInSandbox, serializeError, withTimeout } = require('./sandbox')

const MAX_DIG_REACH = 4.5

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function distanceTo(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function createChainExecutor() {
  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n))
  }

  function threatLevel(ctx, bot) {
    return ctx?.snapshot?.threat_level
      || (bot?.health != null && bot.health <= 8 ? 'high' : 'none')
  }

  function adaptiveTimeoutMs(step, ctx, bot, targetPos) {
    const t = step?.type || 'unknown'
    const threat = threatLevel(ctx, bot)
    const origin = bot.entity?.position
    const dist = (origin && targetPos) ? origin.distanceTo(targetPos) : null

    if (t === 'navigate') {
      const base = dist != null ? (dist * 500 + 2500) : 9000
      if (threat === 'high') return clamp(base * 0.65, 2500, 7000)
      if (threat === 'low') return clamp(base * 0.85, 3500, 9000)
      return clamp(base, 4500, 12000)
    }
    if (t === 'dig') {
      const base = dist != null && dist > 4.5 ? 15000 : 12000
      if (threat === 'high') return clamp(base * 0.7, 7000, 12000)
      return clamp(base, 9000, 18000)
    }
    if (t === 'skill') {
      if (threat === 'high') return 7000
      return 12000
    }
    if (t === 'craft') return threat === 'high' ? 7000 : 12000
    return 10000
  }

  function listPlaceGroundCandidates(bot) {
    const origin = bot.entity?.position?.floored()
    if (!origin) return []
    const candidates = [
      origin.offset(1, -1, 0), origin.offset(-1, -1, 0),
      origin.offset(0, -1, 1), origin.offset(0, -1, -1),
      origin.offset(1, -1, 1), origin.offset(-1, -1, -1),
      origin.offset(1, -1, -1), origin.offset(-1, -1, 1),
      origin.offset(0, -1, 0),
    ]
    const out = []
    for (const p of candidates) {
      const ground = bot.blockAt(p)
      const above = bot.blockAt(p.offset(0, 1, 0))
      if (!ground || ground.name === 'air') continue
      if (!above || above.name !== 'air') continue
      out.push(ground)
    }
    return out
  }

  async function confirmPlaced(bot, groundPos, itemName) {
    const expectName = String(itemName || '').toLowerCase()
    for (let i = 0; i < 4; i++) {
      const placed = bot.blockAt(groundPos.offset(0, 1, 0))
      if (placed && placed.name === expectName) {
        return { x: placed.position.x, y: placed.position.y, z: placed.position.z }
      }
      await sleep(120)
    }
    return null
  }

  async function executeStep(step, { api, bot, ctx, state }) {
    const type = step.type || 'unknown'

    switch (type) {
      case 'chat': {
        const message = step.message || ''
        if (message) bot.chat(String(message))
        return { ok: true, result: { type: 'chat', message } }
      }

      case 'navigate': {
        let target = null
        if (step.position) {
          target = step.position
        } else if (step.target) {
          target = resolveNavigationTarget(step.target, bot, ctx)
        }
        if (!target) {
          return { ok: false, error: { message: `Cannot resolve navigation target: ${step.target || 'none'}` } }
        }
        try {
          const timeoutMs = adaptiveTimeoutMs(step, ctx, bot, target)
          await navigateWithObstacleClear(bot, api, target, { sprint: step.sprint || false, timeoutMs })
          return { ok: true, result: { type: 'navigate', arrived: true } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'skill': {
        const code = step.code
        if (!code) {
          return { ok: false, error: { message: 'Skill step missing code' } }
        }
        const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        const result = await runSkillInSandbox({
          code: normalizedCode,
          ctx,
          api,
          timeoutMs: step.timeoutMs || adaptiveTimeoutMs(step, ctx, bot),
          filename: `${step.skillName || 'chain_skill'}.js`,
        })
        return result
      }

      case 'wait': {
        const timeoutMs = step.timeoutMs || 5000
        await sleep(timeoutMs)
        return { ok: true, result: { type: 'wait', waited: timeoutMs } }
      }

      case 'dig': {
        const blockTarget = step.target
        if (!blockTarget) {
          return { ok: false, error: { message: 'Dig step missing target' } }
        }
        if (String(blockTarget).toLowerCase() === 'crafting_table' && !state?.confirmedPlaced?.crafting_table) {
          return { ok: false, error: { message: 'dig crafting_table blocked: no confirmed place success in this chain' } }
        }
        try {
          let block = null
          if (String(blockTarget).toLowerCase() === 'crafting_table' && state?.confirmedPlaced?.crafting_table) {
            const p = state.confirmedPlaced.crafting_table
            const { Vec3 } = require('vec3')
            const candidate = bot.blockAt(new Vec3(p.x, p.y, p.z))
            if (candidate?.name === 'crafting_table') block = candidate
          }
          if (!block) block = findBlockByDescription(blockTarget, bot)
          if (!block) {
            return { ok: false, error: { message: `Block not found: ${blockTarget}` } }
          }
          const origin = bot.entity?.position
          if (origin && block.position) {
            const dist = origin.distanceTo(block.position)
            if (dist > MAX_DIG_REACH) {
              const timeoutMs = adaptiveTimeoutMs({ type: 'navigate' }, ctx, bot, {
                x: block.position.x, y: block.position.y, z: block.position.z,
              })
              await navigateWithObstacleClear(bot, api, {
                x: block.position.x,
                y: block.position.y,
                z: block.position.z,
              }, { sprint: false, timeoutMs })
            }
          }
          await withTimeout(
            bot.dig(block, 'raycast', 'raycast'),
            step.timeoutMs || adaptiveTimeoutMs(step, ctx, bot, block.position),
            async () => {
              try { bot.stopDigging?.() } catch { /* best effort */ }
              try { api.clearControlStates?.() } catch { /* best effort */ }
            },
          )
          let collected = 0
          try {
            const loot = await api.collectNearbyDrops?.({
              maxDistance: 6.5,
              timeoutMs: 3000,
              anchorPos: block.position ? { x: block.position.x, y: block.position.y, z: block.position.z } : null,
            })
            collected = Number(loot?.collected || 0)
          } catch { /* non-fatal best-effort looting */ }
          if (String(blockTarget).toLowerCase() === 'crafting_table' && state?.confirmedPlaced) {
            delete state.confirmedPlaced.crafting_table
          }
          return { ok: true, result: { type: 'dig', block: blockTarget, collected } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'place': {
        const itemName = String(step.item || 'crafting_table')
        try {
          const item = bot.inventory.items().find((i) => i.name === itemName)
          if (!item) return { ok: false, error: { message: `Item not in inventory: ${itemName}` } }
          const grounds = listPlaceGroundCandidates(bot)
          if (!grounds.length) return { ok: false, error: { message: 'No valid ground to place block' } }
          const { Vec3 } = require('vec3')
          let placedPos = null
          let lastErr = null
          for (const ground of grounds.slice(0, 3)) {
            try {
              await withTimeout(
                api.placeBlock(ground, new Vec3(0, 1, 0), item),
                step.timeoutMs || adaptiveTimeoutMs({ type: 'skill' }, ctx, bot),
                async () => {
                  try { api.clearControlStates?.() } catch { /* best effort */ }
                },
              )
              placedPos = await confirmPlaced(bot, ground.position, itemName)
              if (placedPos) break
            } catch (err) {
              lastErr = err
            }
          }
          if (!placedPos) {
            return { ok: false, error: { message: `Place not confirmed: ${itemName}${lastErr ? ` (${lastErr.message || 'error'})` : ''}` } }
          }
          if (state?.confirmedPlaced) state.confirmedPlaced[itemName] = placedPos
          return { ok: true, result: { type: 'place', item: itemName, position: placedPos, confirmed: true } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'equip': {
        const itemName = step.item
        if (!itemName) {
          return { ok: false, error: { message: 'Equip step missing item' } }
        }
        try {
          const item = bot.inventory.items().find((i) => i.name === itemName)
          if (!item) {
            return { ok: false, error: { message: `Item not in inventory: ${itemName}` } }
          }
          await bot.equip(item, 'hand')
          return { ok: true, result: { type: 'equip', item: itemName } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'attack': {
        try {
          const targetType = step.target === 'nearest' ? undefined : step.target
          const result = await api.attackNearest(targetType)
          return { ok: true, result: { type: 'attack', ...result } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'craft': {
        const itemName = step.item
        if (!itemName) {
          return { ok: false, error: { message: 'Craft step missing item' } }
        }
        try {
          const result = step.smart !== false
            ? await api.smartCraft(itemName, step.count || 1)
            : await api.craft(itemName, step.count || 1, !!step.useCraftingTable)
          return { ok: true, result: { type: 'craft', ...result } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'smelt': {
        const itemName = step.item
        if (!itemName) {
          return { ok: false, error: { message: 'Smelt step missing item' } }
        }
        try {
          const result = await api.smeltItem(itemName, {
            count: step.count || 1,
            fuelItemName: step.fuel || null,
            timeoutMs: step.timeoutMs || 22000,
            ensureFurnace: step.ensureFurnace !== false,
          })
          return { ok: true, result: { type: 'smelt', ...result } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      case 'torch': {
        try {
          const result = await api.placeTorchSmart({
            count: step.count || 1,
            itemName: step.item || 'torch',
            radius: step.radius || 3,
            force: step.force === true,
          })
          return { ok: true, result: { type: 'torch', ...result } }
        } catch (err) {
          return { ok: false, error: serializeError(err) }
        }
      }

      default:
        return { ok: false, error: { message: `Unknown action type: ${type}` } }
    }
  }

  async function navigateWithObstacleClear(bot, api, target, { sprint = false, timeoutMs = 12_000 } = {}) {
    const startPos = bot.entity?.position?.clone()
    await api.navigateTo(target, { sprint, timeoutMs })

    const endPos = bot.entity?.position
    if (!startPos || !endPos) return

    const moved = startPos.distanceTo(endPos)
    const remaining = distanceTo(endPos, target)

    if (moved < 1.5 && remaining > 2) {
      const cleared = await clearBlockInFront(bot)
      if (cleared) {
        await api.navigateTo(target, { sprint, timeoutMs: Math.max(4000, timeoutMs - 2000) })
      }
    }
  }

  async function clearBlockInFront(bot) {
    try {
      return await clearObstacleInFront(bot)
    } catch {
      return false
    }
  }

  function resolveNavigationTarget(description, bot, ctx) {
    const desc = (description || '').toLowerCase()

    if (desc === 'nearest_player' || desc === 'player') {
      const entities = ctx?.snapshot?.nearby?.entities || []
      const players = entities
        .filter((e) => String(e.type || '').toLowerCase() === 'player' || !!e.username)
        .sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity))
      if (players[0]?.position) return players[0].position
      const origin = bot.entity?.position
      if (!origin) return null
      const live = Object.values(bot.entities || {})
        .filter((e) => e?.position && e.id !== bot.entity?.id && (e.type === 'player' || !!e.username))
        .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))
      if (live[0]?.position) return { x: live[0].position.x, y: live[0].position.y, z: live[0].position.z }
      return null
    }

    if (desc.startsWith('nearest_')) {
      const blockName = desc.replace('nearest_', '').replace(/_/g, ' ')

      // Tier 1: check snapshot (radius 5)
      const blocks = ctx?.snapshot?.nearby?.blocks || []
      const match = blocks.find((b) => {
        const n = (b.name || '').toLowerCase().replace(/_/g, ' ')
        return n.includes(blockName)
      })
      const blockPos = match?.pos || match?.position
      if (blockPos) return blockPos

      // Tier 2: extended search via bot.findBlock (radius 32, fast chunk lookup)
      try {
        const mcData = require('minecraft-data')(bot.version)
        const searchName = desc.replace('nearest_', '')
        const blockType = mcData.blocksByName[searchName]
        if (!blockType) return null
        if (blockType) {
          const found = bot.findBlock({
            matching: blockType.id,
            maxDistance: 32,
          })
          if (found?.position) {
            return { x: found.position.x, y: found.position.y, z: found.position.z }
          }
        }
      } catch { /* mcData or findBlock unavailable, continue */ }
      return null
    }

    const entities = ctx?.snapshot?.nearby?.entities || []
    const entityMatch = entities.find((e) => {
      const n = (e.name || '').toLowerCase()
      return n.includes(desc) || desc.includes(n)
    })
    if (entityMatch?.position) return entityMatch.position

    return null
  }

  function findBlockByDescription(description, bot) {
    const desc = (description || '').toLowerCase().replace(/ /g, '_')
    const origin = bot.entity?.position
    if (!origin) return null

    // Tier 1: nearby scan (radius 5), prefer exact match then partial
    const radius = 5
    const floored = origin.floored()
    let exactMatch = null
    let partialMatch = null
    let bestDist = Infinity
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const block = bot.blockAt(floored.offset(dx, dy, dz))
          if (block && block.name !== 'air') {
            const name = block.name.toLowerCase()
            const dist = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
            if (name === desc && dist < bestDist) {
              exactMatch = block
              bestDist = dist
            } else if (!exactMatch && name.includes(desc)) {
              partialMatch = block
            }
          }
        }
      }
    }

    if (exactMatch) return exactMatch
    if (partialMatch) return partialMatch

    // Tier 2: extended search via bot.findBlock (radius 16)
    try {
      const mcData = require('minecraft-data')(bot.version)
      const blockType = mcData.blocksByName[desc]
      if (blockType) {
        return bot.findBlock({ matching: blockType.id, maxDistance: 16 }) || null
      }
    } catch { /* fallback failed */ }

    return null
  }

  function validateStepPolicy(step) {
    const type = String(step?.type || '')
    if (type === 'navigate' && !step.position && !step.target) {
      return { ok: false, message: 'navigate requires target or position' }
    }
    if (type === 'navigate' && typeof step.target === 'string') {
      const t = step.target.trim().toLowerCase()
      if (t.startsWith('nearest_') && !/^[a-z0-9_]+$/.test(t)) {
        return { ok: false, message: `invalid navigate target format: ${step.target}` }
      }
    }
    if (type === 'dig' && typeof step.target === 'string') {
      const t = step.target.trim().toLowerCase()
      if (t.includes('player')) return { ok: false, message: 'dig target cannot be player-like' }
    }
    if (type === 'place' && !step.item) {
      return { ok: false, message: 'place requires item name' }
    }
    if (type === 'smelt' && !step.item) {
      return { ok: false, message: 'smelt requires item name' }
    }
    return { ok: true }
  }

  async function run({ chain, api, bot, ctx, reflexLayer, logger, cycle }) {
    const total = chain.length
    let completed = 0
    let interrupted = false
    let failedStep = null
    const results = []
    const state = { confirmedPlaced: {} }

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]

      // Mid-chain reflex check: sense between steps
      if (i > 0 && reflexLayer) {
        const midSnapshot = sense(bot, { radius: 5 })
        const reflexAction = reflexLayer.check(midSnapshot, ctx)
        if (reflexAction) {
          if (logger) {
            await logger.log({
              type: 'chain_reflex_interrupt', cycle,
              step: i, action: reflexAction.name, reason: reflexAction.reason,
            })
          }
          try {
            await reflexAction.execute({ api, bot, ctx })
          } catch { /* reflex must not crash chain */ }
          interrupted = true
          break
        }
      }

      if (logger) {
        await logger.log({
          type: 'chain_step_start', cycle,
          stepIndex: i, stepType: step.type, total,
        })
      }

      const policy = validateStepPolicy(step)
      if (!policy.ok) {
        failedStep = { index: i, type: step.type, error: { message: policy.message } }
        results.push({ step: i, type: step.type, ok: false, error: { message: policy.message } })
        if (logger) {
          await logger.log({
            type: 'chain_step_rejected',
            cycle,
            stepIndex: i,
            stepType: step.type,
            reason: policy.message,
          })
        }
        break
      }

      const stepResult = await executeStep(step, { api, bot, ctx, state })
      results.push({ step: i, type: step.type, ...stepResult })

      if (logger) {
        await logger.log({
          type: 'chain_step_end', cycle,
          stepIndex: i, stepType: step.type,
          ok: stepResult.ok,
          error: stepResult.error?.message || null,
        })
      }

      if (stepResult.ok) {
        completed += 1
      } else {
        failedStep = { index: i, type: step.type, error: stepResult.error }
        break
      }
    }

    return Object.freeze({
      completed,
      total,
      interrupted,
      failedStep,
      results,
    })
  }

  return Object.freeze({ run, executeStep })
}

module.exports = { createChainExecutor }
