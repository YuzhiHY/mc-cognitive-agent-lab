# Runtime Audit (Phase 0)

## Scope

Audited modules:

- `src/runtime/daemon.js`
- `src/runtime/api.js`
- `src/runtime/sense.js`
- `src/runtime/reflexLayer.js`
- `src/runtime/stuckDetector.js`
- `src/runtime/skillRegistry.js`
- `src/runtime/sandbox.js`
- `src/runtime/centralReasoning.js`
- `src/runtime/chainExecutor.js`
- `src/runtime/engine.js`

## 1) Module Responsibilities and Exports

### `src/runtime/daemon.js`

- **Primary role:** daemon loop orchestration (`sense -> reflex -> central reasoning -> chain execution`), event wiring, pacing, state logging.
- **Also does:** personality chat behavior, expectation evaluation, auto skill promotion, memory writes, task-state transitions.
- **Export:** `createDaemon()`.

### `src/runtime/api.js`

- **Primary role:** body adapter and Mineflayer capability wrappers.
- **Also does:** behavior-level logic (crafting table auto-provisioning, furnace provisioning, smelt mapping, fuel heuristics, stuck handling in navigation).
- **Export:** `createApi()`.

### `src/runtime/sense.js`

- **Primary role:** structured snapshot generation (status, inventory, nearby blocks/entities, far resources).
- **Also does:** interpretation (threat derivation, resource categories, obstacle labeling).
- **Exports:** `sense()`, `nearestHostileDistance()`, `HOSTILE_MOBS`.

### `src/runtime/reflexLayer.js`

- **Primary role:** deterministic urgent rule selection and execution.
- **Also does:** weapon scoring/equip logic, combat control cadence, flee movement.
- **Exports:** `createReflexLayer()`, `HOSTILE_MOBS`, `FOOD_ITEMS`.

### `src/runtime/stuckDetector.js`

- **Primary role:** low-motion stuck detection.
- **Also does:** JSONL persistence of failure fingerprints.
- **Export:** `createStuckDetector()`.

### `src/runtime/skillRegistry.js`

- **Primary role:** reusable skill lookup from index/meta.
- **Also does:** scoring, wildcard pattern match, metadata persistence.
- **Export:** `createSkillRegistry()`.

### `src/runtime/sandbox.js`

- **Primary role:** VM sandbox for skill code execution.
- **Also does:** timeout helper and error serialization utility.
- **Exports:** `runSkillInSandbox()`, `serializeError()`, `withTimeout()`.

### `src/runtime/centralReasoning.js`

- **Primary role:** 3-phase central reasoning (`analyze -> personality -> decide`) and optional expectation/learn evaluation.
- **Also does:** memory updates, learn-queue merge logic, persona tie-break weighting.
- **Export:** `createCentralReasoning()` -> `{ think, setLastChainResult, evaluateLearnProgress }`.

### `src/runtime/chainExecutor.js`

- **Primary role:** execute action chain step-by-step.
- **Also does:** target resolution heuristics, adaptive timeouts, placement confirmation, reflex mid-chain interrupt checks.
- **Export:** `createChainExecutor()` -> `{ run, executeStep }`.

### `src/runtime/engine.js`

- **Primary role:** single-task orchestration loop (`sense -> plan -> execute`) with lock.
- **Also does:** LLM retry, skill reuse, fallback-skill execution, stuck handling, personality event processing, skill code persistence.
- **Export:** `createEngine()` -> `{ runTask }`.

## 2) Atomic Actions vs Composed Skills vs Generated vs Hardcoded

### Atomic actions (currently mixed in API and chain step handlers)

- Movement/control: `navigateTo`, `moveForward`, `lookAt`, `setControlState`, `clearControlStates`.
- Body ops: `equip`, `activateItem`, `deactivateItem`, `dig`, `placeBlock`, `attackNearest`.
- Snapshot helpers: `getBotState`, `findBlock`.

### Composed skills/behaviors (currently not isolated as explicit skill contracts)

