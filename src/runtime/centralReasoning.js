const {
  buildSystemPrompt,
  buildCentralAnalyzePayload,
  buildCentralDecidePayload,
  buildCentralLearnEvalPayload,
} = require('./llm/prompt')
const { buildGameKnowledge, buildAnchorFacts } = require('./gameKnowledge')
// sense is no longer imported here — snapshot refresh is injected via refreshSnapshot callback
const {
  getQueue,
  saveQueue,
  mergeProposalsFromAnalysis,
  compactChainForEval,
  compactChainResults,
  appendHabit,
} = require('./learnTasks')

/**
 * Curate memory for the LLM planner — semantic tier mediation.
 * Instead of dumping raw memory.getAll() to the LLM, extract only
 * knowledge-relevant entries and compact them for token efficiency.
 */
function curateMemoryForPlanner(memory, ctx) {
  if (!memory) return {}
  const all = memory.getAll()
  const curated = {}

  // Extract knowledge entries (the ones the LLM actually uses)
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('knowledge:')) {
      curated[key] = value
    }
    if (key.startsWith('learned:')) {
      // Only include non-promoted learned patterns (promoted are in stable skills)
      if (value && !value.promoted) {
        curated[key] = {
          signature: value.signature,
          successCount: value.successCount,
          failCount: value.failCount,
        }
      }
    }
    if (key.startsWith('skill:')) {
      curated[key] = { skillName: value?.skillName, source: value?.source }
    }
  }

  // Include memory hints from failure fingerprints (already in ctx)
  if (ctx?.memory_hint) {
    curated._memory_hints = ctx.memory_hint
  }

  // Include habits
  const habits = all['learn:habits']
  if (habits) {
    curated['learn:habits'] = habits
  }

  return curated
}
const { chooseHardcodedSkill } = require('./planning/skillSelector')
const { compileActionChain } = require('./planning/chainCompiler')
const { buildIntentAwareChain, shouldSuppressAutoWood } = require('./planning/intentFallback')
const { derivePlannerMeta } = require('./contracts/plannerOutput')
const { canSynthesize, filterSynthesisSteps } = require('./synthesisPolicy')

function hasExplicitUserIntent(ctx, analysis) {
  if (Array.isArray(ctx?.playerMessages) && ctx.playerMessages.length > 0) return true
  if (ctx?.runtimeDirectives?.hadPlayerMessageBatch) return true
  const g = String(ctx?.runtimeDirectives?.primaryGoal || analysis?.selfGoal || '').trim()
  if (!g) return false
  if (/maintain progress safely|fast_fallback/i.test(g)) return false
  if (/^demo$/i.test(g) || /^test$/i.test(g)) return false
  return true
}

