# Perception System

The perception system builds a tiered snapshot of the world state each cycle. Each tier serves a specific runtime consumer and is frozen to prevent cross-layer mutation.

## Four Tiers

### Reflex Tier

**Consumer:** `reflexLayer.js` (13 survival rules)

Fast boolean flags for emergency evaluation. No complex data structures.

| Field | Type | Description |
|-------|------|-------------|
| `inWater` | boolean | Entity in water |
| `onFire` | boolean | Entity on fire |
| `isInLava` | boolean | Entity in lava |
| `fallingRisk` | boolean | Cliff edge or falling |
| `closeThreat` | boolean | Hostile within melee range |
| `health` | number | Current health points |
| `onGround` | boolean | Entity grounded |
| `velocity` | vec3 | Current movement vector |
| `recentDamageMs` | number/null | Milliseconds since last damage |
| `damageSource` | object/null | `{type, name, entityId, at}` |
| `stuckLikely` | boolean | Stuck detection flag |

### Execution Tier

**Consumer:** Skill execution layer, `chainExecutor.js`

Body state needed during active skill execution.

| Field | Type | Description |
|-------|------|-------------|
| `position` | vec3 | Current world position |
| `velocity` | vec3 | Movement vector |
| `health` | number | Health points |
| `food` | number | Food level |
| `heldItem` | object/null | Currently held item |
| `onGround` | boolean | Grounded state |
| `nearbyBlocks` | array | Blocks within scan radius |
| `nearbyEntities` | array | Entities within scan radius |
| `immediateObstacles` | array | Blocking obstacles |

### Decision Tier

**Consumer:** `centralReasoning.js` (planner phases 1-3)

Structured data for goal selection and action planning.

| Field | Type | Description |
|-------|------|-------------|
| `threatLevel` | string | `none`, `low`, `high` |
| `closeThreat` | boolean | Hostile within melee range |
| `nearestHostileDistance` | number | Distance to nearest hostile |
| `threatBands` | object | Hostiles grouped by distance band |
| `nearbyHostiles` | array | Hostile entities (filtered from all entities) |
| `nearbyResources` | array | Mineable/gatherable blocks nearby |
| `farResources` | array | Resources beyond immediate radius |
| `usefulStations` | array | Crafting tables, furnaces, chests |
| `inventorySummary` | object | Condensed inventory contents |
| `inventorySlotsUsed` | number | Slots currently occupied |
| `currentGoalProgress` | object/null | Progress toward active goal |

### Semantic Tier

**Consumer:** LLM prompt builder, personality layer

High-level labels derived from lower tiers. Used in LLM system prompts.

| Field | Type | Description |
|-------|------|-------------|
| `areaSafetyLabel` | string | `safe`, `cautious`, `risky_night`, `dangerous` |
| `opportunityHints` | array | `ore_nearby`, `wood_nearby`, `ore_cluster_close`, etc. |
| `memoryHints` | array | Relevant memories for current context |
| `capabilityHints` | array | Available capabilities given inventory/tools |
| `personalityModifiers` | object/null | Personality-derived context modifiers |

## Safety Label Derivation

```
threat=high OR closeThreat        → dangerous
threat=low AND isNight            → risky_night
threat=low                        → cautious
otherwise                         → safe
```

## Tier Isolation

Each tier is `Object.freeze()`-d. Tiers are distinct objects — modifying one cannot affect another. The reflex tier intentionally excludes decision-level fields (e.g., `threatBands`, `inventorySummary`) to prevent reflex rules from depending on complex data that may not be available under time pressure.

## Flat Snapshot (Legacy)

A backward-compatible flat view is also produced, merging key fields from all tiers into a single object. This is used by modules not yet migrated to tiered access. New code should always use the tiered snapshot.

## Entry Point

```js
const { buildTieredSnapshot } = require('./contracts/perceptionSnapshot')

const tiered = buildTieredSnapshot({ bot, status, inventory, blocks, entities, ... })
// tiered.reflex   — for reflex layer
// tiered.execution — for skill execution
// tiered.decision  — for planner
// tiered.semantic  — for LLM prompts
// tiered.flat      — legacy compat
```

## Hostile Entity Set

23 mob types are classified as hostile: zombie, skeleton, creeper, spider, cave_spider, enderman, witch, slime, phantom, drowned, husk, stray, blaze, ghast, magma_cube, wither_skeleton, pillager, vindicator, evoker, ravager, hoglin, piglin_brute, warden.
