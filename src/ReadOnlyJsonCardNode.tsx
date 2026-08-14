import {
  memo,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Pencil,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  pathToId,
  type JsonPath,
  type JsonPrimitive,
  type JsonValue,
  type JsonValueType,
} from './json'
import type { JsonFlowNode } from './graph'

interface RowContextMenu {
  copyKey: string
  copyValue: string
  path: JsonPath
  type: JsonValueType
  x: number
  y: number
}

interface CopyableRow {
  copyKey: string
  copyValue: string
  path: JsonPath
  type: JsonValueType
}

interface ValueEditorState {
  draft: string
  error: string | null
  keyLabel: string
  path: JsonPath
  type: JsonValueType
}

function parseEditedValue(
  draft: string,
  type: JsonValueType,
): { error: string | null; value?: JsonValue } {
  if (type === 'string') return { error: null, value: draft }
  if (type === 'null') return { error: null, value: null }

  try {
    const value = JSON.parse(draft) as JsonValue
    const valueType =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    if (valueType !== type) {
      return { error: `请输入 ${type} 类型的值` }
    }
    return { error: null, value }
  } catch {
    return { error: 'Value 格式不正确' }
  }
}

function StaticKey({
  label,
  arrayItem = false,
}: {
  label: string
  arrayItem?: boolean
}) {
  return (
    <span className="json-key-cell">
      <span className={`json-row-key ${arrayItem ? 'array-key' : ''}`}>
        {label}
      </span>
      <span className="key-colon">:</span>
    </span>
  )
}

function StaticValue({
  value,
}: {
  value: JsonPrimitive
}) {
  const type = value === null ? 'null' : typeof value
  const text = value === null ? 'null' : String(value)

  return (
    <span className={`json-value value-${type}`} title={text}>
      {text}
    </span>
  )
}

