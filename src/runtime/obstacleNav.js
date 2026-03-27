function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSolid(block) {
  return block && block.name !== 'air' && block.name !== 'bedrock'
}

function leftRightFromForward(dx, dz) {
  return {
    left: { x: Math.round(-dz), z: Math.round(dx) },
    right: { x: Math.round(dz), z: Math.round(-dx) },
  }
}

/**
 * Jump / dig head / dig feet, plus crevice & low-corner cases (V-shaped lips, side squeeze with low floor).
 */
async function clearObstacleInFront(bot) {
  if (bot.targetDigBlock) return false
  const pos = bot.entity?.position
  if (!pos) return false
  const yaw = bot.entity.yaw
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const floored = pos.floored()
  const rdx = Math.round(dx)
  const rdz = Math.round(dz)
  const fwd = floored.offset(rdx, 0, rdz)
  const { left, right } = leftRightFromForward(dx, dz)
  const leftFeet = floored.offset(left.x, 0, left.z)
  const rightFeet = floored.offset(right.x, 0, right.z)

  const blockAtFeet = bot.blockAt(fwd)
  const blockAtHead = bot.blockAt(fwd.offset(0, 1, 0))
  const feetSolid = isSolid(blockAtFeet)
  const headSolid = isSolid(blockAtHead)

  if (feetSolid && !headSolid) {
    bot.setControlState('jump', true)
    await sleep(350)
    bot.setControlState('jump', false)
    return true
  }

  if (!feetSolid && headSolid && blockAtHead.diggable !== false) {
    await bot.dig(blockAtHead, 'raycast', 'raycast')
    return true
  }

  if (feetSolid && headSolid) {
    if (blockAtHead.diggable !== false) await bot.dig(blockAtHead, 'raycast', 'raycast')
    if (blockAtFeet.diggable !== false) await bot.dig(blockAtFeet, 'raycast', 'raycast')
    return true
  }

  // Forward column is clear at head/feet — may still be wedged (L-corner, V-lip, or low floor ahead)
  const fwdAirColumn = !feetSolid && !headSolid
  if (!fwdAirColumn) return false

  const leftS = isSolid(bot.blockAt(leftFeet))
  const rightS = isSolid(bot.blockAt(rightFeet))
  const fwdL = fwd.offset(left.x, 0, left.z)
  const fwdR = fwd.offset(right.x, 0, right.z)
  const flSolid = isSolid(bot.blockAt(fwdL))
  const frSolid = isSolid(bot.blockAt(fwdR))

  // Two diagonal pillars ahead form a narrow mouth — dig one (often reads as "air ahead" to naïve checks)
  if (flSolid && frSolid) {
    const bl = bot.blockAt(fwdL)
    const br = bot.blockAt(fwdR)
    const pick = bl && bl.diggable !== false ? bl : br
    if (pick && pick.diggable !== false) {
      await bot.dig(pick, 'raycast', 'raycast')
      return true
    }
  }

  // Squeezed from left+right at feet with clear air forward: low block under forward cell can block crouch/clip
  const belowFwd = bot.blockAt(fwd.offset(0, -1, 0))
  if (leftS && rightS && belowFwd && belowFwd.diggable !== false && belowFwd.position.y < floored.y) {
    await bot.dig(belowFwd, 'raycast', 'raycast')
    return true
  }

  // One side + diagonal corner ahead (common ┐-shaped gap)
  if ((leftS && frSolid) || (rightS && flSolid)) {
    const target = (leftS && frSolid) ? bot.blockAt(fwdR) : bot.blockAt(fwdL)
    if (target && target.diggable !== false) {
      await bot.dig(target, 'raycast', 'raycast')
      return true
    }
  }

  // Low lip: solid block same level as feet but in front-down cell (step / slab edge) while forward column air
  const lipFwdDown = bot.blockAt(floored.offset(rdx, -1, rdz))
  if (lipFwdDown && lipFwdDown.diggable !== false && isSolid(lipFwdDown)
      && lipFwdDown.position.y === floored.y - 1) {
    await bot.dig(lipFwdDown, 'raycast', 'raycast')
    return true
  }
  return false
}

module.exports = { clearObstacleInFront, isSolid, leftRightFromForward }
