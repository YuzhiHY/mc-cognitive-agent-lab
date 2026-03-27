const fs = require('node:fs')
const path = require('node:path')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function createMemory({ memoryDir } = {}) {
  const baseDir = memoryDir || path.resolve(process.cwd(), 'memory')
  ensureDir(baseDir)

  const files = {
    locations: path.join(baseDir, 'locations.json'),
    knowledge: path.join(baseDir, 'knowledge.json'),
    learned_skills: path.join(baseDir, 'learned_skills.json'),
  }

  for (const filePath of Object.values(files)) {
    if (!fs.existsSync(filePath)) writeJson(filePath, {})
  }

  const caches = {
    locations: readJsonSafe(files.locations),
    knowledge: readJsonSafe(files.knowledge),
    learned_skills: readJsonSafe(files.learned_skills),
  }

  function categorize(key) {
    if (key.startsWith('loc:') || key.startsWith('location:')) return 'locations'
    if (key.startsWith('skill:') || key.startsWith('learned:')) return 'learned_skills'
    return 'knowledge'
  }

  function get(key) {
    const cat = categorize(key)
    return caches[cat][key] ?? null
  }

  function set(key, value) {
    const cat = categorize(key)
    if (key === 'knowledge:persona:preference_profile' && value && typeof value === 'object') {
      const compact = {
        values: Array.isArray(value.values) ? value.values.slice(0, 6) : [],
        strategyBias: value.strategyBias && typeof value.strategyBias === 'object'
          ? Object.fromEntries(
              Object.entries(value.strategyBias)
                .slice(0, 12)
                .map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : 0.5]),
            )
          : {},
        stabilityScore: Number.isFinite(Number(value.stabilityScore)) ? Number(value.stabilityScore) : 0.6,
        lastReinforcedAt: value.lastReinforcedAt || null,
        recentPreferenceHints: Array.isArray(value.recentPreferenceHints)
          ? value.recentPreferenceHints.slice(-8)
          : [],
      }
      caches[cat][key] = compact
      writeJson(files[cat], caches[cat])
      return
    }
    caches[cat][key] = value
    // Bound high-churn expectation history to avoid unbounded long-run growth.
    if (cat === 'knowledge' && key.startsWith('knowledge:expectation:last:')) {
      const limit = Number(process.env.MEMORY_EXPECTATION_KEEP || 200)
      const keys = Object.keys(caches.knowledge)
        .filter((k) => k.startsWith('knowledge:expectation:last:'))
        .sort((a, b) => {
          const na = Number(a.split(':').pop()) || 0
          const nb = Number(b.split(':').pop()) || 0
          return na - nb
        })
      const extra = keys.length - Math.max(20, limit)
      if (extra > 0) {
        for (const oldKey of keys.slice(0, extra)) {
          delete caches.knowledge[oldKey]
        }
      }
    }
    writeJson(files[cat], caches[cat])
  }

  function remove(key) {
    const cat = categorize(key)
    delete caches[cat][key]
    writeJson(files[cat], caches[cat])
  }

  function getAll() {
    return {
      locations: { ...caches.locations },
      knowledge: { ...caches.knowledge },
      learned_skills: { ...caches.learned_skills },
    }
  }

  function getCategory(cat) {
    return caches[cat] ? { ...caches[cat] } : {}
  }

  function setDirect(category, key, value) {
    if (!caches[category]) return
    caches[category][key] = value
    writeJson(files[category], caches[category])
  }

  function reload() {
    caches.locations = readJsonSafe(files.locations)
    caches.knowledge = readJsonSafe(files.knowledge)
    caches.learned_skills = readJsonSafe(files.learned_skills)
  }

  return Object.freeze({
    get,
    set,
    delete: remove,
    getAll,
    getCategory,
    setDirect,
    reload,
  })
}

module.exports = { createMemory }
