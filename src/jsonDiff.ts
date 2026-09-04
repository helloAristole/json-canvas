import {
  formatPath,
  isContainer,
  isJsonObject,
  type JsonPath,
  type JsonValue,
} from './json'

export type JsonDiffKind = 'added' | 'removed' | 'changed'

export interface JsonDiffEntry {
  kind: JsonDiffKind
  leftText: string | null
  path: JsonPath
  pathLabel: string
  rightText: string | null
}

export const MAX_COMPARE_LINES = 1200

function previewValue(value: JsonValue): string {
  if (value === null) return 'null'
  if (isContainer(value)) {
    return Array.isArray(value)
      ? `[${value.length} items]`
      : `{${Object.keys(value).length} keys}`
  }
  const text = String(value)
  return text.length <= 48 ? text : `${text.slice(0, 47)}…`
}

function childEntries(
  value: JsonValue,
): Array<[string | number, JsonValue]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => [index, item])
  }
  if (isJsonObject(value)) return Object.entries(value)
  return []
}

function valuesEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function parseJsonDocument(source: string): JsonValue | null {
  const trimmed = source.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed) as JsonValue
  } catch {
    return null
  }
}

export function diffJson(
  left: JsonValue,
  right: JsonValue,
): JsonDiffEntry[] {
  const diffs: JsonDiffEntry[] = []

  const visit = (leftValue: JsonValue | undefined, rightValue: JsonValue | undefined, path: JsonPath) => {
    if (leftValue === undefined && rightValue === undefined) return

    if (leftValue === undefined) {
      diffs.push({
        kind: 'added',
        path,
        pathLabel: formatPath(path),
        leftText: null,
        rightText: previewValue(rightValue as JsonValue),
      })
      return
    }

    if (rightValue === undefined) {
      diffs.push({
        kind: 'removed',
        path,
        pathLabel: formatPath(path),
        leftText: previewValue(leftValue),
        rightText: null,
      })
      return
    }

    const leftContainer = isContainer(leftValue)
    const rightContainer = isContainer(rightValue)
    if (leftContainer && rightContainer && Array.isArray(leftValue) === Array.isArray(rightValue)) {
      const leftMap = new Map(childEntries(leftValue))
      const rightMap = new Map(childEntries(rightValue))
      const keys = new Set([...leftMap.keys(), ...rightMap.keys()])
      keys.forEach((key) => {
        visit(leftMap.get(key), rightMap.get(key), [...path, key])
      })
      return
    }

    if (!valuesEqual(leftValue, rightValue)) {
      diffs.push({
        kind: 'changed',
        path,
        pathLabel: formatPath(path),
        leftText: previewValue(leftValue),
        rightText: previewValue(rightValue),
      })
    }
  }

  visit(left, right, [])
  return diffs
}

export function diffKindByPath(
  diffs: JsonDiffEntry[],
): Map<string, Exclude<JsonDiffKind, 'removed'>> {
  const map = new Map<string, Exclude<JsonDiffKind, 'removed'>>()
  diffs.forEach((entry) => {
    if (entry.kind === 'removed') return
    map.set(formatPath(entry.path), entry.kind)
  })
  return map
}

export type CompareLineKind = 'same' | 'added' | 'removed' | 'changed'

export interface CompareLine {
  depth: number
  keyLabel: string | null
  kind: CompareLineKind
  left: string | null
  path: JsonPath
  right: string | null
}

