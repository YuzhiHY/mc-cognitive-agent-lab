const { validateLLMResponse } = require('./types')
const { parseJsonLoose } = require('./json')
const { buildSystemPrompt, buildUserPayload } = require('./prompt')

/**
 * Generic OpenAI-compatible API client.
 *
 * Works with any third-party API that follows the OpenAI chat completions format:
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer {apiKey}
 *   Body: { model, messages, temperature, response_format }
 *
 * Compatible with: OpenRouter, Together AI, Groq, Mistral, vLLM, Ollama, LM Studio,
 * and any other OpenAI-compatible endpoint.
 *
 * Env: CUSTOM_LLM_API_KEY, CUSTOM_LLM_MODEL, CUSTOM_LLM_BASE_URL
 */
function createCustomLLMClient({
  apiKey,
  model = 'default',
  baseUrl,
  timeoutMs = 15_000,
}) {
  if (!baseUrl) throw new Error('Custom LLM baseUrl is required (set CUSTOM_LLM_BASE_URL)')

  return Object.freeze({
    name: 'custom',
    async plan({ ctx, history, _systemPromptOverride, _userPayloadOverride, _skipValidation }) {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const basePrompt = _systemPromptOverride
          || buildSystemPrompt({ mode: process.env.LLM_PROMPT_MODE || 'default' })
        const systemContent = `${basePrompt} Output must be json.`
        const userContent = _userPayloadOverride
          || buildUserPayload({ ctx, history })

        const headers = { 'content-type': 'application/json' }
        if (apiKey) {
          headers.authorization = `Bearer ${apiKey}`
        }

        const bodyPayload = {
          model,
          temperature: 0.2,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
        }

        let res
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyPayload),
            signal: controller.signal,
          })
        } catch (fetchErr) {
          const isAbort = fetchErr?.name === 'AbortError'
          const inputTokenEstimate = Math.ceil((systemContent.length + userContent.length) / 3.5)
          throw new Error(
            `Custom LLM fetch failed: ${isAbort ? `timeout after ${timeoutMs}ms` : fetchErr.message}`
            + ` (baseUrl=${baseUrl}, model=${model}, est_input_tokens=${inputTokenEstimate})`
          )
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`Custom LLM error: HTTP ${res.status} ${text.slice(0, 500)}`)
        }

        const json = await res.json()
        const content = json?.choices?.[0]?.message?.content
        if (!content) {
          throw new Error(`Custom LLM empty response (model=${model})`)
        }
        const parsed = parseJsonLoose(content)
        if (_skipValidation) return parsed
        return validateLLMResponse(parsed)
      } finally {
        clearTimeout(t)
      }
    },
  })
}

module.exports = { createCustomLLMClient }
