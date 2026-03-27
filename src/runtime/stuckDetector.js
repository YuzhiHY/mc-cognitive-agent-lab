const fs = require('node:fs')
const path = require('node:path')
const { createFingerprint, classifyFailure } = require('./contracts/failureFingerprint')

function distSquared(a, b) {
  if (!a || !b) return Infinity
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function createStuckDetector(bot, { stuckThreshold = 0.5, fingerprintsDir } = {}) {
  const thresholdSq = stuckThreshold * stuckThreshold
  let lastPos = null
  const fpDir = fingerprintsDir || path.resolve(process.cwd(), 'logs')
  const fpFile = path.join(fpDir, 'failure_fingerprints.jsonl')

  // Extended tracking for richer detection
  let pathGoalChangeCount = 0
  let lastPathGoal = null
  let jumpWithoutDisplacement = 0
  let lastYaw = null
  let yawThrashCount = 0
  const recentFingerprints = []
  const MAX_RECENT = 50

  function posSnapshot() {
    const p = bot.entity?.position
    if (!p) return null
    return { x: p.x, y: p.y, z: p.z }
  }

  function checkStuck(step, skillDone) {
    const current = posSnapshot()
    const prev = lastPos
    lastPos = current

    if (!prev || !current) return { stuck: false }
    if (skillDone !== false) return { stuck: false }

    const dSq = distSquared(prev, current)
    if (dSq >= thresholdSq) return { stuck: false }

    return {
      stuck: true,
      tag: 'Physical_Impasse',
      delta: Math.sqrt(dSq),
      pos: current,
    }
  }

  /**
   * Track pathfinder goal changes. Repeated recomputation suggests stuck.
   */
  function notePathGoalChange(goal) {
    const goalStr = goal ? JSON.stringify(goal) : null
    if (goalStr !== lastPathGoal) {
      pathGoalChangeCount += 1
      lastPathGoal = goalStr
    }
  }

  /**
   * Track jumps without displacement.
   */
  function noteJump() {
    const current = posSnapshot()
    if (lastPos && current) {
      const dSq = distSquared(lastPos, current)
      if (dSq < 0.3 * 0.3) {
        jumpWithoutDisplacement += 1
      } else {
        jumpWithoutDisplacement = 0
      }
    }
  }

  /**
   * Track yaw thrashing (look direction changes without position change).
   */
  function noteYawChange() {
    const yaw = bot.entity?.yaw
    if (typeof yaw !== 'number') return
    if (lastYaw !== null) {
      const diff = Math.abs(yaw - lastYaw)
      const current = posSnapshot()
      if (diff > 0.3 && lastPos && current && distSquared(lastPos, current) < 0.1) {
        yawThrashCount += 1
      } else {
        yawThrashCount = Math.max(0, yawThrashCount - 1)
      }
    }
    lastYaw = yaw
  }

  /**
   * Get extended stuck signals.
   */
  function getExtendedSignals() {
    return {
      pathGoalChanges: pathGoalChangeCount,
      jumpWithoutDisplacement,
      yawThrashCount,
      repeatedPathRecomputation: pathGoalChangeCount >= 3,
      repeatedJumpStuck: jumpWithoutDisplacement >= 3,
      lookThrashing: yawThrashCount >= 4,
    }
  }

  async function writeFingerprint({ step, skillName, tag, pos, snapshotFeatures, failureClass, reason }) {
    const fingerprint = createFingerprint({
      actionType: step || 'stuck',
      skillName,
      failureClass: failureClass || 'stuck_collision',
      reason: reason || tag || 'Physical_Impasse',
      location: pos || posSnapshot(),
      contextualTags: [tag].filter(Boolean),
      retryable: true,
    })

    recentFingerprints.push(fingerprint)
    if (recentFingerprints.length > MAX_RECENT) {
      recentFingerprints.splice(0, recentFingerprints.length - MAX_RECENT)
    }

    try {
      await fs.promises.mkdir(fpDir, { recursive: true })
      const entry = {
        ...fingerprint,
        ts: new Date(fingerprint.timestamp).toISOString(),
        snapshotFeatures: snapshotFeatures || null,
      }
      await fs.promises.appendFile(fpFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // Fingerprint writing must never break the agent loop.
    }

    return fingerprint
  }

  /**
   * Record a failure from an execution result.
   */
  async function recordExecutionFailure(executionResult, context = {}) {
    const fingerprint = classifyFailure(executionResult, {
      ...context,
      location: context.location || posSnapshot(),
    })

    recentFingerprints.push(fingerprint)
    if (recentFingerprints.length > MAX_RECENT) {
      recentFingerprints.splice(0, recentFingerprints.length - MAX_RECENT)
    }

    try {
      await fs.promises.mkdir(fpDir, { recursive: true })
      const entry = {
        ...fingerprint,
        ts: new Date(fingerprint.timestamp).toISOString(),
        snapshotFeatures: context.snapshotFeatures || null,
      }
      await fs.promises.appendFile(fpFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch { /* must not break */ }

    return fingerprint
  }

  /**
   * Get recent fingerprints within a time window.
   */
  function getRecentFingerprints(windowMs = 60000) {
    const cutoff = Date.now() - windowMs
    return recentFingerprints.filter((f) => f.timestamp >= cutoff)
  }

  /**
   * Get repeated failure patterns (same failureClass + similar location).
   */
  function getRepeatedPatterns(windowMs = 120000, minCount = 2) {
    const recent = getRecentFingerprints(windowMs)
    const counts = new Map()
    for (const f of recent) {
      const key = `${f.failureClass}:${f.actionType}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const patterns = []
    for (const [key, count] of counts) {
      if (count >= minCount) {
        const [failureClass, actionType] = key.split(':')
        patterns.push({ failureClass, actionType, count })
      }
    }
    return patterns
  }

  function reset() {
    lastPos = null
    pathGoalChangeCount = 0
    lastPathGoal = null
    jumpWithoutDisplacement = 0
    lastYaw = null
    yawThrashCount = 0
  }

  return Object.freeze({
    checkStuck,
    writeFingerprint,
    recordExecutionFailure,
    getRecentFingerprints,
    getRepeatedPatterns,
    getExtendedSignals,
    notePathGoalChange,
    noteJump,
    noteYawChange,
    reset,
  })
}

module.exports = { createStuckDetector }
