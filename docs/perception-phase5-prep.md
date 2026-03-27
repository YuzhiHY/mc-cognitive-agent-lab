# Phase 5 Perception Prep

This document defines perception consumer expectations before full tiered perception refactor.

## Consumer Map

- `reflexLayer` needs:
  - immediate hazards (`lava`, `water`, `fire/burn`, `fall risk`)
  - close hostile pressure (`close_threat`, nearest hostile, damage burst hints)
  - short-window survival signals (`health`, `recentDamageMs`, oxygen/water danger)
- runtime/execution (`daemon`, `chainExecutor`) needs:
  - stable movement + action context (`position`, `onGround`, nearby blocks/entities)
  - interrupt-facing fields (`threat_level`, world-change deltas)
  - lightweight inventory summary for execution policy gating
- planner (`centralReasoning`) needs:
  - decision-quality summary (`resources`, `obstacles`, threat bands, inventory gate)
  - enough context for chain/skill scheduling without full raw world dump
- semantic/memory/personality consumers need:
  - compact natural-language-friendly facts
  - trend/history hooks (damage trend, recent failures, confidence windows)

## Current Fields Already Available

- `status`:
  - position/yaw/pitch/health/food/worldTime/isNight/onGround
- `inventory.summary`
- `nearby.blocks` and `nearby.entities`
- `farResources`
- `threat_level`, `close_threat`, `nearest_hostile_distance`, `threat_bands`
- `resources`, `obstacles`
- daemon-enriched runtime fields:
  - `status.recentDamageMs`

## Current Mixing Debt

- reflex consumers still read from broad snapshot shape instead of a strict reflex tier
- planner and execution both read overlapping fields from the same payload
- semantic-personality consumers rely on planner-side transformations, not explicit semantic tier
- some runtime-only signals are injected in daemon rather than produced in a dedicated perception tier

## Proposed Phase 5 Target Shape

```json
{
  "timestamp": 0,
  "reflex": {
    "inWater": false,
    "onFire": false,
    "fallingRisk": false,
    "closeThreat": false,
    "nearestHostileDistance": null,
    "recentDamageMs": null,
    "health": 20
  },
  "execution": {
    "position": { "x": 0, "y": 64, "z": 0 },
    "onGround": true,
    "nearbyBlocks": [],
    "nearbyEntities": [],
    "inventorySummary": []
  },
  "decision": {
    "threatLevel": "none",
    "threatBands": {},
    "resources": [],
    "obstacles": {},
    "farResources": []
  },
  "semantic": {
    "briefFacts": [],
    "situationSummary": "",
    "confidenceHints": []
  }
}
```

## Phase 5 Entry Criteria

- keep backward compatibility while introducing tiered payload
- wire consumers by tier:
  - reflex -> `reflex`
  - execution runtime -> `execution`
  - planner -> `decision + semantic`
- remove daemon-only perception patching where tier can own the field

