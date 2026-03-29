/**
 * Memory System v2
 *
 * Two-tier memory: working (short-term, in-memory) + long-term (persistent, categorized).
 * Composes workingMemory, longTermMemory, promotionEngine, and memoryProjection.
 * Wraps the legacy memory.js for backward compatibility.
 */

const { createWorkingMemory } = require('./memory2/workingMemory')
const { createLongTermMemory } = require('./memory2/longTermMemory')
const { createPromotionEngine } = require('./memory2/promotionEngine')
const { createMemoryProjection } = require('./memory2/memoryProjection')

function createMemorySystem({ memory, memoryDir }) {
  const workingMemory = createWorkingMemory()
  const longTermMemory = createLongTermMemory({ memoryDir })
  const promotionEngine = createPromotionEngine({ workingMemory, longTermMemory })
  const projection = createMemoryProjection({
    workingMemory,
    longTermMemory,
    legacyMemory: memory,
  })

  // One-time migration from legacy knowledge.json
  if (memory && typeof memory.getCategory === 'function') {
    try {
      const knowledge = memory.getCategory('knowledge')
      if (knowledge && typeof knowledge === 'object') {
        longTermMemory.importFromLegacy(knowledge)
      }
    } catch { /* migration is best-effort */ }
  }

  return Object.freeze({
    workingMemory,
    longTermMemory,
    promotionEngine,
    projection,
    legacy: memory,
  })
}

module.exports = { createMemorySystem }
