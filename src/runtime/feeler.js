/**
 * Feeler Module (触须模块)
 *
 * Low-privilege local movement compensation layer.
 * Projects short-range probe points around the bot (especially forward),
 * detects near-body obstacles, and applies minimal compensatory actions:
 *   sidestep, short jump, yaw correction, re-approach.
 *
 * Design constraints:
 *   - Does NOT replace pathfinder or high-level planning.
 *   - Does NOT run as an independent high-frequency control loop.
 *   - Does NOT default to digging — only clears disposable blocks as last resort.
 *   - Intended to be called from navigateTo stuck checks, follow loops,
 *     and recover_from_stuck, NOT as a standalone ticker.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Block classification ───────────────────────────────────────────

function isSolid(block) {
  return block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air'
}

/**
 * Blocks that are safe to break as a last resort — dirt, grass, sand, gravel,
 * leaves, snow, etc. Never ores, chests, signs, or anything valuable.
 */
const DISPOSABLE_PATTERN = /^(dirt|grass_block|sand|gravel|snow|snow_block|cobweb|dead_bush|tall_grass|fern|large_fern|seagrass|kelp|vine|hanging_roots|moss_carpet|moss_block|short_grass|tall_grass)$/
const NEVER_BREAK_PATTERN = /ore|chest|sign|spawner|beacon|shulker|barrel|hopper|dropper|dispenser|furnace|crafting|anvil|enchant|brewing|bed|door|command/

function isDisposable(block) {
  if (!block || !block.name) return false
  if (NEVER_BREAK_PATTERN.test(block.name)) return false
  if (DISPOSABLE_PATTERN.test(block.name)) return true
  // Leaves of any kind
  if (block.name.endsWith('_leaves')) return true
  return false
}

// ─── Directional helpers ────────────────────────────────────────────

function yawToForward(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) }
}

function forwardToLeftRight(dx, dz) {
  return {
    left:  { x: Math.round(-dz), z: Math.round(dx) },
    right: { x: Math.round(dz),  z: Math.round(-dx) },
  }
}

// ─── Probe ──────────────────────────────────────────────────────────

/**
 * Project probe points around the bot and return a structured obstacle map.
 * All positions are floored block coords.
 *
 * @param {object} bot  - mineflayer bot
 * @param {object} [targetPos] - optional {x,y,z} the bot is trying to reach
 * @returns {object} probe result
 */
