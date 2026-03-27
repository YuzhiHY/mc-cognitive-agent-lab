# Mineflayer LLM Agent Framework

This project is a modular Minecraft AI agent framework based on Mineflayer.

Core loop:

1. Sense environment and format compact JSON.
2. Send context to LLM and get JSON with `thought`, `skillName`, `code`.
3. Save generated skill code into `skills/`.
4. Execute skill in Node.js `vm` sandbox via `module.exports.run({ api, ctx })`.
5. Capture errors/logs and feed back for re-think.
6. Stop when skill returns `done !== false`, or when hard timeout is reached.

## Requirements

- Node.js 18+ (tested on Node.js 22)
- A reachable Minecraft server

The bot waits for the `spawn` event and, when available, `waitForChunksToLoad()` before running tasks, so `sense()` sees nearby blocks instead of empty columns right after TCP login.

## Quick start

1. Copy env template:

   - Windows PowerShell:
     - `Copy-Item .env.example .env`
   - macOS/Linux:
     - `cp .env.example .env`

2. Edit `.env`:

   - `MC_HOST`, `MC_PORT`, `MC_USERNAME`
   - `TASK_GOAL` (optional)
   - `HARD_TIMEOUT_MS` (default `10000`)
   - `MAX_STEPS_PER_TASK` (default `8`)
   - `LLM_PROVIDER` (`local` | `openai` | `anthropic` | `deepseek`)
   - `LLM_PROMPT_MODE` (`default` | `decision`)
   - `LLM_PLAN_MAX_ATTEMPTS` (default `2`, retries for invalid/failed plan calls)
   - `SKILL_REUSE_ENABLED` (`true` | `false`, default `false`)
   - `SKILL_REUSE_MIN_SCORE` (default `0.25`, token-overlap threshold)
   - `LLM_INPUT_PATH` (only for `local`, default `./skills/_next.json`)
   - `OPENAI_API_KEY` / `OPENAI_MODEL` (for `openai`)
   - `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (for `anthropic`)
   - `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` (for `deepseek`)

3. Run:

   - `npm start` — single-task mode (run once and exit)
   - `npm run daemon` — daemon mode (continuous sense→think→act loop)

## LLM response contract

The framework expects:

```json
{
  "thought": "why this action",
  "skillName": "action_name",
  "code": "module.exports.run = async ({ api, ctx }) => { /* ... */ return { done: true }; }"
}
```

## Skill function contract

Every generated skill must export:

```js
module.exports.run = async ({ api, ctx }) => {
  // api: low-level primitives only
  // ctx: task + compact environment snapshot + history
  return { done: true }
}
```

`done` rules:

- `done: false` -> loop continues (re-sense + re-think + next skill)
- omit `done` or `done: true` -> task considered complete

## Provided context (`ctx`)

- `ctx.task`: task metadata (`id`, `goal`)
- `ctx.step`: current loop step (starts from `1`)
- `ctx.snapshot.status`: health, food, position, orientation, etc.
- `ctx.snapshot.inventory`: inventory summary
- `ctx.snapshot.nearby.blocks`: non-air blocks in radius 5
- `ctx.snapshot.nearby.entities`: nearest 3 entities
- `ctx.snapshot.threat_level`: `"none"` / `"low"` / `"high"` based on hostile mob proximity
- `ctx.snapshot.close_threat`: `true` when hostile is within melee danger window
- `ctx.snapshot.nearest_hostile_distance`: nearest hostile distance (or `null`)
- `ctx.snapshot.status.recentDamageMs`: ms since last damage event in daemon
- `ctx.snapshot.resources`: nearby harvestable resources `[{type, blocks, count}]`
- `ctx.snapshot.obstacles`: `{water, lava, cliff}` hazard booleans
- `ctx.history`: execution records for re-think
- `ctx.memory_hint`: `{recent_failures, fingerprint_matches}` from past failure fingerprints
- `ctx.capabilities`: `{canNavigate, canAttack, canDig, canPlace}` available API flags
- `ctx.personality`: (when enabled) `{voice, emotionalTags}` from personality LLM

## Provided API (`api`)

Low-level primitives (no high-level strategy):

- `api.chat(message)`
- `api.sleep(ms)`
- `api.lookAt(pos, force?)`
- `api.setControlState(control, state)`
- `api.clearControlStates()`
- `api.swingArm(hand?)`
- `api.equip(item, destination?)`
- `api.activateItem()`, `api.deactivateItem()`
- `api.dig(block, forceLook?)`
- `api.placeBlock(referenceBlock, faceVector, item?)`
- `api.getBotState()`
- `api.findBlock(matching, maxDistance?)`
- `api.navigateTo(pos, opts?)` - pathfinder-based navigation
- `api.moveForward(ms)` - simple forward movement
- `api.attackNearest(entityType?)` - attack nearest entity
- `api.getCapabilities()` - returns capability flags

## Architecture

### Core Runtime
- `src/runtime/sense.js`: compact world snapshot with semantic fields (threat, resources, obstacles)
- `src/runtime/llm/`: LLM client layer, response validation, prompt builder (default/decision/personality/central_analyze/central_decide modes)
- `src/runtime/sandbox.js`: `vm` execution + timeout + error serialization
- `src/runtime/engine.js`: single-task closed-loop orchestrator (backward-compatible mode)
- `src/runtime/api.js`: bot action primitives including pathfinder navigation and combat

### Daemon Architecture (Phase 5)
- `src/runtime/daemon.js`: continuous sense→think→act loop, replaces single-task engine in daemon mode
- `src/runtime/centralReasoning.js`: 3-phase reasoning protocol (analyze→personality consult→decide)
- `src/runtime/chainExecutor.js`: multi-step action chain executor with mid-chain reflex interruption
- `src/runtime/reflexLayer.js`: deterministic reflex rules for emergencies (flee, eat, jump — no LLM needed)
- `src/runtime/memory.js`: persistent memory system (locations, knowledge, learned skills)

### Support Modules
- `src/runtime/stuckDetector.js`: position delta tracking, Physical_Impasse tagging, failure fingerprints
- `src/runtime/skillValidator.js`: precondition checking (safe field-path evaluation, no eval)
- `src/runtime/memoryHint.js`: failure fingerprint retrieval and feature-similarity matching
- `src/runtime/personality.js`: dual-LLM personality system (event tagging, trigger logic, state persistence, sync consultation)

### Data Directories
- `skills/`: generated skill code storage
- `skills/reflex/`: pre-written emergency skills (flee, eat_food, emergency_jump)
- `personality/`: persona definition (`persona.md`) and persistent state (`state.json`)
- `memory/`: persistent memory files (`locations.json`, `knowledge.json`, `learned_skills.json`)

## Dual LLM Architecture

The framework supports two independent LLM instances:

- **Core LLM (中枢/left brain)**: situation analysis, strategic planning, multi-step action chain generation. Configured via `LLM_PROVIDER`.
- **Personality LLM (人格/right brain)**: emotional/personality responses, behavioral suggestions. Configured via `PERSONALITY_LLM_PROVIDER`.

### Daemon Mode: 3-Phase Reasoning

In daemon mode, each think cycle runs 3 phases:

1. **Phase 1 — Analyze & Translate** (Core LLM): reads sense data + memory → outputs `situationAnalysis`, `personalityBrief` (natural language for personality), `selfGoal`, `memoryUpdates`
2. **Phase 2 — Personality Consult** (Personality LLM): receives the natural language brief → outputs `voice`, `emotionalTags`, `suggestion`
3. **Phase 3 — Final Decision** (Core LLM): integrates phase 1 analysis + phase 2 personality feedback → outputs `thought`, `actionChain` (multi-step), `memoryUpdates`, `nextGoalHint`

### Reflex Layer

Before any reasoning, the reflex layer checks for emergencies:
- High threat + low health → flee
- Critical health → eat food
- Near lava → emergency jump
- Under attack with no weapon → flee

These are deterministic rules — no LLM call, ~0ms latency.
Additionally, daemon now keeps a short `combat_mode` lock after close threat or recent damage, so planning is temporarily suspended until danger clears.

### Personality System

The personality LLM operates in two modes:
- **Event-driven (post-execution)**: triggers on failure, threat, completion, significant state changes — via `processEvent()`
- **Synchronous consultation (pre-decision)**: called by central reasoning phase 2 — via `consultSync()`

Edit `personality/persona.md` to customize the bot's personality. No code changes needed.

## Notes

- Current LLM integration uses a local file client for easy bootstrap.
- Replace `localFileClient` with OpenAI/Anthropic/DeepSeek client without changing engine/sandbox/sense modules.
- Sandbox currently disables `require` inside skills.
- When `LOG_TO_FILE=true`, the framework writes per-task JSONL logs to `logs/` (for replay/debug).
- Before each LLM call, `history` is truncated for safety using `LLM_HISTORY_MAX_ITEMS` and `LLM_HISTORY_MAX_CHARS`.
- Task loop has a safety cap using `MAX_STEPS_PER_TASK` to avoid infinite retries.
- Task result includes lifecycle `state`: `succeeded`, `timeout`, `max_steps`, or `failed`.
- Task result includes `failureCode` (`TASK_HARD_TIMEOUT`, `TASK_MAX_STEPS_REACHED`, `LLM_PLAN_FAILED`, `RUNTIME_FAILURE`).
- Task result includes compact `summary` and `steps` arrays.
- JSONL `task_end` logs include `reuseSummary` and `personalitySummary`.
- Execution lock prevents concurrent task runs on the same engine instance.
- Stuck detection writes to `logs/failure_fingerprints.jsonl` for cross-task memory.
- Skill fallback: `skills/index.json` entries can define `fallbackSkill` for graceful degradation (single-level).
- Skill preconditions: `skills/index.json` entries can define `preconditions` array, checked before execution.
- LLM is skipped when: previous skill returned `done:false`, no error, no threat escalation, no personality urgency.
- LLM retries use exponential backoff (`attempt * 1000ms`).
- Optional skill reuse supports `skills/index.json` (preferred) and `skills/*.meta.json` (fallback).
- `skills/index.json` entries support: `goalPatterns`, `minScoreOverride`, `preconditions`, `fallbackSkill`, `movementIntent`, `emotional_tag`.
- Use `skills/_next.template.json` as a starter when preparing local test plans.
- Default local plan file is `skills/_next.json`.
- Set `PERSONALITY_ENABLED=true` + `PERSONALITY_LLM_PROVIDER`/`PERSONALITY_LLM_API_KEY` to enable the personality system.
- Set `DAEMON_MODE=true` or use `npm run daemon` / `--daemon` flag to run in daemon mode.
- `THINK_INTERVAL_MS` (default `2000`) controls the minimum interval between daemon think cycles.
- `REFLEX_ENABLED` (default `true`) controls whether the reflex layer is active in daemon mode.
- Daemon mode gracefully shuts down on SIGINT/SIGTERM.
- Memory is auto-categorized: `loc:*`/`location:*` → locations, `skill:*`/`learned:*` → learned_skills, else → knowledge.
- Action chain supports types: `chat`, `navigate`, `skill`, `wait`, `dig`, `place`, `equip`, `attack`, `craft`.

