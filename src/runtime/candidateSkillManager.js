/**
 * Candidate Skill Pipeline
 *
 * Manages the lifecycle of generated skills:
 *   experimental → promoted → quarantined
 *
 * Generated skills must pass validation and accumulate successful
 * executions before being promoted to trusted status.
 */

const fs = require('node:fs')
const path = require('node:path')

const PROMOTION_MIN_SUCCESSES = Number(process.env.SKILL_PROMOTION_MIN_SUCCESSES || 3)
const PROMOTION_SUCCESS_RATIO = Number(process.env.SKILL_PROMOTION_SUCCESS_RATIO || 0.75)
const QUARANTINE_CONSECUTIVE_FAILURES = Number(process.env.SKILL_QUARANTINE_FAILURES || 3)
const MAX_RECENT_OUTCOMES = 20

function createCandidateSkillManager({
  experimentalDir = path.resolve(process.cwd(), 'skills', 'experimental'),
  promotedDir = path.resolve(process.cwd(), 'skills', 'promoted'),
} = {}) {

  // In-memory metadata cache keyed by skill name
  const metadata = new Map()

  function ensureDirs() {
    fs.mkdirSync(experimentalDir, { recursive: true })
    fs.mkdirSync(promotedDir, { recursive: true })
  }

  function getMetaPath(skillName, dir) {
    const safe = String(skillName).replace(/[^a-zA-Z0-9._-]/g, '_')
    return path.join(dir, `${safe}.meta.json`)
  }

  function loadMeta(skillName) {
    if (metadata.has(skillName)) return metadata.get(skillName)

    for (const dir of [experimentalDir, promotedDir]) {
      const metaPath = getMetaPath(skillName, dir)
      try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        raw.tier = dir === promotedDir ? 'promoted' : 'experimental'
        metadata.set(skillName, raw)
        return raw
      } catch { /* not found */ }
    }
    return null
  }

  function saveMeta(skillName, meta) {
    const dir = meta.tier === 'promoted' ? promotedDir : experimentalDir
    const metaPath = getMetaPath(skillName, dir)
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
    metadata.set(skillName, meta)
  }

  /**
   * Register a newly generated skill as experimental candidate.
   */
  function registerExperimental(skillName, { code, intent, tags = [], riskLevel = 'medium' } = {}) {
    ensureDirs()
    const meta = {
      name: skillName,
      origin: 'llm_generated',
      tier: 'experimental',
      createdAt: Date.now(),
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      recentOutcomes: [],
      approvedForReuse: false,
      promotionEligible: false,
      quarantined: false,
      riskLevel,
      intent: intent || '',
      tags,
    }
    saveMeta(skillName, meta)

    // Save the code file
    if (code) {
      const safe = String(skillName).replace(/[^a-zA-Z0-9._-]/g, '_')
      const codePath = path.join(experimentalDir, `${safe}.js`)
      fs.writeFileSync(codePath, code, 'utf8')
    }

    return meta
  }

  /**
   * Record an execution outcome for a candidate skill.
   */
  function recordOutcome(skillName, { ok, reason = '' } = {}) {
    const meta = loadMeta(skillName)
    if (!meta) return null

    const outcome = { ok: !!ok, reason, ts: Date.now() }
    meta.recentOutcomes.push(outcome)
    if (meta.recentOutcomes.length > MAX_RECENT_OUTCOMES) {
      meta.recentOutcomes = meta.recentOutcomes.slice(-MAX_RECENT_OUTCOMES)
    }

    if (ok) {
      meta.successCount += 1
      meta.consecutiveFailures = 0
    } else {
      meta.failureCount += 1
      meta.consecutiveFailures += 1
    }

    // Check promotion eligibility
    const total = meta.successCount + meta.failureCount
    const ratio = total > 0 ? meta.successCount / total : 0
    meta.promotionEligible = (
      meta.successCount >= PROMOTION_MIN_SUCCESSES
      && ratio >= PROMOTION_SUCCESS_RATIO
      && !meta.quarantined
    )
    meta.approvedForReuse = meta.promotionEligible || meta.tier === 'promoted'

    // Check quarantine
    if (meta.consecutiveFailures >= QUARANTINE_CONSECUTIVE_FAILURES) {
      meta.quarantined = true
      meta.approvedForReuse = false
      meta.promotionEligible = false
    }

    saveMeta(skillName, meta)
    return meta
  }

  /**
   * Promote an eligible experimental skill to promoted tier.
   */
  function promote(skillName) {
    const meta = loadMeta(skillName)
    if (!meta) return { ok: false, reason: 'skill_not_found' }
    if (!meta.promotionEligible) return { ok: false, reason: 'not_eligible' }
    if (meta.quarantined) return { ok: false, reason: 'quarantined' }

    // Move code file
    const safe = String(skillName).replace(/[^a-zA-Z0-9._-]/g, '_')
    const srcCode = path.join(experimentalDir, `${safe}.js`)
    const dstCode = path.join(promotedDir, `${safe}.js`)
    try {
      if (fs.existsSync(srcCode)) {
        ensureDirs()
        fs.copyFileSync(srcCode, dstCode)
        fs.unlinkSync(srcCode)
      }
    } catch { /* best effort */ }

    // Remove old meta from experimental
    const oldMetaPath = getMetaPath(skillName, experimentalDir)
    try { fs.unlinkSync(oldMetaPath) } catch { /* ok */ }

    meta.tier = 'promoted'
    meta.approvedForReuse = true
    saveMeta(skillName, meta)
    return { ok: true, reason: 'promoted' }
  }

  /**
   * Quarantine a skill (mark as untrusted).
   */
  function quarantine(skillName, reason = 'manual') {
    const meta = loadMeta(skillName)
    if (!meta) return { ok: false, reason: 'skill_not_found' }
    meta.quarantined = true
    meta.approvedForReuse = false
    meta.promotionEligible = false
    meta.quarantineReason = reason
    saveMeta(skillName, meta)
    return { ok: true }
  }

  /**
   * Check if a skill is available for reuse.
   */
  function isApproved(skillName) {
    const meta = loadMeta(skillName)
    return !!meta?.approvedForReuse && !meta?.quarantined
  }

  /**
   * Get metadata for a skill.
   */
  function getMeta(skillName) {
    return loadMeta(skillName) || null
  }

  /**
   * List all candidate skills with their status.
   */
  function listAll() {
    ensureDirs()
    const result = []
    for (const dir of [experimentalDir, promotedDir]) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'))
        for (const f of files) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
            raw.tier = dir === promotedDir ? 'promoted' : 'experimental'
            result.push(raw)
          } catch { /* skip corrupt */ }
        }
      } catch { /* dir missing */ }
    }
    return result
  }

  return Object.freeze({
    registerExperimental,
    recordOutcome,
    promote,
    quarantine,
    isApproved,
    getMeta,
    listAll,
  })
}

module.exports = { createCandidateSkillManager }