function ReadOnlyJsonCardNodeComponent({ data }: NodeProps<JsonFlowNode>) {
  const {
    title,
    pathLabel,
    path,
    kind,
    tone,
    keyColumnWidth,
    collapsed,
    matched,
    selectionState,
    relationHoverState,
    hoveredSourcePathId,
    primitiveRows,
    containerRows,
    onSelect,
    onCopy,
    onEditValue,
    onToggle,
    onToggleBranch,
  } = data
  const canCollapse = kind === 'object' || kind === 'array'
  const isRoot = path.length === 0
  const [contextMenu, setContextMenu] = useState<RowContextMenu | null>(null)
  const [valueEditor, setValueEditor] = useState<ValueEditorState | null>(null)

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('blur', closeMenu)
    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeMenu)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!valueEditor) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setValueEditor(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [valueEditor])

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    row: CopyableRow,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    onSelect(row.path, path)
    setContextMenu({
      copyKey: row.copyKey,
      copyValue: row.copyValue,
      path: row.path,
      type: row.type,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 156)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 116)),
    })
  }

  const copyContextItem = (kind: 'key' | 'value') => {
    if (!contextMenu) return
    onCopy(
      kind === 'key' ? contextMenu.copyKey : contextMenu.copyValue,
      kind,
    )
    setContextMenu(null)
  }

  const editContextValue = () => {
    if (!contextMenu || contextMenu.type === 'null') return
    setValueEditor({
      draft: contextMenu.copyValue,
      error: null,
      keyLabel: contextMenu.copyKey,
      path: contextMenu.path,
      type: contextMenu.type,
    })
    setContextMenu(null)
  }

  const saveEditedValue = () => {
    if (!valueEditor) return
    const result = parseEditedValue(valueEditor.draft, valueEditor.type)
    if (result.error || result.value === undefined) {
      setValueEditor({ ...valueEditor, error: result.error })
      return
    }
    onEditValue(valueEditor.path, result.value)
    setValueEditor(null)
  }

  return (
    <>
      <article
        aria-selected={selectionState === 'selected'}
        className={`json-node tone-${tone} ${
          selectionState === 'selected' ? 'is-selected' : ''
        } ${selectionState === 'dimmed' ? 'is-dimmed' : ''} ${
          matched ? 'is-match' : ''
        } ${relationHoverState === 'target' ? 'is-relation-target' : ''}`}
      >
      {!isRoot && (
        <Handle
          className="node-target-handle"
          type="target"
          position={Position.Left}
        />
      )}

      <header className="json-node-header">
        <span className="node-heading">
          <strong title={title}>{title}</strong>
          <small title={pathLabel}>{pathLabel}</small>
        </span>
        {canCollapse && (
          <button
            aria-label={collapsed ? '展开节点' : '折叠节点'}
            className="node-icon-button nodrag"
            onClick={() => onToggle(path)}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            {collapsed ? (
              <ChevronRight size={11} />
            ) : (
              <ChevronDown size={11} />
            )}
          </button>
        )}
      </header>

      {!collapsed && (
        <div className="json-node-body">
          {primitiveRows.map((row) => (
            <div
              className={`json-node-row nodrag nopan ${
                row.matched ? 'row-match' : ''
              } ${row.selected ? 'is-selected-row' : ''}`}
              key={`${row.path.join('.')}-primitive`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(row.path, path)
              }}
              onContextMenu={(event) => openContextMenu(event, row)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelect(row.path, path)
                }
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
              }}
              role="button"
              style={{
                gridTemplateColumns: `${keyColumnWidth}px minmax(0, 1fr)`,
                order: row.order,
              }}
              tabIndex={0}
            >
              <StaticKey
                arrayItem={row.isArrayItem || row.isRoot}
                label={row.keyLabel}
              />
              <StaticValue value={row.value} />
            </div>
          ))}

          {containerRows.map((row) => (
            <div
              className={`json-node-row nodrag nopan ${
                row.matched ? 'row-match' : ''
              } ${row.selected ? 'is-selected-row' : ''} ${
                pathToId(row.path) === hoveredSourcePathId
                  ? 'is-hovered-relation-row'
                  : ''
              }`}
              key={`${row.path.join('.')}-container`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(row.path, path)
              }}
              onContextMenu={(event) => openContextMenu(event, row)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelect(row.path, path)
                }
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
              }}
              role="button"
              style={{
                gridTemplateColumns: `${keyColumnWidth}px minmax(0, 1fr)`,
                order: row.order,
              }}
              tabIndex={0}
            >
              <StaticKey arrayItem={row.isArrayItem} label={row.keyLabel} />
              {row.linked ? (
                <button
                  className="child-link nodrag"
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelect(row.path, path)
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  type="button"
                >
                  {row.type === 'array'
                    ? `[${row.size} items]`
                    : `{${row.size} keys}`}
                </button>
              ) : (
                <span className="child-link child-summary">
                  {row.type === 'array' ? '[0 items]' : '{0 keys}'}
                </span>
              )}
            </div>
          ))}

          {primitiveRows.length === 0 && containerRows.length === 0 && (
            <div className="empty-node">
              空{kind === 'array' ? '数组' : '对象'}
            </div>
          )}
        </div>
      )}

      {!collapsed &&
        containerRows.map((row) => (
          row.linked ? (
            <Handle
              className={`row-source-handle ${
                pathToId(row.path) === hoveredSourcePathId
                  ? 'is-hovered'
                  : ''
              } ${row.expanded ? 'is-expanded' : ''} nodrag nopan`}
              id={`source-${pathToId(row.path)}`}
              key={`handle-${pathToId(row.path)}`}
              aria-label={`${row.keyLabel}：${
                row.expanded ? '收起分支' : '展开分支'
              }`}
              onClick={(event) => {
                event.stopPropagation()
                onToggleBranch(row.path)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  onToggleBranch(row.path)
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              position={Position.Right}
              style={{
                top: 24 + (row.order + 0.5) * 24,
              }}
              tabIndex={0}
              title={row.expanded ? '收起分支' : '展开分支'}
              type="source"
            />
          ) : null
        ))}
      </article>

      {contextMenu &&
        createPortal(
          <div
            aria-label="字段操作菜单"
            className="json-row-context-menu"
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              autoFocus
              onClick={() => copyContextItem('value')}
              role="menuitem"
              type="button"
            >
              <Copy size={13} />
              <span>复制 Value</span>
            </button>
            <button
              onClick={() => copyContextItem('key')}
              role="menuitem"
              type="button"
            >
              <KeyRound size={13} />
              <span>复制 Key</span>
            </button>
            <button
              disabled={contextMenu.type === 'null'}
              onClick={editContextValue}
              role="menuitem"
              title={
                contextMenu.type === 'null'
                  ? 'null 类型没有可编辑内容'
                  : undefined
              }
              type="button"
            >
              <Pencil size={13} />
              <span>编辑 Value</span>
            </button>
          </div>,
          document.body,
        )}

      {valueEditor &&
        createPortal(
          <div
            className="value-editor-backdrop"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setValueEditor(null)
            }}
            role="presentation"
          >
            <section
              aria-label={`编辑 ${valueEditor.keyLabel} 的 Value`}
              aria-modal="true"
              className="value-editor-dialog"
              onPointerDown={(event) => event.stopPropagation()}
              role="dialog"
            >
              <header>
                <div>
                  <strong>编辑 Value</strong>
                  <span>{valueEditor.keyLabel}</span>
                </div>
                <small>{valueEditor.type}</small>
              </header>
              <textarea
                autoFocus
                className="value-editor-input"
                onChange={(event) =>
                  setValueEditor({
                    ...valueEditor,
                    draft: event.target.value,
                    error: null,
                  })
                }
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    saveEditedValue()
                  }
                }}
                rows={
                  valueEditor.type === 'object' ||
                  valueEditor.type === 'array'
                    ? 12
                    : 4
                }
                spellCheck={false}
                value={valueEditor.draft}
              />
              {valueEditor.error && (
                <p className="value-editor-error">{valueEditor.error}</p>
              )}
              <footer>
                <button
                  className="value-editor-cancel"
                  onClick={() => setValueEditor(null)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="value-editor-save"
                  onClick={saveEditedValue}
                  type="button"
                >
                  保存
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  )
}

export const ReadOnlyJsonCardNode = memo(ReadOnlyJsonCardNodeComponent)
