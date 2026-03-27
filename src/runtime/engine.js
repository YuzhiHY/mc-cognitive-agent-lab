const fs = require('node:fs')
const path = require('node:path')
const { sense } = require('./sense')
const { createApi } = require('./api')
const { runSkillInSandbox, serializeError, withTimeout } = require('./sandbox')
const { createJsonlLogger } = require('./logger')
const { truncateHistoryForLLM } = require('./history')
const { createSkillRegistry } = require('./skillRegistry')
const { createStuckDetector } = require('./stuckDetector')
const { buildMemoryHint } = require('./memoryHint')
const { checkPreconditions } = require('./skillValidator')
const { createPersonality } = require('./personality')

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true })
}

async function saveSkillCode(skillName, code) {
  const safeName = String(skillName).replace(/[^a-zA-Z0-9._-]/g, '_')
  const dir = path.resolve(process.cwd(), 'skills')
  await ensureDir(dir)
  const file = path.join(dir, `${safeName}.js`)

  // Normalize common double-escaped sequences from JSON/LLM outputs.
  // This fixes cases where code contains literal "\n" instead of real newlines.
  if (typeof code === 'string' && code.includes('\\n')) {
    code = code
      .replace(/\\r\\n/g, '\r\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
  }

  await fs.promises.writeFile(file, code, 'utf8')
  return { file, normalizedCode: code }
}

async function getSkillPreconditions(currentSkillName) {
  try {
    const indexPath = path.resolve(process.cwd(), 'skills', 'index.json')
    const raw = await fs.promises.readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.skills) ? parsed.skills : parsed
    const entry = list.find(
      (e) => e && (e.skillName === currentSkillName || e.name === currentSkillName)
    )
    return Array.isArray(entry?.preconditions) ? entry.preconditions : []
  } catch {
    return []
  }
}

async function getFallbackSkillName(skillRegistry, currentSkillName) {
  try {
    const indexPath = path.resolve(process.cwd(), 'skills', 'index.json')
    const raw = await fs.promises.readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.skills) ? parsed.skills : parsed
    const entry = list.find(
      (e) => e && (e.skillName === currentSkillName || e.name === currentSkillName)
    )
    return entry?.fallbackSkill || null
  } catch {
    return null
  }
}