function createCentralReasoning({ llm, personalityLlm, stableSkills }) {
  if (!llm) throw new Error('centralReasoning requires a core LLM client')

  let lastChainResult = null
  // Rolling window of recent chain outcomes for failure pattern detection
  const recentOutcomes = []
  const MAX_RECENT_OUTCOMES = 6
  // Budget defaults scale with LLM_TIMEOUT_MS so API calls don't timeout prematurely.
  // Previous 3500ms defaults caused 100% timeout with real LLM providers.
  const llmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS || 15000)
  const centralThinkBudgetMs = Number(process.env.CENTRAL_THINK_BUDGET_MS || Math.max(llmTimeoutMs * 2.5, 25000))
  const analyzeBudgetMs = Number(process.env.CENTRAL_ANALYZE_BUDGET_MS || Math.max(llmTimeoutMs * 1.1, 12000))
  const decideBudgetMs = Number(process.env.CENTRAL_DECIDE_BUDGET_MS || Math.max(llmTimeoutMs * 1.1, 12000))
  const personalityBudgetMs = Number(process.env.CENTRAL_PERSONALITY_BUDGET_MS || Math.max(llmTimeoutMs * 0.5, 5000))

  function withBudget(promise, ms, label = 'phase') {
    if (!Number.isFinite(ms) || ms <= 0) return promise
    let t = null
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => {
        const err = new Error(`${label}_timeout_${ms}ms`)
        err.code = 'PHASE_TIMEOUT'
        reject(err)
      }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (t) clearTimeout(t)
    })
  }

  function quickFallbackDecision(ctx, analysis = {}) {
    if (hasExplicitUserIntent(ctx, analysis)) {
      const texts = (ctx.playerMessages || []).map((m) => String(m.text || ''))
      const g = String(ctx?.runtimeDirectives?.primaryGoal || analysis?.selfGoal || '')
      const intent = buildIntentAwareChain({ goalText: g, playerTexts: texts, snapshot: ctx?.snapshot })
      if (intent.length > 0) {
        return {
          thought: 'fast_fallback: intent-aware actions from user/task context',
          actionChain: intent,
          memoryUpdates: [],
          nextGoalHint: 'intent_fallback',
        }
      }
      const selected = chooseHardcodedSkill({
        goal: `${g} ${texts.join(' ')}`.trim(),
        snapshot: ctx?.snapshot || null,
        options: { suppressWoodGather: shouldSuppressAutoWood(g, texts) },
      })
      if (selected?.name) {
        return {
          thought: `fast_fallback: stable skill matched to user context (${selected.name})`,
          actionChain: [{ type: 'skill_ref', name: selected.name, args: selected.args || {} }],
          memoryUpdates: [],
          nextGoalHint: `intent_skill_${selected.name}`,
        }
      }
      // Intent exists but LLM failed — safe idle, let next cycle retry LLM.
      // No hardcoded behavioral choice here; decisions belong to the planner.
      return {
        thought: 'fast_fallback: intent present but LLM unavailable, safe idle until next cycle',
        actionChain: [{ type: 'wait', timeoutMs: 800 }],
        memoryUpdates: [],
        nextGoalHint: 'await_llm_retry',
      }
    }
    const blocks = ctx?.snapshot?.nearby?.blocks || []
    const hasOak = blocks.some((b) => String(b.name || '').toLowerCase() === 'oak_log')
    const hasDirt = blocks.some((b) => String(b.name || '').toLowerCase() === 'dirt' || String(b.name || '').toLowerCase() === 'grass_block')
    if (hasOak) {
      return {
        thought: 'fast_fallback: gather nearby oak log via stable skill',
        actionChain: [
          { type: 'skill_ref', name: 'approach_target', args: { target: 'oak_log', sprint: true } },
          { type: 'skill_ref', name: 'mine_named_block', args: { block: 'oak_log', maxDistance: 20 } },
        ],
        memoryUpdates: [],
        nextGoalHint: 'gather_wood_fast',
      }
    }
    if (hasDirt) {
      return {
        thought: 'fast_fallback: dig nearby dirt',
        actionChain: [
          { type: 'navigate', target: 'nearest_dirt', sprint: false },
          { type: 'dig', target: 'dirt' },
        ],
        memoryUpdates: [],
        nextGoalHint: 'safe_progress_dig',
      }
    }
    return {
      thought: 'fast_fallback: no clear target, short wait',
      actionChain: [{ type: 'wait', timeoutMs: 700 }],
      memoryUpdates: [],
      nextGoalHint: 'await_better_snapshot',
    }
  }

  function hardConstraintActive(snapshot) {
    const hp = snapshot?.status?.health ?? 20
    const threat = snapshot?.threat_level || 'none'
    const closeThreat = snapshot?.close_threat === true
    const recentDamage = snapshot?.status?.recentDamageMs
    if (hp <= 8) return true
    if (threat === 'high') return true
    if (closeThreat) return true
    if (typeof recentDamage === 'number' && recentDamage >= 0 && recentDamage < 5000) return true
    return false
  }

  /**
   * Apply personality tendency hints as tie-breaker for action ordering.
   * Uses kernel-method tendencyHints (not label-method preferenceHints).
   * Only reorders same-priority steps; never overrides survival actions.
   */
  function applyTendencyTieBreak(actionChain, { tendencyHints = [], snapshot = null } = {}) {
    if (!Array.isArray(actionChain) || actionChain.length < 2) return actionChain
    if (hardConstraintActive(snapshot)) return actionChain
    const hints = new Set((Array.isArray(tendencyHints) ? tendencyHints : []).map((x) => String(x).toLowerCase()))
    if (hints.size === 0) return actionChain

    const scoreStep = (s) => {
      const t = String(s?.type || '').toLowerCase()
      let score = 0
      // stay_near_familiar / seek_familiar → boost player-related navigation
      if (hints.has('stay_near_familiar') || hints.has('seek_familiar')) {
        if (t === 'navigate' && String(s?.target || '').toLowerCase().includes('player')) score += 1.5
        if (t === 'skill_ref' && String(s?.name || '').includes('follow_player')) score += 1.5
      }
      // retreat_first / avoid_unfamiliar_danger → boost wait, retreat skills
      if (hints.has('retreat_first') || hints.has('avoid_unfamiliar_danger')) {
        if (t === 'wait') score += 1.2
        if (t === 'skill_ref' && String(s?.name || '').includes('retreat')) score += 1.5
      }
      // continue_current → no reordering boost (keep original order)
      // shift_attention → slight boost for non-repeat actions
      if (hints.has('shift_attention')) {
        if (t === 'navigate' || t === 'skill_ref') score += 0.3
      }
      // approach_cautiously → navigation with low sprint
      if (hints.has('approach_cautiously')) {
        if (t === 'navigate') score += 0.5
      }
      // observe_unknown → wait / look actions
      if (hints.has('observe_unknown')) {
        if (t === 'wait') score += 0.8
      }
      return score
    }
    const weighted = actionChain.map((s, idx) => ({ s, idx, score: scoreStep(s) }))
    const stableSorted = weighted
      .slice()
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
      .map((x) => x.s)
    return stableSorted
  }

  function setLastChainResult(result) {
    lastChainResult = result
    if (result) {
      const failed = !!result.failedStep
      const summary = {
        cycle: Date.now(),
        completed: result.completed,
        total: result.total,
        failed,
        failReason: result.failedStep?.error?.message || null,
        failType: result.failedStep?.type || null,
      }
      recentOutcomes.push(summary)
      if (recentOutcomes.length > MAX_RECENT_OUTCOMES) recentOutcomes.shift()
    }
  }

  /**
   * Build a concise failure streak summary for the LLM.
   * If recent cycles show a pattern of repeated failures, produce a strong signal.
   */
  function buildFailureContext() {
    if (recentOutcomes.length < 2) return null
    const failures = recentOutcomes.filter((o) => o.failed)
    if (failures.length < 2) return null

    // Group by failReason
    const reasonCounts = {}
    for (const f of failures) {
      const key = f.failReason || 'unknown'
      reasonCounts[key] = (reasonCounts[key] || 0) + 1
    }

    const dominant = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]
    const streak = failures.length
    const total = recentOutcomes.length

    // Facts only — no behavioral recommendation. The LLM planner decides strategy.
    return {
      consecutiveOrRecentFailures: streak,
      totalRecentCycles: total,
      dominantFailure: { reason: dominant[0], count: dominant[1] },
      allReasons: reasonCounts,
      urgency: streak >= 3 ? 'high' : 'medium',
    }
  }

  async function phaseAnalyze({ ctx, memory, cycle }) {
    const systemPrompt = buildSystemPrompt({ mode: 'central_analyze' })
    const failureContext = buildFailureContext()
    const anchorFacts = buildAnchorFacts(ctx.snapshot, failureContext)
    const userPayload = buildCentralAnalyzePayload({
      snapshot: ctx.snapshot,
      memory: curateMemoryForPlanner(memory, ctx),
      lastChainResult,
      failureContext,
      cycle,
      playerMessages: ctx.playerMessages || undefined,
      anchorFacts,
    })

    const result = await llm.plan({
      ctx: {},
      history: [],
      _systemPromptOverride: systemPrompt,
      _userPayloadOverride: userPayload,
      _skipValidation: true,
    })

    return {
      situationAnalysis: result?.situationAnalysis || '',
      personalityBrief: result?.personalityBrief || '',
      selfGoal: result?.selfGoal || '',
      severity: result?.severity || 'normal',
      rankedGoals: Array.isArray(result?.rankedGoals) ? result.rankedGoals : [],
      longTermLearnProposals: Array.isArray(result?.longTermLearnProposals)
        ? result.longTermLearnProposals
        : [],
      memoryUpdates: Array.isArray(result?.memoryUpdates) ? result.memoryUpdates : [],
    }
  }

  async function phasePersonality({ personality, brief, logger, cycle }) {
    if (!personality || !personality.isEnabled()) {
      return { voice: '', emotionalTags: [], suggestion: null }
    }

    try {
      const result = await personality.consultSync(brief)
      if (logger) {
        await logger.log({
          type: 'central_personality_consult', cycle,
          voice: result?.voice || '',
          emotionalTags: result?.emotionalTags || [],
          tendencyHints: result?.tendencyHints || [],
          suggestion: result?.suggestion || null,
          error: result?.error || null,
        })
      }
      return result || { voice: '', emotionalTags: [], suggestion: null }
    } catch (err) {
      if (logger) {
        await logger.log({
          type: 'central_personality_error', cycle, error: err.message,
        })
      }
      return { voice: '', emotionalTags: [], suggestion: null }
    }
  }

  async function phaseDecide({ analysis, personalityFeedback, ctx, memory }) {
    const systemPrompt = buildSystemPrompt({ mode: 'central_decide' })

    const learnTaskQueue = getQueue(memory).map((t) => ({
      id: t.id,
      summary: t.summary,
      successCriteria: t.successCriteria,
      successesRequired: t.successesRequired,
      successCount: t.successCount,
      priorityTier: t.priorityTier || 'user_long_term_habit',
    }))

    // Build gameKnowledge from current snapshot + skill registry
    const gameKnowledge = buildGameKnowledge(ctx.snapshot, stableSkills)

    const failureCtx = buildFailureContext()
    const userPayload = buildCentralDecidePayload({
      analysis: {
        situationAnalysis: analysis.situationAnalysis,
        selfGoal: analysis.selfGoal,
        goalConstraints: analysis.goalConstraints || null,
        rankedGoals: analysis.rankedGoals || [],
      },
      personalityFeedback: {
        voice: personalityFeedback.voice,
        emotionalTags: personalityFeedback.emotionalTags,
        suggestion: personalityFeedback.suggestion,
        tendencyHints: personalityFeedback.tendencyHints || [],
      },
      snapshot: ctx.snapshot,
      memory: curateMemoryForPlanner(memory, ctx),
      learnTaskQueue,
      rankedGoals: analysis.rankedGoals || [],
      failureContext: failureCtx,
      gameKnowledge,
    })

    const result = await llm.plan({
      ctx: {},
      history: [],
      _systemPromptOverride: systemPrompt,
      _userPayloadOverride: userPayload,
      _skipValidation: true,
    })

    const decision = {
      thought: result?.thought || '',
      actionChain: Array.isArray(result?.actionChain) ? result.actionChain : [],
      memoryUpdates: Array.isArray(result?.memoryUpdates) ? result.memoryUpdates : [],
      nextGoalHint: result?.nextGoalHint || null,
      tendencyHints: Array.isArray(personalityFeedback?.tendencyHints)
        ? personalityFeedback.tendencyHints
        : [],
    }
    // Prefer stable hardcoded skills before low-level ad-hoc chain when possible.
    if (!Array.isArray(decision.actionChain) || decision.actionChain.length === 0) {
      const selected = chooseHardcodedSkill({
        goal: analysis?.selfGoal || analysis?.situationAnalysis || '',
        snapshot: ctx?.snapshot || null,
        options: { suppressWoodGather: hasExplicitUserIntent(ctx, analysis) },
      })
      if (selected?.name) {
        decision.actionChain = [{ type: 'skill_ref', name: selected.name, args: selected.args || {} }]
        decision.thought = decision.thought || `selected stable skill: ${selected.name}`
      }
    }
    decision.actionChain = compileActionChain({
      actionChain: decision.actionChain,
      goal: analysis?.selfGoal || analysis?.situationAnalysis || '',
      snapshot: ctx?.snapshot || null,
      planningContext: {
        explicitUserIntent: hasExplicitUserIntent(ctx, analysis),
        goalText: analysis?.selfGoal || ctx?.runtimeDirectives?.primaryGoal || '',
        playerTexts: (ctx.playerMessages || []).map((m) => String(m.text || '')),
      },
    })
    // Strip skill_ref steps that reference non-existent skills (LLM may hallucinate learned skill names)
    if (stableSkills && Array.isArray(decision.actionChain)) {
      decision.actionChain = decision.actionChain.filter((step) => {
        if (step.type !== 'skill_ref') return true
        const exists = stableSkills.get?.(step.name)
        if (!exists) {
          // eslint-disable-next-line no-console
          console.warn(`[centralReasoning] stripped unknown skill_ref: ${step.name}`)
        }
        return !!exists
      })
    }
    decision.actionChain = applyTendencyTieBreak(
      decision.actionChain,
      {
        tendencyHints: personalityFeedback.tendencyHints || [],
        snapshot: ctx.snapshot,
      },
    )

    // Synthesis policy gate: filter out code generation steps if policy denies
    const plannerMeta = derivePlannerMeta(decision)
    decision._plannerMeta = plannerMeta
    if (plannerMeta.requiresSynthesis) {
      const policy = canSynthesize({
        plannerMeta,
        snapshot: ctx.snapshot,
        stableSkills: stableSkills || null,
      })
      decision._synthesisPolicy = policy
      if (!policy.allowed) {
        decision.actionChain = filterSynthesisSteps(decision.actionChain, false)
      }
    }

    return decision
  }

  async function phaseExpectation({ analysis, decision, personality, cycle, logger }) {
    if (!personality || !personality.isEnabled()) return null
    if (!Array.isArray(decision?.actionChain) || decision.actionChain.length === 0) return null
    try {
      const expectation = await personality.consultExpectation({
        brief: analysis.personalityBrief || analysis.situationAnalysis || '',
        selfGoal: analysis.selfGoal || '',
        actionChain: decision.actionChain,
      })
      if (logger) {
        await logger.log({
          type: 'expectation_created',
          cycle,
          expectedOutcome: expectation?.expectedOutcome || '',
          confidence: expectation?.confidence ?? 0.5,
          risk: expectation?.risk || [],
          emotionIfFail: expectation?.emotionIfFail || 'confused',
          fallbackHint: expectation?.fallbackHint || '',
        })
      }
      return expectation
    } catch {
      return null
    }
  }

  async function evaluateLearnProgress({ memory, chainResult, decision, logger, cycle }) {
    if (!memory || !chainResult || !decision) return
    const overallOk = chainResult.completed >= chainResult.total
      && !chainResult.failedStep
      && !chainResult.interrupted
    if (!overallOk) return

    let queue = getQueue(memory)
    if (queue.length === 0) return

    try {
      const systemPrompt = buildSystemPrompt({ mode: 'central_learn_eval' })
      const userPayload = buildCentralLearnEvalPayload({
        pendingTasks: queue.map((t) => ({
          id: t.id,
          summary: t.summary,
          successCriteria: t.successCriteria,
          successesRequired: t.successesRequired,
          successCount: t.successCount || 0,
        })),
        plannedChain: compactChainForEval(decision.actionChain),
        chainResults: compactChainResults(chainResult.results),
        overallSuccess: true,
        selfGoal: decision.nextGoalHint || decision.thought || '',
      })

      const result = await llm.plan({
        ctx: {},
        history: [],
        _systemPromptOverride: systemPrompt,
        _userPayloadOverride: userPayload,
        _skipValidation: true,
      })

      const increments = Array.isArray(result?.increments) ? result.increments : []
      const completions = Array.isArray(result?.completions) ? result.completions : []
      const completionSummaryById = new Map(
        completions.map((c) => [c.taskId, c.habitSummary || '']).filter(([k]) => k),
      )

      for (const inc of increments) {
        if (!inc || inc.delta !== 1) continue
        const task = queue.find((t) => t.id === inc.taskId)
        if (!task) continue
        task.successCount = Math.min(
          task.successesRequired,
          (task.successCount || 0) + 1,
        )
        if (logger) {
          await logger.log({
            type: 'learn_task_progress',
            cycle,
            taskId: task.id,
            successCount: task.successCount,
            successesRequired: task.successesRequired,
          })
        }
      }

      const done = queue.filter((t) => (t.successCount || 0) >= t.successesRequired)
      queue = queue.filter((t) => (t.successCount || 0) < t.successesRequired)
      await saveQueue(memory, queue)

      for (const t of done) {
        const habitSummary = completionSummaryById.get(t.id)
          || `长期习惯已确立：${t.summary}`
        await appendHabit(memory, {
          id: t.id,
          summary: t.summary,
          habitSummary,
          source: 'learn_task',
          completedAt: new Date().toISOString(),
          successesRequired: t.successesRequired,
        })
        await memory.set(`knowledge:habit_learned:${t.id}`, habitSummary)
        if (logger) {
          await logger.log({
            type: 'learn_task_completed',
            cycle,
            taskId: t.id,
            habitSummary,
          })
        }
      }
    } catch (err) {
      if (logger) {
        await logger.log({
          type: 'learn_task_eval_error',
          cycle,
          error: err.message || String(err),
        })
      }
    }
  }

  async function think({ ctx, refreshSnapshot, memory, personality, logger, cycle }) {
    // Phase 1: Analyze & Translate
    const thinkStart = Date.now()
    let analysis
    try {
      analysis = await withBudget(
        phaseAnalyze({ ctx, memory, cycle }),
        analyzeBudgetMs,
        'analyze',
      )
    } catch (analyzeErr) {
      const errMsg = analyzeErr?.message || String(analyzeErr)
      // eslint-disable-next-line no-console
      console.error(`[centralReasoning] phaseAnalyze FAILED (cycle ${cycle}): ${errMsg}`)
      if (logger) {
        await logger.log({
          type: 'central_analyze_error', cycle,
          error: errMsg,
          budgetMs: analyzeBudgetMs,
        })
      }
      analysis = {
        situationAnalysis: `fast_fallback: analyze failed — ${errMsg.slice(0, 120)}`,
        personalityBrief: '',
        selfGoal: 'maintain progress safely',
        severity: 'normal',
        rankedGoals: [],
        longTermLearnProposals: [],
        memoryUpdates: [],
      }
    }

    if (logger) {
      await logger.log({
        type: 'central_phase1_analyze', cycle,
        situationAnalysis: analysis.situationAnalysis,
        personalityBrief: analysis.personalityBrief,
        selfGoal: analysis.selfGoal,
        memoryUpdates: analysis.memoryUpdates.length,
        rankedGoalsCount: (analysis.rankedGoals || []).length,
        learnProposalsCount: (analysis.longTermLearnProposals || []).length,
      })
    }

    // Apply phase-1 memory updates immediately
    if (memory && analysis.memoryUpdates.length > 0) {
      for (const update of analysis.memoryUpdates) {
        if (update.action === 'remember' && update.key) {
          await memory.set(update.key, update.value)
        } else if (update.action === 'forget' && update.key) {
          await memory.delete(update.key)
        }
      }
    }

    if (memory && (analysis.longTermLearnProposals || []).length > 0) {
      await mergeProposalsFromAnalysis(
        memory,
        analysis.longTermLearnProposals,
        logger,
        cycle,
      )
    }

    // Phase 2: Personality Consultation (skip on routine/low-severity cycles to save latency)
    const severity = analysis.severity || 'normal'
    const skipPersonality = severity === 'idle' && cycle % 3 !== 0

    let personalityFeedback = { voice: '', emotionalTags: [], suggestion: null }
    if (!skipPersonality) {
      try {
        personalityFeedback = await withBudget(
          phasePersonality({
            personality,
            brief: analysis.personalityBrief,
            logger,
            cycle,
          }),
          personalityBudgetMs,
          'personality',
        )
      } catch {
        personalityFeedback = { voice: '', emotionalTags: [], suggestion: null }
      }
    }

    // Refresh snapshot before decide — LLM calls above may have taken seconds,
    // entities/blocks could have changed (creeper exploded, mob despawned, etc.)
    if (typeof refreshSnapshot === 'function') {
      const freshSnapshot = refreshSnapshot()
      ctx = { ...ctx, snapshot: freshSnapshot }
    }

    // Phase 3: Final Decision
    let decision
    try {
      decision = await withBudget(
        phaseDecide({
          analysis,
          personalityFeedback,
          ctx,
          memory,
        }),
        decideBudgetMs,
        'decide',
      )
    } catch (decideErr) {
      const errMsg = decideErr?.message || String(decideErr)
      // eslint-disable-next-line no-console
      console.error(`[centralReasoning] phaseDecide FAILED (cycle ${cycle}): ${errMsg}`)
      if (logger) {
        await logger.log({
          type: 'central_decide_error', cycle,
          error: errMsg,
          budgetMs: decideBudgetMs,
        })
      }
      decision = quickFallbackDecision(ctx, analysis)
    }

    try {
      const elapsed = Date.now() - thinkStart
      if (elapsed < centralThinkBudgetMs - 600) {
        const expectation = await phaseExpectation({
          analysis,
          decision,
          personality,
          cycle,
          logger,
        })
        if (expectation) decision.expectation = expectation
      }
    } catch { /* optional phase */ }

    if (logger) {
      await logger.log({
        type: 'central_phase3_decide', cycle,
        thought: decision.thought,
        actionChainLength: decision.actionChain.length,
        nextGoalHint: decision.nextGoalHint,
      })
    }

    lastChainResult = null
    return decision
  }

  return Object.freeze({ think, setLastChainResult, evaluateLearnProgress })
}

module.exports = { createCentralReasoning }