function formatLeaf(value: JsonValue): string {
  if (typeof value === 'string') {
    const text = JSON.stringify(value)
    return text.length <= 96 ? text : `${text.slice(0, 95)}…`
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return compactPreview(value)
}

function compactPreview(value: JsonValue): string {
  if (!isContainer(value)) return formatLeaf(value)
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.length}]`
  const count = Object.keys(value).length
  return count === 0 ? '{}' : `{${count}}`
}

function formatKeyLabel(key: string | number): string {
  return typeof key === 'number' ? String(key) : JSON.stringify(key)
}

function unionChildKeys(left: JsonValue, right: JsonValue): Array<string | number> {
  const leftKeys = childEntries(left).map(([key]) => key)
  const rightKeys = childEntries(right).map(([key]) => key)
  const seen = new Set(leftKeys)
  const keys = [...leftKeys]
  rightKeys.forEach((key) => {
    if (seen.has(key)) return
    seen.add(key)
    keys.push(key)
  })
  return keys
}

function pushLine(
  lines: CompareLine[],
  line: CompareLine,
): boolean {
  if (lines.length >= MAX_COMPARE_LINES) return false
  lines.push(line)
  return true
}

function dumpSide(
  value: JsonValue,
  path: JsonPath,
  depth: number,
  keyLabel: string | null,
  side: 'left' | 'right',
  kind: 'added' | 'removed',
  lines: CompareLine[],
): void {
  const token = (text: string): CompareLine => ({
    depth,
    keyLabel,
    kind,
    left: side === 'left' ? text : null,
    path,
    right: side === 'right' ? text : null,
  })

  if (!isContainer(value) || compactPreview(value) === '[]' || compactPreview(value) === '{}') {
    pushLine(lines, token(formatLeaf(value)))
    return
  }

  const open = Array.isArray(value) ? '[' : '{'
  const close = Array.isArray(value) ? ']' : '}'
  if (!pushLine(lines, token(open))) return

  childEntries(value).forEach(([key, child]) => {
    dumpSide(child, [...path, key], depth + 1, formatKeyLabel(key), side, kind, lines)
  })

  pushLine(lines, {
    depth,
    keyLabel: null,
    kind,
    left: side === 'left' ? close : null,
    path,
    right: side === 'right' ? close : null,
  })
}

function visitCompare(
  leftValue: JsonValue | undefined,
  rightValue: JsonValue | undefined,
  path: JsonPath,
  depth: number,
  keyLabel: string | null,
  lines: CompareLine[],
): void {
  if (lines.length >= MAX_COMPARE_LINES) return

  if (leftValue === undefined && rightValue !== undefined) {
    dumpSide(rightValue, path, depth, keyLabel, 'right', 'added', lines)
    return
  }
  if (rightValue === undefined && leftValue !== undefined) {
    dumpSide(leftValue, path, depth, keyLabel, 'left', 'removed', lines)
    return
  }
  if (leftValue === undefined || rightValue === undefined) return

  const leftContainer = isContainer(leftValue)
  const rightContainer = isContainer(rightValue)
  if (leftContainer && rightContainer && Array.isArray(leftValue) === Array.isArray(rightValue)) {
    if (valuesEqual(leftValue, rightValue)) {
      pushLine(lines, {
        depth,
        keyLabel,
        kind: 'same',
        left: compactPreview(leftValue),
        path,
        right: compactPreview(rightValue),
      })
      return
    }

    const open = Array.isArray(leftValue) ? '[' : '{'
    const close = Array.isArray(leftValue) ? ']' : '}'
    pushLine(lines, {
      depth,
      keyLabel,
      kind: 'same',
      left: open,
      path,
      right: open,
    })
    const leftMap = new Map(childEntries(leftValue))
    const rightMap = new Map(childEntries(rightValue))
    unionChildKeys(leftValue, rightValue).forEach((key) => {
      visitCompare(
        leftMap.get(key),
        rightMap.get(key),
        [...path, key],
        depth + 1,
        formatKeyLabel(key),
        lines,
      )
    })
    pushLine(lines, {
      depth,
      keyLabel: null,
      kind: 'same',
      left: close,
      path,
      right: close,
    })
    return
  }

  pushLine(lines, {
    depth,
    keyLabel,
    kind: valuesEqual(leftValue, rightValue) ? 'same' : 'changed',
    left: formatLeaf(leftValue),
    path,
    right: formatLeaf(rightValue),
  })
}

export function buildCompareLines(
  left: JsonValue,
  right: JsonValue,
): CompareLine[] {
  const lines: CompareLine[] = []
  visitCompare(left, right, [], 0, null, lines)
  return lines
}
