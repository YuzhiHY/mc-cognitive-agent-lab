/**
 * Long-term Memory
 *
 * Persistent categorized store backed by memory/long_term.json.
 * Four categories: capabilities, worldRules, social, habits.
 * Supports relevance-based querying (keyword + recency, no LLM).
 */

const fs = require('fs')
const path = require('path')

const CATEGORIES = ['capabilities', 'worldRules', 'social', 'habits']

function createLongTermMemory({ memoryDir }) {
  const filePath = path.join(memoryDir, 'long_term.json')
  let store = loadStore()

  function loadStore() {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const s = {}
      for (const cat of CATEGORIES) {
        s[cat] = (parsed[cat] && typeof parsed[cat] === 'object') ? parsed[cat] : {}
      }
      return s
    } catch {
      const s = {}
      for (const cat of CATEGORIES) s[cat] = {}
      return s
    }
  }

  function persist() {
    try {
      fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8')
    } catch { /* best effort */ }
  }

  // --- Writers ---

  function recordCapability({ key, description, successCount = 1 }) {
    const existing = store.capabilities[key]
    if (existing) {
      existing.successCount = (existing.successCount || 0) + 1
      existing.lastUsed = new Date().toISOString()
      if (description) existing.description = description
    } else {
      store.capabilities[key] = {
        type: 'capability',
        description: description || key,
        firstSuccess: new Date().toISOString(),
        successCount: successCount || 1,
        lastUsed: new Date().toISOString(),
      }
    }
    persist()
  }

  function recordWorldRule({ key, description, source }) {
    if (store.worldRules[key]) return // don't overwrite existing rules
    store.worldRules[key] = {
      type: 'world_rule',
      description: description || key,
      source: source || 'execution',
      learnedAt: new Date().toISOString(),
    }
    persist()
  }

  function recordSocial({ playerName, description }) {
    const key = `player:${playerName}`
    const existing = store.social[key]
    if (existing) {
      existing.interactions = (existing.interactions || 0) + 1
      existing.lastSeen = new Date().toISOString()
      if (description) existing.description = description
    } else {
      store.social[key] = {
        type: 'social',
        description: description || `player ${playerName}`,
        interactions: 1,
        lastSeen: new Date().toISOString(),
      }
    }
    persist()
  }

  function recordHabit({ key, description, source }) {
    store.habits[key] = {
      type: 'habit',
      description: description || key,
      source: source || 'unknown',
      confirmedAt: new Date().toISOString(),
    }
    persist()
  }

  function set(category, key, value) {
    if (!CATEGORIES.includes(category)) return
    store[category][key] = value
    persist()
  }

  function remove(category, key) {
    if (!CATEGORIES.includes(category)) return
    delete store[category][key]
    persist()
  }

  // --- Readers ---

  function getCapabilities() {
    return { ...store.capabilities }
  }

  function getCategory(category) {
    if (!CATEGORIES.includes(category)) return {}
    return { ...store[category] }
  }

  function get(category, key) {
    if (!CATEGORIES.includes(category)) return undefined
    return store[category][key] || undefined
  }

  function getAll() {
    const result = {}
    for (const cat of CATEGORIES) result[cat] = { ...store[cat] }
    return result
  }

  /**
   * Relevance-based query. Returns items matching goal/snapshot context.
   * Pure keyword matching + recency scoring, no LLM.
   */
  function queryRelevant({ goal, snapshot, limit } = {}) {
    const goalStr = String(goal || '').toLowerCase()
    const threatLevel = snapshot?.threat_level || 'none'
    const hasCombat = threatLevel === 'high' || threatLevel === 'medium'

    const limits = {
      capabilities: limit?.capabilities ?? 5,
      worldRules: limit?.worldRules ?? 3,
      social: limit?.social ?? 2,
      habits: limit?.habits ?? 2,
    }

    const result = {}
    for (const cat of CATEGORIES) {
      const entries = Object.entries(store[cat])
      const scored = entries.map(([key, val]) => {
        let score = 0
        const desc = String(val.description || '').toLowerCase()
        const keyLow = key.toLowerCase()
        // Goal keyword match
        if (goalStr) {
          const goalWords = goalStr.split(/[\s,_:]+/).filter((w) => w.length > 2)
          for (const w of goalWords) {
            if (keyLow.includes(w)) score += 3
            if (desc.includes(w)) score += 2
          }
        }
        // Combat context boost
        if (hasCombat && (keyLow.includes('attack') || keyLow.includes('retreat') || keyLow.includes('combat') || keyLow.includes('fight'))) {
          score += 2
        }
        // Recency boost (for items with lastUsed/lastSeen)
        const lastTime = val.lastUsed || val.lastSeen || val.confirmedAt || val.learnedAt || val.firstSuccess
        if (lastTime) {
          const ageMs = Date.now() - new Date(lastTime).getTime()
          if (ageMs < 5 * 60 * 1000) score += 2 // last 5 min
          else if (ageMs < 30 * 60 * 1000) score += 1 // last 30 min
        }
        return { key, val, score }
      })
      // Sort by score descending, take top N
      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, limits[cat])
      result[cat] = {}
      for (const { key, val } of top) {
        if (val) result[cat][key] = val
      }
    }
    return result
  }

  /**
   * One-time migration from legacy knowledge.json data.
   */
  function importFromLegacy(knowledgeData) {
    if (!knowledgeData || typeof knowledgeData !== 'object') return 0
    let imported = 0
    for (const [key, value] of Object.entries(knowledgeData)) {
      const keyLow = key.toLowerCase()
      const valStr = typeof value === 'string' ? value : JSON.stringify(value)
      // player_* → social
      if (keyLow.startsWith('player_') || keyLow.startsWith('nearby_player')) {
        const playerName = valStr.match(/(\w+)\s+at\s+distance/)?.[1]
          || valStr.match(/(\w+)\s+requested/)?.[1]
          || 'unknown'
        if (!store.social[`player:${playerName}`]) {
          store.social[`player:${playerName}`] = {
            type: 'social',
            description: valStr.slice(0, 200),
            interactions: 1,
            lastSeen: new Date().toISOString(),
          }
          imported++
        }
      }
      // habit:* or knowledge:habit_learned:* → habits
      if (keyLow.startsWith('habit:') || keyLow.includes('habit_learned')) {
        const habitKey = key.replace(/^(knowledge:)?habit(_learned)?:/, '')
        if (!store.habits[habitKey]) {
          store.habits[habitKey] = {
            type: 'habit',
            description: typeof value === 'string' ? value : (value?.description || valStr).slice(0, 200),
            source: 'legacy_migration',
            confirmedAt: new Date().toISOString(),
          }
          imported++
        }
      }
    }
    if (imported > 0) persist()
    return imported
  }

  function reload() {
    store = loadStore()
  }

  return Object.freeze({
    recordCapability,
    recordWorldRule,
    recordSocial,
    recordHabit,
    set,
    remove,
    getCapabilities,
    getCategory,
    get,
    getAll,
    queryRelevant,
    importFromLegacy,
    reload,
  })
}

module.exports = { createLongTermMemory }
