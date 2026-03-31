# Skill System

Skills are the execution units of the agent. The agent never directly controls the bot — it selects skills (or synthesizes new ones) that the chain executor runs.

## Skill Contract

Every skill must satisfy the contract defined in `src/runtime/contracts/skillContract.js`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier |
| `category` | string | yes | Classification (e.g., `combat`, `resource`, `navigation`) |
| `description` | string | yes | Human-readable summary |
| `preconditions` | function | yes | Returns truthy if skill can run |
| `execute` | function | yes | Async execution body |
| `canInterrupt` | boolean | yes | Whether reflex can interrupt mid-execution |
| `timeoutMs` | number | yes | Positive finite timeout |
| `tags` | array | yes | Search/matching tags |
| `riskLevel` | string | yes | `low`, `medium`, or `high` |

### Execution Flow

```
validateSkillContract(skill)
  → skill.preconditions({api, bot, ctx, args})
    → skill.execute({api, bot, ctx, args, startedAt})
      → executionResult (normalized)
```

If validation fails, returns `invalidResult`. If precondition fails, returns `invalidResult` with reason. Otherwise, the skill's own return value is passed through.

## Stable Skills

13 hardcoded skills in `src/runtime/skills/`:

| Skill | Category | Description |
|-------|----------|-------------|
| `approach_target` | navigation | Navigate toward a block or entity |
| `attack_nearest_hostile` | combat | Melee attack against nearby mobs |
| `collect_nearby_drop` | resource | Pick up dropped items |
| `eat_best_food` | survival | Consume best available food |
| `equip_named_item` | utility | Equip item by name |
| `face_target` | navigation | Look toward a target |
| `follow_player` | social | Follow a player entity |
| `mine_named_block` | resource | Mine a specific block type |
| `place_named_block` | building | Place a block |
| `place_torch_safely` | building | Strategic torch placement |
| `recover_from_stuck` | recovery | Escape stuck states |
| `retreat_from_threat` | combat | Flee from danger |
| `simple_craft_item` | crafting | Craft an item at a crafting table |

### Adding a New Stable Skill

1. Create `src/runtime/skills/your_skill.js`
2. Export an object satisfying the skill contract
3. The skill is auto-loaded by `src/runtime/skills/index.js` on startup
4. Files prefixed with `_` are excluded from auto-loading

```js
module.exports = {
  name: 'your_skill',
  category: 'resource',
  description: 'Does something useful',
  preconditions: ({ bot }) => bot.health > 5,
  execute: async ({ api, bot, ctx }) => {
    // ... skill logic
    return { ok: true, status: 'success' }
  },
  canInterrupt: true,
  timeoutMs: 10000,
  tags: ['resource', 'gather'],
  riskLevel: 'low',
}
```

## Skill Selection (Scheduling-First)

The planner's primary job is to select existing stable skills (`skill_ref` type), not to generate code. The selection flow:

1. **Stable skill repository** — `createStableSkillRepository()` provides `list()` and `get(name)`
2. **Skill selector** — `skillSelector.js` matches goals to skills via token overlap scoring
3. **Skill registry** — `skillRegistry.js` searches both stable and candidate pipeline skills
4. **gameKnowledge** — Constrains the LLM to only reference skills that actually exist

If no stable skill matches, the planner may request synthesis (see Synthesis Policy below).

## Candidate Skill Pipeline

LLM-generated skills go through a managed lifecycle before being trusted:

```
LLM Synthesis → registerExperimental() → recordOutcome() ×N
                    ↓ (3+ successes, 75%+ ratio)
                promote() → skills/promoted/
                    ↓ (3 consecutive failures)
                quarantine() → blocked from reuse
```

### Lifecycle Stages

| Stage | Directory | Approved | Description |
|-------|-----------|----------|-------------|
| experimental | `skills/experimental/` | no | Newly generated, unproven |
| promoted | `skills/promoted/` | yes | Stable enough for reuse |
| quarantined | (in-place) | no | Blocked after repeated failures |

### Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `SKILL_PROMOTION_MIN_SUCCESSES` | 3 | Minimum successes before promotion eligible |
| `SKILL_PROMOTION_SUCCESS_RATIO` | 0.75 | Minimum success ratio |
| `SKILL_QUARANTINE_FAILURES` | 3 | Consecutive failures before quarantine |

### Metadata Schema

Each candidate skill tracks:
- `origin: "llm_generated"`, `tier`, `createdAt`
- `successCount`, `failureCount`, `consecutiveFailures`
- `recentOutcomes` (rolling window of 20)
- `approvedForReuse`, `promotionEligible`, `quarantined`
- `riskLevel`, `intent`, `tags`

## Synthesis Policy

Code synthesis is gated by `synthesisPolicy.js`:

1. Env `ALLOW_SYNTHESIS=false` → blocked globally
2. No synthesis requested → not needed
3. Stable skill already matches goal → use stable instead
4. Risk level exceeds `MAX_SYNTHESIS_RISK` (default `medium`) → blocked
5. Threat level is `high` → blocked (safety)
6. Otherwise → allowed

When synthesis is blocked, synthesis steps are replaced with `recover_from_stuck` as a safe fallback.
