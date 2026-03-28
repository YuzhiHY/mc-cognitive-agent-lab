# mc-cognitive-agent-lab

A modular Minecraft agent framework built on Mineflayer, exploring a transition from LLM-driven code generation to a structured, layered autonomous agent system.

---

## Overview

This project is an experimental AI agent architecture for Minecraft.

It aims to move beyond simple "LLM controls a bot" setups and toward a system with:

- structured, tiered perception
- layered decision-making with explicit gate evaluation
- reusable skill system with promotion/quarantine lifecycle
- reflex / emergency handling with priority-based arbitration
- controlled LLM involvement (scheduling-first, synthesis-gated)
- incremental learning and skill promotion
- failure fingerprinting and avoidance hints

The system is designed as a **cognitive loop**, not a single-shot prompt execution.

---

## Architecture

### Core loop

```
perception → interrupt gate → reflex gate → planner gate → chain orchestration → post-processing
```

Each cycle:

1. **Perception** builds a 4-tier snapshot (reflex / execution / decision / semantic)
2. **Interrupt gate** ranks candidates from damage queue, world-state changes, and danger signals
3. **Reflex gate** runs arbitration against 13 rules with policy evaluation
4. **Planner gate** checks task state machine and combat mode
5. **Chain orchestrator** invokes central reasoning, executes action chain, handles post-processing (expectations, skill promotion, personality feedback)

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
  cycleLogger.js          — structured per-cycle summary (Phase 10 prep)
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

- 13 rules in `reflexLayer.js` covering damage, hostiles, low health, starvation, lava, etc.
- `arbitrate()` returns `{ decision, matchedRule }` — single evaluation, no redundant calls
- Fast ticker (120ms) handles emergency reflexes independently from the slow LLM cycle
- Rule-level cooldown prevents spam (`REFLEX_TAKEOVER_COOLDOWN_MS`)

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
    skills/                      — 14 stable skills (approach, attack, mine, craft, retreat, etc.)
    planning/                    — chain compiler, skill selector, intent fallback
    llm/                         — LLM clients (OpenAI, Anthropic, DeepSeek, local)
    api.js                       — Mineflayer API wrapper
    sense.js                     — perception (raw + tiered)
    reflexLayer.js               — 13-rule reflex arbitration
    taskStateMachine.js          — state authority + execution lock + interrupt policy
    interruptQueue.js            — priority interrupt queue with monotonic IDs
    chainExecutor.js             — multi-step chain execution with abort
    chainRunControl.js           — cooperative cancellation signal
    stuckDetector.js             — movement/path/yaw stuck detection + fingerprints
    memoryHint.js                — failure-based avoidance hints for planner
    candidateSkillManager.js     — experimental skill lifecycle
    synthesisPolicy.js           — synthesis gate (threat, policy, skill availability)
    personality.js               — optional personality layer
    sandbox.js                   — sandboxed code execution
    skillRegistry.js             — skill registration + lookup
    logger.js                    — JSONL structured logging
    memory.js                    — key-value memory store

skills/                          — auto-promoted skill files
tests/                           — 22 automated tests
logs/                            — JSONL runtime logs + failure fingerprints
memory/                          — persistent knowledge/learned skills
personality/                     — persona state
```

---

## Testing

```bash
npm test
```

Runs 22 automated tests covering:

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
| `LLM_PROVIDER` | `local` / `openai` / `anthropic` | `local` |

---

## Current stage

Phases 0-9.5 of the ARCHITECTURE.md roadmap are complete:

- **Phase 0-4**: Core contracts, reflex hardening, task state machine, interrupt arbitration
- **Phase 5**: Tiered perception (reflex/execution/decision/semantic)
- **Phase 6**: Scheduling-first LLM behavior + synthesis policy gate
- **Phase 7**: Candidate skill pipeline (experimental → promoted → quarantined)
- **Phase 8**: Failure fingerprints + stuck detection expansion + avoidance hints
- **Phase 9**: daemon.js pure-function extraction (5 modules)
- **Phase 9.5**: daemon.js orchestration extraction (9 modules, 1167→460 lines)

Remaining: Phase 10 (observability), Phase 11 (scenario tests), Phase 12 (documentation).

---

## Current limitations

- Long `navigate`/`dig` steps do not poll abort mid-step (abort applies between steps)
- Mid-step reflex vs body control can race briefly until current primitive finishes
- Stuck detection is movement-based only (no physics solver)
- Chat listener voice not fully synchronized with committed plan
- Limited long-run stability guarantees on hostile servers

---

## Design philosophy

This project prioritizes **structure over raw capability**.

The goal is not to make the bot "smarter" immediately,
but to make it **more stable, explainable, and evolvable over time**.

- Stability over novelty
- Observability over cleverness
- Bounded behavior over maximum autonomy
- Clean module boundaries over monolithic convenience
- Recoverability over optimistic execution
