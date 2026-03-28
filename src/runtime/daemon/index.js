/**
 * Daemon sub-modules barrel index.
 *
 * Phase 9: pure-function extractions
 * Phase 9.5: orchestration extractions
 */
module.exports = {
  // Phase 9 — pure functions
  ...require('./pacingPolicy'),
  ...require('./skillPromotion'),
  ...require('./expectationEvaluator'),
  ...require('./worldStateInterrupt'),
  ...require('./executionMetadata'),
  ...require('./cycleLogger'),

  // Phase 9.5 — orchestration
  ...require('./sharedState'),
  ...require('./taskStateHelper'),
  ...require('./interruptGate'),
  ...require('./reflexGate'),
  ...require('./plannerGate'),
  ...require('./interruptExecutor'),
  ...require('./chainOrchestrator'),
  ...require('./voiceController'),
  ...require('./eventReactor'),
}
