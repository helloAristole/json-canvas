import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { SearchMatch } from './graph'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function HighlightedText({
  query,
  text,
}: {
  query: string
  text: string
}) {
  if (!query) return text

  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'))
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === query.toLocaleLowerCase() ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      part
    ),
  )
}

export function SearchPanel({
  activeIndex,
  focusNonce = 0,
  matches,
  onActiveIndexChange,
  onClose,
  onQueryChange,
  query,
}: {
  activeIndex: number
  focusNonce?: number
  matches: SearchMatch[]
  onActiveIndexChange: (index: number) => void
  onClose: () => void
  onQueryChange: (value: string) => void
  query: string
}) {
  const total = matches.length
  const current = total === 0 ? 0 : activeIndex + 1
  const activeItemRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  useEffect(() => {
    if (focusNonce === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  const move = (step: number) => {
    if (total === 0) return
    onActiveIndexChange((activeIndex + step + total) % total)
  }

  return (
    <section
      className="search-panel nodrag nopan"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="search-panel-header">
        <Search size={13} />
        <input
          aria-label="搜索键、值或路径"
          autoFocus
          onChange={(event) => onQueryChange(event.target.value)}
          ref={inputRef}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              move(event.shiftKey ? -1 : 1)
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
          placeholder="搜索键、值或路径"
          value={query}
        />
        <span className="search-panel-count">
          {total === 0 ? '0/0' : `${current}/${total}`}
        </span>
        <button
          aria-label="上一个匹配"
          disabled={total === 0}
          onClick={() => move(-1)}
          type="button"
        >
          <ChevronUp size={13} />
        </button>
        <button
          aria-label="下一个匹配"
          disabled={total === 0}
          onClick={() => move(1)}
          type="button"
        >
          <ChevronDown size={13} />
        </button>
        <button aria-label="关闭搜索" onClick={onClose} type="button">
          <X size={13} />
        </button>
      </header>

      {query.trim() && (
        <ul className="search-panel-list">
          {matches.length === 0 ? (
            <li className="search-panel-empty">没有匹配结果</li>
          ) : (
            matches.map((match, index) => (
              <li key={`${match.nodeId}-${match.path.join('.')}`}>
                <button
                  className={`search-panel-item ${
                    index === activeIndex ? 'is-active' : ''
                  }`}
                  onClick={() => onActiveIndexChange(index)}
                  ref={index === activeIndex ? activeItemRef : undefined}
                  type="button"
                >
                  <small>
                    <HighlightedText query={query.trim()} text={match.pathLabel} />
                  </small>
                  <span>
                    <HighlightedText query={query.trim()} text={match.valueText} />
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  )
}
