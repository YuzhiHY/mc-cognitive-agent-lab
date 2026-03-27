const fs = require('node:fs')
const path = require('node:path')

function loadStableSkillsFromDirectory() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !f.startsWith('_'))
    .filter((f) => !['index.js', 'hardcodedSkills.js', 'stableSkillOps.js'].includes(f))

  const loaded = []
  for (const file of files) {
    const mod = require(path.join(__dirname, file))
    if (mod && typeof mod === 'object' && typeof mod.name === 'string') loaded.push(mod)
  }
  return loaded
}

const STABLE_SKILLS = Object.freeze(loadStableSkillsFromDirectory())

function createStableSkillRepository() {
  const byName = new Map(STABLE_SKILLS.map((s) => [s.name, s]))
  return Object.freeze({
    kind: 'stable',
    list: ({ tags = [], category = null } = {}) => STABLE_SKILLS.filter((s) => {
      if (category && s.category !== category) return false
      if (Array.isArray(tags) && tags.length > 0) {
        const set = new Set((s.tags || []).map((t) => String(t).toLowerCase()))
        return tags.every((t) => set.has(String(t).toLowerCase()))
      }
      return true
    }),
    get: (name) => byName.get(String(name || '')),
  })
}

module.exports = {
  createStableSkillRepository,
  STABLE_SKILLS,
}

