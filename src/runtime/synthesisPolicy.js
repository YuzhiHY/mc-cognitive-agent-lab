/**
 * Synthesis Policy Gate
 *
 * Controls when LLM-generated code (type: 'skill') is allowed.
 * Code synthesis is the exception, not the default.
 */

const SYNTHESIS_ENABLED = process.env.ALLOW_SYNTHESIS !== 'false'
const MAX_SYNTHESIS_RISK = process.env.MAX_SYNTHESIS_RISK || 'medium'

const RISK_RANK = { low: 1, medium: 2, high: 3 }

/**
 * Evaluate whether a synthesis request is allowed.
 * @param {object} opts
 * @param {object} opts.plannerMeta - from derivePlannerMeta()
 * @param {object} opts.snapshot - current perception snapshot (flat)
 * @param {object} opts.stableSkills - stable skill repository (Map)
 * @returns {{ allowed: boolean, reason: string, filtered: object[] }}
 */
function canSynthesize({ plannerMeta, snapshot, stableSkills } = {}) {
  if (!SYNTHESIS_ENABLED) {
    return { allowed: false, reason: 'synthesis_disabled_by_policy', filtered: [] }
  }

  if (!plannerMeta?.requiresSynthesis) {
    return { allowed: false, reason: 'no_synthesis_requested', filtered: [] }
  }

  // Check if a stable skill could serve instead
  const goal = plannerMeta.goal || plannerMeta.thought || ''
  const skillList = typeof stableSkills?.list === 'function'
    ? stableSkills.list()
    : (stableSkills instanceof Map ? [...stableSkills.keys()].map((n) => ({ name: n })) : [])
  if (skillList.length > 0) {
    for (const skill of skillList) {
      const name = typeof skill === 'string' ? skill : (skill?.name || '')
      if (name && goal.toLowerCase().includes(name.replace(/_/g, ' '))) {
        return {
          allowed: false,
          reason: `stable_skill_available: ${name}`,
          filtered: [],
        }
      }
    }
  }

  // Risk check
  const riskLevel = plannerMeta.riskAssessment || 'medium'
  const maxRank = RISK_RANK[MAX_SYNTHESIS_RISK] || 2
  if ((RISK_RANK[riskLevel] || 2) > maxRank) {
    return { allowed: false, reason: `risk_too_high: ${riskLevel}`, filtered: [] }
  }

  // Threat check — no synthesis during high threat
  const threat = snapshot?.threat_level || snapshot?.decision?.threatLevel || 'none'
  if (threat === 'high') {
    return { allowed: false, reason: 'synthesis_blocked_during_high_threat', filtered: [] }
  }

  return { allowed: true, reason: 'synthesis_allowed_by_policy', filtered: [] }
}

/**
 * Filter a decision's actionChain: replace blocked synthesis steps with recover_from_stuck.
 * Returns a new chain (does not mutate input).
 */
function filterSynthesisSteps(actionChain, synthesisAllowed) {
  if (synthesisAllowed) return actionChain
  return actionChain.map((step) => {
    if (step.type === 'skill') {
      return { type: 'skill_ref', name: 'recover_from_stuck', args: {}, _originalSynthesis: step.skillName }
    }
    return step
  })
}

module.exports = { canSynthesize, filterSynthesisSteps }
