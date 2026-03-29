function normalizeText(v) {
  return String(v || '').toLowerCase()
}

function listInventoryNames(snapshot) {
  const summary = Array.isArray(snapshot?.inventory?.summary) ? snapshot.inventory.summary : []
  return summary.map((x) => String(x?.name || '').toLowerCase()).filter(Boolean)
}

function hasAny(names, arr) {
  return arr.some((n) => names.includes(n))
}

function inferCapabilities(snapshot) {
  const names = listInventoryNames(snapshot)
  return {
    hasFood: hasAny(names, [
      'bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
      'cooked_mutton', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'carrot',
    ]),
    hasTorch: names.includes('torch'),
    hasWoodLike: names.some((n) => n.endsWith('_log') || n.endsWith('_planks')),
    hasCraftingMaterial: names.some((n) => n.endsWith('_planks')) && names.includes('stick'),
  }
}

/**
 * Default personality weight constants.
 * Each key modulates a scoring dimension. When personality is fully implemented,
 * these will be supplied by the personality layer; for now they act as neutral placeholders.
 */
const DEFAULT_PERSONALITY_WEIGHTS = Object.freeze({
  aggression: 1.0,    // multiplier on combat-offensive scores
  caution: 1.0,       // multiplier on retreat/defensive scores
  selfCare: 1.0,      // multiplier on eat/heal scores
  curiosity: 1.0,     // multiplier on explore/gather scores
  persistence: 1.0,   // multiplier on recovery/stuck handling scores
})

function scoreCandidate(base, {
  goalText, snapshot, caps, personalityWeights = DEFAULT_PERSONALITY_WEIGHTS,
}) {
  const w = { ...DEFAULT_PERSONALITY_WEIGHTS, ...personalityWeights }
  const g = normalizeText(goalText)
  const threatLevel = String(snapshot?.threat_level || 'none').toLowerCase()
  const closeThreat = snapshot?.close_threat === true
  const hp = Number(snapshot?.status?.health ?? 20)
  const food = Number(snapshot?.status?.food ?? 20)
  const recentDamage = Number(snapshot?.status?.recentDamageMs ?? -1)

  let score = base.baseScore || 0

  if (base.name === 'attack_nearest_hostile') {
    if (threatLevel === 'high') score += 3.8 * w.aggression
    if (closeThreat) score += 3.1 * w.aggression
    if (recentDamage >= 0 && recentDamage < 6000) score += 2.8 * w.aggression
    if (g.includes('attack') || g.includes('fight') || g.includes('combat') || g.includes('打') || g.includes('战斗')) score += 2.4
    if (hp <= 8) score -= 2.0 * w.caution
  }
  if (base.name === 'retreat_from_threat') {
    if (threatLevel === 'high' && hp <= 8) score += 3.5 * w.caution
    if (closeThreat && hp <= 10) score += 2.2 * w.caution
  }
  if (base.name === 'eat_best_food') {
    if (caps.hasFood && hp <= 10) score += 2.6 * w.selfCare
    if (caps.hasFood && food <= 10) score += 2.0 * w.selfCare
    if (g.includes('eat') || g.includes('food') || g.includes('hungry') || g.includes('吃') || g.includes('饥饿')) score += 1.8
    if (!caps.hasFood) score -= 4
  }
  if (base.name === 'place_torch_safely') {
    if (caps.hasTorch && (snapshot?.status?.isNight === true || threatLevel !== 'none')) score += 2.1
    if (g.includes('torch') || g.includes('light') || g.includes('照明') || g.includes('火把')) score += 1.8
    if (!caps.hasTorch) score -= 2.6
  }
  if (base.name === 'mine_named_block') {
    if (g.includes('tree') || g.includes('wood') || g.includes('log') || g.includes('砍树') || g.includes('木头')) score += 2.4 * w.curiosity
    if (caps.hasWoodLike) score -= 0.3
    if (threatLevel === 'high') score -= 1.8 * w.caution
  }
  if (base.name === 'simple_craft_item') {
    if (g.includes('craft') || g.includes('make') || g.includes('合成')) score += 1.5
    if (caps.hasCraftingMaterial) score += 0.8
    if (threatLevel === 'high') score -= 2 * w.caution
  }
  if (base.name === 'recover_from_stuck') {
    if (g.includes('stuck') || g.includes('卡住') || g.includes('blocked')) score += 2.5 * w.persistence
  }

  return score
}

function chooseHardcodedSkill({ goal, snapshot, options = {}, personalityWeights = {} }) {
  const caps = inferCapabilities(snapshot)
  const pw = { ...DEFAULT_PERSONALITY_WEIGHTS, ...personalityWeights }
  const candidates = [
    { name: 'attack_nearest_hostile', args: {}, baseScore: 0 },
    { name: 'retreat_from_threat', args: {}, baseScore: -0.2 },
    { name: 'eat_best_food', args: {}, baseScore: -0.1 },
    { name: 'place_torch_safely', args: { count: 1 }, baseScore: -0.1 },
    { name: 'mine_named_block', args: { block: 'oak_log', maxDistance: 20 }, baseScore: 0 },
    { name: 'simple_craft_item', args: {}, baseScore: -0.2 },
    { name: 'recover_from_stuck', args: {}, baseScore: -0.1 },
  ]

  let picked = null
  for (const c of candidates) {
    if (c.name === 'mine_named_block' && options.suppressWoodGather) {
      const g = normalizeText(goal)
      const woodIntent = g.includes('wood') || g.includes('log') || g.includes('tree')
        || g.includes('砍') || g.includes('树') || g.includes('木头')
      if (!woodIntent) continue
    }
    const score = scoreCandidate(c, { goalText: goal, snapshot: snapshot || {}, caps, personalityWeights: pw })
    if (score < 1.2) continue
    if (!picked || score > picked.score) picked = { ...c, score }
  }

  if (!picked) return null
  return { name: picked.name, args: picked.args }
}

module.exports = { chooseHardcodedSkill, DEFAULT_PERSONALITY_WEIGHTS }
