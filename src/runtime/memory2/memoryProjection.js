/**
 * Memory Projection
 *
 * Builds per-consumer memory views from working memory + long-term memory.
 * Replaces the old curateMemoryForPlanner() approach of dumping everything.
 *
 * Three projections:
 * - forPersonality: compact (recent actions + relevant capabilities + goal)
 * - forAnalyze: full working memory + curated long-term + legacy data
 * - forDecide: unanswered messages + recent executions + relevant long-term
 */

function createMemoryProjection({ workingMemory, longTermMemory, legacyMemory }) {

  /**
   * Projection for personality consultation.
   * Goal: let personality know what the bot has done recently.
   * Budget: ~200-300 tokens.
   */
  function forPersonality({ goal, snapshot } = {}) {
    const recentActions = workingMemory.getRecentExecutions(3).map((e) => ({
      skill: e.skill,
      target: e.args?.target || e.args?.block || e.args?.item || null,
      success: e.success,
      failReason: e.failReason || null,
    }))
    const goalContext = workingMemory.getGoalContext()
    const relevant = longTermMemory.queryRelevant({
      goal: goal || goalContext?.selfGoal,
      snapshot,
      limit: { capabilities: 3, worldRules: 1, social: 1, habits: 1 },
    })
    const capabilityNames = Object.keys(relevant.capabilities || {})
    return {
      recentActions,
      goalContext,
      knownCapabilities: capabilityNames,
    }
  }

  /**
   * Projection for central analyze phase.
   * Goal: full context for situation analysis.
   * Budget: ~400-600 tokens.
   */
  function forAnalyze({ goal, snapshot, playerMessages, failureContext } = {}) {
    const working = workingMemory.getAll()
    const relevant = longTermMemory.queryRelevant({
      goal: goal || working.currentGoalContext?.selfGoal,
      snapshot,
    })
    // Legacy learned skills (compact format)
    let learnedSkills = []
    if (legacyMemory && typeof legacyMemory.getCategory === 'function') {
      const ls = legacyMemory.getCategory('learned_skills')
      learnedSkills = Object.entries(ls || {})
        .filter(([k]) => k.startsWith('learned:') || k.startsWith('skill:'))
        .slice(0, 10)
        .map(([k, v]) => ({
          key: k,
          signature: v?.signature || null,
          successCount: v?.successCount || 0,
          failCount: v?.failCount || 0,
        }))
    }
    return {
      workingMemory: {
        recentExecutions: working.executionLog,
        playerMessages: working.playerMessages,
        goalContext: working.currentGoalContext,
        lastThought: working.lastDecisionThought,
      },
      longTerm: relevant,
      learnedSkills,
    }
  }

  /**
   * Projection for central decide phase.
   * Goal: actionable context for plan generation.
   * Budget: ~300-500 tokens.
   */
  function forDecide({ goal, snapshot, analysis } = {}) {
    const unanswered = workingMemory.getUnansweredMessages()
    const recentExec = workingMemory.getRecentExecutions(3)
    const goalContext = workingMemory.getGoalContext()
    const relevant = longTermMemory.queryRelevant({
      goal: goal || analysis?.selfGoal || goalContext?.selfGoal,
      snapshot,
    })
    // Compact relevant long-term for token efficiency
    const compactLongTerm = {}
    for (const [cat, entries] of Object.entries(relevant)) {
      compactLongTerm[cat] = Object.entries(entries).map(([k, v]) => ({
        key: k,
        description: v.description || k,
      }))
    }
    return {
      unansweredPlayerMessages: unanswered,
      recentExecutions: recentExec.map((e) => ({
        skill: e.skill,
        target: e.args?.target || e.args?.block || e.args?.item || null,
        success: e.success,
        failReason: e.failReason || null,
      })),
      goalContext,
      longTerm: compactLongTerm,
    }
  }

  /**
   * Format recent actions as a compact string for personality brief injection.
   */
  function formatRecentActionsForBrief() {
    const actions = workingMemory.getRecentExecutions(3)
    if (actions.length === 0) return ''
    const parts = actions.map((a) => {
      const target = a.args?.target || a.args?.block || a.args?.item || ''
      const result = a.success ? '成功' : `失败(${a.failReason || '未知原因'})`
      return `${a.skill}${target ? '(' + target + ')' : ''}: ${result}`
    })
    return `最近行动: ${parts.join('; ')}`
  }

  return Object.freeze({
    forPersonality,
    forAnalyze,
    forDecide,
    formatRecentActionsForBrief,
  })
}

module.exports = { createMemoryProjection }
