const fs = require('node:fs')
const path = require('node:path')

function tokenize(text) {
  if (!text) return []
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((x) => x && x.length >= 2)
}

function overlapScore(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0
  const a = new Set(aTokens)
  const b = new Set(bTokens)
  let inter = 0
  for (const t of a) {
    if (b.has(t)) inter += 1
  }
  return inter / Math.max(1, Math.max(a.size, b.size))
}

function normalizePattern(p) {
  return String(p || '').trim().toLowerCase()
}

function matchesGoalPattern(taskGoal, pattern) {
  const goal = String(taskGoal || '').toLowerCase()
  const p = normalizePattern(pattern)
  if (!p) return false
  if (!p.includes('*')) return goal.includes(p)
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
  const re = new RegExp(`^${escaped}$`)
  return re.test(goal)
}

function normalizeIndexEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const skillName = raw.skillName || raw.name
  if (!skillName || typeof skillName !== 'string') return null
  const goalPatterns = Array.isArray(raw.goalPatterns)
    ? raw.goalPatterns.map(normalizePattern).filter(Boolean)
    : []
  const minScoreOverride =
    typeof raw.minScoreOverride === 'number' ? raw.minScoreOverride : null
  return {
    skillName,
    enabled: raw.enabled !== false,
    intent: typeof raw.intent === 'string' ? raw.intent : '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    goalPatterns,
    minScoreOverride,
    riskLevel: typeof raw.riskLevel === 'string' ? raw.riskLevel : 'unknown',
    filePath:
      typeof raw.filePath === 'string' && raw.filePath.trim()
        ? raw.filePath
        : `${skillName}.js`,
  }
}

function createSkillRegistry({
  skillsDir = path.resolve(process.cwd(), 'skills'),
  enabled = false,
  minScore = 0.25,
} = {}) {
  const isEnabled = !!enabled
  const indexPath = path.join(skillsDir, 'index.json')

  async function ensureDir() {
    await fs.promises.mkdir(skillsDir, { recursive: true })
  }

  async function saveMetadata({ skillName, thought, taskGoal, tags = [] }) {
    if (!isEnabled) return
    const safeName = String(skillName).replace(/[^a-zA-Z0-9._-]/g, '_')
    const metaPath = path.join(skillsDir, `${safeName}.meta.json`)
    const payload = {
      skillName: safeName,
      thought: thought || '',
      intent: taskGoal || '',
      tags,
      updatedAt: new Date().toISOString(),
    }
    await fs.promises.writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8')
  }

  async function readIndexEntries() {
    try {
      const raw = await fs.promises.readFile(indexPath, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.skills) ? parsed.skills : parsed
      if (!Array.isArray(list)) return []
      return list.map(normalizeIndexEntry).filter(Boolean)
    } catch {
      return []
    }
  }

  async function findReusableSkillWithDiagnostics({ taskGoal }) {
    if (!isEnabled) return null
    await ensureDir()

    const goalTokens = tokenize(taskGoal)
    let best = null
    const candidates = []

    // 1) Explicit index file has higher priority.
    const indexEntries = await readIndexEntries()
    for (const entry of indexEntries) {
      if (!entry.enabled) {
        candidates.push({
          skillName: entry.skillName,
          source: 'index',
          score: 0,
          effectiveMinScore:
            typeof entry.minScoreOverride === 'number' ? entry.minScoreOverride : minScore,
          reason: 'disabled',
        })
        continue
      }
      if (entry.goalPatterns.length > 0) {
        const anyPatternMatch = entry.goalPatterns.some((p) => matchesGoalPattern(taskGoal, p))
        if (!anyPatternMatch) {
          candidates.push({
            skillName: entry.skillName,
            source: 'index',
            score: 0,
            effectiveMinScore:
              typeof entry.minScoreOverride === 'number' ? entry.minScoreOverride : minScore,
            reason: 'pattern_miss',
          })
          continue
        }
      }
      const intentTokens = tokenize(entry.intent)
      const tagTokens = entry.tags.flatMap(tokenize)
      const score = Math.max(overlapScore(goalTokens, intentTokens), overlapScore(goalTokens, tagTokens))
      const effectiveMinScore =
        typeof entry.minScoreOverride === 'number' ? entry.minScoreOverride : minScore
      const absPath = path.resolve(skillsDir, entry.filePath)
      if (!fs.existsSync(absPath)) {
        candidates.push({
          skillName: entry.skillName,
          source: 'index',
          score,
          effectiveMinScore,
          reason: 'file_missing',
        })
        continue
      }
      if (score < effectiveMinScore) {
        candidates.push({
          skillName: entry.skillName,
          source: 'index',
          score,
          effectiveMinScore,
          reason: 'below_threshold',
        })
        continue
      }
      candidates.push({
        skillName: entry.skillName,
        source: 'index',
        score,
        effectiveMinScore,
        reason: 'eligible',
      })
      if (!best || score > best.score) {
        best = {
          score,
          skillName: entry.skillName,
          filePath: absPath,
          meta: {
            intent: entry.intent,
            tags: entry.tags,
            goalPatterns: entry.goalPatterns,
            minScoreOverride: entry.minScoreOverride,
            riskLevel: entry.riskLevel,
          },
          source: 'index',
        }
      }
    }

    // 2) Fallback to auto sidecar metadata files.
    const files = await fs.promises.readdir(skillsDir)
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'))
    for (const f of metaFiles) {
      const full = path.join(skillsDir, f)
      let meta
      try {
        const raw = await fs.promises.readFile(full, 'utf8')
        meta = JSON.parse(raw)
      } catch {
        continue
      }
      const intentTokens = tokenize(meta.intent)
      const tagTokens = Array.isArray(meta.tags) ? meta.tags.flatMap(tokenize) : []
      const score = Math.max(overlapScore(goalTokens, intentTokens), overlapScore(goalTokens, tagTokens))
      const effectiveMinScore = minScore
      const jsPath = path.join(skillsDir, `${meta.skillName}.js`)
      if (!fs.existsSync(jsPath)) {
        candidates.push({
          skillName: meta.skillName,
          source: 'meta',
          score,
          effectiveMinScore,
          reason: 'file_missing',
        })
        continue
      }
      if (score < effectiveMinScore) {
        candidates.push({
          skillName: meta.skillName,
          source: 'meta',
          score,
          effectiveMinScore,
          reason: 'below_threshold',
        })
        continue
      }
      candidates.push({
        skillName: meta.skillName,
        source: 'meta',
        score,
        effectiveMinScore,
        reason: 'eligible',
      })
      if (!best || score > best.score) {
        best = { score, skillName: meta.skillName, filePath: jsPath, meta, source: 'meta' }
      }
    }

    const topCandidates = candidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => ({
        skillName: c.skillName,
        source: c.source,
        score: Number(c.score.toFixed(4)),
        effectiveMinScore: Number(c.effectiveMinScore.toFixed(4)),
        reason: c.reason,
      }))

    return {
      match: best && best.score >= minScore ? best : null,
      diagnostics: {
        topCandidates,
        candidateCount: candidates.length,
      },
    }
  }

  async function findReusableSkill({ taskGoal }) {
    const res = await findReusableSkillWithDiagnostics({ taskGoal })
    return res?.match || null
  }

  async function loadSkillCode(filePath) {
    return fs.promises.readFile(filePath, 'utf8')
  }

  return Object.freeze({
    enabled: isEnabled,
    minScore,
    saveMetadata,
    findReusableSkill,
    findReusableSkillWithDiagnostics,
    loadSkillCode,
  })
}

module.exports = { createSkillRegistry }

