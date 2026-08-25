import { indentUnit } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsonLanguageExtensions } from './jsonHighlight'

function longestLineUnits(draft: string) {
  return draft.split('\n').reduce((longest, line) => {
    const units = Array.from(line).reduce(
      (width, character) =>
        width + ((character.codePointAt(0) ?? 0) > 0xff ? 2 : 1),
      0,
    )
    return Math.max(longest, units)
  }, 0)
}

function measureDraftWidth(draft: string) {
  const maxWidth = Math.min(860, window.innerWidth - 80)
  return Math.max(
    360,
    Math.min(maxWidth, Math.ceil(longestLineUnits(draft) * 7.4 + 72)),
  )
}

function fitJsonEditor(view: EditorView) {
  const maxHeight = Math.min(window.innerHeight * 0.72, 720)
  const nextHeight = Math.max(72, Math.min(maxHeight, Math.ceil(view.contentHeight)))
  if (Math.abs(view.dom.offsetHeight - nextHeight) > 1) {
    view.dom.style.height = `${nextHeight}px`
  }
  const wrapper = view.dom.closest('.value-editor-json')
  if (wrapper instanceof HTMLElement) {
    wrapper.style.width = `${measureDraftWidth(view.state.doc.toString())}px`
  }
}

function useDarkTheme() {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === 'dark',
  )
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(root.dataset.theme === 'dark')
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export function JsonDraftEditor({
  onChange,
  onSubmit,
  value,
}: {
  onChange: (value: string) => void
  onSubmit: () => void
  value: string
}) {
  const dark = useDarkTheme()
  const viewRef = useRef<EditorView | null>(null)
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit

  useEffect(() => {
    const view = viewRef.current
    if (view) fitJsonEditor(view)
  }, [value])

  useEffect(() => {
    const onResize = () => {
      const view = viewRef.current
      if (view) fitJsonEditor(view)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const extensions = useMemo(
    () => [
      ...jsonLanguageExtensions(dark),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      Prec.high(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onSubmitRef.current()
              return true
            },
          },
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSubmitRef.current()
              return true
            },
          },
        ]),
      ),
    ],
    [dark],
  )

  return (
    <div
      className="value-editor-json"
      style={{ width: measureDraftWidth(value) }}
    >
      <CodeMirror
        autoFocus
        basicSetup={{
          bracketMatching: true,
          closeBrackets: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightSelectionMatches: false,
          indentOnInput: true,
          lineNumbers: true,
          searchKeymap: false,
        }}
        extensions={extensions}
        height="auto"
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view
          window.requestAnimationFrame(() => fitJsonEditor(view))
        }}
        theme="none"
        value={value}
      />
    </div>
  )
}
