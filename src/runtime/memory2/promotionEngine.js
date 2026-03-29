/**
 * Promotion Engine
 *
 * Auto-promotion from working memory → long-term memory.
 *
 * Deterministic rules only (no semantic judgment):
 * - First success of a skill type → capability
 * - Social record update on player interaction
 *
 * Causal failure → worldRule and player instruction → habit
 * are handled by the LLM analyze phase via longTermLearnProposals.
 * Per CLAUDE.md: "ALL decisions go through central LLM,
 * keyword matching ONLY for reflex-tier neural reflexes."
 *
 * Never promotes: wait, aimless navigate
 */

const SKIP_SKILLS = new Set(['wait', 'idle'])

function createPromotionEngine({ workingMemory, longTermMemory }) {

  /**
   * Evaluate a completed execution for promotion.
   * Only promotes first-success → capability (deterministic).
   */
  function evaluateAfterExecution(entry) {
    if (!entry) return []
    const promoted = []

    const skill = String(entry.skill || '').toLowerCase()
    const target = entry.args?.target || entry.args?.block || entry.args?.item || ''
    const capKey = target ? `${skill}:${target}` : skill

    // Skip non-meaningful actions
    if (SKIP_SKILLS.has(skill)) return promoted
    if (skill === 'navigate' && !target) return promoted

    if (entry.success) {
      // First success → capability
      const existing = longTermMemory.get('capabilities', capKey)
      if (!existing) {
        const desc = target
          ? `成功执行过 ${skill}(${target})`
          : `成功执行过 ${skill}`
        longTermMemory.recordCapability({ key: capKey, description: desc })
        promoted.push({ category: 'capabilities', key: capKey, description: desc })
      } else {
        // Update success count for existing capability
        longTermMemory.recordCapability({ key: capKey })
      }
    }
    // Causal failure → worldRule is now handled by LLM analyze phase.
    // No keyword matching here.

    return promoted
  }

  /**
   * Evaluate a player message. Only updates social record (deterministic).
   * Habit/rule extraction is handled by LLM analyze phase.
   */
  function evaluatePlayerMessage(message) {
    if (!message || !message.text) return []

    // Social record update only (deterministic)
    longTermMemory.recordSocial({
      playerName: message.from,
      description: `玩家${message.from}，最近交互过`,
    })

    return []
  }

  return Object.freeze({
    evaluateAfterExecution,
    evaluatePlayerMessage,
  })
}

// --- Utility ---

function hashString(str) {
  let hash = 0
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

/**
 * Simple word-overlap similarity (0-1).
 */
function textSimilarity(a, b) {
  const wordsA = new Set(a.split(/[\s,._:：，。]+/).filter((w) => w.length > 1))
  const wordsB = new Set(b.split(/[\s,._:：，。]+/).filter((w) => w.length > 1))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }
  return overlap / Math.max(wordsA.size, wordsB.size)
}

module.exports = { createPromotionEngine, hashString, textSimilarity }
