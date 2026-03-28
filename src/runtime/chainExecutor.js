const { clearObstacleInFront } = require('./obstacleNav')
const { runSkillInSandbox, serializeError, withTimeout } = require('./sandbox')
const {
  successResult,
  failureResult,
  invalidResult,
  blockedResult,
  interruptedResult,
} = require('./contracts/executionResult')
const { runSkillWithContract } = require('./contracts/skillContract')
const { createStableSkillRepository } = require('./skills')

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

function createChainExecutor({ hardcodedSkillsFactory = null } = {}) {
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

  async function executeStep(step, { api, bot, ctx, state, signal }) {
    const type = step.type || 'unknown'
    const startedAt = Date.now()
    const okOut = (result, reason = 'ok') => {
      const executionResult = successResult({
        source: 'chain',
        actionType: type,
        startedAt,
        endedAt: Date.now(),
        reason,
        details: { result },
      })
      return { ...executionResult, executionResult, result }
    }
    const failOut = (error, reason = 'step_failed', kind = 'failure') => {
      const msg = error?.message || String(error || reason)
      const factory = kind === 'invalid' ? invalidResult : (kind === 'blocked' ? blockedResult : failureResult)
      const executionResult = factory({
        source: 'chain',
        actionType: type,
        startedAt,
        endedAt: Date.now(),
        reason,
        errorMessage: msg,
        details: { error: serializeError(error) },
      })
      return { ...executionResult, executionResult, error: serializeError(error) || { message: msg } }
    }

    switch (type) {
      case 'skill_ref': {
        const skillName = String(step.name || '')
        if (!skillName) return failOut(new Error('skill_ref requires name'), 'missing_skill_name', 'invalid')
        const repo = typeof hardcodedSkillsFactory === 'function'
          ? hardcodedSkillsFactory({ api, bot })
          : createStableSkillRepository({ api, bot })
        const skill = repo?.get?.(skillName)
        if (!skill) return failOut(new Error(`Unknown hardcoded skill: ${skillName}`), 'unknown_skill_ref', 'invalid')
        const res = await runSkillWithContract({
          skill,
          api,
          bot,
          ctx,
          args: step.args || {},
        })
        return { ...res, result: res?.details?.output }
      }
      case 'chat': {
        const message = step.message || ''
        if (message) bot.chat(String(message))
        return okOut({ type: 'chat', message }, 'chat_sent')
      }

      case 'navigate': {
        let target = null
        if (step.position) {
          target = step.position
        } else if (step.target) {
          target = resolveNavigationTarget(step.target, bot, ctx)
        }
        if (!target) {
          return failOut(new Error(`Cannot resolve navigation target: ${step.target || 'none'}`), 'target_unresolved', 'invalid')
        }
        try {
          const timeoutMs = adaptiveTimeoutMs(step, ctx, bot, target)
          const navResult = await navigateWithObstacleClear(bot, api, target, { sprint: step.sprint || false, timeoutMs, abortSignal: signal })
          if (navResult?.reason === 'aborted') {
            return { ...interruptedResult({ source: 'chain', actionType: 'navigate', startedAt, endedAt: Date.now(), interruptReason: 'abort_signal', details: {} }), result: navResult }
          }
          return okOut({ type: 'navigate', arrived: true }, 'arrived')
        } catch (err) {
          const msg = String(err?.message || err || '').toLowerCase()
          if (/path|stuck|timeout|no path|goal|movement/i.test(msg)) {
            try { ctx?.reportStuck?.('navigate_failed') } catch { /* */ }
          }
          return failOut(err, 'navigate_failed')
        }
      }

      case 'skill': {
        const code = step.code
        if (!code) {
          return failOut(new Error('Skill step missing code'), 'missing_skill_code', 'invalid')
        }
        const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        const result = await runSkillInSandbox({
          code: normalizedCode,
          ctx,
          api,
          timeoutMs: step.timeoutMs || adaptiveTimeoutMs(step, ctx, bot),
          filename: `${step.skillName || 'chain_skill'}.js`,
        })
        // Sandbox now returns normalized execution result directly.
        const output = result?.details?.output
        if (output !== undefined) return { ...result, result: output }
        return result
      }

      case 'wait': {
        const timeoutMs = step.timeoutMs || 5000
        // Abort-aware sleep: check signal every 200ms instead of blocking
        if (signal) {
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            if (signal.aborted) {
              return { ...interruptedResult({ source: 'chain', actionType: 'wait', startedAt, endedAt: Date.now(), interruptReason: 'abort_signal', details: {} }), result: { type: 'wait', aborted: true } }
            }
            await sleep(Math.min(200, deadline - Date.now()))
          }
        } else {
          await sleep(timeoutMs)
        }
        return okOut({ type: 'wait', waited: timeoutMs }, 'wait_done')
      }

      case 'dig': {
        const blockTarget = step.target
        if (!blockTarget) {
          return failOut(new Error('Dig step missing target'), 'missing_dig_target', 'invalid')
        }
        if (String(blockTarget).toLowerCase() === 'crafting_table' && !state?.confirmedPlaced?.crafting_table) {
          return failOut(new Error('dig crafting_table blocked: no confirmed place success in this chain'), 'dig_blocked_by_place_gate', 'blocked')
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
            return failOut(new Error(`Block not found: ${blockTarget}`), 'target_block_not_found', 'invalid')
          }
          const origin = bot.entity?.position
          if (origin && block.position) {
            const dist = origin.distanceTo(block.position)
            if (dist > MAX_DIG_REACH) {
              if (signal?.aborted) {
                return { ...interruptedResult({ source: 'chain', actionType: 'dig', startedAt, endedAt: Date.now(), interruptReason: 'abort_signal', details: {} }), result: { aborted: true } }
              }
              const timeoutMs = adaptiveTimeoutMs({ type: 'navigate' }, ctx, bot, {
                x: block.position.x, y: block.position.y, z: block.position.z,
              })
              try {
                const navResult = await navigateWithObstacleClear(bot, api, {
                  x: block.position.x,
                  y: block.position.y,
                  z: block.position.z,
                }, { sprint: false, timeoutMs, abortSignal: signal })
                if (navResult?.reason === 'aborted') {
                  return { ...interruptedResult({ source: 'chain', actionType: 'dig', startedAt, endedAt: Date.now(), interruptReason: 'abort_signal', details: {} }), result: { aborted: true } }
                }
              } catch (e) {
                const msg = String(e?.message || e || '').toLowerCase()
                if (/path|stuck|timeout|no path|goal|movement/i.test(msg)) {
                  try { ctx?.reportStuck?.('dig_nav_failed') } catch { /* */ }
                }
                return failOut(e, 'dig_navigate_failed')
              }
            }
          }
          try {
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
          } catch { /* */ }
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
          return okOut({ type: 'dig', block: blockTarget, collected }, 'dig_done')
        } catch (err) {
          return failOut(err, 'dig_failed')
        }
      }

      case 'place': {
        const itemName = String(step.item || 'crafting_table')
        try {
          const item = bot.inventory.items().find((i) => i.name === itemName)
          if (!item) return failOut(new Error(`Item not in inventory: ${itemName}`), 'missing_item', 'invalid')
          const grounds = listPlaceGroundCandidates(bot)
          if (!grounds.length) return failOut(new Error('No valid ground to place block'), 'no_place_ground', 'blocked')
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
            return failOut(new Error(`Place not confirmed: ${itemName}${lastErr ? ` (${lastErr.message || 'error'})` : ''}`), 'place_not_confirmed')
          }
          if (state?.confirmedPlaced) state.confirmedPlaced[itemName] = placedPos
          return okOut({ type: 'place', item: itemName, position: placedPos, confirmed: true }, 'place_done')
        } catch (err) {
          return failOut(err, 'place_failed')
        }
      }

      case 'equip': {
        const itemName = step.item
        if (!itemName) {
          return failOut(new Error('Equip step missing item'), 'missing_equip_item', 'invalid')
        }
        try {
          const item = bot.inventory.items().find((i) => i.name === itemName)
          if (!item) {
            return failOut(new Error(`Item not in inventory: ${itemName}`), 'missing_item', 'invalid')
          }
          await bot.equip(item, 'hand')
          return okOut({ type: 'equip', item: itemName }, 'equip_done')
        } catch (err) {
          return failOut(err, 'equip_failed')
        }
      }

      case 'attack': {
        try {
          const targetType = step.target === 'nearest' ? undefined : step.target
          const result = await api.attackNearest(targetType)
          return okOut({ type: 'attack', ...result }, 'attack_done')
        } catch (err) {
          return failOut(err, 'attack_failed')
        }
      }

      case 'craft': {
        const itemName = step.item
        if (!itemName) {
          return failOut(new Error('Craft step missing item'), 'missing_craft_item', 'invalid')
        }
        try {
          const result = step.smart !== false
            ? await api.smartCraft(itemName, step.count || 1)
            : await api.craft(itemName, step.count || 1, !!step.useCraftingTable)
          return okOut({ type: 'craft', ...result }, 'craft_done')
        } catch (err) {
          return failOut(err, 'craft_failed')
        }
      }

      case 'smelt': {
        const itemName = step.item
        if (!itemName) {
          return failOut(new Error('Smelt step missing item'), 'missing_smelt_item', 'invalid')
        }
        try {
          const result = await api.smeltItem(itemName, {
            count: step.count || 1,
            fuelItemName: step.fuel || null,
            timeoutMs: step.timeoutMs || 22000,
            ensureFurnace: step.ensureFurnace !== false,
          })
          return okOut({ type: 'smelt', ...result }, 'smelt_done')
        } catch (err) {
          return failOut(err, 'smelt_failed')
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
          return okOut({ type: 'torch', ...result }, 'torch_done')
        } catch (err) {
          return failOut(err, 'torch_failed')
        }
      }

      default:
        return failOut(new Error(`Unknown action type: ${type}`), 'unknown_action_type', 'invalid')
    }
  }

  async function navigateWithObstacleClear(bot, api, target, { sprint = false, timeoutMs = 12_000, abortSignal } = {}) {
    const startPos = bot.entity?.position?.clone()
    const result = await api.navigateTo(target, { sprint, timeoutMs, abortSignal })
    if (result?.reason === 'aborted') return result

    const endPos = bot.entity?.position
    if (!startPos || !endPos) return result

    const moved = startPos.distanceTo(endPos)
    const remaining = distanceTo(endPos, target)

    if (moved < 1.5 && remaining > 2) {
      if (abortSignal?.aborted) return { arrived: false, reason: 'aborted' }
      const cleared = await clearBlockInFront(bot)
      if (cleared) {
        const r2 = await api.navigateTo(target, { sprint, timeoutMs: Math.max(4000, timeoutMs - 2000), abortSignal })
        return r2
      }
    }
    return result
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

  async function run({ chain, api, bot, ctx, reflexLayer, logger, cycle, runControl }) {
    const total = chain.length
    let completed = 0
    let interrupted = false
    let failedStep = null
    const results = []
    const state = { confirmedPlaced: {} }
    const signal = runControl?.signal

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]

      if (signal?.aborted) {
        interrupted = true
        const ir = interruptedResult({
          source: 'chain',
          actionType: 'external_abort',
          startedAt: Date.now(),
          endedAt: Date.now(),
          interruptReason: signal.reason || 'chain_aborted',
          details: { stepIndex: i, abortedAt: signal.at },
        })
        results.push({ step: i, type: 'external_abort', ...ir })
        if (logger) {
          await logger.log({
            type: 'chain_aborted',
            cycle,
            stepIndex: i,
            reason: signal.reason || 'aborted',
            total,
          })
        }
        break
      }

      // Reflex / interrupts are owned by daemon + taskStateMachine; do not execute reflex here.

      if (logger) {
        await logger.log({
          type: 'chain_step_start', cycle,
          stepIndex: i, stepType: step.type, total,
        })
      }

      const policy = validateStepPolicy(step)
      if (!policy.ok) {
        failedStep = { index: i, type: step.type, error: { message: policy.message } }
        const ir = invalidResult({
          source: 'chain',
          actionType: step.type,
          startedAt: Date.now(),
          endedAt: Date.now(),
          reason: 'step_policy_rejected',
          errorMessage: policy.message,
          details: { stepIndex: i },
        })
        results.push({ step: i, type: step.type, ...ir })
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

      const stepResult = await executeStep(step, { api, bot, ctx, state, signal })
      results.push({ step: i, type: step.type, ...stepResult })

      if (signal?.aborted) {
        interrupted = true
        const ir = interruptedResult({
          source: 'chain',
          actionType: 'external_abort',
          startedAt: Date.now(),
          endedAt: Date.now(),
          interruptReason: signal.reason || 'chain_aborted_after_step',
          details: { stepIndex: i + 1, abortedAt: signal.at },
        })
        results.push({ step: i + 1, type: 'external_abort', ...ir })
        if (logger) {
          await logger.log({
            type: 'chain_aborted',
            cycle,
            stepIndex: i + 1,
            reason: signal.reason || 'aborted',
            afterStep: i,
            total,
          })
        }
        break
      }

      if (logger) {
        await logger.log({
          type: 'chain_step_end', cycle,
          stepIndex: i, stepType: step.type,
          ok: stepResult.ok,
          status: stepResult.status || null,
          reason: stepResult.reason || null,
          error: stepResult.errorMessage || stepResult.error?.message || null,
        })
      }

      if (stepResult.ok) {
        completed += 1
      } else {
        failedStep = {
          index: i,
          type: step.type,
          error: stepResult.error || { message: stepResult.errorMessage || stepResult.reason || 'step_failed' },
        }
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
