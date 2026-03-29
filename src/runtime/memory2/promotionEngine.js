/**
 * Promotion Engine
 *
 * Rule-based auto-promotion from working memory → long-term memory.
 * Zero LLM cost. Runs after each chain execution.
 *
 * Promotion rules:
 * - First success of a skill type → capability
 * - Causal failure (need X, missing Y) → world rule
 * - Player repeated instruction → habit
 * - Player explicit rule ("以后都要"/"记住") → habit
 *
 * Never promotes: wait, aimless navigate, expectation records
 */

const SKIP_SKILLS = new Set(['wait', 'idle'])
const CAUSAL_KEYWORDS = [
  'need', 'missing', 'require', 'no pickaxe', 'no axe', 'no sword', 'no tool',
  'cannot mine', 'cannot craft', 'too far', 'not enough',
  '需要', '缺少', '不够', '没有',
]
const EXPLICIT_HABIT_PATTERNS = [
  /以后都要/,
  /以后记得/,
  /永远不要/,
  /从现在开始/,
  /记住/,
  /长期规矩/,
  /always\b/i,
  /never\b/i,
  /from now on/i,
]

function createPromotionEngine({ workingMemory, longTermMemory }) {

  /**
   * Evaluate a completed execution for promotion.
   * Called after each chain result in chainOrchestrator.
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
    } else if (entry.failReason) {
      // Causal failure → world rule
      const reason = String(entry.failReason).toLowerCase()
      const isCausal = CAUSAL_KEYWORDS.some((kw) => reason.includes(kw.toLowerCase()))
      if (isCausal) {
        const ruleKey = `rule_${hashString(reason).slice(0, 12)}`
        const existing = longTermMemory.get('worldRules', ruleKey)
        if (!existing) {
          const desc = `${skill}${target ? '(' + target + ')' : ''} 失败: ${entry.failReason}`
          longTermMemory.recordWorldRule({
            key: ruleKey,
            description: desc.slice(0, 200),
            source: 'execution_failure',
          })
          promoted.push({ category: 'worldRules', key: ruleKey, description: desc })
        }
      }
    }

    return promoted
  }

  /**
   * Evaluate a player message for habit promotion.
   * Called when a player message is recorded.
   */
  function evaluatePlayerMessage(message) {
    if (!message || !message.text) return []
    const promoted = []
    const text = String(message.text)

    // Explicit habit pattern match
    const isExplicit = EXPLICIT_HABIT_PATTERNS.some((p) => p.test(text))
    if (isExplicit) {
      const habitKey = `habit_${hashString(text).slice(0, 12)}`
      const existing = longTermMemory.get('habits', habitKey)
      if (!existing) {
        longTermMemory.recordHabit({
          key: habitKey,
          description: text.slice(0, 200),
          source: 'player_explicit',
        })
        promoted.push({ category: 'habits', key: habitKey, description: text })
      }
    }

    // Repeated instruction detection (same player, similar content, 2+ times)
    const unanswered = workingMemory.getAllMessages(8)
    const fromSame = unanswered.filter((m) => m.from === message.from)
    if (fromSame.length >= 2) {
      const current = text.toLowerCase()
      const similar = fromSame.filter((m) => {
        const prev = String(m.text).toLowerCase()
        return prev !== current && textSimilarity(prev, current) > 0.5
      })
      if (similar.length >= 1) {
        const habitKey = `habit_repeated_${hashString(text).slice(0, 12)}`
        const existing = longTermMemory.get('habits', habitKey)
        if (!existing) {
          const desc = `玩家${message.from}反复提到: ${text.slice(0, 150)}`
          longTermMemory.recordHabit({
            key: habitKey,
            description: desc,
            source: 'player_repeated',
          })
          promoted.push({ category: 'habits', key: habitKey, description: desc })
        }
      }
    }

    // Update social record for the player
    longTermMemory.recordSocial({
      playerName: message.from,
      description: `玩家${message.from}，最近交互过`,
    })

    return promoted
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
