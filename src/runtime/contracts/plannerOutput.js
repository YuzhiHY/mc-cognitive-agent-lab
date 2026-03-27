/**
 * Planner Output Contract
 *
 * Defines the scheduling-first output shape from central reasoning.
 * The planner should prefer existing skill_ref over code synthesis.
 */

function validatePlannerOutput(output) {
  if (!output || typeof output !== 'object') {
    return { ok: false, reason: 'output must be an object' }
  }
  if (typeof output.thought !== 'string') {
    return { ok: false, reason: 'thought must be a string' }
  }
  if (!Array.isArray(output.actionChain)) {
    return { ok: false, reason: 'actionChain must be an array' }
  }
  return { ok: true }
}

/**
 * Derive scheduling metadata from a planner decision.
 * Extracts which skills were chosen and whether synthesis is needed.
 */
function derivePlannerMeta(decision) {
  const chain = Array.isArray(decision?.actionChain) ? decision.actionChain : []

  const chosenSkillChain = chain
    .filter((s) => s.type === 'skill_ref')
    .map((s) => s.name)

  const chosenSkill = chosenSkillChain.length > 0 ? chosenSkillChain[0] : null

  const synthesisSteps = chain.filter((s) => s.type === 'skill')
  const requiresSynthesis = synthesisSteps.length > 0

  return {
    thought: decision?.thought || '',
    goal: decision?.nextGoalHint || '',
    chosenSkill,
    chosenSkillChain,
    requiresSynthesis,
    synthesisReason: requiresSynthesis
      ? `${synthesisSteps.length} skill step(s) require code generation`
      : null,
    riskAssessment: decision?.riskAssessment || null,
    expectedOutcome: decision?.expectedOutcome || decision?.nextGoalHint || null,
  }
}

module.exports = { validatePlannerOutput, derivePlannerMeta }