function createEngine({ bot, llm, personalityLlm, hardTimeoutMs = 10_000 }) {
  const api = createApi(bot)
  let isExecutionLocked = false

  const personalityEnabled =
    String(process.env.PERSONALITY_ENABLED || 'false').toLowerCase() === 'true'
  const personality = createPersonality({
    enabled: personalityEnabled,
    personalityLlm,
    cooldownSteps: process.env.PERSONALITY_TRIGGER_COOLDOWN_STEPS
      ? Number(process.env.PERSONALITY_TRIGGER_COOLDOWN_STEPS)
      : 3,
  })

  function classifyFailureCode(err) {
    if (!err) return 'UNKNOWN_ERROR'
    if (err.code === 'HARD_TIMEOUT') return 'TASK_HARD_TIMEOUT'
    if (err.code === 'MAX_STEPS_REACHED') return 'TASK_MAX_STEPS_REACHED'
    if (err.code === 'LLM_PLAN_FAILED') return 'LLM_PLAN_FAILED'
    return 'RUNTIME_FAILURE'
  }

  function mapErrorToState(err) {
    if (!err) return 'failed'
    if (err.code === 'HARD_TIMEOUT') return 'timeout'
    if (err.code === 'MAX_STEPS_REACHED') return 'max_steps'
    return 'failed'
  }

  function buildStepSummaries(history) {
    function isExecutionOk(execution) {
      if (!execution || typeof execution !== 'object') return false
      if (typeof execution.status === 'string') return execution.status === 'success'
      return execution.ok === true
    }
    function isExecutionDone(execution) {
      const st = execution?.status
      if (st && st !== 'success') return false
      const output = execution?.details?.output ?? execution?.result
      return output?.done !== false
    }
    return history
      .filter((h) => h && (h.stage === 'skill_execute' || h.stage === 'skill_execute_fallback'))
      .map((h) => ({
        step: h.step ?? null,
        skillName: h.skillName ?? null,
        ok: isExecutionOk(h.execution),
        done: isExecutionDone(h.execution),
        errorCode: h.execution?.details?.error?.code ?? null,
        errorMessage: h.execution?.errorMessage ?? h.execution?.details?.error?.message ?? null,
        isFallback: h.stage === 'skill_execute_fallback',
        status: h.execution?.status ?? null,
      }))
  }

  function buildSummaryFromSteps(steps) {
    return {
      stepsTotal: steps.length,
      stepsSucceeded: steps.filter((s) => s.ok).length,
      stepsFailed: steps.filter((s) => !s.ok).length,
      lastSkillName: steps.length ? steps[steps.length - 1].skillName : null,
    }
  }

  async function runFallbackSkill({
    fallbackName, ctx, api, logger, task, step, startedAt, hardTimeoutMs, history,
  }) {
    const fallbackSucceeded = (execution) => {
      if (!execution || typeof execution !== 'object') return false
      if (typeof execution.status === 'string') return execution.status === 'success'
      return execution.ok === true
    }
    try {
      const fbPath = path.resolve(process.cwd(), 'skills', `${fallbackName}.js`)
      const fbCode = await fs.promises.readFile(fbPath, 'utf8')
      const fbExecution = await runSkillInSandbox({
        code: fbCode, ctx, api,
        timeoutMs: Math.max(1, hardTimeoutMs - (Date.now() - startedAt)),
        filename: fbPath,
      })
      const fbRecord = {
        stage: 'skill_execute_fallback', step, ts: nowIso(),
        skillName: fallbackName, execution: fbExecution,
      }
      history.push(fbRecord)
      await logger.log({
        type: 'skill_execute_fallback', taskId: task.id, step,
        originalSkill: ctx._currentSkillName || null, fallbackSkill: fallbackName,
        execution: {
          ok: fallbackSucceeded(fbExecution),
          status: fbExecution?.status || null,
          reason: fbExecution?.reason || null,
          error: fbExecution?.errorMessage || fbExecution?.details?.error?.message || null,
          logs: Array.isArray(fbExecution?.details?.logs) ? fbExecution.details.logs.slice(-5) : null,
        },
      })
      return fbExecution
    } catch {
      return null
    }
  }

  async function runTask({ task }) {
    if (isExecutionLocked) {
      const lockErr = new Error('Another task is already running')
      lockErr.code = 'EXECUTION_LOCKED'
      throw lockErr
    }
    isExecutionLocked = true

    const startedAt = Date.now()
    const history = []
    let finalState = 'running'
    let finalError = null
    const logger = createJsonlLogger({
      enabled: process.env.LOG_TO_FILE !== undefined ? process.env.LOG_TO_FILE : true,
      dir: process.env.LOG_DIR || 'logs',
      taskId: task.id,
      filePrefix: process.env.LOG_FILE_PREFIX || 'agent',
    })

    const stuckDetector = createStuckDetector(bot, {
      stuckThreshold: 0.5,
      fingerprintsDir: process.env.LOG_DIR || 'logs',
    })

    const historyForLLMSettings = {
      maxItems: process.env.LLM_HISTORY_MAX_ITEMS
        ? Number(process.env.LLM_HISTORY_MAX_ITEMS)
        : 20,
      maxChars: process.env.LLM_HISTORY_MAX_CHARS ? Number(process.env.LLM_HISTORY_MAX_CHARS) : 8000,
    }
    const maxStepsPerTask = process.env.MAX_STEPS_PER_TASK
      ? Number(process.env.MAX_STEPS_PER_TASK)
      : 8
    const llmPlanMaxAttempts = process.env.LLM_PLAN_MAX_ATTEMPTS
      ? Number(process.env.LLM_PLAN_MAX_ATTEMPTS)
      : 2
    const skillReuseEnabled =
      String(process.env.SKILL_REUSE_ENABLED || 'false').toLowerCase() === 'true'
    const skillReuseMinScore = process.env.SKILL_REUSE_MIN_SCORE
      ? Number(process.env.SKILL_REUSE_MIN_SCORE)
      : 0.25
    const skillRegistry = createSkillRegistry({
      enabled: skillReuseEnabled,
      minScore: skillReuseMinScore,
    })

    const reuseCounts = { hits: 0, misses: 0, sourceMap: {} }

    await logger.log({
      type: 'task_start',
      taskId: task.id,
      goal: task.goal,
      hardTimeoutMs,
      maxStepsPerTask,
      llmPlanMaxAttempts,
      skillReuseEnabled,
      skillReuseMinScore,
      isExecutionLocked: true,
    })

    const runLoop = async () => {
      let step = 0
      let lastPlan = null
      let lastExecution = null
      let prevThreatLevel = 'none'

      while (true) {
        step += 1
        if (step > maxStepsPerTask) {
          const maxStepErr = new Error(`Max steps reached (${maxStepsPerTask})`)
          maxStepErr.code = 'MAX_STEPS_REACHED'
          throw maxStepErr
        }

      function executionSucceeded(execution) {
        if (!execution || typeof execution !== 'object') return false
        if (typeof execution.status === 'string') return execution.status === 'success'
        return execution.ok === true
      }

      function executionDone(execution) {
        if (!execution || typeof execution !== 'object') return false
        if (typeof execution.status === 'string' && execution.status !== 'success') return false
        const output = execution?.details?.output ?? execution?.result
        return output?.done !== false
      }

        const snapshot = sense(bot, { radius: 5 })
        const memoryHint = await buildMemoryHint({
          currentPos: snapshot.status?.position,
          currentSnapshot: snapshot,
        })
        const personalityState = personality.isEnabled() ? personality.getState() : null
        const ctx = {
          task,
          snapshot,
          step,
          maxStepsPerTask,
          memory_hint: memoryHint,
          capabilities: typeof api.getCapabilities === 'function' ? api.getCapabilities() : {},
          personality: personalityState
            ? { voice: personalityState.voice, emotionalTags: personalityState.emotionalTags }
            : undefined,
        }

        const llmHistory = truncateHistoryForLLM(history, historyForLLMSettings)
        ctx.history = llmHistory

        const currentThreatLevel = snapshot.threat_level || 'none'
        const threatEscalated = (prevThreatLevel === 'none' && currentThreatLevel !== 'none')
          || (prevThreatLevel === 'low' && currentThreatLevel === 'high')
        prevThreatLevel = currentThreatLevel

        const personalityUrgency = personalityState?.emotionalTags?.some(
          (t) => ['urgent', 'flee', 'danger', 'panic', 'retreat', 'run'].includes(t?.toLowerCase())
        ) || false
        const canSkipLLM = lastPlan
          && executionSucceeded(lastExecution)
          && !executionDone(lastExecution)
          && !threatEscalated
          && !personalityUrgency

        let plan = null
        let reusedSkill = null

        if (canSkipLLM) {
          plan = lastPlan
          await logger.log({
            type: 'llm_skipped', taskId: task.id, step,
            reason: 'Rerunning previous skill (done=false, no error, no threat escalation)',
            skillName: lastPlan.skillName,
          })
        } else if (skillRegistry.enabled) {
          const reuseProbe = await skillRegistry.findReusableSkillWithDiagnostics({
            taskGoal: task.goal,
          })
          reusedSkill = reuseProbe?.match || null
          const reuseDiagnostics = reuseProbe?.diagnostics || null
          if (reusedSkill) {
            const reusedCode = await skillRegistry.loadSkillCode(reusedSkill.filePath)
            plan = {
              thought: `Reusing skill '${reusedSkill.skillName}' (score=${reusedSkill.score.toFixed(3)})`,
              skillName: reusedSkill.skillName,
              code: reusedCode,
            }
            reuseCounts.hits += 1
            const src = reusedSkill.source || 'unknown'
            reuseCounts.sourceMap[src] = (reuseCounts.sourceMap[src] || 0) + 1
            await logger.log({
              type: 'skill_reuse_selected',
              taskId: task.id,
              step,
              skillName: reusedSkill.skillName,
              score: reusedSkill.score,
              filePath: reusedSkill.filePath,
              source: reusedSkill.source || 'unknown',
              riskLevel: reusedSkill.meta?.riskLevel ?? null,
              topCandidates: reuseDiagnostics?.topCandidates || [],
            })
          } else {
            reuseCounts.misses += 1
            await logger.log({
              type: 'skill_reuse_miss',
              taskId: task.id,
              step,
              reason: 'No candidate above score threshold',
              topCandidates: reuseDiagnostics?.topCandidates || [],
              candidateCount: reuseDiagnostics?.candidateCount || 0,
            })
          }
        }

        if (!plan) {
          let lastPlanErr = null
          for (let attempt = 1; attempt <= llmPlanMaxAttempts; attempt += 1) {
            try {
              if (attempt > 1) {
                ctx.llmRepair = {
                  attempt,
                  maxAttempts: llmPlanMaxAttempts,
                  lastError: serializeError(lastPlanErr),
                  instruction:
                    'Return STRICT JSON with thought, skillName, code. Fix previous formatting/content issue.',
                }
              }
              plan = await llm.plan({ ctx, history: llmHistory })
              break
            } catch (err) {
              lastPlanErr = err
              await logger.log({
                type: 'llm_plan_attempt_failed',
                taskId: task.id,
                step,
                attempt,
                maxAttempts: llmPlanMaxAttempts,
                error: serializeError(err),
              })
              if (attempt < llmPlanMaxAttempts) {
                const backoffMs = attempt * 1000
                await new Promise((r) => setTimeout(r, backoffMs))
              }
            }
          }
          if (!plan) {
            const failure = {
              stage: 'llm_plan',
              step,
              ts: nowIso(),
              attempts: llmPlanMaxAttempts,
              error: serializeError(lastPlanErr),
            }
            history.push(failure)
            await logger.log({ type: 'llm_plan_failed', taskId: task.id, step, error: failure.error })
            const err = new Error('LLM planning failed after retries')
            err.code = 'LLM_PLAN_FAILED'
            err.detail = failure
            throw err
          }
        }

        const { thought, skillName, code } = plan

        // Check preconditions from skill registry if available.
        if (reusedSkill?.meta?.preconditions || skillRegistry.enabled) {
          const preconditions = reusedSkill?.meta?.preconditions
            || await getSkillPreconditions(skillName)
          if (preconditions && preconditions.length > 0) {
            const check = checkPreconditions(preconditions, ctx)
            if (!check.passed) {
              await logger.log({
                type: 'skill_precondition_failed',
                taskId: task.id, step, skillName,
                failed: check.failed,
              })
              history.push({
                stage: 'skill_precondition_failed', step, ts: nowIso(),
                skillName, failed: check.failed,
              })
              continue
            }
          }
        }

        await logger.log({
          type: 'llm_plan',
          taskId: task.id,
          step,
          thought,
          skillName,
        })
        const { file: savedSkillPath, normalizedCode } = await saveSkillCode(skillName, code)
        if (!reusedSkill && skillRegistry.enabled) {
          await skillRegistry.saveMetadata({
            skillName,
            thought,
            taskGoal: task.goal,
            tags: ['generated', `step_${step}`],
          })
        }

        const execution = await runSkillInSandbox({
          code: normalizedCode,
          ctx,
          api,
          timeoutMs: Math.max(1, hardTimeoutMs - (Date.now() - startedAt)),
          filename: savedSkillPath,
        })

        const record = {
          stage: 'skill_execute',
          step,
          ts: nowIso(),
          thought,
          skillName,
          savedSkillPath,
          execution,
        }
        history.push(record)
        await logger.log({
          type: 'skill_execute',
          taskId: task.id,
          step,
          skillName,
          execution: {
            ok: executionSucceeded(execution),
            status: execution.status || null,
            reason: execution.reason || null,
            error: execution.errorMessage || execution?.details?.error?.message || null,
            logs: Array.isArray(execution?.details?.logs) ? execution.details.logs.slice(-5) : null,
          },
        })

        lastPlan = plan
        lastExecution = execution

        // Process personality event after execution.
        if (personality.isEnabled()) {
          try {
            const pResult = await personality.processEvent(execution, ctx)
            if (pResult) {
              await logger.log({
                type: 'personality_event', taskId: task.id, step, skillName,
                triggered: pResult.triggered, eventType: pResult.taggedEvent?.type,
                voice: pResult.voice || null,
                emotionalTags: pResult.emotionalTags || [],
                urgencyOverride: pResult.urgencyOverride || false,
                error: pResult.error || null,
              })
            }
          } catch {
            // Personality must never break the main loop.
          }
        }

        if (!executionSucceeded(execution)) {
          lastPlan = null
          lastExecution = null
          const fallbackName = reusedSkill?.meta?.fallbackSkill
            ?? (skillRegistry.enabled ? await getFallbackSkillName(skillRegistry, skillName) : null)
          if (fallbackName) {
            const fbExecution = await runFallbackSkill({
              fallbackName, ctx, api, logger, task, step, startedAt, hardTimeoutMs, history,
            })
            if (fbExecution && executionSucceeded(fbExecution)) {
              const fbDone = executionDone(fbExecution)
              if (fbDone) {
                finalState = 'succeeded'
                const steps = buildStepSummaries(history)
                return {
                  ok: true, state: finalState, failureCode: null, taskId: task.id,
                  finishedAt: nowIso(), elapsedMs: Date.now() - startedAt,
                  summary: buildSummaryFromSteps(steps), steps, history,
                }
              }
            }
          }
          continue
        }

        // Stuck detection: only meaningful when skill says "not done yet".
        const skillDone = executionDone(execution)
        const stuckResult = stuckDetector.checkStuck(step, skillDone)
        if (stuckResult.stuck) {
          history.push({
            stage: 'stuck_detected', step, ts: nowIso(),
            tag: stuckResult.tag, delta: stuckResult.delta, pos: stuckResult.pos,
          })
          await stuckDetector.writeFingerprint({
            step, skillName, tag: stuckResult.tag, pos: stuckResult.pos,
            snapshotFeatures: {
              threat_level: snapshot.threat_level,
              health: snapshot.status?.health,
              food: snapshot.status?.food,
              hasLava: snapshot.obstacles?.lava ? 1 : 0,
              hasWater: snapshot.obstacles?.water ? 1 : 0,
              hasCliff: snapshot.obstacles?.cliff ? 1 : 0,
            },
          })
          await logger.log({
            type: 'stuck_detected', taskId: task.id, step, skillName,
            tag: stuckResult.tag, delta: stuckResult.delta, pos: stuckResult.pos,
          })
        }

        const done = executionDone(execution)
        if (done) {
          finalState = 'succeeded'
          const steps = buildStepSummaries(history)
          return {
            ok: true,
            state: finalState,
            failureCode: null,
            taskId: task.id,
            finishedAt: nowIso(),
            elapsedMs: Date.now() - startedAt,
            summary: buildSummaryFromSteps(steps),
            steps,
            history,
          }
        }
      }
    }

    try {
      return await withTimeout(runLoop(), hardTimeoutMs)
    } catch (err) {
      finalError = serializeError(err)
      finalState = mapErrorToState(err)
      const steps = buildStepSummaries(history)
      return {
        ok: false,
        state: finalState,
        failureCode: classifyFailureCode(err),
        taskId: task.id,
        finishedAt: nowIso(),
        elapsedMs: Date.now() - startedAt,
        summary: buildSummaryFromSteps(steps),
        steps,
        error: finalError,
        history,
      }
    } finally {
      isExecutionLocked = false
      const finalSteps = buildStepSummaries(history)
      const finalSummary = buildSummaryFromSteps(finalSteps)
      const finalFailureCode = finalError ? classifyFailureCode(finalError) : null

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            type: 'task_result',
            taskId: task.id,
            ok: finalState === 'succeeded',
            state: finalState,
            failureCode: finalFailureCode,
            summary: finalSummary,
            elapsedMs: Date.now() - startedAt,
          },
          null,
          2
        )
      )
      const reuseSummary = {
        hitsTotal: reuseCounts.hits,
        missTotal: reuseCounts.misses,
        sourceDistribution: { ...reuseCounts.sourceMap },
      }
      const personalitySummary = personality.isEnabled()
        ? { ...personality.getSummary(), lastVoice: personality.getState().voice || null }
        : null
      await logger.log({
        type: 'task_end',
        taskId: task.id,
        state: finalState,
        failureCode: finalFailureCode,
        summary: finalSummary,
        steps: finalSteps,
        reuseSummary,
        personalitySummary,
        elapsedMs: Date.now() - startedAt,
        error: finalError,
      })
      await logger.close()
    }
  }

  return Object.freeze({
    runTask,
  })
}

module.exports = { createEngine }

