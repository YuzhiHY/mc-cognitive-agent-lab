/**
 * Working Memory (Short-term)
 *
 * Pure in-memory ring buffers for recent execution results,
 * player messages (with answered tracking), and goal context.
 * Auto-decays old entries each cycle. Never persisted to disk.
 */

function createWorkingMemory({
  maxExecutions = 5,
  maxMessages = 8,
  maxCycleAge = 15,
} = {}) {
  const executionLog = []
  const playerMessages = []
  let currentGoalContext = null
  let lastDecisionThought = ''

  // --- Writers ---

  function recordExecution({ cycle, skill, args, success, failReason, chainSignature, durationMs }) {
    executionLog.push({
      cycle: cycle ?? 0,
      skill: skill || 'unknown',
      args: args || {},
      success: !!success,
      failReason: success ? null : (failReason || null),
      chainSignature: chainSignature || null,
      durationMs: durationMs ?? 0,
      ts: Date.now(),
    })
    // Enforce ring buffer limit
    while (executionLog.length > maxExecutions) executionLog.shift()
  }

  function recordPlayerMessage({ from, text, ts, cycle }) {
    playerMessages.push({
      from: from || 'unknown',
      text: text || '',
      ts: ts || Date.now(),
      cycle: cycle ?? 0,
      answered: false,
    })
    while (playerMessages.length > maxMessages) playerMessages.shift()
  }

  function markMessageAnswered(ts) {
    // Mark by timestamp (closest match within 500ms tolerance)
    for (let i = playerMessages.length - 1; i >= 0; i--) {
      if (Math.abs(playerMessages[i].ts - ts) < 500) {
        playerMessages[i].answered = true
        return true
      }
    }
    // If no exact match, mark the most recent unanswered message
    for (let i = playerMessages.length - 1; i >= 0; i--) {
      if (!playerMessages[i].answered) {
        playerMessages[i].answered = true
        return true
      }
    }
    return false
  }

  /**
   * Mark all unanswered messages from a given sender as answered.
   * Useful when the bot sends a chat — we know it's responding.
   */
  function markAllAnsweredFrom(from) {
    let count = 0
    for (const msg of playerMessages) {
      if (!msg.answered && msg.from === from) {
        msg.answered = true
        count++
      }
    }
    return count
  }

  function setGoalContext({ selfGoal, goalType, targetResource, cycle }) {
    currentGoalContext = {
      selfGoal: selfGoal || '',
      goalType: goalType || 'idle',
      targetResource: targetResource || null,
      cycle: cycle ?? 0,
    }
  }

  function setLastThought(thought) {
    lastDecisionThought = String(thought || '')
  }

  // --- Readers ---

  function getRecentExecutions(n = 3) {
    return executionLog.slice(-n).map((e) => ({ ...e }))
  }

  function getUnansweredMessages() {
    return playerMessages.filter((m) => !m.answered).map((m) => ({ ...m }))
  }

  function getAllMessages(n = 5) {
    return playerMessages.slice(-n).map((m) => ({ ...m }))
  }

  function getGoalContext() {
    return currentGoalContext ? { ...currentGoalContext } : null
  }

  function getLastThought() {
    return lastDecisionThought
  }

  function getAll() {
    return {
      executionLog: executionLog.map((e) => ({ ...e })),
      playerMessages: playerMessages.map((m) => ({ ...m })),
      currentGoalContext: currentGoalContext ? { ...currentGoalContext } : null,
      lastDecisionThought,
    }
  }

  // --- Maintenance ---

  function decay(currentCycle) {
    // Execution log: drop entries older than maxCycleAge
    for (let i = executionLog.length - 1; i >= 0; i--) {
      if (currentCycle - executionLog[i].cycle > maxCycleAge) {
        executionLog.splice(i, 1)
      }
    }
    // Player messages: answered → maxCycleAge, unanswered → 2x maxCycleAge
    for (let i = playerMessages.length - 1; i >= 0; i--) {
      const msg = playerMessages[i]
      const maxAge = msg.answered ? maxCycleAge : maxCycleAge * 2
      if (currentCycle - msg.cycle > maxAge) {
        playerMessages.splice(i, 1)
      }
    }
  }

  return Object.freeze({
    recordExecution,
    recordPlayerMessage,
    markMessageAnswered,
    markAllAnsweredFrom,
    setGoalContext,
    setLastThought,
    getRecentExecutions,
    getUnansweredMessages,
    getAllMessages,
    getGoalContext,
    getLastThought,
    getAll,
    decay,
  })
}

module.exports = { createWorkingMemory }
