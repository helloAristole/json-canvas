import { GitCompare, X } from 'lucide-react'
import { useMemo } from 'react'
import { formatPath, type JsonPath, type JsonValue } from './json'
import {
  buildCompareLines,
  MAX_COMPARE_LINES,
  type JsonDiffEntry,
} from './jsonDiff'

function valueToneClass(text: string): string {
  if (
    text === '{' ||
    text === '}' ||
    text === '[' ||
    text === ']' ||
    text === '{}' ||
    text === '[]' ||
    /^\{\d+\}$/.test(text) ||
    /^\[\d+\]$/.test(text)
  ) {
    return 'compare-bracket'
  }
  if (text === 'true' || text === 'false') return 'compare-value is-boolean'
  if (text === 'null') return 'compare-value is-null'
  if (text.startsWith('"')) return 'compare-value is-string'
  if (/^-?\d/.test(text)) return 'compare-value is-number'
  return 'compare-value'
}

function CompareCell({
  depth,
  keyLabel,
  text,
}: {
  depth: number
  keyLabel: string | null
  text: string | null
}) {
  if (text === null) {
    return <span className="compare-empty"> </span>
  }

  const showColon = keyLabel !== null && text !== '}' && text !== ']'

  return (
    <span className="compare-token" style={{ paddingLeft: depth * 14 }}>
      {keyLabel !== null ? <span className="compare-key">{keyLabel}</span> : null}
      {showColon ? <span className="compare-colon">: </span> : null}
      <span className={valueToneClass(text)}>{text}</span>
    </span>
  )
}

export function ComparePanel({
  currentName,
  diffs,
  leftValue,
  onClose,
  onFocus,
  onSelectTarget,
  rightValue,
  targets,
  targetId,
}: {
  currentName: string
  diffs: JsonDiffEntry[]
  leftValue: JsonValue | null
  onClose: () => void
  onFocus: (path: JsonPath) => void
  onSelectTarget: (id: string) => void
  rightValue: JsonValue
  targets: Array<{ id: string; name: string }>
  targetId: string
}) {
  const added = diffs.filter((entry) => entry.kind === 'added').length
  const removed = diffs.filter((entry) => entry.kind === 'removed').length
  const changed = diffs.filter((entry) => entry.kind === 'changed').length
  const targetName =
    targets.find((target) => target.id === targetId)?.name || 'Untitled'
  const lines = useMemo(
    () => (leftValue === null ? [] : buildCompareLines(leftValue, rightValue)),
    [leftValue, rightValue],
  )

  return (
    <div aria-label="JSON 版本对比" className="compare-stage" role="dialog">
      <header className="compare-stage-bar">
        <strong>
          <GitCompare size={13} strokeWidth={2.2} />
          版本对比
        </strong>
        <p className="compare-stage-summary">
          {leftValue === null
            ? '对比文档不是有效 JSON'
            : diffs.length === 0
              ? '两份 JSON 相同'
              : `${changed} 改 · ${added} 增 · ${removed} 删`}
        </p>
        <span className="compare-legend">
          <i className="is-changed" />
          改
          <i className="is-added" />
          增
          <i className="is-removed" />
          删
        </span>
        <button aria-label="退出对比" onClick={onClose} type="button">
          <X size={13} />
        </button>
      </header>

      <div className="compare-frames">
        <article className="compare-frame">
          <header>
            <small>对比对象</small>
            <select
              aria-label="选择对比的 JSON"
              onChange={(event) => onSelectTarget(event.target.value)}
              value={targetId}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name || 'Untitled'}
                </option>
              ))}
            </select>
          </header>
        </article>
        <article className="compare-frame">
          <header>
            <small>当前</small>
            <b>{currentName || 'Untitled'}</b>
          </header>
        </article>
      </div>

      {leftValue === null ? (
        <p className="compare-stage-empty">无法解析「{targetName}」</p>
      ) : (
        <div className="compare-body">
          {lines.map((line, index) => (
            <button
              className={`compare-row is-${line.kind}`}
              key={`${formatPath(line.path)}:${index}`}
              onClick={() => onFocus(line.path)}
              title={formatPath(line.path)}
              type="button"
            >
              <span className={`compare-cell ${line.left === null ? 'is-blank' : `is-${line.kind}`}`}>
                <CompareCell
                  depth={line.depth}
                  keyLabel={line.left === null ? null : line.keyLabel}
                  text={line.left}
                />
              </span>
              <span className={`compare-cell ${line.right === null ? 'is-blank' : `is-${line.kind}`}`}>
                <CompareCell
                  depth={line.depth}
                  keyLabel={line.right === null ? null : line.keyLabel}
                  text={line.right}
                />
              </span>
            </button>
          ))}
          {lines.length >= MAX_COMPARE_LINES ? (
            <p className="compare-stage-empty">差异过多，仅显示前 {MAX_COMPARE_LINES} 行</p>
          ) : null}
        </div>
      )}
    </div>
  )
}
