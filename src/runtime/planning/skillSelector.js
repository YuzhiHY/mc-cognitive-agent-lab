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

function scoreCandidate(base, {
  goalText, snapshot, caps,
}) {
  const g = normalizeText(goalText)
  const threatLevel = String(snapshot?.threat_level || 'none').toLowerCase()
  const closeThreat = snapshot?.close_threat === true
  const hp = Number(snapshot?.status?.health ?? 20)
  const food = Number(snapshot?.status?.food ?? 20)
  const recentDamage = Number(snapshot?.status?.recentDamageMs ?? -1)

  let score = base.baseScore || 0

  if (base.name === 'attack_nearest_hostile') {
    if (threatLevel === 'high') score += 3.8
    if (closeThreat) score += 3.1
    if (recentDamage >= 0 && recentDamage < 6000) score += 2.8
    if (g.includes('attack') || g.includes('fight') || g.includes('combat') || g.includes('打') || g.includes('战斗')) score += 2.4
    if (hp <= 8) score -= 2.0
  }
  if (base.name === 'retreat_from_threat') {
    if (threatLevel === 'high' && hp <= 8) score += 3.5
    if (closeThreat && hp <= 10) score += 2.2
  }
  if (base.name === 'eat_best_food') {
    if (caps.hasFood && hp <= 10) score += 2.6
    if (caps.hasFood && food <= 10) score += 2.0
    if (g.includes('eat') || g.includes('food') || g.includes('hungry') || g.includes('吃') || g.includes('饥饿')) score += 1.8
    if (!caps.hasFood) score -= 4
  }
  if (base.name === 'place_torch_safely') {
    if (caps.hasTorch && (snapshot?.isNight === true || threatLevel !== 'none')) score += 2.1
    if (g.includes('torch') || g.includes('light') || g.includes('照明') || g.includes('火把')) score += 1.8
    if (!caps.hasTorch) score -= 2.6
  }
  if (base.name === 'mine_named_block') {
    if (g.includes('tree') || g.includes('wood') || g.includes('log') || g.includes('砍树') || g.includes('木头')) score += 2.4
    if (caps.hasWoodLike) score -= 0.3
    if (threatLevel === 'high') score -= 1.8
  }
  if (base.name === 'simple_craft_item') {
    if (g.includes('craft') || g.includes('make') || g.includes('合成')) score += 1.5
    if (caps.hasCraftingMaterial) score += 0.8
    if (threatLevel === 'high') score -= 2
  }
  if (base.name === 'recover_from_stuck') {
    if (g.includes('stuck') || g.includes('卡住') || g.includes('blocked')) score += 2.5
  }

  return score
}

function chooseHardcodedSkill({ goal, snapshot, options = {} }) {
  const caps = inferCapabilities(snapshot)
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
    const score = scoreCandidate(c, { goalText: goal, snapshot: snapshot || {}, caps })
    if (score < 1.2) continue
    if (!picked || score > picked.score) picked = { ...c, score }
  }

  if (!picked) return null
  return { name: picked.name, args: picked.args }
}

module.exports = { chooseHardcodedSkill }

