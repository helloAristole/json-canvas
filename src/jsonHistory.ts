export interface JsonHistoryEntry {
  documentId: string
  documentName: string
  id: string
  savedAt: number
  source: string
}

const HISTORY_KEY = 'json-canvas-history-v1'
const MAX_ENTRIES = 24
const MAX_SOURCE_CHARS = 250_000

function isHistoryEntry(value: unknown): value is JsonHistoryEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<JsonHistoryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.documentId === 'string' &&
    typeof entry.documentName === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.savedAt === 'number'
  )
}

function historyFingerprint(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source))
  } catch {
    return source.trim()
  }
}

function compactHistory(entries: JsonHistoryEntry[]): JsonHistoryEntry[] {
  const latestByFingerprint = new Map<string, JsonHistoryEntry>()
  const order: string[] = []

  for (const entry of entries) {
    const fingerprint = historyFingerprint(entry.source)
    const current = latestByFingerprint.get(fingerprint)
    if (!current) {
      latestByFingerprint.set(fingerprint, entry)
      order.push(fingerprint)
      continue
    }
    if (entry.savedAt >= current.savedAt) {
      latestByFingerprint.set(fingerprint, {
        ...entry,
        id: current.id,
      })
    }
  }

  return order.map((fingerprint) => latestByFingerprint.get(fingerprint)!)
}

function persistHistory(entries: JsonHistoryEntry[]): JsonHistoryEntry[] {
  const trimmed = compactHistory(entries).slice(0, MAX_ENTRIES)
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed))
    return trimmed
  } catch {
    if (trimmed.length <= 1) return trimmed
    return persistHistory(trimmed.slice(0, Math.max(1, Math.floor(trimmed.length / 2))))
  }
}

export function loadHistory(): JsonHistoryEntry[] {
  try {
    const saved = window.localStorage.getItem(HISTORY_KEY)
    if (!saved) return []
    const parsed = JSON.parse(saved) as unknown
    if (!Array.isArray(parsed)) return []
    const entries = parsed.filter(isHistoryEntry)
    const compacted = compactHistory(entries)
    if (compacted.length !== entries.length) persistHistory(compacted)
    return compacted
  } catch {
    return []
  }
}

export function pushHistory(input: {
  documentId: string
  documentName: string
  source: string
}): JsonHistoryEntry[] {
  const source = input.source.trim() ? input.source : '{}'
  if (source.length > MAX_SOURCE_CHARS) return loadHistory()

  const fingerprint = historyFingerprint(source)
  const current = loadHistory()
  const duplicate = current.find(
    (entry) => historyFingerprint(entry.source) === fingerprint,
  )
  const nextEntry: JsonHistoryEntry = {
    id:
      duplicate?.id ??
      `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    documentId: input.documentId,
    documentName: input.documentName.trim() || duplicate?.documentName || 'Untitled',
    source,
    savedAt: Date.now(),
  }

  return persistHistory([
    nextEntry,
    ...current.filter((entry) => entry.id !== nextEntry.id),
  ])
}

export function removeHistory(id: string): JsonHistoryEntry[] {
  return persistHistory(loadHistory().filter((entry) => entry.id !== id))
}

export function historyPreview(source: string): string {
  const compact = source.replace(/\s+/g, ' ').trim() || '{}'
  return compact.length <= 72 ? compact : `${compact.slice(0, 71)}…`
}

const MAX_HOVER_PREVIEW_CHARS = 6000

export function formatHistoryHoverPreview(source: string): string {
  const trimmed = source.trim() || '{}'
  let text = trimmed
  try {
    text = JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    // Keep the raw snapshot when it is not valid JSON.
  }
  if (text.length <= MAX_HOVER_PREVIEW_CHARS) return text
  return `${text.slice(0, MAX_HOVER_PREVIEW_CHARS)}\n…`
}

export function formatHistoryTime(savedAt: number, now = Date.now()): string {
  const delta = Math.max(0, now - savedAt)
  if (delta < 45_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`
  if (delta < 22 * 3_600_000) return `${Math.round(delta / 3_600_000)} 小时前`

  const date = new Date(savedAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (savedAt >= startOfToday.getTime()) return `今天 ${clock}`
  if (savedAt >= startOfToday.getTime() - 86_400_000) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}
