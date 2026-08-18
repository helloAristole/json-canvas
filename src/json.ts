export type JsonPrimitive = string | number | boolean | null
export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonPath = Array<string | number>
export type JsonValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export const SAMPLE_JSON: JsonValue = {
  project: 'JSON Canvas',
  version: 1,
  active: true,
  owner: {
    name: '祝许浩',
    role: 'Software engineer',
  },
  features: [
    {
      name: '实时预览',
      ready: true,
    },
    {
      name: '可视化编辑',
      ready: true,
    },
    {
      name: '导入与导出',
      ready: false,
    },
  ],
  settings: {
    theme: 'system',
    autosave: true,
    maxDepth: null,
  },
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isContainer(value: JsonValue): value is JsonObject | JsonValue[] {
  return Array.isArray(value) || isJsonObject(value)
}

export function getValueType(value: JsonValue): JsonValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value as Exclude<JsonValueType, 'null' | 'array' | 'object'>
}

export function parentCardPath(path: JsonPath): JsonPath | null {
  if (path.length === 0) return null
  if (typeof path[path.length - 1] === 'number') {
    return path.length <= 1 ? [] : path.slice(0, -2)
  }
  return path.slice(0, -1)
}

export function pathCardTitle(path: JsonPath): string {
  if (path.length === 0) return '根节点'
  const last = path[path.length - 1]
  if (typeof last === 'number') {
    const parentKey = path[path.length - 2]
    return typeof parentKey === 'string' ? `${parentKey}[${last}]` : `[${last}]`
  }
  return last
}

export function pathToId(path: JsonPath): string {
  if (path.length === 0) return 'json-root'
  return `json-${path
    .map((part) =>
      typeof part === 'number'
        ? `i-${part}`
        : `k-${encodeURIComponent(part).replaceAll('%', '_')}`,
    )
    .join('--')}`
}

export function copyKeyForPath(path: JsonPath, fallback = '$'): string {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const part = path[index]
    if (typeof part === 'string') return part
  }
  return fallback
}

export function formatPath(path: JsonPath): string {
  if (path.length === 0) return '$'

  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${part}]`
    if (/^[A-Za-z_$][\w$]*$/.test(part)) return `${result}.${part}`
    return `${result}[${JSON.stringify(part)}]`
  }, '$')
}

export function getAtPath(root: JsonValue, path: JsonPath): JsonValue {
  return path.reduce<JsonValue>((current, part) => {
    if (Array.isArray(current) && typeof part === 'number') return current[part]
    if (isJsonObject(current) && typeof part === 'string') return current[part]
    throw new Error(`Invalid JSON path: ${formatPath(path)}`)
  }, root)
}

export function updateAtPath(
  root: JsonValue,
  path: JsonPath,
  update: (current: JsonValue) => JsonValue,
): JsonValue {
  if (path.length === 0) return update(root)

  const [part, ...rest] = path

  if (Array.isArray(root) && typeof part === 'number') {
    const copy = [...root]
    copy[part] = updateAtPath(copy[part], rest, update)
    return copy
  }

  if (isJsonObject(root) && typeof part === 'string') {
    return {
      ...root,
      [part]: updateAtPath(root[part], rest, update),
    }
  }

  return root
}

export function deleteAtPath(root: JsonValue, path: JsonPath): JsonValue {
  if (path.length === 0) return null

  const parentPath = path.slice(0, -1)
  const key = path[path.length - 1]

  return updateAtPath(root, parentPath, (parent) => {
    if (Array.isArray(parent) && typeof key === 'number') {
      const copy = [...parent]
      copy.splice(key, 1)
      return copy
    }

    if (isJsonObject(parent) && typeof key === 'string') {
      const copy = { ...parent }
      delete copy[key]
      return copy
    }

    return parent
  })
}

export function renameObjectKey(
  root: JsonValue,
  path: JsonPath,
  nextKey: string,
): JsonValue {
  if (path.length === 0 || !nextKey.trim()) return root

  const parentPath = path.slice(0, -1)
  const previousKey = path[path.length - 1]
  if (typeof previousKey !== 'string' || previousKey === nextKey) return root

  return updateAtPath(root, parentPath, (parent) => {
    if (!isJsonObject(parent) || Object.hasOwn(parent, nextKey)) return parent

    const renamed: JsonObject = {}
    Object.entries(parent).forEach(([key, value]) => {
      renamed[key === previousKey ? nextKey : key] = value
    })
    return renamed
  })
}

export function addValueAtPath(root: JsonValue, path: JsonPath): JsonValue {
  return updateAtPath(root, path, (container) => {
    if (Array.isArray(container)) return [...container, null]
    if (!isJsonObject(container)) return container

    let key = 'newField'
    let suffix = 2
    while (Object.hasOwn(container, key)) {
      key = `newField${suffix}`
      suffix += 1
    }
    return { ...container, [key]: null }
  })
}

export function parsePrimitiveDraft(
  draft: string,
  type: JsonValueType,
): JsonPrimitive {
  switch (type) {
    case 'number': {
      const value = Number(draft)
      return Number.isFinite(value) ? value : 0
    }
    case 'boolean':
      return draft === 'true'
    case 'null':
      return null
    default:
      return draft
  }
}

export function primitiveToDraft(value: JsonPrimitive): string {
  if (value === null) return 'null'
  return String(value)
}

export interface JsonStats {
  values: number
  objects: number
  arrays: number
  maxDepth: number
}

export function getJsonStats(value: JsonValue): JsonStats {
  const stats: JsonStats = {
    values: 0,
    objects: 0,
    arrays: 0,
    maxDepth: 0,
  }

  const visit = (current: JsonValue, depth: number) => {
    stats.values += 1
    stats.maxDepth = Math.max(stats.maxDepth, depth)

    if (Array.isArray(current)) {
      stats.arrays += 1
      current.forEach((item) => visit(item, depth + 1))
    } else if (isJsonObject(current)) {
      stats.objects += 1
      Object.values(current).forEach((item) => visit(item, depth + 1))
    }
  }

  visit(value, 0)
  return stats
}

export function getJsonError(error: unknown): string {
  if (!(error instanceof Error)) return 'JSON 格式无效'
  return error.message.replace(/^JSON\.parse:\s*/i, '')
}
