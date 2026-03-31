# Reflex System and Interrupts

The reflex layer is the **only** place where deterministic hardcoded reactions are allowed. Everything above survival threshold goes through the planner with personality weighting.

## Reflex Rules

13 survival rules defined in `reflexLayer.js`, evaluated every cycle:

| Priority | Rule | Trigger | Action |
|----------|------|---------|--------|
| 205 | falling_risk | Falling or cliff edge | Emergency jump |
| 200 | emergency_lava | Near lava blocks | Jump + sprint away |
| 199 | hostile_injured_melee_flee | Health >14, hostile <=7 blocks | Sprint away |
| 198 | fire_or_burn_danger | In fire or lava | Flee burst |
| 198 | creeper_close_pure_flee | Creeper <=6 blocks | Sprint away from creeper |
| 196 | drowning_or_unsafe_water | In water, low air | Jump + sprint to land |
| 196 | hostile_very_close_pure_flee | Hostile <=3.6 blocks | Burst escape |
| 194 | recent_damage_burst | 2+ damage events in 2.5s | Flee burst |
| 150 | flee_critical_health | Health <=5 | Flee any direction |
| 143 | recent_damage_snapshot_flee | Damage <3.2s ago + threat | Flee burst |
| 125 | eat_food_for_regen | Has food, health or food <20 | Equip + eat |
| 110 | fight_back_armed | Health >=12, hostiles <=3, has weapon | Attack loop |
| 100 | fight_back_unarmed | Being attacked, health >8 | Punch loop |
| 90 | flee_unarmed_low_health | High threat, health <=12, no weapon | Flee |

### Priority Levels (Mapped from Score)

| Score Range | Level | Behavior |
|-------------|-------|----------|
| 190+ | `fatal_immediate` | Bypasses all gates, immediate execution |
| 130-189 | `high` | Interrupts active execution |
| 90-129 | `medium` | Interrupts if execution is interruptible |
| <90 | `low` | Queued, may not interrupt |

### Rule Evaluation

Each rule has:
- `condition(reflexView, internalState)` — pure function, reads only reflex tier + internal state
- `execute({api, bot, ctx})` — async action body
- `priority` — numeric score determining firing order

Only the highest-priority triggered rule fires per cycle.

## Internal State

The reflex layer maintains combat and damage tracking:

| State | Description |
|-------|-------------|
| `lastHealth` | Previous health value for delta detection |
| `beingAttacked` | Currently under attack |
| `lastAttackAt` | Timestamp of last attack |
| `combatModeUntilTs` | Combat mode expiry timestamp |
| `recentStuckCount` | Consecutive stuck detections |
| `lastStuckAt` | Timestamp of last stuck |
| `recentDamageEvents` | Array of recent damage timestamps |
| `lastDamageSource` | `{type, name, entityId, at}` — who dealt damage |

**Combat mode** blocks the planner from replanning while reflexes handle the fight. Duration: 2000-3200ms per trigger.

## Interrupt System

### Interrupt Decision Contract

Defined in `contracts/interruptDecision.js`:

```js
{
  shouldInterrupt: boolean,
  priority: 'fatal_immediate' | 'high' | 'medium' | 'low',
  interruptReason: string,
  source: 'reflex' | 'damage' | 'world_change' | 'planner' | 'system',
  suggestedSkill: string | null,
  fallbackMode: string | null,
  metadata: object | null,
}
```

Factory functions: `noInterrupt()`, `interruptDecision()`, `reflexInterrupt()`, `systemInterrupt()`

### Interrupt Gate

`interruptGate.js` collects candidates from three sources each cycle:

1. **Queued interrupts** — damage events pushed by `eventReactor.js`
2. **Immediate danger** — `close_threat=true` OR `recentDamageMs < 2500`
3. **World state changes** — significant snapshot delta

Candidates are sorted by priority rank. The task state machine's interrupt policy decides acceptance.

### Interrupt Executor Lifecycle

`interruptExecutor.js` manages the full takeover:

1. **Validate** — Check `shouldInterrupt` flag
2. **Resolve action** — Use matched reflex rule or damage fallback
3. **Guard** — Reject if another reflex is in-flight
4. **Cooldown** — Same rule within 3800ms → suppressed (prevents spam)
5. **Abort chain** — Cancel active chain execution via `chainRunControl.abort()`
6. **Execute reflex** — Run the reflex skill
7. **State transitions** — `interrupted → recovering → idle`
8. **Log result** — Structured logging with priority, reason, outcome
9. **Release** — `reflexTakeoverInFlight = false`, execution lock released

### Cooldown

Default: 3800ms (env `REFLEX_TAKEOVER_COOLDOWN_MS`).

The cooldown key is derived from the rule name + action name. This prevents the same reflex from firing repeatedly but allows different reflexes to fire in quick succession.

## Damage Fast-Path

The daemon main loop has a special pre-cycle check for critical damage events. If health <= 5 and a damage interrupt is queued, it bypasses the full cycle pipeline and directly triggers the interrupt executor. This ensures survival even when the planner or other gates would cause delay.

## How Interrupts Flow Through the System

```
Event (damage/threat)
  → eventReactor.js (queues interrupt)
    → daemon cycle start
      → interruptGate.js (ranks candidates)
        → reflexGate.js (evaluates reflex rules)
          → interruptExecutor.js (takeover lifecycle)
            → reflexLayer.execute(rule) (survival action)
              → state: interrupted → recovering → idle
```

After recovery, the agent re-enters the normal cycle pipeline. The planner sees the interruption context (failure fingerprint, damage source) and decides the next action — the reflex layer does not decide what happens after survival.
