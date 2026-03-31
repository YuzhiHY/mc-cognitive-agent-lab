# Planner Policy

The central reasoning pipeline is the agent's decision-maker. It runs when the planner gate allows it and produces an action chain for execution.

## Scheduling-First Principle

The planner's default behavior is to **schedule existing skills**, not generate new code. This is enforced at multiple levels:

1. The LLM prompt lists available stable skills via `gameKnowledge`
2. `skill_ref` steps reference existing skills; `skill` steps request synthesis
3. Synthesis is gated by `synthesisPolicy.js` (blocked during high threat, when stable skill exists, etc.)
4. Hallucinated skill references (names not in the registry) are stripped and replaced with safe fallbacks

## 4-Phase Reasoning Pipeline

`centralReasoning.js` orchestrates:

### Phase 1: Analyze

**Budget:** 12s (env `CENTRAL_ANALYZE_BUDGET_MS`)

Extracts situation assessment from the current snapshot:
- `situationAnalysis` — fact-based summary of the world state
- `selfGoal` — derived goal from snapshot + memory + player messages
- `goalConstraints` — structured: `{goalType, targetResource, prerequisite, blockedBy}`
- `severity` — `idle`, `normal`, `urgent`
- `rankedGoals` — prioritized goal list
- `memoryUpdates` — immediate memory changes (remember/forget)

### Phase 2: Personality

**Budget:** 5s (env `CENTRAL_PERSONALITY_BUDGET_MS`)

Generates behavioral tendency signals:
- `tendencyHints` — array of tendency tags (e.g., `stay_near_familiar`, `retreat_first`, `observe_unknown`)
- `voice` — personality expression text
- `emotionalTags` — current emotional state
- `suggestion` — strategic hint

Skipped when `severity=idle` and not every 3rd cycle (saves latency).

### Phase 3: Decide

**Budget:** 12s (env `CENTRAL_DECIDE_BUDGET_MS`)

Produces the action chain:
- Builds `gameKnowledge` constraints (valid skills, blocks, items)
- Resolves goal prerequisites (e.g., need crafting table before tools)
- Filters hallucinated skill_ref steps
- Applies hard constraint: 3+ consecutive failures of same type → strip matching steps
- Applies personality tendency hints as tie-break (reorder same-priority steps)
- Gates synthesis policy

Output: `actionChain` (array of steps), `thought`, `nextGoalHint`

### Phase 4: Expectation (Optional)

Runs only if time permits within the overall budget (25s default):
- `expectedOutcome` — predicted result
- `confidence` — 0-1 prediction confidence
- `risk` — predicted risks
- `fallbackHint` — suggested recovery action

## Planner Output Schema

Defined in `contracts/plannerOutput.js`:

```js
{
  thought: string,           // reasoning trace
  actionChain: [             // steps to execute
    { type: 'skill_ref', skillName: 'mine_named_block', ... },
    { type: 'skill_ref', skillName: 'simple_craft_item', ... },
  ],
  nextGoalHint: string,      // goal for post-processing
  memoryUpdates: [],          // memory changes
  expectation: {              // from Phase 4
    expectedOutcome: string,
    confidence: number,
  },
  tendencyHints: [],          // from Phase 2
}
```

### Action Chain Step Types

| Type | Description | Synthesis? |
|------|-------------|-----------|
| `skill_ref` | Reference to existing stable skill | No |
| `skill` | LLM-generated code | Yes |
| `wait` | Passive wait with timeout | No |

## Failure Handling

The planner receives failure context from previous cycles:
- `recentOutcomes` — rolling window of 6 recent results
- `lastChainResult` — detailed result of last execution
- `failureFingerprint` — classified failure (path_blocked, no_required_item, etc.)

**Hard constraint:** If the same failure class occurs 3+ times consecutively, matching action chain steps are automatically stripped. This prevents infinite retry loops.

**Quick fallback:** If the LLM is unavailable or times out, `quickFallbackDecision()` produces a safe action chain using intent-based skill matching or `recover_from_stuck`.

## Personality Influence

Personality tendency hints influence the planner through **tie-breaking**, not override:
- Same-priority steps can be reordered based on tendency hints
- Hints like `retreat_first` boost retreat-related skills in priority
- Hints like `observe_unknown` boost wait/observe skills
- Personality cannot override survival rules or inject actions directly

## Memory Integration

Every 12 cycles, the planner runs a memory review phase:
- Curates long-term memory (promote, delete, update)
- Extracts `knowledge:*` and `learned:*` entries for context
- Records world rules and habits from LLM proposals

## Budget Enforcement

Each phase runs within a budget enforced by `withBudget()`:
- Phase timeouts prevent runaway LLM calls
- Overall cycle budget: 25s (env `CENTRAL_THINK_BUDGET_MS`)
- If a phase times out, its output is skipped and the next phase proceeds with available data
