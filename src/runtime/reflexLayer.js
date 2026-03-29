function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
const {
  successResult,
  failureResult,
  invalidResult,
} = require('./contracts/executionResult')
const {
  noInterrupt,
  reflexInterrupt,
} = require('./contracts/interruptDecision')

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton',
  'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'evoker', 'vex', 'hoglin', 'piglin_brute', 'warden',
  'zombified_piglin', 'guardian', 'elder_guardian', 'shulker',
])

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'golden_apple',
  'apple', 'melon_slice', 'sweet_berries', 'carrot', 'beetroot', 'dried_kelp',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie', 'cookie',
  'golden_carrot', 'enchanted_golden_apple',
])

function hasFoodInInventory(inventory) {
  const items = Array.isArray(inventory?.summary) ? inventory.summary : (Array.isArray(inventory) ? inventory : [])
  return items.some((item) => FOOD_ITEMS.has(item?.name))
}

function isNearLava(blocks) {
  if (!Array.isArray(blocks)) return false
  return blocks.some((b) =>
    (b.name === 'lava' || b.name === 'flowing_lava') && (b.distance || Infinity) <= 2
  )
}

/**
 * Extract a unified reflex view from any snapshot shape (flat or tiered).
 * Rule conditions ONLY read from this view + internal reflex state — never from bot.
 */
function extractReflexView(snapshot) {
  const rc = snapshot?.reflexContext || {}
  const s = snapshot?.status || {}
  return {
    health: rc.health ?? s.health ?? 20,
    food: rc.food ?? s.food ?? 20,
    inWater: rc.inWater ?? false,
    onFire: rc.onFire ?? false,
    isInLava: rc.isInLava ?? false,
    onGround: rc.onGround ?? true,
    vy: rc.vy ?? 0,
    oxygenLevel: rc.oxygenLevel ?? 20,
    belowAir: rc.belowAir ?? false,
    below2Air: rc.below2Air ?? false,
    nearestHostileVec: rc.nearestHostileVec ?? null,
    nearestCreeperVec: rc.nearestCreeperVec ?? null,
    hostilesWithin3: rc.hostilesWithin3 ?? 0,
    hostilesWithin7: rc.hostilesWithin7 ?? 0,
    hasWeapon: rc.hasWeapon ?? false,
    hasFood: rc.hasFood ?? false,
    // From flat snapshot fields
    threat_level: snapshot?.threat_level || 'none',
    close_threat: snapshot?.close_threat === true,
    recentDamageMs: s.recentDamageMs ?? null,
    inventory: snapshot?.inventory || null,
    nearbyBlocks: snapshot?.nearby?.blocks || [],
  }
}

function columnBlockedAt(bot, floored, fx, fz) {
  const cell = floored.offset(fx, 0, fz)
  const low = bot.blockAt(cell)
  const high = bot.blockAt(cell.offset(0, 1, 0))
  const solid = (b) => b && b.name !== 'air' && b.name !== 'bedrock'
  return solid(low) && solid(high)
}