function probe(bot, targetPos) {
  const pos = bot.entity?.position
  if (!pos) return null
  const floored = pos.floored()
  const yaw = bot.entity.yaw
  const fwd = yawToForward(yaw)
  const rdx = Math.round(fwd.x)
  const rdz = Math.round(fwd.z)
  const { left, right } = forwardToLeftRight(fwd.x, fwd.z)

  // Probe helper
  const at = (dx, dy, dz) => bot.blockAt(floored.offset(dx, dy, dz))

  const forwardFeet  = at(rdx, 0, rdz)
  const forwardHead  = at(rdx, 1, rdz)
  const forwardAbove = at(rdx, 2, rdz) // 2 blocks up from feet in fwd direction
  const forwardGround = at(rdx, -1, rdz)
  const leftFeet     = at(left.x, 0, left.z)
  const leftHead     = at(left.x, 1, left.z)
  const rightFeet    = at(right.x, 0, right.z)
  const rightHead    = at(right.x, 1, right.z)
  const fwdLeftFeet  = at(rdx + left.x, 0, rdz + left.z)
  const fwdRightFeet = at(rdx + right.x, 0, rdz + right.z)
  const ceiling      = at(0, 2, 0)
  const below        = at(0, -1, 0)

  const fwdFeetSolid = isSolid(forwardFeet)
  const fwdHeadSolid = isSolid(forwardHead)
  const leftClear    = !isSolid(leftFeet) && !isSolid(leftHead)
  const rightClear   = !isSolid(rightFeet) && !isSolid(rightHead)
  const gapAhead     = !isSolid(forwardGround) && !fwdFeetSolid

  // Distance to target (if known)
  let distToTarget = null
  let yawToTarget = null
  if (targetPos) {
    const dx = targetPos.x - pos.x
    const dz = targetPos.z - pos.z
    distToTarget = Math.sqrt(dx * dx + dz * dz)
    yawToTarget = Math.atan2(-dx, -dz)
  }

  return {
    pos: { x: floored.x, y: floored.y, z: floored.z },
    yaw,
    forward: {
      feet: forwardFeet, head: forwardHead, above: forwardAbove,
      ground: forwardGround,
      feetSolid: fwdFeetSolid, headSolid: fwdHeadSolid,
      blocked: fwdFeetSolid || fwdHeadSolid,
    },
    left: {
      feet: leftFeet, head: leftHead, clear: leftClear,
    },
    right: {
      feet: rightFeet, head: rightHead, clear: rightClear,
    },
    diagonal: {
      forwardLeft: fwdLeftFeet, forwardRight: fwdRightFeet,
      flSolid: isSolid(fwdLeftFeet), frSolid: isSolid(fwdRightFeet),
    },
    ceiling: { block: ceiling, low: isSolid(ceiling) },
    ground: { below, gapAhead },
    target: {
      distance: distToTarget,
      yawToTarget,
      yawDelta: yawToTarget != null ? normalizeAngle(yawToTarget - yaw) : null,
    },
  }
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

// ─── Compensate ─────────────────────────────────────────────────────

/**
 * Given a probe result, pick and execute the smallest compensatory action.
 * Returns { action: string, detail?: string } describing what was done,
 * or null if no compensation was needed / possible.
 *
 * Compensation priority (movement-first, dig-last):
 *   1. Yaw correction toward target (if off-angle and close)
 *   2. Short jump (feet blocked, head clear)
 *   3. Sidestep (forward blocked, side clear)
 *   4. Back-step (gap ahead)
 *   5. Clear ONE disposable block (last resort, only if truly stuck)
 *
 * @param {object} bot
 * @param {object} probeResult  - from probe()
 * @param {object} [opts]
 * @param {boolean} [opts.allowDig=false] - whether disposable-block clearing is permitted
 */
async function compensate(bot, probeResult, opts = {}) {
  if (!probeResult) return null
  const pr = probeResult
  const allowDig = opts.allowDig === true

  // 1. Yaw correction — if we're within ~5 blocks and aiming >30° off target
  if (pr.target.distance != null && pr.target.distance < 5 && pr.target.yawDelta != null) {
    const absDelta = Math.abs(pr.target.yawDelta)
    if (absDelta > 0.52) { // ~30 degrees
      try {
        await bot.look(pr.target.yawToTarget, 0, false)
        await sleep(100)
        return { action: 'yaw_correction', detail: `delta=${(absDelta * 180 / Math.PI).toFixed(0)}°` }
      } catch { /* non-critical */ }
    }
  }

  // 2. Short jump — forward feet blocked but head clear
  if (pr.forward.feetSolid && !pr.forward.headSolid && !pr.ceiling.low) {
    try {
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(300)
      bot.setControlState('jump', false)
      await sleep(150)
      bot.setControlState('forward', false)
      return { action: 'jump_over', detail: pr.forward.feet?.name }
    } catch { /* */ }
  }

  // 3. Sidestep — forward blocked, pick the side closer to target (or any clear side)
  if (pr.forward.blocked) {
    let preferLeft = pr.left.clear
    let preferRight = pr.right.clear
    // If both sides clear, pick the one closer to the target direction
    if (preferLeft && preferRight && pr.target.yawDelta != null) {
      preferLeft = pr.target.yawDelta < 0
      preferRight = !preferLeft
    }
    const side = preferLeft ? 'left' : preferRight ? 'right' : null
    if (side) {
      try {
        bot.setControlState(side, true)
        await sleep(250)
        bot.setControlState(side, false)
        return { action: 'sidestep', detail: side }
      } catch { /* */ }
    }
  }

  // 4. Back-step for gap ahead
  if (pr.ground.gapAhead && !pr.forward.blocked) {
    try {
      bot.setControlState('back', true)
      await sleep(200)
      bot.setControlState('back', false)
      return { action: 'backstep_gap' }
    } catch { /* */ }
  }

  // 5. Diagonal squeeze — both forward-left and forward-right blocked (narrow passage)
  if (pr.diagonal.flSolid && pr.diagonal.frSolid && !pr.forward.blocked) {
    // Nudge slightly toward whichever side has more room
    const side = pr.left.clear ? 'left' : pr.right.clear ? 'right' : null
    if (side) {
      try {
        bot.setControlState(side, true)
        bot.setControlState('forward', true)
        await sleep(200)
        bot.setControlState(side, false)
        bot.setControlState('forward', false)
        return { action: 'squeeze_through', detail: side }
      } catch { /* */ }
    }
  }

  // 6. Last resort: clear ONE disposable block (only if explicitly allowed)
  if (allowDig && pr.forward.blocked) {
    // Prefer feet-level block (more common: tall grass, dirt lip)
    const candidates = [pr.forward.feet, pr.forward.head].filter(
      (b) => b && isDisposable(b) && b.diggable !== false,
    )
    if (candidates.length > 0) {
      try {
        await bot.dig(candidates[0], 'raycast', 'raycast')
        return { action: 'clear_disposable', detail: candidates[0].name }
      } catch { /* */ }
    }
  }

  return null
}

// ─── Integrated feeler check (probe + compensate in one call) ───────

/**
 * One-shot feeler: probe surroundings and compensate if needed.
 * Designed to be called from stuck-check intervals, follow loops, etc.
 *
 * @param {object} bot
 * @param {object} [targetPos] - {x,y,z} the bot is trying to reach
 * @param {object} [opts] - { allowDig: false }
 * @returns {{ probed: boolean, compensated: boolean, action?: string, detail?: string }}
 */
async function feel(bot, targetPos, opts) {
  const pr = probe(bot, targetPos)
  if (!pr) return { probed: false, compensated: false, positionDelta: 0, yawDelta: 0 }

  // Only compensate if there's actually a problem
  const needsHelp = pr.forward.blocked
    || pr.ground.gapAhead
    || pr.ceiling.low
    || (pr.diagonal.flSolid && pr.diagonal.frSolid)
    || (pr.target.yawDelta != null && Math.abs(pr.target.yawDelta) > 0.52 && pr.target.distance < 5)

  if (!needsHelp) return { probed: true, compensated: false, positionDelta: 0, yawDelta: 0 }

  // Capture pre-compensation state
  const posBefore = bot.entity?.position?.clone()
  const yawBefore = bot.entity?.yaw

  const result = await compensate(bot, pr, opts)
  if (result) {
    // Measure post-compensation drift
    const posAfter = bot.entity?.position
    const yawAfter = bot.entity?.yaw
    const positionDelta = (posAfter && posBefore)
      ? posAfter.distanceTo(posBefore)
      : 0
    const yawDeltaAbs = (yawAfter != null && yawBefore != null)
      ? Math.abs(normalizeAngle(yawAfter - yawBefore))
      : 0
    return { probed: true, compensated: true, ...result, positionDelta, yawDelta: yawDeltaAbs }
  }
  return { probed: true, compensated: false, positionDelta: 0, yawDelta: 0 }
}

module.exports = { probe, compensate, feel, isSolid, isDisposable }
