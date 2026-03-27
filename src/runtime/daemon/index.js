/**
 * Daemon sub-modules (Phase 9 decomposition)
 *
 * These modules were extracted from daemon.js to reduce its size
 * and improve testability of individual responsibilities.
 */
module.exports = {
  ...require('./pacingPolicy'),
  ...require('./skillPromotion'),
  ...require('./expectationEvaluator'),
  ...require('./worldStateInterrupt'),
  ...require('./executionMetadata'),
}
