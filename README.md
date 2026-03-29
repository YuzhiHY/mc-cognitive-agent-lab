# mc-cognitive-agent-lab

A modular Minecraft agent framework built on Mineflayer, exploring a layered autonomous agent architecture with structured perception, kernel-method personality, and scheduling-first LLM planning.

---

## Overview

This project is an experimental AI agent architecture for Minecraft.

It aims to move beyond simple "LLM controls a bot" setups and toward a system with:

- Structured, tiered perception (reflex / execution / decision / semantic)
- Layered decision-making: perception → analyze → personality → decide → execute
- Kernel-method personality: cognitive rules and value axioms, not role-playing labels
- gameKnowledge-constrained LLM output: only valid options from current game state
- Reusable skill system with promotion/quarantine lifecycle
- Reflex / emergency handling with priority-based arbitration
- Scheduling-first LLM (prefer stable skills, synthesis is last resort)
- Feeler module for local movement micro-compensation
- Failure fingerprinting and avoidance hints

The system is designed as a **cognitive loop**, not a single-shot prompt execution.

---

## Architecture

### Core cognitive loop

```
perception → interrupt gate → reflex gate → planner gate → chain orchestration → post-processing
```

Each cycle:

1. **Perception** builds a 4-tier snapshot (reflex / execution / decision / semantic)
2. **Interrupt gate** ranks candidates from damage queue, world-state changes, and danger signals
3. **Reflex gate** runs arbitration against 13 survival-only rules with policy evaluation
4. **Planner gate** checks task state machine and combat mode
5. **Chain orchestrator** invokes central reasoning (analyze → personality → decide), executes action chain, handles post-processing

### Central reasoning pipeline

```
phaseAnalyze (fact extraction + anchorFacts + goalConstraints)
     ↓
phasePersonality (kernel-method cognitive response + tendencyHints)
     ↓
phaseDecide (gameKnowledge-constrained actionChain generation)
     ↓
phaseExpectation (subjective prediction for post-execution comparison)
```

- **Analyze** produces structured `goalConstraints` (goalType, targetResource, prerequisite, blockedBy) and `anchorFacts` (hard facts the personality cannot soften)
- **Personality** returns `tendencyHints` (behavioral tendency signals like `stay_near_familiar`, `retreat_first`) — not action commands
- **Decide** references `gameKnowledge` to constrain all action parameters to currently valid options
- **Expectation** generates verifiable predictions for post-execution learning

### Personality: kernel method

Personality is defined by cognitive mechanisms and value axioms, not surface trait labels.

Four layers:
1. **Cognitive foundation** (Layer 1): default response to unknown, source of security, self-preservation style, value hierarchy. Rarely changes.
2. **Development stage** (Layer 2): capability boundaries that control assertiveness. "Early stage" = low assertiveness from cognitive structure, not role-playing.
3. **Expression constraints** (Layer 3): output format, length, vocabulary. Emerges from layers 1+2.
4. **External identity** (Layer 4): name, age, backstory. Reserved interface, not active in early testing.

Personality output = `tendencyHints` (tendency signals), not action commands. Never overrides survival rules.

### gameKnowledge

`gameKnowledge.js` builds a dynamic, cycle-specific reference object from the current snapshot + skill registry:

| Field | Content |
|-------|---------|
| `actionSchema` | Valid action types and their parameter specs |
| `availableSkills` | Registered stable skills with arg descriptions |
| `navigableTargets` | Blocks/entities the bot can navigate to right now |
| `diggableBlocks` | Blocks the bot can mine right now |
| `craftableItems` | Items craftable with current inventory |
| `attackableEntities` | Hostile entities currently nearby |
| `equippableItems` | Items in inventory that can be equipped |
| `craftingChains` | Relevant crafting recipes for current craftable items |

The LLM decide prompt enforces: "不在列表中 = 非法" (not in the list = illegal). This prevents hallucination of non-existent blocks/skills/items.

### Daemon decomposition (Phase 9 + 9.5)

`daemon.js` is a thin composition shell (~460 lines) that wires together focused sub-modules:

```
src/runtime/daemon/
  sharedState.js          — mutable state bag shared by all sub-modules
  taskStateHelper.js      — state transition bridge with logging + trace
  interruptGate.js        — rank + evaluate interrupt candidates (pure gate)
  reflexGate.js           — reflex arbitration + policy (pure gate)
  plannerGate.js          — planning eligibility check (pure gate)
  interruptExecutor.js    — full interrupt takeover lifecycle (cooldown, abort, execute)
  chainOrchestrator.js    — plan → execute → post-process pipeline
  voiceController.js      — voice output dedup + cooldown
  eventReactor.js         — health/chat/reflex/stuck event wiring
  pacingPolicy.js         — voice timing, threat-based cooldowns
  skillPromotion.js       — chain signature, code synthesis, promotion logic
  expectationEvaluator.js — post-execution expectation comparison
  worldStateInterrupt.js  — world-state change detection + interrupt building
  executionMetadata.js    — chain → execution metadata inference
  cycleLogger.js          — structured per-cycle summary
```

