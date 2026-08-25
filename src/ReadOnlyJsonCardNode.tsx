import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  CornerLeftUp,
  KeyRound,
  Pencil,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { JsonDraftEditor } from './JsonDraftEditor'
import {
  parentCardPath,
  pathToId,
  type JsonPath,
  type JsonPrimitive,
  type JsonValue,
  type JsonValueType,
} from './json'
import type { ContainerRow, JsonFlowNode } from './graph'

const cardEditorOpeners = new Map<string, () => void>()

export function openJsonCardEditor(nodeId: string) {
  cardEditorOpeners.get(nodeId)?.()
}

interface NavTarget {
  label: string
  path: JsonPath
}

interface RowContextMenu {
  copyKey: string
  copyValue: string
  mode: 'card' | 'row'
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
  scope: 'card' | 'value'
  type: JsonValueType
}

function measureDraftWidth(draft: string): number {
  const longestLine = draft.split('\n').reduce((longest, line) => {
    const units = Array.from(line).reduce(
      (width, character) =>
        width + (character.codePointAt(0)! > 0xff ? 2 : 1),
      0,
    )
    return Math.max(longest, units)
  }, 0)
  return Math.ceil(longestLine * 7.4 + 28)
}

function childTargetsFromRows(rows: ContainerRow[]): NavTarget[] {
  return rows.flatMap((row) => {
    if (!row.linked) return []
    const focusPath = row.focusPath ?? row.path
    const flattened =
      focusPath.length === row.path.length + 1 &&
      typeof focusPath[focusPath.length - 1] === 'number'
    if (flattened) {
      return Array.from({ length: Math.max(0, row.size) }, (_, index) => ({
        label: `${row.keyLabel}[${index}]`,
        path: [...row.path, index] as JsonPath,
      }))
    }
    return [{ label: row.keyLabel, path: row.path }]
  })
}

function fitValueEditor(textarea: HTMLTextAreaElement) {
  const minWidth = 360
  const maxWidth = Math.min(860, window.innerWidth - 80)
  const maxHeight = Math.min(window.innerHeight * 0.72, 720)
  textarea.style.width = `${Math.max(
    minWidth,
    Math.min(maxWidth, measureDraftWidth(textarea.value)),
  )}px`
  textarea.style.height = 'auto'
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, 78), maxHeight)
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
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
    return {
      error: type === 'object' || type === 'array' ? 'JSON 格式不正确' : 'Value 格式不正确',
    }
  }
}

function previewPrimitive(value: JsonPrimitive): string {
  if (value === null) return 'null'
  return String(value)
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

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
}

function StaticValue({
  multiline = false,
  onDoubleClick,
  value,
}: {
  multiline?: boolean
  onDoubleClick?: (event: ReactMouseEvent<HTMLSpanElement>) => void
  value: JsonPrimitive
}) {
  const type = value === null ? 'null' : typeof value
  const text = value === null ? 'null' : String(value)
  const swatch = typeof value === 'string' && isHexColor(value.trim()) ? value.trim() : null

  return (
    <span
      className={`json-value value-${type} ${
        swatch ? 'has-color-swatch' : ''
      } ${multiline ? 'is-multiline nowheel nopan' : ''}`}
      onDoubleClick={onDoubleClick}
      title={type === 'null' ? text : `${text}\n双击编辑`}
    >
      {swatch ? (
        <span
          aria-hidden="true"
          className="color-swatch"
          style={{ background: swatch }}
        />
      ) : null}
      {text}
    </span>
  )
}

