import { History, X } from 'lucide-react'
import {
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
  return (
    <div
      aria-label="JSON 历史记录"
      className="history-panel"
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
                className="history-entry"
                onClick={() => onRestore(entry)}
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
    </div>
  )
}
