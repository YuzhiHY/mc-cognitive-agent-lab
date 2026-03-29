const { Vec3 } = require('vec3')
const { clearObstacleInFront } = require('./obstacleNav')
const { feel } = require('./feeler')
const { createStableSkillOps } = require('./skills/stableSkillOps')
const {
  successResult,
  failureResult,
  invalidResult,
} = require('./contracts/executionResult')

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


function createApi(bot) {
  const hasPathfinder = () => {
    ensurePathfinder(bot)
    return !!bot.pathfinder
  }

  let api = {
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
    digByName: async (blockName, { maxDistance = 16, navigate = true, abortSignal } = {}) => {
      const mcData = require('minecraft-data')(bot.version)
      const blockType = mcData.blocksByName[blockName]
      if (!blockType) throw new Error(`api.digByName: unknown block '${blockName}'`)
      let found = bot.findBlock({ matching: blockType.id, maxDistance })
      if (!found) throw new Error(`api.digByName: no '${blockName}' found within ${maxDistance}`)
      const origin = bot.entity?.position
      if (navigate && origin && found.position && origin.distanceTo(found.position) > 4.2) {
        if (abortSignal?.aborted) return { dug: null, reason: 'aborted' }
        const navResult = await api.navigateTo({ x: found.position.x, y: found.position.y, z: found.position.z }, { sprint: false, timeoutMs: 12_000, abortSignal })
        if (navResult?.reason === 'aborted') return { dug: null, reason: 'aborted' }
        found = bot.findBlock({ matching: blockType.id, maxDistance }) || found
      }
      const center = found.position.offset(0.5, 0.5, 0.5)
      const canSee = typeof bot.canSeeBlock === 'function'
        ? () => bot.canSeeBlock(found)
        : () => true
      const lookTargets = [
        new Vec3(0.5, 0.5, 0.5),
        new Vec3(0.5, 0.2, 0.5),
        new Vec3(0.5, 0.85, 0.5),
        new Vec3(0.25, 0.5, 0.25),
        new Vec3(0.75, 0.5, 0.75),
        new Vec3(0.5, 0.5, 0.15),
        new Vec3(0.5, 0.5, 0.85),
      ]
      for (let attempt = 0; attempt < lookTargets.length; attempt++) {
        const o = lookTargets[attempt]
        try {
          await bot.lookAt(found.position.offset(o.x, o.y, o.z), true)
        } catch { /* ignore look errors */ }
        await sleep(attempt === 0 ? 45 : 95)
        if (canSee()) break
      }
      if (!canSee() && navigate && origin && found.position) {
        const d = origin.distanceTo(found.position)
        if (d > 1.85 && d < 8) {
          if (abortSignal?.aborted) return { dug: null, reason: 'aborted' }
          try {
            const navResult = await api.navigateTo({ x: found.position.x, y: found.position.y, z: found.position.z }, { sprint: false, timeoutMs: 10_000, abortSignal })
            if (navResult?.reason === 'aborted') return { dug: null, reason: 'aborted' }
          } catch { /* */ }
          found = bot.findBlock({ matching: blockType.id, maxDistance }) || found
          try {
            await bot.lookAt(found.position.offset(0.5, 0.5, 0.5), true)
          } catch { /* */ }
          await sleep(120)
        }
      }
      if (!canSee() && origin && found.position) {
        const eye = origin.offset(0, bot.entity.eyeHeight, 0)
        const c = found.position.offset(0.5, 0.5, 0.5)
        const dx = c.x - eye.x
        const dz = c.z - eye.z
        const yaw = Math.atan2(-dx, -dz)
        try {
          await bot.look(yaw, 0.28, true)
          bot.setControlState('forward', true)
          await sleep(200)
          bot.setControlState('forward', false)
          await sleep(100)
        } catch { /* */ }
        found = bot.findBlock({ matching: blockType.id, maxDistance }) || found
        for (let a = 0; a < 4; a++) {
          const o = lookTargets[Math.min(a, lookTargets.length - 1)]
          try {
            await bot.lookAt(found.position.offset(o.x, o.y, o.z), true)
          } catch { /* */ }
          await sleep(85)
          if (canSee()) break
        }
      }
      // Try to dig even if canSee reports false — bot.dig will throw if truly unreachable.
      // canSeeBlock is unreliable in many positions (corners, half-slabs, near water).
      try {
        await bot.dig(found, 'raycast', 'raycast')
      } catch (digErr) {
        // If raycast dig fails, try without raycast as fallback
        if (!canSee()) {
          throw new Error(`api.digByName: block not in view after alignment (${blockName})`)
        }
        throw digErr
      }
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

    navigateTo: async (pos, { sprint = false, timeoutMs = 15_000, abortSignal } = {}) => {
      if (!pos) throw new Error('api.navigateTo: missing pos')
      if (abortSignal?.aborted) {
        return { arrived: false, reason: 'aborted_before_start' }
      }
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
      const navTarget = pos // capture for feeler

      const stuckInterval = setInterval(async () => {
        if (bot.targetDigBlock) return
        const curPos = bot.entity?.position
        if (!curPos || !lastCheckPos) { lastCheckPos = curPos?.clone(); return }
        const moved = lastCheckPos.distanceTo(curPos)
        lastCheckPos = curPos.clone()
        if (moved < 0.3) {
          stuckChecks++
          if (stuckChecks >= 1) {
            // Phase 1: feeler — movement-first compensation
            try {
              const result = await feel(bot, navTarget, { allowDig: stuckChecks >= 3 })
              if (result.compensated) { stuckChecks = Math.max(0, stuckChecks - 1); return }
            } catch { /* */ }
            // Phase 2: legacy obstacle clearing (only after feeler fails twice)
            if (stuckChecks >= 2) {
              try { await clearObstacleInFront(bot) } catch { /* */ }
              stuckChecks = 0
            }
          }
        } else {
          stuckChecks = 0
        }
      }, 1500)

      return await new Promise((resolve, reject) => {
        let timer = null
        let abortPoll = null
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
        const onAbort = () => {
          cleanup()
          try { bot.pathfinder.setGoal(null) } catch { /* */ }
          const controls = ['forward','back','left','right','jump','sprint','sneak']
          for (const c of controls) bot.setControlState(c, false)
          resolve({ arrived: false, reason: 'aborted' })
        }
        const cleanup = () => {
          clearInterval(stuckInterval)
          if (timer) clearTimeout(timer)
          if (abortPoll) clearInterval(abortPoll)
          bot.off('goal_reached', onArrived)
          bot.off('path_stopped', onPathStopped)
          bot.off('path_update', onPathUpdate)
        }
        timer = setTimeout(onTimeout, timeoutMs)
        // Poll abort signal at high frequency so long navigations resolve quickly on abort
        if (abortSignal) {
          abortPoll = setInterval(() => {
            if (abortSignal.aborted) onAbort()
          }, 80)
        }
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

    collectNearbyDrops: async ({ maxDistance = 5, timeoutMs = 2500, anchorPos = null, abortSignal } = {}) => {
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
        if (abortSignal?.aborted) break
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
    placeNamedBlock: async (itemName) => {
      const normalized = normalizeItemName(itemName)
      const item = bot.inventory.items().find((i) => i.name === normalized)
      if (!item) throw new Error(`api.placeNamedBlock: missing item '${normalized}'`)
      const origin = bot.entity?.position?.floored?.()
      if (!origin) throw new Error('api.placeNamedBlock: missing position')
      const { Vec3 } = require('vec3')
      const bases = [
        origin.offset(1, -1, 0), origin.offset(-1, -1, 0),
        origin.offset(0, -1, 1), origin.offset(0, -1, -1),
        origin.offset(0, -1, 0),
      ]
      for (const p of bases) {
        const ground = bot.blockAt(p)
        const above = bot.blockAt(p.offset(0, 1, 0))
        if (!ground || ground.name === 'air') continue
        if (!above || above.name !== 'air') continue
        try {
          await bot.equip(item, 'hand')
          await bot.placeBlock(ground, new Vec3(0, 1, 0))
          return { item: normalized, placed: true }
        } catch { /* next */ }
      }
      throw new Error(`api.placeNamedBlock: no valid place spot for '${normalized}'`)
    },
    eatFood: async (itemName) => {
      const normalized = normalizeItemName(itemName)
      const item = bot.inventory.items().find((i) => i.name === normalized)
      if (!item) throw new Error(`api.eatFood: missing item '${normalized}'`)
      await bot.equip(item, 'hand')
      bot.activateItem()
      await sleep(1850)
      bot.deactivateItem()
      return { ate: normalized }
    },
    retreatFromThreat: async () => {
      const origin = bot.entity?.position
      if (!origin) throw new Error('api.retreatFromThreat: missing position')
      const target = Object.values(bot.entities || {})
        .filter((e) => e?.position && e.id !== bot.entity?.id)
        .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))[0]
      if (!target?.position) throw new Error('api.retreatFromThreat: no nearby threat')
      const dx = origin.x - target.position.x
      const dz = origin.z - target.position.z
      const yaw = Math.atan2(-dx, -dz)
      await bot.look(yaw, bot.entity.pitch, true)
      bot.setControlState('sprint', true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(900)
      api.clearControlStates()
      return { retreated: true }
    },
    recoverFromStuck: async () => {
      await clearObstacleInFront(bot)
      bot.setControlState('jump', true)
      await sleep(220)
      bot.setControlState('jump', false)
      return { recovered: true }
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

    smartCraft: async () => { throw new Error('api.smartCraft: uninitialized') },
    craftItem: async (itemName, count = 1) => api.smartCraft(itemName, count),
    craftAny: async (itemName, count = 1) => api.smartCraft(itemName, count),

    smeltItem: async () => { throw new Error('api.smeltItem: uninitialized') },

    placeTorchSmart: async () => { throw new Error('api.placeTorchSmart: uninitialized') },

    getCapabilities: () => ({
      canNavigate: hasPathfinder(),
      canAttack: true,
      canDig: true,
      canPlace: true,
      canCraft: true,
      canSmelt: true,
      canTorch: true,
    }),

    // Phase 1 normalized API execution contract entry.
    // Keeps existing methods unchanged while providing a status-first path.
    executeAction: async (actionType, payload = {}) => {
      const startedAt = Date.now()
      const t = String(actionType || '').trim()
      const done = (details, reason = 'ok') => successResult({
        source: 'api',
        actionType: t || 'unknown',
        startedAt,
        endedAt: Date.now(),
        reason,
        details,
      })
      const fail = (err, reason = 'api_action_failed', kind = 'failure') => {
        const factory = kind === 'invalid' ? invalidResult : failureResult
        return factory({
          source: 'api',
          actionType: t || 'unknown',
          startedAt,
          endedAt: Date.now(),
          reason,
          errorMessage: err?.message || String(err),
          details: { error: err?.message || String(err), payload },
        })
      }
      try {
        switch (t) {
          case 'navigate': {
            if (!payload?.pos) return fail(new Error('navigate requires payload.pos'), 'missing_pos', 'invalid')
            const result = await api.navigateTo(payload.pos, payload.options || {})
            return done(result, result?.arrived ? 'arrived' : 'navigate_not_arrived')
          }
          case 'digByName': {
            if (!payload?.name) return fail(new Error('digByName requires payload.name'), 'missing_name', 'invalid')
            const result = await api.digByName(payload.name, payload.options || {})
            return done(result, 'dug')
          }
          case 'craftAny': {
            if (!payload?.item) return fail(new Error('craftAny requires payload.item'), 'missing_item', 'invalid')
            const result = await api.craftAny(payload.item, payload.count || 1)
            return done(result, 'crafted')
          }
          case 'smeltItem': {
            if (!payload?.item) return fail(new Error('smeltItem requires payload.item'), 'missing_item', 'invalid')
            const result = await api.smeltItem(payload.item, payload.options || {})
            return done(result, 'smelted')
          }
          case 'placeTorchSmart': {
            const result = await api.placeTorchSmart(payload.options || {})
            return done(result, 'torch_placed')
          }
          case 'attackNearest': {
            const result = await api.attackNearest(payload.entityType)
            return done(result, 'attacked')
          }
          case 'placeNamedBlock': {
            if (!payload?.item) return fail(new Error('placeNamedBlock requires payload.item'), 'missing_item', 'invalid')
            const result = await api.placeNamedBlock(payload.item)
            return done(result, 'placed')
          }
          case 'eatFood': {
            if (!payload?.item) return fail(new Error('eatFood requires payload.item'), 'missing_item', 'invalid')
            const result = await api.eatFood(payload.item)
            return done(result, 'ate')
          }
          case 'retreatFromThreat': {
            const result = await api.retreatFromThreat()
            return done(result, 'retreated')
          }
          case 'recoverFromStuck': {
            const result = await api.recoverFromStuck()
            return done(result, 'recovered')
          }
          default:
            return fail(new Error(`Unknown actionType: ${t}`), 'unknown_action_type', 'invalid')
        }
      } catch (err) {
        return fail(err)
      }
    },

    // Key contract-wrapped exits for status-first consumers.
    navigateToResult: async (pos, options = {}) => api.executeAction('navigate', { pos, options }),
    digByNameResult: async (name, options = {}) => api.executeAction('digByName', { name, options }),
    craftAnyResult: async (item, count = 1) => api.executeAction('craftAny', { item, count }),
    smeltItemResult: async (item, options = {}) => api.executeAction('smeltItem', { item, options }),
    placeTorchSmartResult: async (options = {}) => api.executeAction('placeTorchSmart', { options }),
    attackNearestResult: async (entityType) => api.executeAction('attackNearest', { entityType }),
  }

  // Transitional compatibility bridge: craft/smelt/torch are delegated to stableSkillOps.
  // TODO(phase4): move these into dedicated modular skills and keep API strictly primitive.
  const stableOps = createStableSkillOps(bot)
  api.smartCraft = async (itemName, count = 1) => stableOps.smartCraft(itemName, count)
  api.smeltItem = async (itemName, options = {}) => stableOps.smeltItem(itemName, options)
  api.placeTorchSmart = async (options = {}) => stableOps.placeTorchSmart(options)

  return Object.freeze(api)
}

module.exports = { createApi }

