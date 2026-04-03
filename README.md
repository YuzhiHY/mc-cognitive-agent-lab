# mc-cognitive-agent-lab

A Minecraft agent framework built on Mineflayer, focused on structured cognition rather than single-shot LLM prompting. This is an experimental project exploring how cognitive architecture can make LLM-driven agents more flexible and autonomous while keeping the system lightweight. It is under active development and behavior is not yet stable. The codebase is primarily written with Claude Code.

The agent runs a continuous cognitive loop (perception → reasoning → action → learning) and makes decisions through a layered pipeline instead of directly asking the LLM "what should I do."

The personality system uses a kernel method — defining behavior through cognitive mechanisms and value axioms rather than character descriptions. The LLM's output is constrained by a gameKnowledge layer that only exposes currently valid actions, blocks, and items. Skills synthesized by the LLM go through a promotion/quarantine lifecycle based on actual success rate, and failures are fingerprinted and fed back to the planner.

## Quick start

```bash
# Configure
cp .env.example .env
# Edit .env: MC_HOST, MC_PORT, MC_USERNAME, LLM_PROVIDER, API keys, etc.

# Install
npm install

# Run (single task)
npm start

# Run (continuous daemon — the intended mode)
npm run daemon
```

### Key environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `LLM_PROVIDER` | `local` / `openai` / `anthropic` / `deepseek` / `gemini` / `custom` | `local` |
| `DAEMON_MODE` | Enable continuous cognitive loop | `false` |
| `PERSONALITY_ENABLED` | Enable kernel-method personality layer | `false` |
| `REFLEX_ENABLED` | Enable survival reflex layer | `true` |
| `AGENT_DEBUG` | Compact console debug output per cycle | unset |

See `.env.example` for the full list.

## Architecture overview

```
perception → interrupt gate → reflex gate → planner gate → chain orchestration → post-processing
```

Each cycle:
1. **Perception** builds a tiered snapshot of the world (reflex / execution / decision / semantic)
2. **Interrupt & reflex gates** handle survival emergencies deterministically — the only place where hardcoded reactions are allowed
3. **Central reasoning** (LLM) analyzes the situation, consults personality, and produces an action chain constrained by gameKnowledge
4. **Chain executor** runs the action steps (navigate, mine, craft, place, attack, etc.) with abort support
5. **Post-processing** evaluates expectations, updates memory, promotes or quarantines skills

The personality layer outputs *tendency signals* (e.g., `retreat_first`, `seek_familiar`), not action commands. The planner remains the sole decision-maker.

For detailed architecture docs, see [`docs/`](docs/).

## Testing

```bash
npm test
```

28 test suites covering contracts, state machine, reflex arbitration, planning, perception, skill lifecycle, failure fingerprints, daemon orchestration, and multi-cycle behavioral invariants.

## Project status

The core architecture is complete and in iterative testing. The system runs as a continuous daemon, perceives its environment, makes LLM-driven decisions, executes skills, and learns from outcomes.

Current focus: runtime stability, failure recovery, and tuning the cognitive loop through real gameplay sessions.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Layered runtime walkthrough and module map |
| [Perception](docs/perception.md) | 4-tier perception model and field reference |
| [Skills](docs/skills.md) | Skill contract, stable skills, candidate pipeline |
| [Planner Policy](docs/planner-policy.md) | 4-phase reasoning and scheduling-first policy |
| [Reflex & Interrupts](docs/reflex-and-interrupts.md) | Survival reflexes, interrupt lifecycle, priority system |

## Current limitations

- Stuck detection is movement-based only (no physics solver)
- gameKnowledge covers basic Minecraft items; advanced recipes not yet included
- LLM latency varies by provider (Gemini Flash is fastest, DeepSeek can add 2-5s per cycle)
- Mid-step reflex vs body control can race briefly until the current primitive finishes