- `api.smartCraft` (recursive craft strategy + fallback).
- `api.smeltItem` (furnace ensure + fuel choose + wait/take output).
- `api.placeTorchSmart` (placement policy).
- `api.collectNearbyDrops` (navigate + obstacle fallback).
- `chainExecutor` step policies and confirmation flows (`place`, `dig` + loot collection).
- Reflex rules in `reflexLayer` (`flee_burst`, `fight_back`, `eat_food`, etc.).

### LLM generated behavior paths

- `engine.js`: `llm.plan(...)` returns `thought/skillName/code`, code saved and sandbox-executed.
- `chainExecutor.js`: `skill` step with inline `code` executes via sandbox.

### Hardcoded deterministic behavior

- Reflex rule set in `reflexLayer.js`.
- Chain step execution branches in `chainExecutor.js`.
- API methods in `api.js`.
- Stuck detection logic in `stuckDetector.js`.

### Promotion/reuse paths

- `daemon.js`: chain signature-based auto-promotion to `skills/*.js` + memory keys (`learned:auto:*`, `skill:*`).
- `engine.js`: skill metadata write + registry-based reuse probe (`skillRegistry.findReusableSkillWithDiagnostics`).

## 3) Result Shape Inventory and Direct Consumers

## API return shapes (`src/runtime/api.js`)

- `navigateTo` -> `{ arrived: boolean, reason: 'goal_reached' | 'path_stopped_after_goal' | 'timeout' }`
  - **Consumers:** `chainExecutor.navigateWithObstacleClear`, `liveSelftest`.
- `digByName` -> `{ dug, pos }`
  - **Consumers:** `liveSelftest`.
- `navigateToNearestBlock` -> `{ block, position }`
  - **Consumers:** promoted/generated code path, indirect.
- `attackNearest` -> `{ attacked, id }`
  - **Consumers:** `chainExecutor` attack step.
- `collectNearbyDrops` -> `{ collected } | { collected: 0, reason: 'no_origin' }`
  - **Consumers:** `chainExecutor` dig step.
- `craft/smartCraft/craftAny` -> `{ crafted, count, ... }`
  - **Consumers:** `chainExecutor`, `liveSelftest`.
- `smeltItem` -> `{ requested, smeltedInput, output, outputCount, mappedFrom }`
  - **Consumers:** `chainExecutor`, `liveSelftest`.
- `placeTorchSmart` -> `{ placed, item } | { placed: 0, reason: 'daytime_skip' }`
  - **Consumers:** `chainExecutor`, `liveSelftest`.
- `getCapabilities` -> capability booleans.
  - **Consumers:** `daemon`, `engine`, `liveSelftest`.

## Sandbox result shapes (`src/runtime/sandbox.js`)

- `runSkillInSandbox` success:
  - `{ ok: true, result: any, logs: [...] }`
- `runSkillInSandbox` failure:
  - `{ ok: false, error: {name,message,stack,code}, logs: [...] }`
- `serializeError(err)`:
  - `{ name, message, stack, code }`
- `withTimeout(...)`:
  - pass-through resolve value, or throws error code `HARD_TIMEOUT`.

**Consumers:** `engine` and `chainExecutor` (`skill` branch), plus error pipelines.

## Chain executor result shapes (`src/runtime/chainExecutor.js`)

- `executeStep`:
  - `{ ok: true, result: { type: <stepType>, ... } }`
  - `{ ok: false, error: { message | serializedError fields } }`
  - `skill` step returns sandbox envelope directly.
- `run` aggregate:
  - `{ completed, total, interrupted, failedStep, results[] }`.

**Consumers:** `daemon` (`centralReasoning` execution phase), logs and expectation evaluation.

## Reflex result/output shapes (`src/runtime/reflexLayer.js`)

- `check(snapshot, ctx)`:
  - `null` or `ruleObject` (`id,name,priority,reason,execute`).
- `rule.execute(...)`:
  - side effects only, no normalized result object.