function ReadOnlyJsonCardNodeComponent({
  data,
  id,
}: NodeProps<JsonFlowNode>) {
  const {
    title,
    pathLabel,
    path,
    kind,
    tone,
    keyColumnWidth,
    collapsed,
    copyValue,
    matched,
    selectionState,
    relationHoverState,
    hoveredSourcePathId,
    primitiveRows,
    containerRows,
    onFocus,
    onSelect,
    onCopy,
    onEditValue,
    onToggle,
    onToggleBranch,
    onMeasuredHeight,
  } = data
  const canCollapse = kind === 'object' || kind === 'array'
  const isRoot = path.length === 0
  const parentPath = parentCardPath(path)
  const childTargets = childTargetsFromRows(containerRows)
  const hasParent = parentPath !== null
  const canGoto = childTargets.length > 0 || primitiveRows.length > 0
  const [contextMenu, setContextMenu] = useState<RowContextMenu | null>(null)
  const [gotoOpen, setGotoOpen] = useState(false)
  const [gotoMenuStyle, setGotoMenuStyle] = useState<CSSProperties>({
    left: 0,
    top: 0,
  })
  const [valueEditor, setValueEditor] = useState<ValueEditorState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const gotoTriggerRef = useRef<HTMLButtonElement>(null)
  const gotoMenuRef = useRef<HTMLDivElement>(null)
  const gotoCloseTimerRef = useRef<number | null>(null)
  const valueEditorInputRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const saveEditedValueRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node || !onMeasuredHeight) return

    const report = () => onMeasuredHeight(id, node.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [collapsed, id, onMeasuredHeight])

  const clearGotoCloseTimer = () => {
    if (gotoCloseTimerRef.current !== null) {
      window.clearTimeout(gotoCloseTimerRef.current)
      gotoCloseTimerRef.current = null
    }
  }

  const openGoto = () => {
    clearGotoCloseTimer()
    setGotoOpen(true)
  }

  const scheduleCloseGoto = () => {
    clearGotoCloseTimer()
    gotoCloseTimerRef.current = window.setTimeout(() => {
      setGotoOpen(false)
      gotoCloseTimerRef.current = null
    }, 180)
  }

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = () => {
      clearGotoCloseTimer()
      setContextMenu(null)
      setGotoOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (gotoMenuRef.current?.contains(target)) return
      closeMenu()
    }

    window.addEventListener('blur', closeMenu)
    window.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeMenu)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!gotoOpen || !gotoTriggerRef.current) return
    const trigger = gotoTriggerRef.current.getBoundingClientRect()
    const flyout = gotoMenuRef.current
    const menuWidth = Math.max(flyout?.offsetWidth ?? 220, 196)
    const menuHeight = flyout?.offsetHeight ?? 160
    const maxHeight = Math.min(360, window.innerHeight - 16)
    let left = trigger.right - 2
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, trigger.left - menuWidth + 2)
    }
    let top = trigger.top
    if (top + Math.min(menuHeight, maxHeight) > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - Math.min(menuHeight, maxHeight) - 8)
    }
    setGotoMenuStyle({ left, top, maxHeight })
  }, [childTargets.length, gotoOpen, primitiveRows.length])

  useEffect(() => {
    return () => {
      if (gotoCloseTimerRef.current !== null) {
        window.clearTimeout(gotoCloseTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!valueEditor) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      setValueEditor(null)
    }
    const saveOnShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
        return
      }
      event.preventDefault()
      saveEditedValueRef.current()
    }
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('keydown', saveOnShortcut)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('keydown', saveOnShortcut)
    }
  }, [valueEditor])

  const isJsonDraft =
    valueEditor?.type === 'object' || valueEditor?.type === 'array'

  useLayoutEffect(() => {
    const textarea = valueEditorInputRef.current
    if (!valueEditor || isJsonDraft || !textarea) return
    fitValueEditor(textarea)
  }, [isJsonDraft, valueEditor])

  useEffect(() => {
    if (!valueEditor || isJsonDraft) return
    const onResize = () => {
      if (valueEditorInputRef.current) {
        fitValueEditor(valueEditorInputRef.current)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isJsonDraft, valueEditor !== null])

  const menuPosition = (event: ReactMouseEvent<HTMLElement>, height: number) => ({
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 280)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height)),
  })

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    row: CopyableRow,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    onSelect(row.path, path)
    setGotoOpen(false)
    setContextMenu({
      copyKey: row.copyKey,
      copyValue: row.copyValue,
      mode: 'row',
      path: row.path,
      type: row.type,
      ...menuPosition(event, hasParent ? 150 : 116),
    })
  }

  const openCardContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onSelect(path, path)
    setGotoOpen(false)
    setContextMenu({
      copyKey: title,
      copyValue,
      mode: 'card',
      path,
      type: kind,
      ...menuPosition(event, hasParent && canGoto ? 160 : 120),
    })
  }

  const focusParentNode = () => {
    if (parentPath === null) return
    onFocus(parentPath)
    setContextMenu(null)
    setGotoOpen(false)
  }

  const focusNavTarget = (targetPath: JsonPath) => {
    onFocus(targetPath)
    setContextMenu(null)
    setGotoOpen(false)
  }

  const copyContextItem = (kind: 'key' | 'value') => {
    if (!contextMenu) return
    onCopy(
      kind === 'key' ? contextMenu.copyKey : contextMenu.copyValue,
      kind,
    )
    setContextMenu(null)
    setGotoOpen(false)
  }

  const openValueEditor = (
    row: CopyableRow,
    scope: 'card' | 'value' = 'value',
  ) => {
    if (row.type === 'null') return
    setContextMenu(null)
    setGotoOpen(false)
    setValueEditor({
      draft: row.copyValue,
      error: null,
      keyLabel: row.copyKey,
      path: row.path,
      scope,
      type: row.type,
    })
  }

  const openCardEditor = (event?: ReactMouseEvent<HTMLElement>) => {
    event?.preventDefault()
    event?.stopPropagation()
    onSelect(path, path)
    openValueEditor(
      {
        copyKey: title,
        copyValue,
        path,
        type: kind,
      },
      'card',
    )
  }

  const editContextValue = () => {
    if (!contextMenu) return
    openValueEditor(
      contextMenu,
      contextMenu.mode === 'card' ? 'card' : 'value',
    )
  }

  const openCardEditorRef = useRef(openCardEditor)
  openCardEditorRef.current = openCardEditor

  useLayoutEffect(() => {
    const open = () => openCardEditorRef.current()
    cardEditorOpeners.set(id, open)
    return () => {
      cardEditorOpeners.delete(id)
    }
  }, [id])

  const copyEditorDraft = () => {
    if (!valueEditor) return
    onCopy(valueEditor.draft, 'value')
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
  saveEditedValueRef.current = saveEditedValue

  const updateEditorDraft = (draft: string) => {
    setValueEditor((current) =>
      current ? { ...current, draft, error: null } : current,
    )
  }

  return (
    <>
      <article
        aria-selected={selectionState === 'selected'}
        className={`json-node nodrag nopan tone-${tone} ${
          selectionState === 'selected' ? 'is-selected' : ''
        } ${selectionState === 'dimmed' ? 'is-dimmed' : ''} ${
          matched ? 'is-match' : ''
        } ${relationHoverState === 'target' ? 'is-relation-target' : ''}`}
        onDoubleClick={openCardEditor}
        ref={rootRef}
      >
      {!isRoot && (
        <Handle
          className="node-target-handle"
          type="target"
          position={Position.Left}
          style={{ top: 12 }}
        />
      )}

      <header
        className="json-node-header nodrag nopan"
        onContextMenu={openCardContextMenu}
        onDoubleClick={openCardEditor}
        title="双击编辑整张卡片"
      >
        <span className="node-heading">
          <strong title={title}>{title}</strong>
          <small title={pathLabel}>{pathLabel}</small>
        </span>
        {canCollapse && (
          <button
            aria-label={collapsed ? '展开节点' : '折叠节点'}
            className="node-icon-button nodrag"
            onClick={() => onToggle(path)}
            onDoubleClick={(event) => event.stopPropagation()}
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
              } ${row.selected ? 'is-selected-row' : ''} ${
                row.multiline ? 'is-multiline' : ''
              } ${row.keyLabel ? '' : 'is-leaf-text'}`}
              key={`${row.path.join('.')}-primitive`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(row.path, path)
              }}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onSelect(row.path, path)
                openValueEditor(row)
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
                gridTemplateColumns: row.keyLabel
                  ? `${keyColumnWidth}px minmax(0, 1fr)`
                  : 'minmax(0, 1fr)',
                height: row.multiline ? undefined : row.height,
                order: row.order,
              }}
              tabIndex={0}
            >
              {row.keyLabel ? (
                <StaticKey
                  arrayItem={row.isArrayItem || row.isRoot}
                  label={row.keyLabel}
                />
              ) : null}
              <StaticValue
                multiline={row.multiline}
                onDoubleClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelect(row.path, path)
                  openValueEditor(row)
                }}
                value={row.value}
              />
            </div>
          ))}

          {containerRows.map((row) => (
            <div
              className={`json-node-row nodrag nopan is-item-row ${
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
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onSelect(row.path, path)
                openValueEditor(row)
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
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onSelect(row.path, path)
                    openValueEditor(row)
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  title="双击编辑"
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
                top: 24 + row.offsetY + row.height / 2,
              }}
              tabIndex={0}
              title={row.expanded ? '收起分支' : '展开分支'}
              type="source"
            />
          ) : null
        ))}
      </article>

      {contextMenu
        ? createPortal(
            <div className="json-context-portals">
            <div
              aria-label="字段操作菜单"
              className="json-row-context-menu"
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => event.stopPropagation()}
              ref={menuRef}
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <div className="json-row-context-menu-meta">
                <strong title={contextMenu.mode === 'card' ? title : contextMenu.copyKey}>
                  {contextMenu.mode === 'card' ? title : contextMenu.copyKey}
                </strong>
                {contextMenu.mode === 'row' ? (
                  <span>{contextMenu.type}</span>
                ) : null}
              </div>
              {hasParent ? (
                <button onClick={focusParentNode} role="menuitem" type="button">
                  <CornerLeftUp size={13} />
                  <span>定位到父节点</span>
                </button>
              ) : null}
              {contextMenu.mode === 'card' && canGoto ? (
                <div className={`context-goto ${gotoOpen ? 'is-open' : ''}`}>
                  <button
                    aria-expanded={gotoOpen}
                    aria-haspopup="menu"
                    onClick={openGoto}
                    onMouseEnter={openGoto}
                    onMouseLeave={scheduleCloseGoto}
                    ref={gotoTriggerRef}
                    role="menuitem"
                    type="button"
                  >
                    <CornerDownRight size={13} />
                    <span>前往</span>
                    <ChevronRight className="context-goto-chevron" size={12} />
                  </button>
                </div>
              ) : null}
              {contextMenu.mode === 'card' ? (
                <button
                  disabled={contextMenu.type === 'null'}
                  onClick={editContextValue}
                  role="menuitem"
                  type="button"
                >
                  <Pencil size={13} />
                  <span>编辑卡片</span>
                </button>
              ) : (
                <>
                  <button
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
                </>
              )}
            </div>
            {gotoOpen && contextMenu.mode === 'card' ? (
              <div
                className="json-row-context-menu context-goto-flyout"
                onContextMenu={(event) => event.preventDefault()}
                onMouseEnter={openGoto}
                onMouseLeave={scheduleCloseGoto}
                onPointerDown={(event) => event.stopPropagation()}
                ref={gotoMenuRef}
                role="menu"
                style={gotoMenuStyle}
              >
                {primitiveRows.length > 0 ? (
                  <div className="context-goto-props">
                    {primitiveRows.map((row) => (
                      <div className="context-goto-prop" key={pathToId(row.path)}>
                        <span className="context-goto-prop-key">
                          {row.keyLabel || title}
                        </span>
                        <span
                          className={`context-goto-prop-value value-${row.type}`}
                          title={previewPrimitive(row.value)}
                        >
                          {previewPrimitive(row.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {childTargets.length > 0 ? (
                  <div className="context-goto-group">
                    <span className="context-goto-label">Outgoing</span>
                    {childTargets.map((target) => (
                      <button
                        key={`child-${pathToId(target.path)}`}
                        onClick={() => focusNavTarget(target.path)}
                        role="menuitem"
                        title={target.label}
                        type="button"
                      >
                        <CornerDownRight size={12} />
                        <span>{target.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            </div>,
            document.body,
          )
        : null}

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
              aria-label={
                valueEditor.scope === 'card'
                  ? `编辑卡片 ${valueEditor.keyLabel}`
                  : `编辑 ${valueEditor.keyLabel} 的 Value`
              }
              aria-modal="true"
              className={`value-editor-dialog ${
                isJsonDraft ? 'is-json-draft' : ''
              }`}
              onPointerDown={(event) => event.stopPropagation()}
              role="dialog"
            >
              <header>
                <div>
                  <strong>
                    {valueEditor.scope === 'card' ? '编辑卡片' : '编辑 Value'}
                  </strong>
                  <span>{valueEditor.keyLabel}</span>
                </div>
                <small>{valueEditor.type}</small>
              </header>
              {isJsonDraft ? (
                <JsonDraftEditor
                  onChange={updateEditorDraft}
                  onSubmit={saveEditedValue}
                  value={valueEditor.draft}
                />
              ) : (
                <textarea
                  autoFocus
                  className="value-editor-input"
                  onChange={(event) =>
                    updateEditorDraft(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      saveEditedValue()
                    }
                  }}
                  ref={valueEditorInputRef}
                  rows={1}
                  spellCheck={false}
                  value={valueEditor.draft}
                />
              )}
              {valueEditor.error && (
                <p className="value-editor-error">{valueEditor.error}</p>
              )}
              <footer>
                <button
                  className="value-editor-copy"
                  onClick={copyEditorDraft}
                  type="button"
                >
                  <Copy size={13} />
                  复制
                </button>
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
