const { validateLLMResponse } = require('./types')
const { parseJsonLoose } = require('./json')
const { buildSystemPrompt, buildUserPayload } = require('./prompt')

/**
 * Google Gemini API client.
 *
 * Uses the Gemini REST API (generateContent endpoint).
 * Env: GEMINI_API_KEY, GEMINI_MODEL, GEMINI_BASE_URL
 */
function createGeminiLLMClient({
  apiKey,
  model = 'gemini-2.5-flash',
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  timeoutMs = 15_000,
}) {
  if (!apiKey) throw new Error('Gemini apiKey is required')

  return Object.freeze({
    name: 'gemini',
    async plan({ ctx, history, _systemPromptOverride, _userPayloadOverride, _skipValidation }) {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const systemContent = _systemPromptOverride
          || buildSystemPrompt({ mode: process.env.LLM_PROMPT_MODE || 'default' })
        const userContent = _userPayloadOverride
          || buildUserPayload({ ctx, history })

        const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`

        const body = {
          systemInstruction: {
            parts: [{ text: systemContent }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userContent }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 3000,
            responseMimeType: 'application/json',
          },
        }

        let res
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
        } catch (fetchErr) {
          const isAbort = fetchErr?.name === 'AbortError'
          throw new Error(
            `Gemini fetch failed: ${isAbort ? `timeout after ${timeoutMs}ms` : fetchErr.message}`
            + ` (model=${model})`
          )
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`Gemini error: HTTP ${res.status} ${text.slice(0, 500)}`)
        }

        const json = await res.json()
        const content = json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!content) {
          const reason = json?.candidates?.[0]?.finishReason || 'no_content'
          throw new Error(`Gemini empty response: finishReason=${reason}`)
        }
        let parsed
        try {
          parsed = parseJsonLoose(content)
        } catch (parseErr) {
          throw new Error(
            `${parseErr.message} (model=${model}, raw=${content.slice(0, 300)})`
          )
        }
        if (_skipValidation) return parsed
        return validateLLMResponse(parsed)
      } finally {
        clearTimeout(t)
      }
    },
  })
}

module.exports = { createGeminiLLMClient }
