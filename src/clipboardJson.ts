import type { JsonValue } from './json'

export interface ClipboardJson {
  extracted: boolean
  pretty: boolean
  source: string
  value: JsonValue
}

function tryParse(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function stripMarkdownFences(text: string): string {
  return text.replace(/```(?:jsonc?)?[^\n]*\n?([\s\S]*?)```/gi, '$1')
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function normalizeQuotes(text: string): string {
  return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1')
}

function maybeDecodeUri(text: string): string | null {
  if (!/%7[bBdD]/i.test(text) && !/%5[bBdD]/i.test(text)) return null
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

function extractJsonFragments(text: string): string[] {
  let best: string | null = null
  const stack: number[] = []
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') inString = false
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{' || character === '[') {
      stack.push(index)
      continue
    }
    if (character !== '}' && character !== ']') continue

    const start = stack.pop()
    if (start === undefined) continue
    const opener = text[start]
    const matched =
      (opener === '{' && character === '}') ||
      (opener === '[' && character === ']')
    if (!matched) continue

    const fragment = text.slice(start, index + 1)
    if (!best || fragment.length > best.length) best = fragment
  }

  return best ? [best] : []
}

function parseCandidate(text: string): ClipboardJson | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const direct = tryParse(trimmed)
  if (direct !== undefined) {
    return { extracted: false, pretty: false, source: trimmed, value: direct }
  }

  const repaired = tryParse(stripTrailingCommas(trimmed))
  if (repaired !== undefined) {
    return {
      extracted: false,
      pretty: true,
      source: JSON.stringify(repaired, null, 2),
      value: repaired,
    }
  }

  return null
}

function unwrapEncodedJson(value: JsonValue, source: string, extracted: boolean): ClipboardJson {
  let currentValue = value
  let currentSource = source
  let pretty = false
  let unwrapped = extracted
  let unwraps = 0

  while (typeof currentValue === 'string' && unwraps < 8) {
    unwraps += 1
    const innerText = currentValue.trim()
    if (!innerText) break
    const inner = parseCandidate(innerText)
    if (!inner) break
    currentValue = inner.value
    currentSource = inner.source
    pretty = inner.pretty || innerText !== inner.source
    unwrapped = true
  }

  return { extracted: unwrapped, pretty, source: currentSource, value: currentValue }
}

function bestParsed(texts: string[]): ClipboardJson | null {
  let best: ClipboardJson | null = null

  for (const text of texts) {
    const parsed = parseCandidate(text)
    if (!parsed) continue
    const unwrapped = unwrapEncodedJson(parsed.value, parsed.source, parsed.extracted)
    if (
      !best ||
      unwrapped.source.length > best.source.length ||
      (unwrapped.source.length === best.source.length && !unwrapped.pretty && best.pretty)
    ) {
      best = unwrapped
    }
  }

  return best
}

export function parseClipboardJson(raw: string): ClipboardJson | null {
  const trimmed = stripBom(raw).trim()
  if (!trimmed) return null

  const decodedUri = maybeDecodeUri(trimmed)
  const variants = [
    trimmed,
    stripMarkdownFences(trimmed),
    decodeHtmlEntities(trimmed),
    normalizeQuotes(trimmed),
    decodedUri,
  ].filter((value): value is string => Boolean(value))

  const uniqueVariants = [...new Set(variants.map((value) => value.trim()))]
  const whole = bestParsed(uniqueVariants)
  if (whole) return whole

  const extracted = bestParsed(
    uniqueVariants.flatMap((value) => extractJsonFragments(value)),
  )
  if (!extracted) return null

  return {
    extracted: true,
    pretty: true,
    source: JSON.stringify(extracted.value, null, 2),
    value: extracted.value,
  }
}
