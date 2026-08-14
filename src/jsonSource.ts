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

  const skipWhitespace = () => {
    while (index < source.length && /\s/.test(source[index])) index += 1
  }

  const parseString = (): { value: string; from: number; to: number } => {
    const from = index
    index += 1

    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2
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
      // The caller only invokes this for valid JSON; retain the raw key as fallback.
    }
    return { value, from, to: index }
  }

  const parseValue = (path: JsonPath): ParsedValueRange => {
    skipWhitespace()
    const from = index
    const token = source[index]
    const isContainer = token === '{' || token === '['

    if (token === '{') {
      index += 1
      skipWhitespace()

      while (index < source.length && source[index] !== '}') {
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
      }

      if (source[index] === '}') index += 1
    } else if (token === '[') {
      index += 1
      skipWhitespace()
      let itemIndex = 0

      while (index < source.length && source[index] !== ']') {
        parseValue([...path, itemIndex])
        itemIndex += 1
        skipWhitespace()
        if (source[index] === ',') {
          index += 1
          skipWhitespace()
        }
      }

      if (source[index] === ']') index += 1
    } else if (token === '"') {
      parseString()
    } else {
      while (
        index < source.length &&
        !/[\s,\]}]/.test(source[index])
      ) {
        index += 1
      }
    }

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

export function locateJsonPath(
  source: string,
  targetPath: JsonPath,
  includeProperty = false,
): SourceRange | null {
  const match = parseJsonRanges(source).find((range) =>
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
  const matches = parseJsonRanges(source)
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
