/**
 * Shared mutable state bag for daemon sub-modules (Phase 9.5).
 *
 * Every daemon sub-orchestrator receives this object by reference.
 * Single-writer semantics: each field has one logical owner, others read only.
 */

function createSharedState() {
  return {
    cycleCount: 0,
    stopped: false,
    started: false,

    // Interrupt executor owns these
    reflexTakeoverInFlight: false,
    lastReflexCooldownKey: null,
    lastReflexCooldownAt: 0,

    // Chain orchestrator owns these
    currentChainRunControl: null,
    currentExecutionMeta: null,
    currentSkillMeta: null,
    stuckWatchLastPos: null,
    stuckWatchLastAt: 0,
    stuckWatchZeroCount: 0,

    // Task lifecycle
    activeTask: null,
    stateTransitionTrace: [],

    // Perception / damage
    lastDamageAt: 0,
    lastCycleSnapshot: null,

    // Metrics
    metrics: {
      cycles: 0,
      reflexCount: 0,
      reasoningCount: 0,
      errorCount: 0,
      combatHoldCount: 0,
    },

    // Cycle-scoped observability (reset each cycle, written by chainOrchestrator)
    cycleFailureFingerprint: null,
    cycleCandidatePromotion: null,
    cycleCandidateQuarantine: null,

    // Player messages (chatListener pushes, runCycle splices)
    playerMessageQueue: [],

    // Connection state (eventReactor sets on disconnect/kick)
    botDisconnected: false,
  }
}

module.exports = { createSharedState }