**Consumers:** `daemon` pre-cycle, fast ticker, damage interrupt; `chainExecutor` mid-chain reflex interrupt.

## Daemon cycle output shapes (`src/runtime/daemon.js`)

- `runCycle()` returns one of:
  - `{ type:'reflex', action, elapsedMs }`
  - `{ type:'combat_mode_hold', elapsedMs }`
  - `{ type:'reasoning', elapsedMs }`
  - `{ type:'error', error, elapsedMs }`
  - `{ type:'idle', elapsedMs }`

**Consumers:** `daemon.start()` loop for console/log behavior.

## Engine task output shapes (`src/runtime/engine.js`)

- Success:
  - `{ ok:true, state:'succeeded', failureCode:null, taskId, finishedAt, elapsedMs, summary, steps, history }`
- Failure:
  - `{ ok:false, state:'timeout'|'max_steps'|'failed', failureCode, taskId, finishedAt, elapsedMs, summary, steps, error, history }`
- Lock conflict throws `EXECUTION_LOCKED`.

**Consumers:** `src/index.js` single-task mode and task-end logs.

## 4) `daemon.js` Mixing Map (By Concern)

- **Planning:** `centralReasoning.think(...)`, decision logs, memory updates from decision.
- **Execution:** `chainExecutor.run(...)`, direct reflex execution, control/path reset calls.
- **Learning/promotion:** `promoteSkillIfStable(...)`, `evaluateLearnProgress(...)`, expectation memory writes.
- **Interrupt handling:** pre-cycle reflex, fast reflex ticker, damage interrupt branch, combat hold bypass.
- **Logging:** direct `logger.log` calls for every subsystem stage + readiness summary.
- **Personality reinforcement:** `personality.processEvent(...)`, `consultSync(...)` chat reaction, `reinforcePreferenceProfile(...)`.

Concrete hotspots:

- `runCycle()` combines planning + execution + learning + logging + memory mutation.
- `start()` combines event binding + loop + interrupt arbitration + pacing policy.
- In-file promotion and synthesis utilities couple daemon to skill file persistence.

## 5) Current Boundary Risks (Phase 1 Handoff)

1. **Result contract fragmentation**
   - API/chain/sandbox/reflex/daemon/engine all use different shape conventions.
   - Phase 1 needs one normalized `ExecutionResult` contract and adapters.

2. **Reflex returns rule object, not normalized execution result**
   - Hard to compare with chain and sandbox outcomes.
   - Interrupt arbitration lacks shared status/reason semantics.

3. **`daemon.js` is a mixed orchestrator + subsystem host**
   - Planning, personality, promotion, and direct control operations are co-located.
   - Makes state transitions and failure diagnosis harder.

4. **API includes policy-heavy behavior**
   - Body adapter and skill-level logic are blended (`smartCraft`, `smeltItem`, utility provisioning).
   - Limits clean action/skill separation for Phase 2.

5. **Generated/promotion paths are spread**
   - `engine` and `daemon` both influence reusable behavior pathways.
   - Candidate-vs-stable lifecycle is not unified.

## 6) Phase 1 Contract Migration Edges (Highest Risk)

- `chainExecutor.executeStep` and `chainExecutor.run` are the first high-impact producers to normalize.
- `daemon.runCycle` is the highest fan-in consumer; should consume only normalized statuses/reasons.
- `sandbox.runSkillInSandbox` should be wrapped/adapted to normalized source/action metadata.
- `reflexLayer.check/execute` requires an interrupt result envelope to align with execution contract.
- `engine.runTask` state/failure summaries should map from normalized results instead of ad hoc fields.

## 7) Notes on Existing Strengths to Preserve

- Mineflayer body adapter with pathfinder integration.
- Sandbox timeout and error serialization protections.
- Skill registry and metadata concept.
- Stuck detector + fingerprint logging mechanism.
- Chain executor model.
- Daemon mode with reflex fast-path.
- Existing hardening tests and capability tests.

