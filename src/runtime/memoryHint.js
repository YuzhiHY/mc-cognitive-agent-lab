const fs = require('node:fs')
const path = require('node:path')

function distanceBetween(a, b) {
  if (!a || !b) return Infinity
  const dx = (a.x || 0) - (b.x || 0)
  const dy = (a.y || 0) - (b.y || 0)
  const dz = (a.z || 0) - (b.z || 0)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

async function readFingerprints(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8')
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function extractFeatures(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {}
  return {
    threat_level: snapshot.threat_level || 'none',
    health: snapshot.status?.health ?? 20,
    food: snapshot.status?.food ?? 20,
    hasLava: snapshot.obstacles?.lava === true ? 1 : 0,
    hasWater: snapshot.obstacles?.water === true ? 1 : 0,
    hasCliff: snapshot.obstacles?.cliff === true ? 1 : 0,
  }
}

function featureSimilarity(a, b) {
  if (!a || !b) return 0
  let matches = 0
  let total = 0
  const threatMap = { none: 0, low: 1, high: 2 }
  const aT = threatMap[a.threat_level] ?? 0
  const bT = threatMap[b.threat_level] ?? 0
  if (aT === bT) matches += 2; else if (Math.abs(aT - bT) === 1) matches += 1
  total += 2

  const healthDiff = Math.abs((a.health ?? 20) - (b.health ?? 20))
  if (healthDiff <= 2) matches += 2; else if (healthDiff <= 5) matches += 1
  total += 2

  if (a.hasLava === b.hasLava) matches += 1; total += 1
  if (a.hasWater === b.hasWater) matches += 1; total += 1
  if (a.hasCliff === b.hasCliff) matches += 1; total += 1

  return total > 0 ? matches / total : 0
}

async function buildMemoryHint({
  fingerprintsPath,
  currentPos,
  currentSnapshot,
  maxDistance = 20,
  maxResults = 3,
  fingerprintMinSimilarity = 0.6,
}) {
  const fpPath = fingerprintsPath || path.resolve(process.cwd(), 'logs', 'failure_fingerprints.jsonl')
  const entries = await readFingerprints(fpPath)
  if (entries.length === 0) return { recent_failures: [], fingerprint_matches: [] }

  const nearby = entries
    .map((e) => ({
      ...e,
      _dist: distanceBetween(currentPos, e.pos),
    }))
    .filter((e) => e._dist <= maxDistance)
    .sort((a, b) => {
      const tA = new Date(a.ts || 0).getTime()
      const tB = new Date(b.ts || 0).getTime()
      return tB - tA
    })
    .slice(0, maxResults)
    .map(({ _dist, ...rest }) => ({ ...rest, distanceFromCurrent: Math.round(_dist * 100) / 100 }))

  const currentFeatures = currentSnapshot ? extractFeatures(currentSnapshot) : null
  let fingerprintMatches = []
  if (currentFeatures) {
    fingerprintMatches = entries
      .filter((e) => e.snapshotFeatures)
      .map((e) => ({
        ...e,
        _sim: featureSimilarity(currentFeatures, e.snapshotFeatures),
      }))
      .filter((e) => e._sim >= fingerprintMinSimilarity)
      .sort((a, b) => b._sim - a._sim)
      .slice(0, maxResults)
      .map(({ _sim, ...rest }) => ({ ...rest, similarity: Math.round(_sim * 1000) / 1000 }))
  }

  // Generate avoidance hints from repeated failure patterns
  const avoidanceHints = deriveAvoidanceHints(entries)

  return { recent_failures: nearby, fingerprint_matches: fingerprintMatches, avoidance_hints: avoidanceHints }
}

/**
 * Derive avoidance hints from repeated failure fingerprints.
 * If the same failureClass appears 3+ times in recent entries, suggest avoidance.
 */
function deriveAvoidanceHints(entries, windowMs = 300000, minCount = 3) {
  const cutoff = Date.now() - windowMs
  const recent = entries.filter((e) => {
    const ts = e.timestamp || new Date(e.ts || 0).getTime()
    return ts >= cutoff
  })

  const counts = new Map()
  for (const e of recent) {
    const cls = e.failureClass || e.tag || 'unknown'
    const action = e.actionType || e.step || 'unknown'
    const key = `${cls}:${action}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  const hints = []
  for (const [key, count] of counts) {
    if (count >= minCount) {
      const [cls, action] = key.split(':')
      hints.push({
        type: 'avoid_repeated_failure',
        failureClass: cls,
        actionType: action,
        count,
        hint: `Avoid ${action} — repeated ${cls} failure (${count}x recent)`,
      })
    }
  }
  return hints
}

module.exports = { buildMemoryHint, extractFeatures, featureSimilarity, deriveAvoidanceHints }