### Key contracts

| Contract | Location | Purpose |
|----------|----------|---------|
| `executionResult` | `contracts/executionResult.js` | Normalized success/failure/timeout/interrupted/invalid/blocked results |
| `interruptDecision` | `contracts/interruptDecision.js` | Structured interrupt decisions with 4 priority levels |
| `perceptionSnapshot` | `contracts/perceptionSnapshot.js` | 4-tier perception (reflex, execution, decision, semantic) |
| `plannerOutput` | `contracts/plannerOutput.js` | Planner decision schema + meta derivation |
| `skillContract` | `contracts/skillContract.js` | Skill shape: preconditions, execute, canInterrupt, tags, riskLevel |
| `failureFingerprint` | `contracts/failureFingerprint.js` | 12 failure classes with auto-classification |

### State authority

`taskStateMachine.js` is the **single source of truth** for runtime state. It controls:
- State transitions: `idle → assessing → planning → executing → completed/failed → recovering`
- Execution lock: prevents replanning during active chains
- Interrupt policy: evaluates whether an interrupt should be accepted based on priority, source, and current state

### Skill lifecycle

```
LLM synthesis → experimental (candidateSkillManager) → promoted (3+ successes, 75%+ ratio) → stable
                                                      → quarantined (3 consecutive failures)
```

Synthesis is gated by `synthesisPolicy.js`: blocked during high threat, when a stable skill already matches, or when policy disables it.

### Reflex system

- 13 survival-only rules in `reflexLayer.js` covering damage, hostiles, low health, starvation, lava, fire, drowning, falling
- Stuck is **not** a survival threat — detection stays in perception, response goes through planner
- `arbitrate()` returns `{ decision, matchedRule }` — single evaluation, no redundant calls
- Fast ticker (120ms) handles emergency reflexes independently from the slow LLM cycle

### Feeler module

`feeler.js` is a lightweight local movement compensation layer:

- **probe()**: 12 detection points around bot (forward feet/head/above, sides, diagonals, ceiling, ground)
- **compensate()**: Priority-ordered micro-corrections: yaw correction → jump → sidestep → backstep → squeeze → clear disposable block (last resort)
- **feel()**: One-shot probe + compensate
- Does NOT replace pathfinder or high-level planning
- Block breaking is last resort, only for disposable blocks (dirt/sand/gravel/leaves)

Integrated into: `api.js` navigateTo stuck handler, `follow_player.js`, `recover_from_stuck.js`

### Failure fingerprints

- 12 failure classes: `path_blocked`, `timeout`, `hostile_interrupt`, `craft_missing_materials`, `stuck_collision`, etc.
- `classifyFailure()` auto-classifies from execution results
- `stuckDetector.js` tracks path recomputation, jump thrashing, yaw oscillation
- `memoryHint.js` generates avoidance hints from repeated failure patterns

---

## Project structure

```
src/
  runtime/
    daemon.js                    — thin composition shell (main loop + wiring)
    daemon/                      — 15 focused sub-modules (see above)
    contracts/                   — normalized data contracts
    skills/                      — 13 stable skills (approach, attack, mine, craft, follow, retreat, etc.)
    planning/                    — chain compiler, skill selector, intent fallback
    llm/                         — LLM clients + prompt builders
    api.js                       — Mineflayer API wrapper
    sense.js                     — perception (raw + tiered)
    reflexLayer.js               — 13-rule survival reflex arbitration
    taskStateMachine.js          — state authority + execution lock + interrupt policy
    interruptQueue.js            — priority interrupt queue with monotonic IDs
    chainExecutor.js             — multi-step chain execution with abort
    chainRunControl.js           — cooperative cancellation signal
    stuckDetector.js             — movement/path/yaw stuck detection + fingerprints
    memoryHint.js                — failure-based avoidance hints for planner
    candidateSkillManager.js     — experimental skill lifecycle
    synthesisPolicy.js           — synthesis gate (threat, policy, skill availability)
    centralReasoning.js          — analyze → personality → decide pipeline
    personality.js               — kernel-method personality layer
    gameKnowledge.js             — dynamic valid-option lists for LLM constraint
    feeler.js                    — local movement micro-compensation
    sandbox.js                   — sandboxed code execution
    skillRegistry.js             — skill registration + lookup
    logger.js                    — JSONL structured logging
    memory.js                    — key-value memory store

personality/
  persona.md                     — kernel-method cognitive rules (not labels)
  state.json                     — personality state (mood, recent events, tendency hints)

skills/                          — auto-promoted skill files
tests/                           — 23 automated tests
logs/                            — JSONL runtime logs + failure fingerprints
memory/                          — persistent knowledge/learned skills
```

---

## Testing

```bash
npm test
```

Runs 23 automated tests covering:

