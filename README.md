# mc-cognitive-agent-lab

A modular Minecraft agent framework built on Mineflayer, exploring a transition from LLM-driven code generation to a structured, layered autonomous agent system.

---

## 🧠 Overview

This project is an experimental AI agent architecture for Minecraft.

It aims to move beyond simple "LLM controls a bot" setups and toward a system with:

- structured perception
- layered decision-making
- reusable skill system
- reflex / emergency handling
- controlled LLM involvement
- incremental learning and skill promotion

The system is designed as a **cognitive loop**, not a single-shot prompt execution.

---

## ⚙️ Current Implementation (Important)

> This section reflects the **actual current state of the codebase**.

The current system is **partially structured**, but still relies significantly on LLM-generated behavior.

### Core loop (current default runtime path)

1. Perception layer builds a structured snapshot
2. Central planner selects goal and action chain / skill usage
3. Executor runs bounded actions and chain steps with explicit success/failure status
4. Outcomes are logged and fed into memory / learning signals
5. Planner runs again only when execution completes/fails/interruption occurs

### Current transition status

- The runtime is actively transitioning away from a codegen-first default loop.
- A modular skill layer now exists under `src/runtime/skills/` and is used as a first-class execution path (`skill_ref`).
- The daemon runtime now uses a task state machine (`taskStateMachine`) to gate planning vs execution by default.
- Replanning is blocked during active execution lock unless interrupt policy allows takeover (reflex/high-priority/state-change).
- Reflex/interrupt arbitration now uses explicit priority levels and structured interrupt outputs before planner execution.
- LLM-generated skills are still supported via sandbox and remain part of the system for controlled synthesis.
- Stable skills and generated skills now coexist; generated code is no longer the only behavior route.

### Controlled synthesis path (non-default)

- If no suitable existing behavior is found, LLM synthesis may be used under policy/sandbox constraints.
- Generated behavior is treated as untrusted and must be validated before stable reuse.

---

### What is already implemented

#### 🧩 Runtime structure
- daemon loop (`daemon.js`)
- reflex layer (interrupt / emergency handling)
- central reasoning (LLM interaction)
- chain executor (multi-step execution)
- sandbox execution layer

#### 👁 Perception
- environment snapshot (`sense.js`)
- includes:
  - threat estimation
  - nearby resources
  - obstacles
  - recent damage
  - memory hints
  - capability hints

#### 🦾 Execution layer
- Mineflayer-based API wrapper (`api.js`)
- includes:
  - navigation (pathfinder)
  - mining
  - combat
  - crafting / smelting
  - item interaction

#### 🧠 Skill system (early stage)
- skill registry
- skill persistence (`skills/`)
- promotion logic (basic)
- validation layer

#### ⚠️ Reflex & recovery
- reflex layer (threat-based interrupts)
- stuck detector
- failure fingerprint logging

#### 🧪 Testing
- hardening tests (sandbox, JSON parsing, memory limits)
- basic capability tests (crafting, placing, execution)

---

### Current limitations

The system is **not yet fully stabilized** and still exhibits:

- heavy reliance on LLM-generated code
- incomplete separation between planning and execution
- daemon acting as a central control hub (high coupling)
- skill system not yet dominant over code generation
- limited long-run stability guarantees

---

## 🧭 Target Architecture (Design Goal)

The intended evolution of this system is:

### Default loop (target)


perception → goal selection → skill selection → execution → feedback → memory update


NOT:


LLM → generate code → execute directly


---

### Planned architecture

#### 🧱 Layered system

- **Perception layer**
  - structured, tiered snapshots (reflex / execution / decision / semantic)

- **Execution layer (body)**
  - bounded actions
  - stable skills
  - deterministic behavior

- **Skill layer**
  - reusable mid-level behaviors
  - explicit success/failure semantics
  - promotion from validated experience

- **Reflex layer**
  - high-priority interrupts
  - survival-first logic

- **Planning layer (LLM)**
  - selects goals and skills
  - evaluates outcomes
  - does NOT directly control movement

---

### LLM role (target)

LLM should:

- interpret environment
- select goals
- choose from existing skills
- decide when new skill synthesis is needed
- analyze failures

LLM should NOT:

- directly control low-level movement
- generate arbitrary code on every cycle
- bypass skill or safety layers

---

### Skill evolution model

1. LLM may generate new behavior **only when necessary**
2. Generated skills are:
   - sandboxed
   - treated as experimental
3. Only after repeated success:
   - they are promoted to reusable skills
4. Failed or unstable skills are:
   - rejected or quarantined

---

## 🧪 Project Goals

This project is not trying to:

- maximize raw intelligence
- create a chatbot in Minecraft

It is trying to:

- build a **stable, inspectable agent system**
- explore **bounded autonomy**
- study **skill-based cognition in game environments**
- balance **LLM flexibility vs system control**

---

## 🗂 Project Structure (simplified)


src/
runtime/
api.js
sense.js
daemon.js
reflexLayer.js
stuckDetector.js
skillRegistry.js
sandbox.js

skills/
(generated and stored behaviors)

tests/
(hardening + capability tests)

memory/
personality/


---

## 🚧 Current Stage

This project is in an **early-to-mid prototype stage**:

- architecture is largely defined
- core systems are present
- stability and control are still under active development

---

## 📌 Future Direction

Next steps focus on:

- reducing reliance on code generation
- strengthening skill-based execution
- introducing execution locks and task state machines
- formalizing perception layers
- improving failure recovery
- building a reliable skill promotion pipeline
- improving observability and debugging

---

## ⚠️ Disclaimer

This is an experimental system.

Expect:
- unstable behavior
- incomplete features
- ongoing architectural changes

---

## 💡 Notes

This project prioritizes **structure over raw capability**.

The goal is not to make the bot "smarter" immediately,
but to make it **more stable, explainable, and evolvable over time**.

