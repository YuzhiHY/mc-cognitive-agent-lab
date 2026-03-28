const { validateLLMResponse } = require('./types')
const { parseJsonLoose } = require('./json')
const { buildSystemPrompt, buildUserPayload } = require('./prompt')

function createDeepSeekLLMClient({
  apiKey,
  model = 'deepseek-chat',
  baseUrl = 'https://api.deepseek.com',
  timeoutMs = 15_000,
}) {
  if (!apiKey) throw new Error('DeepSeek apiKey is required')

  return Object.freeze({
    name: 'deepseek',
    async plan({ ctx, history, _systemPromptOverride, _userPayloadOverride, _skipValidation }) {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const basePrompt = _systemPromptOverride
          || buildSystemPrompt({ mode: process.env.LLM_PROMPT_MODE || 'default' })
        const systemContent = `${basePrompt} Output must be json.`
        const userContent = _userPayloadOverride
          || buildUserPayload({ ctx, history })

        const bodyPayload = {
          model,
          temperature: 0.2,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent },
          ],
        }

        let res
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(bodyPayload),
            signal: controller.signal,
          })
        } catch (fetchErr) {
          // Network / abort errors — log details for diagnosis
          const isAbort = fetchErr?.name === 'AbortError'
          const inputTokenEstimate = Math.ceil((systemContent.length + userContent.length) / 3.5)
          throw new Error(
            `DeepSeek fetch failed: ${isAbort ? `timeout after ${timeoutMs}ms` : fetchErr.message}`
            + ` (model=${model}, est_input_tokens=${inputTokenEstimate})`
          )
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`DeepSeek error: HTTP ${res.status} ${text.slice(0, 500)}`)
        }

        const json = await res.json()
        const content = json?.choices?.[0]?.message?.content
        const parsed = parseJsonLoose(content)
        if (_skipValidation) return parsed
        return validateLLMResponse(parsed)
      } finally {
        clearTimeout(t)
      }
    },
  })
}

module.exports = { createDeepSeekLLMClient }