/** No pathfinder / api.navigateTo — immediate sprint in clearest away direction */
async function pureFleeBurst(bot, awayDx, awayDz, ms = 900, opts = {}) {
  const useJump = opts.jump !== false
  const pos = bot.entity?.position
  const floored = pos?.floored()
  if (!pos || !floored) return
  let dx = awayDx
  let dz = awayDz
  const mag = Math.sqrt(dx * dx + dz * dz) || 1
  dx /= mag
  dz /= mag
  const dirs = [[dx, dz], [-dz, dx], [dz, -dx], [-dx, -dz]]
  try { bot.pathfinder?.setGoal?.(null) } catch { /* */ }
  for (const [tx, tz] of dirs) {
    const fx = Math.round(tx)
    const fz = Math.round(tz)
    if (columnBlockedAt(bot, floored, fx, fz)) continue
    const yaw = Math.atan2(-tx, -tz)
    await bot.look(yaw, bot.entity.pitch, true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    if (useJump) bot.setControlState('jump', true)
    await sleep(ms)
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    return
  }
  const yaw = Math.atan2(-dx, -dz)
  await bot.look(yaw, bot.entity.pitch, true)
  bot.setControlState('sprint', true)
  bot.setControlState('forward', true)
  if (useJump) bot.setControlState('jump', true)
  await sleep(Math.floor(ms * (useJump ? 0.65 : 0.85)))
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
  bot.setControlState('jump', false)
}

// Live bot helpers — used in execute() functions only (body control needs real-time data)
function vectorFromNearestHostile(bot) {
  const origin = bot.entity?.position
  if (!origin) return null
  let best = null
  let bestD = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e.id === bot.entity?.id) continue
    const name = (e.name || e.kind || '').toLowerCase()
    if (!HOSTILE_MOBS.has(name)) continue
    const d = origin.distanceTo(e.position)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  if (!best) return null
  return {
    dx: origin.x - best.position.x,
    dz: origin.z - best.position.z,
    dist: bestD,
  }
}

function vectorFromNearestCreeper(bot) {
  const origin = bot.entity?.position
  if (!origin) return null
  let best = null
  let bestD = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e.id === bot.entity?.id) continue
    if ((e.name || '').toLowerCase() !== 'creeper') continue
    const d = origin.distanceTo(e.position)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  if (!best) return null
  return {
    dx: origin.x - best.position.x,
    dz: origin.z - best.position.z,
    dist: bestD,
  }
}

function weaponScore(name) {
  const n = String(name || '').toLowerCase()
  if (n.includes('netherite_sword')) return 100
  if (n.includes('diamond_sword')) return 95
  if (n.includes('iron_sword')) return 90
  if (n.includes('stone_sword')) return 80
  if (n.includes('wooden_sword') || n.includes('golden_sword')) return 70
  if (n.includes('netherite_axe')) return 66
  if (n.includes('diamond_axe')) return 62
  if (n.includes('iron_axe')) return 58
  if (n.includes('stone_axe')) return 52
  if (n.includes('wooden_axe') || n.includes('golden_axe')) return 45
  return -1
}

function bestWeaponItem(bot) {
  const items = bot?.inventory?.items?.() || []
  let best = null
  let bestScore = -1
  for (const it of items) {
    const s = weaponScore(it?.name)
    if (s > bestScore) {
      bestScore = s
      best = it
    }
  }
  return bestScore >= 0 ? best : null
}

async function ensureWeaponInHand(bot) {
  const hand = bot?.heldItem
  if (weaponScore(hand?.name) >= 0) return true
  const best = bestWeaponItem(bot)
  if (!best) return false
  try {
    await bot.equip(best, 'hand')
    return true
  } catch {
    return false
  }
}

function nearbyHostiles(bot, maxDistance = 2.8) {
  const origin = bot.entity?.position
  if (!origin) return []
  return Object.values(bot.entities || {})
    .filter((e) => {
      if (!e?.position || e.id === bot.entity?.id) return false
      if (!HOSTILE_MOBS.has((e.name || '').toLowerCase())) return false
      return origin.distanceTo(e.position) <= maxDistance
    })
    .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))
}

