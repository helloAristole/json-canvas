import type { JsonPath } from './json'

export interface SourceRange {
  from: number
  to: number
}

function pathsEqual(left: JsonPath, right: JsonPath): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  )
}

interface ParsedValueRange extends SourceRange {
  path: JsonPath
  propertyFrom?: number
  isContainer: boolean
}

function parseJsonRanges(source: string): ParsedValueRange[] {
  let index = 0
  const ranges: ParsedValueRange[] = []
  const rangeLimit = source.length + 8
  const maxDepth = 256

  const skipWhitespace = () => {
    while (index < source.length && /\s/.test(source[index])) index += 1
  }

  const advance = () => {
    if (index < source.length) index += 1
  }

  const parseString = (): { value: string; from: number; to: number } => {
    const from = index
    if (source[index] !== '"') {
      while (index < source.length && !/[\s,:\]}]/.test(source[index])) {
        index += 1
      }
      if (index === from) advance()
      return { value: source.slice(from, index), from, to: index }
    }

    index += 1
    while (index < source.length) {
      if (source[index] === '\\') {
        index = Math.min(index + 2, source.length)
        continue
      }
      if (source[index] === '"') {
        index += 1
        break
      }
      index += 1
    }

    const raw = source.slice(from, index)
    let value = raw.slice(1, -1)
    try {
      value = JSON.parse(raw) as string
    } catch {
      // Invalid JSON may still need a stable key for source mapping.
    }
    return { value, from, to: index }
  }

  const parseValue = (path: JsonPath): ParsedValueRange => {
    skipWhitespace()
    const from = index
    if (
      from >= source.length ||
      ranges.length >= rangeLimit ||
      path.length > maxDepth
    ) {
      if (path.length > maxDepth && index < source.length) {
        let depth = 0
        let inString = false
        let escaped = false
        while (index < source.length) {
          const character = source[index]
          if (inString) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') inString = false
            index += 1
            continue
          }
          if (character === '"') {
            inString = true
            index += 1
            continue
          }
          if (character === '{' || character === '[') depth += 1
          else if (character === '}' || character === ']') {
            if (depth === 0) break
            depth -= 1
          }
          index += 1
        }
      }
      const empty: ParsedValueRange = {
        from,
        to: index,
        path,
        isContainer: false,
      }
      ranges.push(empty)
      return empty
    }

    const token = source[index]
    const isContainer = token === '{' || token === '['

    if (token === '{') {
      index += 1
      skipWhitespace()

      while (index < source.length && source[index] !== '}') {
        const start = index
        const keyToken = parseString()
        const childPath = [...path, keyToken.value]
        skipWhitespace()
        if (source[index] === ':') index += 1
        const childRange = parseValue(childPath)
        childRange.propertyFrom = keyToken.from
        skipWhitespace()
        if (source[index] === ',') {
          index += 1
          skipWhitespace()
        }
        if (index <= start) advance()
        if (ranges.length >= rangeLimit) break
      }

      if (source[index] === '}') index += 1
    } else if (token === '[') {
      index += 1
      skipWhitespace()
      let itemIndex = 0

      while (index < source.length && source[index] !== ']') {
        const start = index
        parseValue([...path, itemIndex])
        itemIndex += 1
        skipWhitespace()
        if (source[index] === ',') {
          index += 1
          skipWhitespace()
        }
        if (index <= start) advance()
        if (ranges.length >= rangeLimit) break
      }

      if (source[index] === ']') index += 1
    } else if (token === '"') {
      parseString()
    } else {
      while (index < source.length && !/[\s,\]}]/.test(source[index])) {
        index += 1
      }
    }

    if (index <= from) advance()

    const range: ParsedValueRange = {
      from,
      to: index,
      path,
      isContainer,
    }
    ranges.push(range)
    return range
  }

  try {
    parseValue([])
    return ranges
  } catch {
    return []
  }
}

let cachedSource: string | null = null
let cachedRanges: ParsedValueRange[] = []

function parseJsonRangesCached(source: string): ParsedValueRange[] {
  if (cachedSource === source) return cachedRanges
  cachedSource = source
  cachedRanges = parseJsonRanges(source)
  return cachedRanges
}

export function locateJsonPath(
  source: string,
  targetPath: JsonPath,
  includeProperty = false,
): SourceRange | null {
  const match = parseJsonRangesCached(source).find((range) =>
    pathsEqual(range.path, targetPath),
  )
  if (!match) return null

  return {
    from: includeProperty ? (match.propertyFrom ?? match.from) : match.from,
    to: match.to,
  }
}

export interface JsonSourceLocation extends SourceRange {
  path: JsonPath
  isContainer: boolean
}

export function findJsonPathAtOffset(
  source: string,
  offset: number,
): JsonSourceLocation | null {
  const matches = parseJsonRangesCached(source)
    .filter((range) => {
      const from = range.propertyFrom ?? range.from
      return offset >= from && offset < range.to
    })
    .sort((left, right) => {
      if (right.path.length !== left.path.length) {
        return right.path.length - left.path.length
      }
      return left.to - left.from - (right.to - right.from)
    })

  const match = matches[0]
  if (!match) return null
  return {
    from: match.propertyFrom ?? match.from,
    to: match.to,
    path: match.path,
    isContainer: match.isContainer,
  }
}
