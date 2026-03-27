function extractFirstJsonObject(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') depth--

    if (depth === 0) {
      return text.slice(start, i + 1)
    }
  }

  return null
}

function parseJsonLoose(raw) {
  if (raw == null) throw new Error('Empty LLM response')
  if (typeof raw === 'object') return raw
  const s = String(raw).trim()
  if (!s) throw new Error('Empty LLM response')

  try {
    return JSON.parse(s)
  } catch {
    const extracted = extractFirstJsonObject(s)
    if (!extracted) throw new Error('LLM response is not valid JSON')
    return JSON.parse(extracted)
  }
}

module.exports = { parseJsonLoose }