| Test | Coverage |
|------|----------|
| `hardening` | Core safety (sandbox, JSON, memory limits) |
| `execution-result-normalization` | All results normalized |
| `skill-contract` | Skill shape validation |
| `skill-registry` | Skill registration + lookup |
| `planning-skillref` | skill_ref prioritization |
| `planning-chain-compiler` | Chain step parsing |
| `interrupt-contract` | Interrupt decision + ID stability |
| `task-state-machine` | State transitions, lock, interrupt policy |
| `task-state-idempotent` | Idempotent state transitions |
| `daemon-state-integration` | Full daemon cycle integration |
| `runtime-chain-abort` | Chain abort signal |
| `reflex-arbitration` | Reflex arbitrate() return shape |
| `reflex-damage-fallback` | Damage without rule match → fallback |
| `planner-user-intent-suppress` | User intent not overridden |
| `capability-selftest` | API capability self-check |
| `perception-tiering` | 4-tier snapshot shape + isolation |
| `planner-output-schema` | Planner output schema validation |
| `synthesis-policy` | Synthesis gate logic |
| `candidate-skill-pipeline` | Skill promotion/quarantine lifecycle |
| `failure-fingerprint` | Failure classification + avoidance |
| `daemon-decomposition` | Phase 9 extracted module unit tests |
| `daemon-orchestration` | Phase 9.5 gate evaluators + orchestrators |
| `feeler` | Feeler probe + compensate + disposable block logic |

---

## Quick start

```bash
# 1. Configure
cp .env.example .env
# Edit .env: MC_HOST, MC_PORT, MC_USERNAME, LLM_PROVIDER, etc.

# 2. Install
npm install

# 3. Run (single task)
npm start

# 4. Run (continuous daemon)
npm run daemon
```

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DAEMON_MODE` | Enable continuous loop | `false` |
| `REFLEX_ENABLED` | Enable reflex layer | `true` |
| `REFLEX_TAKEOVER_COOLDOWN_MS` | Same-rule cooldown | `3800` |
| `PERSONALITY_ENABLED` | Enable personality layer | `false` |
| `SKILL_REUSE_ENABLED` | Enable skill reuse | `true` |
| `AGENT_DEBUG` | Compact console debug output | unset |
| `LLM_PROVIDER` | `local` / `openai` / `anthropic` / `deepseek` | `local` |
| `LLM_TIMEOUT_MS` | LLM API call timeout | `15000` |

---

## Design philosophy

This project prioritizes **structure over raw capability**.

### Core principles

- **Agent is not a tool**: It is an autonomous individual with perception → planner → personality → skill → log pipeline. Not a reactive command executor.
- **All decisions through central LLM**: Keyword matching is ONLY for reflex-tier neural reflexes (survival). Every other decision goes through the full perception → planner → personality pipeline.
- **Personality weights at every decision point**: Personality has influence channels at all decision layers, not just cosmetic output.
- **Fix root causes, not symptoms**: Prefer systems over special cases. Think long-term.
- **Kernel method over label method**: Personality defined by cognitive mechanisms and value axioms. "幼年感" comes from cognitive structure limitations, not from role-playing "a 5-year-old."
- **Stability over novelty**: Clean module boundaries, recoverability, observability.
- **Scheduling-first**: Prefer existing stable skills. Code synthesis is the last resort.

### What the reflex layer does NOT do

- Handle stuck detection (planner's job)
- Make behavioral decisions (planner's job)
- Recommend strategies (planner's job)
- Override personality (personality weights respected except during survival)

---

## Current stage

Phases 0-9.5 of the ARCHITECTURE.md roadmap are complete, plus prompt overhaul:

- **Phase 0-4**: Core contracts, reflex hardening, task state machine, interrupt arbitration
- **Phase 5**: Tiered perception (reflex/execution/decision/semantic)
- **Phase 6**: Scheduling-first LLM behavior + synthesis policy gate
- **Phase 7**: Candidate skill pipeline (experimental → promoted → quarantined)
- **Phase 8**: Failure fingerprints + stuck detection expansion + avoidance hints
- **Phase 9**: daemon.js pure-function extraction (5 modules)
- **Phase 9.5**: daemon.js orchestration extraction (9 modules, 1167→460 lines)
- **Prompt overhaul**: Kernel-method personality prompts, gameKnowledge-constrained decide prompt, anchorFacts injection, tendencyHints pipeline

Remaining: Phase 10 (observability), Phase 11 (scenario tests), Phase 12 (documentation).

---

## Current limitations

- Long `navigate`/`dig` steps do not poll abort mid-step (abort applies between steps)
- Mid-step reflex vs body control can race briefly until current primitive finishes
- Stuck detection is movement-based only (no physics solver)
- Chat listener voice not fully synchronized with committed plan
- gameKnowledge coverage is basic Minecraft items; advanced recipes not yet included
- DeepSeek LLM latency can cause 2-5s planning delays per cycle
