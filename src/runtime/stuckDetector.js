const fs = require('node:fs')
const path = require('node:path')

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

  async function writeFingerprint({ step, skillName, tag, pos, snapshotFeatures }) {
    try {
      await fs.promises.mkdir(fpDir, { recursive: true })
      const entry = {
        ts: new Date().toISOString(),
        step,
        skillName: skillName || null,
        tag,
        pos,
        snapshotFeatures: snapshotFeatures || null,
      }
      await fs.promises.appendFile(fpFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // Fingerprint writing must never break the agent loop.
    }
  }

  function reset() {
    lastPos = null
  }

  return Object.freeze({ checkStuck, writeFingerprint, reset })
}

module.exports = { createStuckDetector }
