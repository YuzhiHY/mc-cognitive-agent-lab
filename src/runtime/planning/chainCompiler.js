const { chooseHardcodedSkill } = require('./skillSelector')

function norm(v) {
  return String(v || '').trim().toLowerCase()
}

function isThreatHigh(snapshot) {
  const threat = norm(snapshot?.threat_level)
  const closeThreat = snapshot?.close_threat === true
  const hp = Number(snapshot?.status?.health ?? 20)
  const recentDamage = Number(snapshot?.status?.recentDamageMs ?? -1)
  if (threat === 'high' || threat === 'low') return true
  if (closeThreat) return true
  if (recentDamage >= 0 && recentDamage < 6000) return true
  if (hp <= 8) return true
  return false
}

function toSkillRefForStep(step) {
  const type = norm(step?.type)
  if (type === 'torch') {
    return {
      type: 'skill_ref',
      name: 'place_torch_safely',
      args: {
        count: step.count || 1,
        item: step.item || 'torch',
        radius: step.radius || 3,
        force: step.force === true,
      },
    }
  }
  if (type === 'attack') {
    return { type: 'skill_ref', name: 'attack_nearest_hostile', args: {} }
  }
  if (type === 'craft' && step?.item) {
    return {
      type: 'skill_ref',
      name: 'simple_craft_item',
      args: { item: step.item, count: step.count || 1 },
    }
  }
  return null
}

function compactPairToStableSkills(chain) {
  const out = []
  for (let i = 0; i < chain.length; i++) {
    const a = chain[i]
    const b = chain[i + 1]
    const ta = norm(a?.type)
    const tb = norm(b?.type)
    const navTarget = norm(a?.target)
    const digTarget = norm(b?.target)
    if (
      ta === 'navigate'
      && tb === 'dig'
      && navTarget.startsWith('nearest_')
      && navTarget.replace('nearest_', '') === digTarget
    ) {
      out.push({ type: 'skill_ref', name: 'approach_target', args: { target: digTarget, sprint: !!a?.sprint } })
      out.push({ type: 'skill_ref', name: 'mine_named_block', args: { block: digTarget, maxDistance: 20 } })
      i += 1
      continue
    }
    out.push(a)
  }
  return out
}

function sanitizeChain(actionChain) {
  const arr = Array.isArray(actionChain) ? actionChain : []
  const allowed = new Set([
    'chat', 'navigate', 'dig', 'place', 'equip', 'attack', 'craft', 'smelt', 'torch',
    'skill_ref', 'wait', 'skill',
  ])
  return arr.filter((s) => allowed.has(norm(s?.type)))
}

function compileActionChain({
  actionChain,
  goal,
  snapshot,
}) {
  let chain = sanitizeChain(actionChain)
  chain = compactPairToStableSkills(chain)
  chain = chain.map((step) => toSkillRefForStep(step) || step)

  if (isThreatHigh(snapshot)) {
    const hasCombat = chain.some((s) => norm(s?.type) === 'skill_ref' && norm(s?.name) === 'attack_nearest_hostile')
      || chain.some((s) => norm(s?.type) === 'attack')
    if (!hasCombat) {
      chain.unshift({ type: 'skill_ref', name: 'attack_nearest_hostile', args: {} })
    }
    chain = chain.filter((s, idx) => !(idx === 1 && norm(s?.type) === 'chat'))
  }

  if (chain.length === 0) {
    const selected = chooseHardcodedSkill({ goal: goal || '', snapshot: snapshot || null })
    if (selected?.name) chain = [{ type: 'skill_ref', name: selected.name, args: selected.args || {} }]
  }

  return chain
}

module.exports = {
  compileActionChain,
}

