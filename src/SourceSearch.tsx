import {
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { ChevronDown, ChevronRight, ChevronUp, List, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react'

const MAX_MATCHES = 9999

export interface SourceSearchHandle {
  move: (step: 1 | -1) => void
  open: (view: EditorView, withReplace?: boolean) => void
}

function collectMatches(view: EditorView, query: SearchQuery) {
  if (!query.valid || !query.search) return []
  const matches: { from: number; to: number }[] = []
  const cursor = query.getCursor(view.state)
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    matches.push(result.value)
    if (matches.length >= MAX_MATCHES) break
  }
  return matches
}

function buildQuery(
  search: string,
  replace: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  regexp: boolean,
) {
  return new SearchQuery({
    search,
    replace,
    caseSensitive,
    wholeWord,
    regexp,
  })
}

export const SourceSearch = forwardRef<
  SourceSearchHandle,
  {
    onOpenChange: (open: boolean) => void
    open: boolean
    source: string
    view: EditorView | null
  }
>(function SourceSearch({ onOpenChange, open, source, view }, ref) {
  const [query, setQuery] = useState('')
  const [replace, setReplace] = useState('')
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regexp, setRegexp] = useState(false)
  const [matchIndex, setMatchIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  const [capped, setCapped] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef(0)

  const currentQuery = useCallback(
    () => buildQuery(query, replace, caseSensitive, wholeWord, regexp),
    [caseSensitive, query, regexp, replace, wholeWord],
  )

  const applyQuery = useCallback(
    (nextQuery: SearchQuery, reveal: boolean, from = anchorRef.current) => {
      if (!view) return
      view.dispatch({ effects: setSearchQuery.of(nextQuery) })
      const matches = collectMatches(view, nextQuery)
      setCapped(matches.length >= MAX_MATCHES)
      setMatchCount(matches.length)
      if (matches.length === 0) {
        setMatchIndex(0)
        return
      }
      if (!reveal) {
        const current = view.state.selection.main
        const currentIndex = matches.findIndex(
          (match) => match.from === current.from && match.to === current.to,
        )
        setMatchIndex(currentIndex >= 0 ? currentIndex : 0)
        return
      }
      let index = matches.findIndex((match) => match.from >= from)
      if (index < 0) index = 0
      const match = matches[index]
      setMatchIndex(index)
      view.dispatch({
        selection: { anchor: match.from, head: match.to },
        scrollIntoView: true,
      })
    },
    [view],
  )

  const move = useCallback(
    (step: 1 | -1) => {
      const nextQuery = currentQuery()
      if (!view || !nextQuery.valid || !nextQuery.search) return
      const ran = step > 0 ? findNext(view) : findPrevious(view)
      if (!ran) return
      const matches = collectMatches(view, nextQuery)
      const current = view.state.selection.main
      const index = matches.findIndex(
        (match) => match.from === current.from && match.to === current.to,
      )
      setMatchCount(matches.length)
      setMatchIndex(index >= 0 ? index : 0)
    },
    [currentQuery, view],
  )

  useImperativeHandle(
    ref,
    () => ({
      move,
      open: (editor, withReplace = false) => {
        const selection = editor.state.selection.main
        anchorRef.current = selection.from
        if (!selection.empty) {
          const selected = editor.state.sliceDoc(selection.from, selection.to)
          if (selected && !selected.includes('\n') && selected.length <= 200) {
            setQuery(selected)
          }
        }
        setReplaceOpen((current) => withReplace || current)
        onOpenChange(true)
        window.setTimeout(() => {
          const target = withReplace ? replaceInputRef.current : inputRef.current
          target?.focus()
          target?.select()
        }, 0)
      },
    }),
    [move, onOpenChange],
  )

  useEffect(() => {
    if (!open || !view) return
    applyQuery(
      buildQuery(query, replace, caseSensitive, wholeWord, regexp),
      Boolean(query),
    )
  }, [applyQuery, caseSensitive, open, query, regexp, view, wholeWord])

  useEffect(() => {
    if (!open || !view) return
    applyQuery(
      buildQuery(query, replace, caseSensitive, wholeWord, regexp),
      false,
    )
  }, [applyQuery, caseSensitive, open, query, regexp, replace, source, view, wholeWord])

  useEffect(() => {
    if (open || !view) return
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: '' })),
    })
  }, [open, view])

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
        view?.focus()
        return
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (key === 'c') {
          event.preventDefault()
          setCaseSensitive((current) => !current)
        }
        if (key === 'w') {
          event.preventDefault()
          setWholeWord((current) => !current)
        }
        if (key === 'r') {
          event.preventDefault()
          setRegexp((current) => !current)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpenChange, open, view])

  const runReplace = (all: boolean) => {
    const nextQuery = currentQuery()
    if (!view || !nextQuery.valid || !nextQuery.search) return
    if (all) replaceAll(view)
    else replaceNext(view)
    applyQuery(nextQuery, !all)
  }

  if (!open) return null

  const invalid = Boolean(query) && !currentQuery().valid
  const countLabel = invalid
    ? 'Invalid regex'
    : matchCount === 0
      ? 'No results'
      : `${matchIndex + 1} of ${matchCount}${capped ? '+' : ''}`

  return (
    <div className="source-search-slot">
    <div
      className={`source-search ${replaceOpen ? 'has-replace' : ''}`}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        aria-expanded={replaceOpen}
        aria-label={replaceOpen ? '隐藏替换' : '显示替换'}
        className="source-search-toggle"
        onClick={() => {
          setReplaceOpen((current) => {
            const next = !current
            if (next) {
              window.setTimeout(() => replaceInputRef.current?.focus(), 0)
            } else {
              inputRef.current?.focus()
            }
            return next
          })
        }}
        onMouseDown={(event) => event.preventDefault()}
        title="替换 (Ctrl+H)"
        type="button"
      >
        {replaceOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>

      <div className="source-search-body">
        <div className="source-search-row">
          <label className="source-search-field">
            <input
              aria-label="查找"
              onChange={(event) => {
                anchorRef.current = view?.state.selection.main.from ?? 0
                setQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  move(event.shiftKey ? -1 : 1)
                }
              }}
              placeholder="Find"
              ref={inputRef}
              spellCheck={false}
              value={query}
            />
            <span className="source-search-options">
              <button
                aria-pressed={caseSensitive}
                className={caseSensitive ? 'is-active' : ''}
                onClick={() => setCaseSensitive((current) => !current)}
                onMouseDown={(event) => event.preventDefault()}
                title="Match Case (Alt+C)"
                type="button"
              >
                Aa
              </button>
              <button
                aria-pressed={wholeWord}
                className={wholeWord ? 'is-active' : ''}
                onClick={() => setWholeWord((current) => !current)}
                onMouseDown={(event) => event.preventDefault()}
                title="Match Whole Word (Alt+W)"
                type="button"
              >
                ab
              </button>
              <button
                aria-pressed={regexp}
                className={regexp ? 'is-active' : ''}
                onClick={() => setRegexp((current) => !current)}
                onMouseDown={(event) => event.preventDefault()}
                title="Use Regular Expression (Alt+R)"
                type="button"
              >
                .*
              </button>
            </span>
          </label>
          {query ? (
            <span
              className={`source-search-count ${
                invalid || matchCount === 0 ? 'is-empty' : ''
              }`}
            >
              {countLabel}
            </span>
          ) : null}
          <button
            disabled={matchCount === 0}
            onClick={() => move(-1)}
            onMouseDown={(event) => event.preventDefault()}
            title="Previous (Shift+Enter)"
            type="button"
          >
            <ChevronUp size={12} />
          </button>
          <button
            disabled={matchCount === 0}
            onClick={() => move(1)}
            onMouseDown={(event) => event.preventDefault()}
            title="Next (Enter)"
            type="button"
          >
            <ChevronDown size={12} />
          </button>
          <button
            disabled={matchCount === 0}
            onClick={() => view && selectMatches(view)}
            onMouseDown={(event) => event.preventDefault()}
            title="Select All Matches"
            type="button"
          >
            <List size={11} />
          </button>
          <button
            onClick={() => {
              onOpenChange(false)
              view?.focus()
            }}
            onMouseDown={(event) => event.preventDefault()}
            title="Close (Esc)"
            type="button"
          >
            <X size={11} />
          </button>
        </div>

        {replaceOpen ? (
          <div className="source-search-row">
            <label className="source-search-field">
              <input
                aria-label="替换"
                onChange={(event) => setReplace(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    runReplace(event.ctrlKey || event.metaKey)
                  }
                }}
                placeholder="Replace"
                ref={replaceInputRef}
                spellCheck={false}
                value={replace}
              />
            </label>
            <button
              disabled={matchCount === 0 || invalid}
              onClick={() => runReplace(false)}
              onMouseDown={(event) => event.preventDefault()}
              title="Replace (Enter)"
              type="button"
            >
              Replace
            </button>
            <button
              disabled={matchCount === 0 || invalid}
              onClick={() => runReplace(true)}
              onMouseDown={(event) => event.preventDefault()}
              title="Replace All (Ctrl+Enter)"
              type="button"
            >
              All
            </button>
          </div>
        ) : null}
      </div>
    </div>
    </div>
  )
})
