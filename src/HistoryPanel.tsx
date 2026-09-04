import { History, X } from 'lucide-react'
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  formatHistoryHoverPreview,
  formatHistoryTime,
  historyPreview,
  type JsonHistoryEntry,
} from './jsonHistory'

export function HistoryPanel({
  entries,
  onClose,
  onDelete,
  onRestore,
}: {
  entries: JsonHistoryEntry[]
  onClose: () => void
  onDelete: (id: string) => void
  onRestore: (entry: JsonHistoryEntry) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [previewStyle, setPreviewStyle] = useState<CSSProperties>({
    left: 0,
    top: 0,
  })
  const panelRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const hoveredRectRef = useRef<DOMRect | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const hoveredEntry = hoveredId
    ? (entries.find((entry) => entry.id === hoveredId) ?? null)
    : null

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const openPreview = (
    entryId: string,
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    clearCloseTimer()
    hoveredRectRef.current = event.currentTarget.getBoundingClientRect()
    setHoveredId(entryId)
  }

  const scheduleClosePreview = () => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setHoveredId(null)
      closeTimerRef.current = null
    }, 160)
  }

  useLayoutEffect(() => {
    if (!hoveredEntry || !panelRef.current) return

    const place = () => {
      const panelEl = panelRef.current
      if (!panelEl) return
      const panel = panelEl.getBoundingClientRect()
      const triggerEl = panelEl.querySelector(
        '.history-entry.is-previewed',
      )
      if (triggerEl) {
        hoveredRectRef.current = triggerEl.getBoundingClientRect()
      }
      const trigger = hoveredRectRef.current
      const preview = previewRef.current
      const width = Math.max(preview?.offsetWidth ?? 320, 280)
      const height = preview?.offsetHeight ?? 220
      let left = panel.left - width - 8
      if (left < 8) {
        left = Math.min(window.innerWidth - width - 8, panel.right + 8)
      }
      let top = trigger?.top ?? panel.top
      if (top + height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - height - 8)
      }
      setPreviewStyle({
        left,
        top,
        maxHeight: Math.min(420, window.innerHeight - 16),
      })
    }

    place()
    const list = panelRef.current.querySelector('ul')
    list?.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      list?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [hoveredEntry])

  useLayoutEffect(() => {
    return () => clearCloseTimer()
  }, [])

  return (
    <div
      aria-label="JSON 历史记录"
      className="history-panel"
      ref={panelRef}
      role="dialog"
    >
      <header>
        <strong>
          <History size={12} strokeWidth={2.2} />
          历史记录
        </strong>
        <button aria-label="关闭历史记录" onClick={onClose} type="button">
          <X size={12} />
        </button>
      </header>
      {entries.length === 0 ? (
        <p className="history-empty">编辑有效 JSON 后会自动保存在这里</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                className={`history-entry ${
                  hoveredId === entry.id ? 'is-previewed' : ''
                }`}
                onClick={() => onRestore(entry)}
                onMouseEnter={(event) => openPreview(entry.id, event)}
                onMouseLeave={scheduleClosePreview}
                title="恢复为新标签页"
                type="button"
              >
                <span className="history-entry-meta">
                  <b>{entry.documentName}</b>
                  <small>{formatHistoryTime(entry.savedAt)}</small>
                </span>
                <code>{historyPreview(entry.source)}</code>
              </button>
              <button
                aria-label={`删除 ${entry.documentName} 的这条历史`}
                className="history-entry-delete"
                onClick={() => onDelete(entry.id)}
                title="删除这条历史"
                type="button"
              >
                <X size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {hoveredEntry
        ? createPortal(
            <aside
              className="history-preview"
              onMouseEnter={clearCloseTimer}
              onMouseLeave={scheduleClosePreview}
              ref={previewRef}
              style={previewStyle}
            >
              <header>
                <strong title={hoveredEntry.documentName}>
                  {hoveredEntry.documentName}
                </strong>
                <small>{formatHistoryTime(hoveredEntry.savedAt)}</small>
              </header>
              <pre>{formatHistoryHoverPreview(hoveredEntry.source)}</pre>
            </aside>,
            document.body,
          )
        : null}
    </div>
  )
}