function createReflexLayer(bot) {
  let lastHealth = bot?.health ?? 20
  let beingAttacked = false
  let lastAttackAt = 0
  let combatModeUntilTs = 0
  let recentStuckCount = 0
  let lastStuckAt = 0
  let recentDamageEvents = []
  let lastDamageAt = 0

  if (bot) {
    bot.on('health', () => {
      if (bot.health < lastHealth) {
        beingAttacked = true
        lastDamageAt = Date.now()
        recentDamageEvents.push(lastDamageAt)
        recentDamageEvents = recentDamageEvents.filter((t) => lastDamageAt - t <= 4000)
      }
      lastHealth = bot.health
    })
  }

  function resetAttackFlag() { beingAttacked = false }
  function enterCombatMode(ms = 2500) {
    const until = Date.now() + ms
    if (until > combatModeUntilTs) combatModeUntilTs = until
  }
  function isCombatMode() {
    return Date.now() < combatModeUntilTs
  }
  function noteDamage() {
    enterCombatMode(3000)
    lastDamageAt = Date.now()
    recentDamageEvents.push(lastDamageAt)
    recentDamageEvents = recentDamageEvents.filter((t) => lastDamageAt - t <= 4000)
  }
  function noteStuck() {
    const now = Date.now()
    if (now - lastStuckAt > 6000) recentStuckCount = 0
    recentStuckCount += 1
    lastStuckAt = now
  }
  function hasDamageBurst() {
    const now = Date.now()
    recentDamageEvents = recentDamageEvents.filter((t) => now - t <= 2500)
    return recentDamageEvents.length >= 2
  }

  // ── Rules ──
  // All condition functions read ONLY from:
  //   rv (reflexView from snapshot) + internal reflex state (beingAttacked, recentStuckCount, etc.)
  // All execute functions receive { bot } for body control (real-time data needed).

  const rules = [
    {
      id: 'falling_risk',
      name: 'emergency_jump',
      priority: 205,
      condition: (_snapshot, _ctx, rv) => {
        if (rv.onGround === false && rv.vy < -0.25) return true
        if (rv.onGround === true && rv.belowAir && rv.below2Air && rv.vy <= 0.08) return true
        return false
      },
      reason: 'Falling risk detected',
      execute: async ({ bot: b }) => {
        b.setControlState('jump', true)
        await sleep(220)
        b.setControlState('jump', false)
      },
    },
    {
      id: 'emergency_lava',
      name: 'emergency_jump',
      priority: 200,
      condition: (_snapshot, _ctx, rv) => isNearLava(rv.nearbyBlocks),
      reason: 'Near lava — emergency jump to escape',
      execute: async ({ bot: b }) => {
        b.setControlState('jump', true)
        b.setControlState('sprint', true)
        b.setControlState('forward', true)
        await new Promise((r) => setTimeout(r, 1500))
        b.setControlState('jump', false)
        b.setControlState('forward', false)
        b.setControlState('sprint', false)
      },
    },
    {
      id: 'fire_or_burn_danger',
      name: 'flee_burst',
      priority: 198,
      condition: (_snapshot, _ctx, rv) => rv.isInLava || rv.onFire,
      reason: 'Burn/fire danger detected',
      execute: async ({ bot: b }) => {
        enterCombatMode(2000)
        const v = vectorFromNearestHostile(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 900)
        else {
          b.setControlState('sprint', true)
          b.setControlState('forward', true)
          b.setControlState('jump', true)
          await sleep(750)
          b.setControlState('forward', false)
          b.setControlState('sprint', false)
          b.setControlState('jump', false)
        }
      },
    },
    {
      id: 'drowning_or_unsafe_water',
      name: 'flee_burst',
      priority: 196,
      condition: (_snapshot, _ctx, rv) => {
        if (!rv.inWater) return false
        const oxygenLow = rv.oxygenLevel <= 6
        return oxygenLow || rv.health <= 10
      },
      reason: 'Unsafe water / drowning risk',
      execute: async ({ bot: b }) => {
        enterCombatMode(1800)
        b.setControlState('jump', true)
        b.setControlState('forward', true)
        b.setControlState('sprint', true)
        await sleep(900)
        b.setControlState('jump', false)
        b.setControlState('forward', false)
        b.setControlState('sprint', false)
      },
    },
    {
      id: 'recent_damage_snapshot_flee',
      name: 'flee_burst',
      priority: 143,
      condition: (_snapshot, _ctx, rv) => {
        const ms = Number(rv.recentDamageMs ?? -1)
        if (ms < 0 || ms >= 3200) return false
        if (rv.threat_level === 'high' || rv.threat_level === 'low') return true
        return rv.close_threat || beingAttacked
      },
      reason: 'Recent damage window — flee burst',
      execute: async ({ bot: b }) => {
        enterCombatMode(2400)
        const v = vectorFromNearestHostile(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 780)
        else {
          b.setControlState('sprint', true)
          b.setControlState('forward', true)
          await sleep(520)
          b.setControlState('forward', false)
          b.setControlState('sprint', false)
        }
      },
    },
    {
      id: 'recent_damage_burst',
      name: 'flee_burst',
      priority: 194,
      condition: () => hasDamageBurst(),
      reason: 'Recent damage burst',
      execute: async ({ bot: b }) => {
        enterCombatMode(2200)
        const v = vectorFromNearestHostile(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 1000)
      },
    },
    {
      id: 'creeper_close_pure_flee',
      name: 'flee_burst',
      priority: 198,
      condition: (_snapshot, _ctx, rv) => {
        return rv.nearestCreeperVec && rv.nearestCreeperVec.dist <= 6
      },
      reason: 'Creeper nearby — instant sprint away (no pathfinder)',
      execute: async ({ bot: b }) => {
        enterCombatMode(2200)
        const v = vectorFromNearestCreeper(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 1100)
        resetAttackFlag()
      },
    },
    // NOTE: stuck recovery rules removed per CLAUDE.md — "stuck" is not a survival threat.
    // Stuck detection stays in perception (stuckDetector / noteStuck), but the RESPONSE
    // is decided by the planner in the next planning cycle, not hardcoded here.
    {
      id: 'hostile_injured_melee_flee',
      name: 'flee_burst',
      priority: 199,
      condition: (_snapshot, _ctx, rv) => {
        if (rv.health > 14) return false
        return rv.nearestHostileVec && rv.nearestHostileVec.dist <= 7
      },
      reason: 'Hostile nearby while injured — sprint away (flat flee)',
      execute: async ({ bot: b }) => {
        enterCombatMode(3200)
        const v = vectorFromNearestHostile(b)
        const noJump = (b.health ?? 20) <= 11
        if (v) await pureFleeBurst(b, v.dx, v.dz, 1150, { jump: !noJump })
        resetAttackFlag()
      },
    },
    {
      id: 'hostile_very_close_pure_flee',
      name: 'flee_burst',
      priority: 196,
      condition: (_snapshot, _ctx, rv) => {
        return rv.nearestHostileVec && rv.nearestHostileVec.dist <= 3.6
      },
      reason: 'Hostile in melee range — burst escape',
      execute: async ({ bot: b }) => {
        enterCombatMode(2600)
        const v = vectorFromNearestHostile(b)
        const low = (b.health ?? 20) <= 12
        if (v) await pureFleeBurst(b, v.dx, v.dz, 1050, { jump: !low })
        resetAttackFlag()
      },
    },
    {
      id: 'flee_critical_health',
      name: 'flee',
      priority: 150,
      condition: (_snapshot, _ctx, rv) => rv.health <= 5,
      reason: 'Critical health — flee regardless',
      execute: async ({ bot: b }) => {
        enterCombatMode(2600)
        const v = vectorFromNearestHostile(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 1400)
        else {
          b.setControlState('sprint', true)
          b.setControlState('forward', true)
          await sleep(2500)
          b.setControlState('forward', false)
          b.setControlState('sprint', false)
        }
        resetAttackFlag()
      },
    },
    {
      id: 'eat_food_for_regen',
      name: 'eat_food',
      priority: 125,
      condition: (snapshot, _ctx, rv) => {
        if (!rv.hasFood && !hasFoodInInventory(snapshot.inventory)) return false
        if (rv.food >= 20) return false
        if (rv.health >= 20 && rv.food >= 18) return false
        if (rv.threat_level === 'high') return false
        return rv.health < 20 && rv.food < 20
      },
      reason: 'Injured — eat to refill hunger so natural regen can work (full hunger heals HP)',
      execute: async ({ bot: b }) => {
        const inventory = b.inventory.items()
        const foodItem = inventory.find((item) => FOOD_ITEMS.has(item?.name))
        if (foodItem) {
          await b.equip(foodItem, 'hand')
          b.activateItem()
          await sleep(1850)
          b.deactivateItem()
        }
      },
    },
    {
      id: 'fight_back_armed',
      name: 'fight_back',
      priority: 110,
      condition: (snapshot, _ctx, rv) => {
        if (rv.health < 12) return false
        if (rv.hostilesWithin3 > 0) return true
        if (rv.threat_level !== 'high' && rv.threat_level !== 'low') return false
        if (!beingAttacked && rv.threat_level !== 'high') return false
        if (rv.health <= 5) return false
        return rv.hasWeapon || hasWeaponInInventory(snapshot.inventory)
      },
      reason: 'Threat detected and armed/close — fight back',
      execute: async ({ bot: b }) => {
        const origin = b.entity?.position
        if (!origin) return
        enterCombatMode(2600)
        const armed = await ensureWeaponInHand(b)
        const attackCdMs = 625
        const deadline = Date.now() + 2600
        while (Date.now() < deadline) {
          const hostiles = nearbyHostiles(b, 2.8)
          const target = hostiles[0]
          if (!target) break
          if (!target.isValid) continue
          if (!armed) {
            const v = vectorFromNearestHostile(b)
            if (v) await pureFleeBurst(b, v.dx, v.dz, 600)
            break
          }
          const now = Date.now()
          const wait = attackCdMs - (now - lastAttackAt)
          if (wait > 0) await sleep(wait)
          try {
            await b.lookAt(target.position.offset(0, target.height || 1, 0))
            b.attack(target)
            lastAttackAt = Date.now()
          } catch { break }
          await sleep(30)
        }
        resetAttackFlag()
      },
    },
    {
      id: 'fight_back_unarmed',
      name: 'fight_back',
      priority: 100,
      condition: (_snapshot, _ctx, rv) => {
        if (!beingAttacked) return false
        if (rv.health <= 8) return false
        return rv.threat_level === 'high' || rv.threat_level === 'low'
      },
      reason: 'Being attacked unarmed but healthy — punch back',
      execute: async ({ bot: b }) => {
        const origin = b.entity?.position
        if (!origin) return
        enterCombatMode(2200)
        const attackCdMs = 625
        const deadline = Date.now() + 1500
        while (Date.now() < deadline) {
          const hostiles = nearbyHostiles(b, 2.2)
          const target = hostiles[0]
          if (!target) break
          if (!target.isValid) continue
          const now = Date.now()
          const wait = attackCdMs - (now - lastAttackAt)
          if (wait > 0) await sleep(wait)
          try {
            await b.lookAt(target.position.offset(0, target.height || 1, 0))
            b.attack(target)
            lastAttackAt = Date.now()
          } catch { break }
          await sleep(30)
        }
        resetAttackFlag()
      },
    },
    {
      id: 'flee_unarmed_low_health',
      name: 'flee',
      priority: 90,
      condition: (_snapshot, _ctx, rv) => {
        if (rv.threat_level !== 'high') return false
        return rv.health <= 12 && !rv.hasWeapon
      },
      reason: 'Under threat, unarmed, losing health — flee',
      execute: async ({ bot: b }) => {
        enterCombatMode(2400)
        const v = vectorFromNearestHostile(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 1200)
        resetAttackFlag()
      },
    },
  ]

  // Legacy compat: fallback for inventory weapon check when reflexContext unavailable
  function hasWeaponInInventory(inventory) {
    const items = Array.isArray(inventory?.summary) ? inventory.summary : (Array.isArray(inventory) ? inventory : [])
    return items.some((item) => {
      const n = (item?.name || '').toLowerCase()
      return n.includes('sword') || n.includes('axe') || n.includes('bow')
    })
  }

  function levelFromScore(score) {
    if (score >= 190) return 'fatal_immediate'
    if (score >= 130) return 'high'
    if (score >= 90) return 'medium'
    return 'low'
  }

  function buildInterrupt(rule, snapshot, ctx) {
    if (!rule) {
      return noInterrupt({
        source: 'reflex',
        reason: 'no_reflex_match',
        metadata: {
          cycle: ctx?.cycle || null,
          threat: snapshot?.threat_level || null,
        },
      })
    }
    return reflexInterrupt({
      priority: levelFromScore(Number(rule.priority || 0)),
      interruptReason: rule.reason || rule.name || 'reflex_interrupt',
      suggestedSkill: rule.name || null,
      metadata: {
        ruleId: rule.id || null,
        ruleName: rule.name || null,
        score: Number(rule.priority || 0),
        cycle: ctx?.cycle || null,
        threat: snapshot?.threat_level || null,
        closeThreat: snapshot?.close_threat === true,
        health: snapshot?.status?.health ?? null,
      },
    })
  }

  function arbitrate(snapshot, ctx) {
    const rule = check(snapshot, ctx)
    const decision = buildInterrupt(rule, snapshot, ctx)
    return { decision, matchedRule: rule }
  }

  function check(snapshot, ctx) {
    const rv = extractReflexView(snapshot)
    const triggered = rules
      .filter((rule) => {
        try {
          return rule.condition(snapshot, ctx, rv)
        } catch (err) {
          // Log rule evaluation errors for diagnostics — rule is skipped but not silently
          // eslint-disable-next-line no-console
          console.error(`[reflex] rule ${rule.id || rule.name} condition error: ${err?.message || err}`)
          return false
        }
      })
      .sort((a, b) => b.priority - a.priority)

    if (triggered.length === 0) return null
    return triggered[0]
  }

  function getDamageFallbackAction() {
    return {
      id: 'damage_fallback_flee',
      name: 'flee_burst',
      reason: 'Damage interrupt fallback — flee burst',
      execute: async ({ bot: b }) => {
        enterCombatMode(2600)
        const v = vectorFromNearestHostile(b)
        if (v) await pureFleeBurst(b, v.dx, v.dz, 720)
        else {
          b.setControlState('sprint', true)
          b.setControlState('forward', true)
          await sleep(580)
          b.setControlState('forward', false)
          b.setControlState('sprint', false)
        }
      },
    }
  }

  async function execute(rule, { api, bot: b, ctx } = {}) {
    const startedAt = Date.now()
    if (!rule || typeof rule.execute !== 'function') {
      return invalidResult({
        source: 'reflex',
        actionType: 'reflex_rule',
        startedAt,
        endedAt: Date.now(),
        reason: 'invalid_reflex_rule',
        errorMessage: 'Reflex rule missing execute function',
      })
    }
    try {
      await rule.execute({ api, bot: b, ctx })
      return successResult({
        source: 'reflex',
        actionType: rule.name || 'reflex_rule',
        startedAt,
        endedAt: Date.now(),
        reason: rule.reason || 'reflex_executed',
        details: { ruleId: rule.id || null },
      })
    } catch (err) {
      return failureResult({
        source: 'reflex',
        actionType: rule.name || 'reflex_rule',
        startedAt,
        endedAt: Date.now(),
        reason: 'reflex_execute_failed',
        errorMessage: err?.message || String(err),
        details: { ruleId: rule.id || null },
      })
    }
  }

  return Object.freeze({
    arbitrate,
    check,
    execute,
    getDamageFallbackAction,
    rules,
    isBeingAttacked: () => beingAttacked,
    isCombatMode,
    enterCombatMode,
    noteDamage,
    noteStuck,
    resetAttackFlag,
  })
}

module.exports = { createReflexLayer, HOSTILE_MOBS, FOOD_ITEMS }
