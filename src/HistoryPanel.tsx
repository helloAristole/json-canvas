import { History, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { tokenizeJsonPreview } from './jsonHighlight'
import {
  formatHistoryHoverPreview,
  formatHistoryTime,
  historyPreview,
  type JsonHistoryEntry,
} from './jsonHistory'

function highlightedJson(text: string) {
  return tokenizeJsonPreview(text).map((token, index) =>
    token.className ? (
      <span className={token.className} key={index}>
        {token.text}
      </span>
    ) : (
      token.text
    ),
  )
}

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
  const [hovered, setHovered] = useState<JsonHistoryEntry | null>(null)
  const hideTimer = useRef(0)

  const show = (entry: JsonHistoryEntry) => {
    window.clearTimeout(hideTimer.current)
    setHovered(entry)
  }

  const hideSoon = () => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setHovered(null), 120)
  }

  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  const previewTokens = useMemo(
    () =>
      hovered ? highlightedJson(formatHistoryHoverPreview(hovered.source)) : null,
    [hovered],
  )

  return (
    <div aria-label="JSON 历史记录" className="history-panel" role="dialog">
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
        <>
          <ul onMouseLeave={hideSoon}>
            {entries.map((entry) => (
              <li key={entry.id} onMouseEnter={() => show(entry)}>
                <button
                  className={`history-entry ${
                    hovered?.id === entry.id ? 'is-previewed' : ''
                  }`}
                  onClick={() => onRestore(entry)}
                  title="恢复为新标签页"
                  type="button"
                >
                  <span className="history-entry-meta">
                    <b>{entry.documentName}</b>
                    <small>{formatHistoryTime(entry.savedAt)}</small>
                  </span>
                  <code>{highlightedJson(historyPreview(entry.source))}</code>
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
          {hovered ? (
            <aside
              className="history-preview"
              onMouseEnter={() => show(hovered)}
              onMouseLeave={hideSoon}
            >
              <header>
                <strong title={hovered.documentName}>{hovered.documentName}</strong>
                <small>{formatHistoryTime(hovered.savedAt)}</small>
              </header>
              <pre>{previewTokens}</pre>
            </aside>
          ) : null}
        </>
      )}
    </div>
  )
}
