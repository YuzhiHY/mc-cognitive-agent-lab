# Architecture Walkthrough

This document describes the layered runtime architecture of the Minecraft cognitive agent. For the implementation roadmap, see `ARCHITECTURE.md` (root).

## Design Principles

- The agent is autonomous — it has its own goals, not commands to execute.
- All non-survival decisions go through a central LLM planner (no keyword matching).
- Personality influences decisions via tendency signals, not character role-play.
- Stable skills are preferred over LLM-generated code (scheduling-first).
- Reflex layer handles only immediate survival — everything else goes through the planner.

## Cycle Pipeline

Each daemon cycle executes a 5-stage pipeline:

```
Sense → Interrupt Gate → Reflex Gate → Planner Gate → Chain Orchestrate
```

### 1. Sense

`sense.js` + `perceptionSnapshot.js` build a 4-tier snapshot of the world:
- **Reflex tier** — boolean flags for survival checks (fire, water, threat proximity)
- **Execution tier** — body state for skill execution (position, health, inventory)
- **Decision tier** — structured data for the planner (threat bands, resources, stations)
- **Semantic tier** — high-level labels for LLM context (safety label, opportunity hints)

Each tier is frozen and served only to its intended consumer.

### 2. Interrupt Gate

`interruptGate.js` collects interrupt candidates from three sources:
- Queued damage events
- Immediate danger detection (close threat, recent damage)
- World state changes

Candidates are ranked by priority (`fatal_immediate > high > medium > low`). The task state machine's interrupt policy decides whether to accept or hold.

### 3. Reflex Gate

`reflexGate.js` + `reflexLayer.js` evaluate 13 survival rules. Rules are priority-scored (90-205) and the highest-triggered rule fires. If a reflex fires:

1. Active chain execution is aborted via `chainRunControl.abort()`
2. Reflex skill executes (flee, jump, eat, fight)
3. State transitions: `interrupted → recovering → idle`
4. Cooldown prevents repeated firing of the same rule (3800ms default)

Reflex is the **only** layer with hardcoded deterministic reactions.

### 4. Planner Gate

`plannerGate.js` checks eligibility:
- Task state must allow planning (not locked in execution)
- Combat mode blocks replanning (reflex handles combat)
- Execution lock prevents concurrent plan+execute

### 5. Chain Orchestration

`chainOrchestrator.js` runs the full planning-to-execution lifecycle:

**Central Reasoning (4 phases):**
1. **Analyze** — Extract situation, goals, severity from snapshot + memory
2. **Personality** — Generate tendency hints and emotional state
3. **Decide** — Produce action chain (skill_ref or synthesis steps)
4. **Expectation** — Predict outcome and confidence (if time permits)

**Execution:**
- Action chain compiled by `chainCompiler.js`
- Each step run by `chainExecutor.js` with timeout and abort support
- Execution lock held for the duration; subsequent cycles return `executing_hold`

**Post-processing:**
- Record outcome on candidate skill pipeline
- Evaluate expectations vs actual
- Personality tendency feedback
- Failure fingerprint generation (if failed)
- Task state transition: `completed` or `failed`

## Module Map

```
src/runtime/
  daemon.js                    Thin composition shell — wires sub-modules
  daemon/
    sharedState.js             Mutable state bag (single-writer per field)
    taskStateHelper.js         State transition bridge + logging
    interruptGate.js           Interrupt candidate ranking
    reflexGate.js              Reflex policy evaluation
    plannerGate.js             Planning eligibility check
    interruptExecutor.js       Interrupt takeover lifecycle
    chainOrchestrator.js       Plan → execute → post-process
    cycleLogger.js             Structured per-cycle summary
    voiceController.js         Voice output dedup
    eventReactor.js            Health/chat/reflex/stuck wiring
    skillPromotion.js          Legacy skill promotion
    expectationEvaluator.js    Expected vs actual comparison
    executionMetadata.js       Execution tracking
    pacingPolicy.js            Threat-adaptive polling

  contracts/
    executionResult.js         Normalized execution result shape
    skillContract.js           Skill object shape validation
    interruptDecision.js       Interrupt decision format
    perceptionSnapshot.js      4-tier perception builder
    plannerOutput.js           Planner output schema
    failureFingerprint.js      Failure classification

  skills/                      13 stable hardcoded skills
  actions/bodyActions.js       Atomic body actions
  planning/
    skillSelector.js           Skill matching by goal
    chainCompiler.js           Chain compilation
    intentFallback.js          Fallback intent handling

  centralReasoning.js          4-phase LLM reasoning pipeline
  reflexLayer.js               13 survival reflex rules
  sense.js                     World perception
  taskStateMachine.js          State authority + interrupt policy
  candidateSkillManager.js     Generated skill lifecycle
  skillRegistry.js             Skill lookup (stable + candidate)
  synthesisPolicy.js           Synthesis gate
  memory2.js                   Working + long-term memory
  logger.js                    JSONL structured logging
```

## LLM's Role

The LLM is the central decision-maker but is constrained:

- It can only select from known stable skills (`skill_ref`) or request synthesis (`skill`)
- Synthesis is gated by policy (disabled during high threat, blocked if stable skill exists)
- Its output is validated against `gameKnowledge` (valid blocks, items, recipes)
- Hallucinated skill references are stripped and replaced with safe fallbacks
- After 3+ consecutive failures of the same type, matching steps are removed
- Personality tendency hints reorder same-priority steps but cannot override survival

The LLM never directly controls the bot. It produces an action chain that the chain executor runs step-by-step through the skill layer.
