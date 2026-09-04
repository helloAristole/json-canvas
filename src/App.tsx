import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import CodeMirror from '@uiw/react-codemirror'
import { keymap, EditorView, type ViewUpdate } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { search } from '@codemirror/search'
import { jsonLanguageExtensions } from './jsonHighlight'
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  CircleAlert,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  Eraser,
  GitCompare,
  History,
  KeyRound,
  Link2,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Sparkles,
  Sun,
  Upload,
  X,
} from 'lucide-react'
import { parseClipboardJson } from './clipboardJson'
import { ComparePanel } from './ComparePanel'
import { Diagram, type FocusRequest } from './Diagram'
import { buildGraph, type GraphActions } from './graph'
import { HistoryPanel } from './HistoryPanel'
import { findJsonPathAtOffset, locateJsonPath } from './jsonSource'
import {
  diffJson,
  diffKindByPath,
  parseJsonDocument,
} from './jsonDiff'
import {
  loadHistory,
  pushHistory,
  removeHistory,
} from './jsonHistory'
import { SourceSearch, type SourceSearchHandle } from './SourceSearch'
import {
  SAMPLE_JSON,
  copyKeyForPath,
  formatPath,
  getAtPath,
  getJsonError,
  getJsonStats,
  getValueType,
  isContainer,
  pathToId,
  updateAtPath,
  type JsonPath,
  type JsonValue,
  type JsonValueType,
} from './json'

interface EditorContextMenu {
  copyKey: string
  copyValue: string
  keyLabel: string
  pathLabel: string
  type: JsonValueType
  x: number
  y: number
}

function formatCopyValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (isContainer(value)) return JSON.stringify(value, null, 2)
  return value === null ? 'null' : String(value)
}

function cardPathForSelection(value: JsonValue, path: JsonPath): JsonPath {
  let cardPath: JsonPath = []
  let cursor: JsonValue = value

  for (const [index, key] of path.entries()) {
    if (!isContainer(cursor)) return cardPath

    const child = Array.isArray(cursor)
      ? typeof key === 'number'
        ? cursor[key]
        : undefined
      : typeof key === 'string'
        ? cursor[key]
        : undefined
    if (child === undefined) return cardPath

    if (isContainer(child)) {
      const empty = Array.isArray(child)
        ? child.length === 0
        : Object.keys(child).length === 0
      const flattenedArray =
        Array.isArray(child) &&
        child.length > 0 &&
        child.every((item) => isContainer(item))
      if (!empty && !flattenedArray) {
        cardPath = path.slice(0, index + 1)
      }
    }

    cursor = child
  }

  return cardPath
}

const STORAGE_KEY = 'json-canvas-document-v1'
const WORKSPACE_STORAGE_KEY = 'json-canvas-workspace-v2'
const THEME_KEY = 'json-canvas-theme'
const EDITOR_FONT_KEY = 'json-canvas-editor-font-v2'
const EDITOR_FONT_DEFAULT = 12
const EDITOR_FONT_MIN = 10
const EDITOR_FONT_MAX = 18

interface StoredDocument {
  name: string
  source: string
}

interface InitialDocument extends StoredDocument {
  value: JsonValue
  error: string | null
}

interface JsonViewDocument extends StoredDocument {
  id: string
}

interface StoredWorkspace {
  activeDocumentId: string
  documents: JsonViewDocument[]
}

interface InitialWorkspace extends StoredWorkspace {
  document: InitialDocument
}

function uniqueDocumentName(names: Iterable<string>, base: string): string {
  const existing = new Set(names)
  if (!existing.has(base)) return base
  let suffix = 2
  while (existing.has(`${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}

function isBlankJsonSource(source: string): boolean {
  const trimmed = source.trim()
  return trimmed === '' || trimmed === '{}' || trimmed === '[]'
}

function createDocumentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `json-view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

function compactJsonIndentation(source: string): string {
  if (!source.trim()) return source
  if (!/^\t/m.test(source) && !/^ {3,}/m.test(source)) return source

  try {
    JSON.parse(source)
  } catch {
    return source
  }

  const sourceWithSpaces = source.replace(/^[\t ]+(?=\S)/gm, (indentation) => {
    const width = [...indentation].reduce(
      (total, character) => total + (character === '\t' ? 2 : 1),
      0,
    )
    return ' '.repeat(width)
  })
  const indentationWidths = Array.from(
    sourceWithSpaces.matchAll(/^( +)(?=\S)/gm),
    (match) => match[1].length,
  )
  const smallestIndentation = indentationWidths.reduce(
    (smallest, width) => Math.min(smallest, width),
    Number.POSITIVE_INFINITY,
  )

  if (!Number.isFinite(smallestIndentation) || smallestIndentation <= 2) {
    return sourceWithSpaces
  }

  return sourceWithSpaces.replace(/^( +)(?=\S)/gm, (indentation) =>
    ' '.repeat(
      Math.max(2, Math.round((indentation.length * 2) / smallestIndentation)),
    ),
  )
}

function loadInitialDocument(): InitialDocument {
  const fallbackSource = JSON.stringify(SAMPLE_JSON, null, 2)

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) {
      return {
        name: 'Untitled',
        source: fallbackSource,
        value: SAMPLE_JSON,
        error: null,
      }
    }

    const document = JSON.parse(saved) as StoredDocument
    const source = compactJsonIndentation(document.source)
    return {
      name:
        !document.name || document.name === '示例数据'
          ? 'Untitled'
          : document.name,
      source,
      value: source.trim() ? (JSON.parse(source) as JsonValue) : {},
      error: null,
    }
  } catch {
    return {
      name: 'Untitled',
      source: fallbackSource,
      value: SAMPLE_JSON,
      error: null,
    }
  }
}

function isJsonViewDocument(value: unknown): value is JsonViewDocument {
  if (value === null || typeof value !== 'object') return false
  const document = value as Partial<JsonViewDocument>
  return (
    typeof document.id === 'string' &&
    typeof document.name === 'string' &&
    typeof document.source === 'string'
  )
}

function hydrateDocument(document: JsonViewDocument): InitialDocument {
  const source = compactJsonIndentation(document.source)
  if (!source.trim()) {
    return {
      name: document.name,
      source,
      value: {},
      error: null,
    }
  }

  try {
    return {
      name: document.name,
      source,
      value: JSON.parse(source) as JsonValue,
      error: null,
    }
  } catch (error) {
    return {
      name: document.name,
      source,
      value: {},
      error: getJsonError(error),
    }
  }
}

function loadInitialWorkspace(): InitialWorkspace {
  try {
    const saved = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (saved) {
      const workspace = JSON.parse(saved) as Partial<StoredWorkspace>
      const documents = Array.isArray(workspace.documents)
        ? workspace.documents.filter(isJsonViewDocument)
        : []
      if (documents.length > 0) {
        const activeDocument =
          documents.find(
            (document) => document.id === workspace.activeDocumentId,
          ) ?? documents[0]
        return {
          activeDocumentId: activeDocument.id,
          documents,
          document: hydrateDocument(activeDocument),
        }
      }
    }
  } catch {
    // Fall through to the legacy single-document storage.
  }

  const document = loadInitialDocument()
  const initialView: JsonViewDocument = {
    id: createDocumentId(),
    name: document.name,
    source: document.source,
  }
  return {
    activeDocumentId: initialView.id,
    documents: [initialView],
    document,
  }
}

function clampEditorFontSize(size: number): number {
  return Math.min(
    EDITOR_FONT_MAX,
    Math.max(EDITOR_FONT_MIN, Math.round(size)),
  )
}

function loadInitialEditorFontSize(): number {
  const stored = Number(window.localStorage.getItem(EDITOR_FONT_KEY))
  if (!Number.isFinite(stored)) return EDITOR_FONT_DEFAULT
  return clampEditorFontSize(stored)
}

function loadInitialTheme(): boolean {
  const stored = window.localStorage.getItem(THEME_KEY)
  if (stored) return stored === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`
}

function collectContainerIds(value: JsonValue): Set<string> {
  const ids = new Set<string>()

  const visit = (current: JsonValue, path: JsonPath) => {
    if (!isContainer(current) || path.length > 32) return
    ids.add(pathToId(path))
    const entries = Array.isArray(current)
      ? current.map((item, index) => [index, item] as const)
      : Object.entries(current)
    entries.forEach(([key, child]) => visit(child, [...path, key]))
  }

  visit(value, [])
  return ids
}

export default function App() {
  const [initialWorkspace] = useState(loadInitialWorkspace)
  const initialDocument = initialWorkspace.document
  const [documents, setDocuments] = useState(initialWorkspace.documents)
  const [activeDocumentId, setActiveDocumentId] = useState(
    initialWorkspace.activeDocumentId,
  )
  const [documentName, setDocumentName] = useState(initialDocument.name)
  const [source, setSource] = useState(initialDocument.source)
  const [jsonValue, setJsonValue] = useState<JsonValue>(initialDocument.value)
  const [parseError, setParseError] = useState<string | null>(initialDocument.error)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [hiddenBranchIds, setHiddenBranchIds] = useState<Set<string>>(new Set())
  const [searchTerm, setSearchTerm] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchIndex, setSearchIndex] = useState(0)
  const [graphSearchFocusNonce, setGraphSearchFocusNonce] = useState(0)
  const [selectedPath, setSelectedPath] = useState<JsonPath | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [preserveViewportRequest, setPreserveViewportRequest] = useState(0)
  const [dark, setDark] = useState(loadInitialTheme)
  const [editorFontSize, setEditorFontSize] = useState(loadInitialEditorFontSize)
  const [editorVisible, setEditorVisible] = useState(true)
  const [sourcePanelWidth, setSourcePanelWidth] = useState<number | null>(null)
  const [resizingSource, setResizingSource] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState(loadHistory)
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareTargetId, setCompareTargetId] = useState<string | null>(null)
  const [editorContextMenu, setEditorContextMenu] =
    useState<EditorContextMenu | null>(null)
  const valueRef = useRef(jsonValue)
  const parseErrorRef = useRef(initialDocument.error)
  const documentsRef = useRef(initialWorkspace.documents)
  const editorViewRef = useRef<EditorView | null>(null)
  const sourceSearchRef = useRef<SourceSearchHandle | null>(null)
  const sourceSearchOpenRef = useRef(false)
  const openSourceSearchRef = useRef<(withReplace?: boolean) => void>(() => {})
  const clearSourceRef = useRef<() => void>(() => {})
  const openFromClipboardRef = useRef<() => void>(() => {})
  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const [sourceSearchOpen, setSourceSearchOpen] = useState(false)
  const syncingSelectionRef = useRef(false)
  const expectedEditorSelectionRef = useRef<{
    anchor: number
    head: number
  } | null>(null)
  const selectionSyncTimerRef = useRef<number | null>(null)
  const selectionOriginRef = useRef<'graph' | 'editor' | null>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const sourcePanelRef = useRef<HTMLElement>(null)
  const graphPanelRef = useRef<HTMLElement>(null)
  const activePaneRef = useRef<'source' | 'graph'>(
    editorVisible ? 'source' : 'graph',
  )
  const resizePointerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const compareMenuRef = useRef<HTMLDivElement>(null)
  const historyTimerRef = useRef<number | null>(null)
  const persistTimerRef = useRef<number | null>(null)
  const jsonApplyTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const dragDepthRef = useRef(0)
  const warnOnLeaveRef = useRef(false)

  const markWorkspaceEdited = useCallback(() => {
    warnOnLeaveRef.current = true
  }, [])

  const persistWorkspace = useCallback(() => {
    const currentDocuments = documentsRef.current
    const currentActiveId =
      currentDocuments.find((document) => document.id === activeDocumentId)
        ?.id ?? currentDocuments[0]?.id
    const activeDocument =
      currentDocuments.find((document) => document.id === currentActiveId) ??
      currentDocuments[0]
    if (!activeDocument || !currentActiveId) return

    try {
      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({
          activeDocumentId: currentActiveId,
          documents: currentDocuments,
        }),
      )
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          name: activeDocument.name,
          source: activeDocument.source,
        }),
      )
    } catch {
      // Local storage can be unavailable in privacy-restricted contexts.
    }
  }, [activeDocumentId])

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const recordSnapshot = useCallback(
    (document: { id: string; name: string; source: string }) => {
      const nextSource = document.source.trim() || '{}'
      if (nextSource === '{}' || nextSource === '[]') return
      try {
        JSON.parse(nextSource)
      } catch {
        return
      }
      setHistoryEntries(
        pushHistory({
          documentId: document.id,
          documentName: document.name,
          source: nextSource,
        }),
      )
    },
    [],
  )

  const dispatchEditorSelection = useCallback(
    (
      view: EditorView,
      anchor: number,
      head = anchor,
      scrollIntoView = false,
      scrollTo?: number,
    ) => {
      const expectedSelection = { anchor, head }
      expectedEditorSelectionRef.current = expectedSelection
      if (selectionSyncTimerRef.current !== null) {
        window.clearTimeout(selectionSyncTimerRef.current)
      }
      selectionSyncTimerRef.current = window.setTimeout(() => {
        if (expectedEditorSelectionRef.current === expectedSelection) {
          expectedEditorSelectionRef.current = null
        }
        selectionSyncTimerRef.current = null
      }, 300)

      syncingSelectionRef.current = true
      try {
        view.dispatch({
          selection: { anchor, head },
          ...(typeof scrollTo === 'number'
            ? {
                effects: EditorView.scrollIntoView(scrollTo, {
                  x: 'start',
                  xMargin: 12,
                  y: 'center',
                  yMargin: 0,
                }),
              }
            : { scrollIntoView }),
        })
      } finally {
        syncingSelectionRef.current = false
      }
    },
    [],
  )

  const resizeSourcePanel = useCallback((clientX: number) => {
    const workspace = workspaceRef.current
    if (!workspace) return

    const bounds = workspace.getBoundingClientRect()
    const dividerWidth = 6
    const minimumSourceWidth = 270
    const minimumGraphWidth = 360
    const maximumSourceWidth = Math.max(
      minimumSourceWidth,
      bounds.width - minimumGraphWidth - dividerWidth,
    )
    const nextWidth = Math.min(
      maximumSourceWidth,
      Math.max(minimumSourceWidth, clientX - bounds.left),
    )

    setSourcePanelWidth((nextWidth / bounds.width) * 100)
  }, [])

  const handleResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      resizePointerRef.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      setResizingSource(true)
      resizeSourcePanel(event.clientX)
    },
    [resizeSourcePanel],
  )

  const handleResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (resizePointerRef.current !== event.pointerId) return
      resizeSourcePanel(event.clientX)
    },
    [resizeSourcePanel],
  )

  const finishSourceResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (resizePointerRef.current !== event.pointerId) return
      resizePointerRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setResizingSource(false)
    },
    [],
  )

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const workspace = workspaceRef.current
      const sourcePanel = sourcePanelRef.current
      if (!workspace || !sourcePanel) return

      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      resizeSourcePanel(
        workspace.getBoundingClientRect().left +
          sourcePanel.getBoundingClientRect().width +
          direction * 16,
      )
    },
    [resizeSourcePanel],
  )

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
      if (selectionSyncTimerRef.current !== null) {
        window.clearTimeout(selectionSyncTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    window.localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  }, [dark])

  const changeEditorFontSize = useCallback(
    (nextSize: number | ((current: number) => number)) => {
      setEditorFontSize((current) =>
        clampEditorFontSize(
          typeof nextSize === 'function' ? nextSize(current) : nextSize,
        ),
      )
    },
    [],
  )

  useEffect(() => {
    window.localStorage.setItem(EDITOR_FONT_KEY, String(editorFontSize))
    editorViewRef.current?.requestMeasure()
  }, [editorFontSize])

  useEffect(() => {
    const panel = sourcePanelRef.current
    if (!panel) return

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      changeEditorFontSize((current) => current + (event.deltaY < 0 ? 1 : -1))
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (!panel.contains(document.activeElement)) return
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        changeEditorFontSize((current) => current + 1)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        changeEditorFontSize((current) => current - 1)
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        changeEditorFontSize(EDITOR_FONT_DEFAULT)
        return
      }
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault()
        openSourceSearchRef.current(true)
      }
    }

    panel.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [changeEditorFontSize, editorVisible])

  useEffect(() => {
    if (!editorVisible) {
      setSourceSearchOpen(false)
      activePaneRef.current = 'graph'
    }
  }, [editorVisible])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return

    const rememberPane = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (sourcePanelRef.current?.contains(target)) {
        activePaneRef.current = 'source'
        return
      }
      if (graphPanelRef.current?.contains(target)) {
        activePaneRef.current = 'graph'
      }
    }

    workspace.addEventListener('pointerdown', rememberPane, true)
    workspace.addEventListener('focusin', rememberPane)
    return () => {
      workspace.removeEventListener('pointerdown', rememberPane, true)
      workspace.removeEventListener('focusin', rememberPane)
    }
  }, [editorVisible])

  const closeGraphSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchTerm('')
    setSearchIndex(0)
  }, [])

  const openGraphSearch = useCallback(() => {
    setSourceSearchOpen(false)
    setSearchOpen(true)
    setGraphSearchFocusNonce((current) => current + 1)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.shiftKey) return
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      event.stopPropagation()
      if (editorVisible && activePaneRef.current === 'source') {
        closeGraphSearch()
        openSourceSearchRef.current(false)
        return
      }
      openGraphSearch()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closeGraphSearch, editorVisible, openGraphSearch])

  useEffect(() => {
    if (!editorVisible) return

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
      if (event.key !== 'Backspace' && event.key !== 'Delete') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, .cm-editor')) return
      event.preventDefault()
      clearSourceRef.current()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editorVisible])

  useEffect(() => {
    document.title = 'JSON Canvas'
    setDocuments((current) => {
      const activeDocument = current.find(
        (document) => document.id === activeDocumentId,
      )
      if (
        !activeDocument ||
        (activeDocument.name === documentName &&
          activeDocument.source === source)
      ) {
        documentsRef.current = current
        return current
      }

      const next = current.map((document) =>
        document.id === activeDocumentId
          ? { ...document, name: documentName, source }
          : document,
      )
      documentsRef.current = next
      return next
    })
  }, [activeDocumentId, documentName, source])

  useEffect(() => {
    documentsRef.current = documents
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistWorkspace()
      persistTimerRef.current = null
    }, 450)
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
    }
  }, [activeDocumentId, documents, persistWorkspace])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      persistWorkspace()
      if (!warnOnLeaveRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [persistWorkspace])

  useEffect(() => {
    return () => {
      if (jsonApplyTimerRef.current !== null) {
        window.clearTimeout(jsonApplyTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const view = editorViewRef.current
    if (
      !view ||
      selectedPath === null ||
      parseError ||
      selectionOriginRef.current !== 'graph'
    ) {
      return
    }

    const range = locateJsonPath(source, selectedPath, true)
    if (!range) {
      selectionOriginRef.current = null
      return
    }

    window.requestAnimationFrame(() => {
      if (selectionOriginRef.current !== 'graph') return
      selectionOriginRef.current = null
      dispatchEditorSelection(view, range.from, range.to, false, range.from)
    })
  }, [
    dispatchEditorSelection,
    parseError,
    selectedPath,
    source,
  ])

  const clearSelection = useCallback(() => {
    selectionOriginRef.current = null
    setSelectedPath(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    const view = editorViewRef.current
    if (!view) return
    const head = view.state.selection.main.head
    dispatchEditorSelection(view, head)
  }, [dispatchEditorSelection])

  const handleSourceChange = useCallback((nextSource: string) => {
    markWorkspaceEdited()
    const compactedSource = compactJsonIndentation(nextSource)
    setSource(compactedSource)
    if (!compactedSource.trim()) {
      if (jsonApplyTimerRef.current !== null) {
        window.clearTimeout(jsonApplyTimerRef.current)
        jsonApplyTimerRef.current = null
      }
      const emptyValue: JsonValue = {}
      valueRef.current = emptyValue
      parseErrorRef.current = null
      setJsonValue(emptyValue)
      setParseError(null)
      return
    }

    try {
      const nextValue = JSON.parse(compactedSource) as JsonValue
      valueRef.current = nextValue
      parseErrorRef.current = null
      setParseError(null)
      if (jsonApplyTimerRef.current !== null) {
        window.clearTimeout(jsonApplyTimerRef.current)
      }
      jsonApplyTimerRef.current = window.setTimeout(() => {
        jsonApplyTimerRef.current = null
        setJsonValue(nextValue)
        selectionOriginRef.current = null
        setSelectedPath(null)
        setSelectedNodeId(null)
        setSelectedEdgeId(null)
      }, 140)
    } catch (error) {
      const message = getJsonError(error)
      parseErrorRef.current = message
      setParseError(message)
    }
  }, [markWorkspaceEdited])

  useEffect(() => {
    if (parseError) return
    if (historyTimerRef.current !== null) {
      window.clearTimeout(historyTimerRef.current)
    }
    historyTimerRef.current = window.setTimeout(() => {
      recordSnapshot({
        id: activeDocumentId,
        name: documentName,
        source,
      })
      historyTimerRef.current = null
    }, 2000)
    return () => {
      if (historyTimerRef.current !== null) {
        window.clearTimeout(historyTimerRef.current)
      }
    }
  }, [activeDocumentId, documentName, parseError, recordSnapshot, source])

  useEffect(() => {
    if (!historyOpen) return
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (historyMenuRef.current?.contains(event.target as Node)) return
      setHistoryOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryOpen(false)
    }
    window.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [historyOpen])

  useEffect(() => {
    if (!compareOpen) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setCompareOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [compareOpen])

  const activateDocument = useCallback((document: JsonViewDocument) => {
    const compactedSource = compactJsonIndentation(document.source)
    selectionOriginRef.current = null
    setDocumentName(document.name)
    setSource(compactedSource)
    setSearchTerm('')
    setSearchOpen(false)
    setSearchIndex(0)
    setCollapsedIds(new Set())
    setHiddenBranchIds(new Set())
    setSelectedPath(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setFocusRequest(null)

    if (!compactedSource.trim()) {
      const emptyValue: JsonValue = {}
      valueRef.current = emptyValue
      parseErrorRef.current = null
      setJsonValue(emptyValue)
      setParseError(null)
      return
    }

    try {
      const nextValue = JSON.parse(compactedSource) as JsonValue
      valueRef.current = nextValue
      parseErrorRef.current = null
      setJsonValue(nextValue)
      setParseError(null)
    } catch (error) {
      const emptyValue: JsonValue = {}
      valueRef.current = emptyValue
      const message = getJsonError(error)
      parseErrorRef.current = message
      setJsonValue(emptyValue)
      setParseError(message)
    }
  }, [])

  const snapshotActiveDocument = useCallback(() => {
    const next = documentsRef.current.map((document) =>
      document.id === activeDocumentId
        ? { ...document, name: documentName, source }
        : document,
    )
    documentsRef.current = next
    return next
  }, [activeDocumentId, documentName, source])

  const switchDocument = useCallback(
    (documentId: string) => {
      if (documentId === activeDocumentId) return
      const currentDocuments = snapshotActiveDocument()
      const target = currentDocuments.find(
        (document) => document.id === documentId,
      )
      if (!target) return

      setDocuments(currentDocuments)
      setActiveDocumentId(target.id)
      activateDocument(target)
    },
    [activateDocument, activeDocumentId, snapshotActiveDocument],
  )

  const handleFocus = useCallback((path: JsonPath) => {
    selectionOriginRef.current = 'graph'
    setHiddenBranchIds((current) => {
      const next = new Set(current)
      for (let index = 1; index <= path.length; index += 1) {
        next.delete(pathToId(path.slice(0, index)))
      }
      return next
    })
    setCollapsedIds((current) => {
      const next = new Set(current)
      for (let index = 0; index <= path.length; index += 1) {
        next.delete(pathToId(path.slice(0, index)))
      }
      return next
    })
    setSelectedEdgeId(null)
    setSelectedPath(path)
    setSelectedNodeId(pathToId(path))
    setFocusRequest({
      id: pathToId(path),
      nonce: Date.now(),
    })
  }, [])

  const handleToggle = useCallback((path: JsonPath) => {
    setPreserveViewportRequest((current) => current + 1)
    const id = pathToId(path)
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleToggleBranch = useCallback(
    (path: JsonPath) => {
      clearSelection()
      setPreserveViewportRequest((current) => current + 1)
      const id = pathToId(path)
      setHiddenBranchIds((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [clearSelection],
  )

  const handleSelect = useCallback((sourcePath: JsonPath, nodePath: JsonPath) => {
    selectionOriginRef.current = 'graph'
    setSelectedEdgeId(null)
    setSelectedPath(sourcePath)
    setSelectedNodeId(pathToId(nodePath))
  }, [])

  const handleSelectEdge = useCallback(
    (edgeId: string, sourcePath: JsonPath) => {
      selectionOriginRef.current = 'graph'
      setSelectedEdgeId(edgeId)
      setSelectedPath(sourcePath)
      setSelectedNodeId(null)
    },
    [],
  )

  useEffect(() => {
    if (!editorContextMenu) return

    const closeMenu = () => setEditorContextMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
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
  }, [editorContextMenu])

  const handleCopyGraphItem = useCallback(
    (text: string, kind: 'key' | 'value' | 'path') => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(text)
          showToast(
            `${kind === 'key' ? 'Key' : kind === 'value' ? 'Value' : text} 已复制`,
          )
        } catch {
          showToast('复制失败，请稍后重试')
        }
      })()
    },
    [showToast],
  )

  const handleEditorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const view = editorViewRef.current
      if (!view || parseError) return

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      let offset = pos ?? view.state.selection.main.head
      const line = view.state.doc.lineAt(offset)
      const firstContentIndex = line.text.search(/\S/)
      if (firstContentIndex >= 0 && offset <= line.from + firstContentIndex) {
        offset = line.from + firstContentIndex
      }

      const location =
        findJsonPathAtOffset(view.state.doc.toString(), offset) ??
        (selectedPath
          ? { path: selectedPath, from: 0, to: 0, isContainer: false }
          : null)
      if (!location) {
        event.preventDefault()
        showToast('请先选中一个字段')
        return
      }

      event.preventDefault()

      let value: JsonValue
      try {
        value = getAtPath(jsonValue, location.path)
      } catch {
        showToast('无法读取该字段')
        return
      }

      const keyLabel = copyKeyForPath(location.path, documentName || '$')
      const cardPath = cardPathForSelection(jsonValue, location.path)

      selectionOriginRef.current = 'editor'
      setSelectedEdgeId(null)
      setSelectedPath(location.path)
      setSelectedNodeId(pathToId(cardPath))
      setEditorContextMenu({
        copyKey: keyLabel,
        copyValue: formatCopyValue(value),
        keyLabel,
        pathLabel: formatPath(location.path),
        type: getValueType(value),
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 156)),
      })
    },
    [documentName, jsonValue, parseError, selectedPath, showToast],
  )

  const copyEditorContextItem = useCallback(
    (kind: 'key' | 'value' | 'path') => {
      if (!editorContextMenu) return
      handleCopyGraphItem(
        kind === 'key'
          ? editorContextMenu.copyKey
          : kind === 'path'
            ? editorContextMenu.pathLabel
            : editorContextMenu.copyValue,
        kind,
      )
      setEditorContextMenu(null)
    },
    [editorContextMenu, handleCopyGraphItem],
  )

  const handleEditGraphValue = useCallback(
    (path: JsonPath, nextValue: JsonValue) => {
      markWorkspaceEdited()
      const nextJsonValue = updateAtPath(valueRef.current, path, () => nextValue)
      valueRef.current = nextJsonValue
      selectionOriginRef.current = null
      setJsonValue(nextJsonValue)
      setSource(JSON.stringify(nextJsonValue, null, 2))
      parseErrorRef.current = null
      setParseError(null)
      setPreserveViewportRequest((current) => current + 1)
      showToast('Value 已更新')
    },
    [markWorkspaceEdited, showToast],
  )

  const graphActions = useMemo<GraphActions>(
    () => ({
      onFocus: handleFocus,
      onSelect: handleSelect,
      onCopy: handleCopyGraphItem,
      onEditValue: handleEditGraphValue,
      onToggle: handleToggle,
      onToggleBranch: handleToggleBranch,
    }),
    [
      handleCopyGraphItem,
      handleEditGraphValue,
      handleFocus,
      handleSelect,
      handleToggle,
      handleToggleBranch,
    ],
  )

  const compareTargets = useMemo(
    () =>
      documents
        .filter((document) => document.id !== activeDocumentId)
        .map((document) => ({
          id: document.id,
          name: document.name || 'Untitled',
        })),
    [activeDocumentId, documents],
  )

  const compareLeftValue = useMemo(() => {
    if (!compareOpen || !compareTargetId) return null
    const target = documents.find((document) => document.id === compareTargetId)
    if (!target) return null
    return parseJsonDocument(target.source)
  }, [compareOpen, compareTargetId, documents])

  const compareDiffs = useMemo(() => {
    if (!compareOpen || compareLeftValue === null) return []
    return diffJson(compareLeftValue, jsonValue)
  }, [compareOpen, compareLeftValue, jsonValue])

  const diffByPath = useMemo(
    () => (compareOpen ? diffKindByPath(compareDiffs) : undefined),
    [compareDiffs, compareOpen],
  )

  useEffect(() => {
    if (!compareOpen) return
    if (compareTargets.length === 0) {
      setCompareOpen(false)
      setCompareTargetId(null)
      return
    }
    if (
      compareTargetId &&
      compareTargets.some((target) => target.id === compareTargetId)
    ) {
      return
    }
    setCompareTargetId(compareTargets[0]?.id ?? null)
  }, [compareOpen, compareTargetId, compareTargets])

  const graph = useMemo(
    () =>
      buildGraph(
        jsonValue,
        collapsedIds,
        hiddenBranchIds,
        searchTerm,
        documentName,
        graphActions,
        diffByPath,
      ),
    [
      collapsedIds,
      diffByPath,
      documentName,
      graphActions,
      hiddenBranchIds,
      jsonValue,
      searchTerm,
    ],
  )
  const stats = useMemo(() => getJsonStats(jsonValue), [jsonValue])
  const graphCollapsed =
    stats.objects + stats.arrays > 0 &&
    collapsedIds.size >= stats.objects + stats.arrays

  const handleToggleGraphCollapse = useCallback(() => {
    setPreserveViewportRequest((current) => current + 1)
    setCollapsedIds(graphCollapsed ? new Set() : collectContainerIds(jsonValue))
  }, [graphCollapsed, jsonValue])

  const sourceBytes = useMemo(() => utf8ByteLength(source), [source])
  const jsonExtension = useMemo(
    () => jsonLanguageExtensions(dark),
    [dark],
  )
  const sourceSearchExtension = useMemo(
    () => [
      search({ top: true }),
      Prec.high(
        keymap.of([
          {
            key: 'Mod-f',
            preventDefault: true,
            stopPropagation: true,
            run: () => {
              openSourceSearchRef.current(false)
              return true
            },
          },
          {
            key: 'Mod-h',
            preventDefault: true,
            stopPropagation: true,
            run: () => {
              openSourceSearchRef.current(true)
              return true
            },
          },
          {
            key: 'Mod-Shift-Backspace',
            preventDefault: true,
            stopPropagation: true,
            run: () => {
              clearSourceRef.current()
              return true
            },
          },
          {
            key: 'Mod-Shift-Delete',
            preventDefault: true,
            stopPropagation: true,
            run: () => {
              clearSourceRef.current()
              return true
            },
          },
          {
            key: 'F3',
            run: () => {
              if (sourceSearchOpenRef.current) {
                sourceSearchRef.current?.move(1)
              } else {
                openSourceSearchRef.current(false)
              }
              return true
            },
            shift: () => {
              if (sourceSearchOpenRef.current) {
                sourceSearchRef.current?.move(-1)
              } else {
                openSourceSearchRef.current(false)
              }
              return true
            },
          },
          {
            key: 'Mod-g',
            preventDefault: true,
            run: () => {
              sourceSearchRef.current?.move(1)
              return true
            },
            shift: () => {
              sourceSearchRef.current?.move(-1)
              return true
            },
          },
        ]),
      ),
    ],
    [],
  )
  const editorExtensions = useMemo(
    () => [...jsonExtension, ...sourceSearchExtension],
    [jsonExtension, sourceSearchExtension],
  )

  sourceSearchOpenRef.current = sourceSearchOpen
  openSourceSearchRef.current = (withReplace = false) => {
    const view = editorViewRef.current
    if (!view) return
    sourceSearchRef.current?.open(view, withReplace)
  }

  const handleEditorUpdate = useCallback(
    (update: ViewUpdate) => {
      if (update.docChanged || !update.selectionSet) {
        return
      }
      if (parseErrorRef.current) return

      const selection = update.state.selection.main
      const expectedSelection = expectedEditorSelectionRef.current
      if (
        expectedSelection &&
        ((selection.anchor === expectedSelection.anchor &&
          selection.head === expectedSelection.head) ||
          (selection.anchor === expectedSelection.head &&
            selection.head === expectedSelection.anchor))
      ) {
        return
      }
      if (syncingSelectionRef.current) return

      if (
        !selection.empty &&
        selection.from === 0 &&
        selection.to === update.state.doc.length
      ) {
        selectionOriginRef.current = 'editor'
        setSelectedEdgeId(null)
        setSelectedPath(null)
        setSelectedNodeId(null)
        setFocusRequest(null)
        return
      }

      let offset = selection.empty ? selection.head : selection.from
      const line = update.state.doc.lineAt(offset)
      const firstContentIndex = line.text.search(/\S/)
      if (firstContentIndex >= 0 && offset <= line.from + firstContentIndex) {
        offset = line.from + firstContentIndex
      }

      const sourceText = update.state.doc.toString()
      const location = findJsonPathAtOffset(sourceText, offset)
      if (!location) return

      const cardPath = cardPathForSelection(jsonValue, location.path)
      const nodeId = pathToId(cardPath)

      setHiddenBranchIds((current) => {
        const next = new Set(current)
        for (let index = 1; index <= location.path.length; index += 1) {
          next.delete(pathToId(location.path.slice(0, index)))
        }
        return next
      })
      setCollapsedIds((current) => {
        const next = new Set(current)
        for (let index = 0; index <= cardPath.length; index += 1) {
          next.delete(pathToId(cardPath.slice(0, index)))
        }
        return next
      })

      selectionOriginRef.current = 'editor'
      setSelectedEdgeId(null)
      setSelectedPath(location.path)
      setSelectedNodeId(nodeId)
      setFocusRequest({
        id: nodeId,
        nonce: Date.now(),
        path: location.path,
      })
    },
    [jsonValue],
  )

  const activateSearchMatch = useCallback(
    (index: number) => {
      const matches = graph.matches
      if (matches.length === 0) {
        setSearchIndex(0)
        return
      }
      const next = ((index % matches.length) + matches.length) % matches.length
      const match = matches[next]
      setSearchIndex(next)
      selectionOriginRef.current = 'graph'
      setSelectedEdgeId(null)
      setSelectedPath(match.path)
      setSelectedNodeId(match.nodeId)
      setFocusRequest({
        id: match.nodeId,
        nonce: Date.now(),
        path: match.path,
      })
    },
    [graph.matches],
  )

  useEffect(() => {
    if (!searchOpen || !searchTerm.trim()) {
      setSearchIndex(0)
      return
    }
    const match = graph.matches[0]
    if (!match) {
      setSearchIndex(0)
      return
    }
    setSearchIndex(0)
    selectionOriginRef.current = 'graph'
    setSelectedEdgeId(null)
    setSelectedPath(match.path)
    setSelectedNodeId(match.nodeId)
    setFocusRequest({
      id: match.nodeId,
      nonce: Date.now(),
      path: match.path,
    })
  }, [searchOpen, searchTerm])

  const formatSource = () => {
    if (parseError) {
      showToast('请先修复 JSON 语法错误')
      return
    }
    markWorkspaceEdited()
    setSource(JSON.stringify(jsonValue, null, 2))
    showToast('已格式化')
  }

  const sourceIsEmpty = source.trim() === '' || source.trim() === '{}'

  const clearSource = useCallback(() => {
    if (source.trim() === '' || source.trim() === '{}') return
    setCollapsedIds(new Set())
    setHiddenBranchIds(new Set())
    handleSourceChange('{}')
    showToast('已清空')
  }, [handleSourceChange, showToast, source])

  clearSourceRef.current = clearSource

  const createDocument = useCallback(() => {
    markWorkspaceEdited()
    const currentDocuments = snapshotActiveDocument()
    const existingNames = new Set(
      currentDocuments.map((document) => document.name),
    )
    let documentNumber = 1
    while (existingNames.has(`JSON ${documentNumber}`)) documentNumber += 1

    const nextDocument: JsonViewDocument = {
      id: createDocumentId(),
      name: `JSON ${documentNumber}`,
      source: '{}',
    }
    const nextDocuments = [...currentDocuments, nextDocument]
    documentsRef.current = nextDocuments
    setDocuments(nextDocuments)
    setActiveDocumentId(nextDocument.id)
    activateDocument(nextDocument)
  }, [activateDocument, markWorkspaceEdited, snapshotActiveDocument])

  const restoreHistoryEntry = useCallback(
    (entry: { documentName: string; source: string }) => {
      markWorkspaceEdited()
      const currentDocuments = snapshotActiveDocument()
      const existingNames = new Set(
        currentDocuments.map((document) => document.name),
      )
      const baseName = entry.documentName.trim() || 'Untitled'
      let name = baseName
      let suffix = 2
      while (existingNames.has(name)) {
        name = `${baseName} ${suffix}`
        suffix += 1
      }

      const nextDocument: JsonViewDocument = {
        id: createDocumentId(),
        name,
        source: entry.source,
      }
      const nextDocuments = [...currentDocuments, nextDocument]
      documentsRef.current = nextDocuments
      setDocuments(nextDocuments)
      setActiveDocumentId(nextDocument.id)
      activateDocument(nextDocument)
      setHistoryOpen(false)
      showToast(`已恢复到「${name}」`)
    },
    [activateDocument, markWorkspaceEdited, showToast, snapshotActiveDocument],
  )

  const openFromClipboard = useCallback(async () => {
    let text = ''
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('unsupported')
      }
      text = await Promise.race([
        navigator.clipboard.readText(),
        new Promise<string>((_, reject) => {
          window.setTimeout(() => reject(new Error('timeout')), 8000)
        }),
      ])
    } catch {
      showToast('无法读取剪贴板')
      return
    }

    const parsed = parseClipboardJson(text)
    if (!parsed) {
      showToast(text.trim() ? '剪贴板中没有有效 JSON' : '剪贴板为空')
      return
    }

    const nextSource = compactJsonIndentation(parsed.source)
    const toast = parsed.extracted
      ? '已从剪贴板提取 JSON'
      : '已从剪贴板打开'

    markWorkspaceEdited()
    const currentDocuments = snapshotActiveDocument()

    if (isBlankJsonSource(source)) {
      const keepName =
        documentName.trim() !== '' && documentName !== 'Untitled'
      setDocumentName(
        keepName
          ? documentName
          : uniqueDocumentName(
              currentDocuments
                .filter((document) => document.id !== activeDocumentId)
                .map((document) => document.name),
              'Clipboard',
            ),
      )
      handleSourceChange(nextSource)
      showToast(toast)
      return
    }

    const nextDocument: JsonViewDocument = {
      id: createDocumentId(),
      name: uniqueDocumentName(
        currentDocuments.map((document) => document.name),
        'Clipboard',
      ),
      source: nextSource,
    }
    const nextDocuments = [...currentDocuments, nextDocument]
    documentsRef.current = nextDocuments
    setDocuments(nextDocuments)
    setActiveDocumentId(nextDocument.id)
    activateDocument(nextDocument)
    showToast(toast)
  }, [
    activateDocument,
    activeDocumentId,
    documentName,
    handleSourceChange,
    markWorkspaceEdited,
    showToast,
    snapshotActiveDocument,
    source,
  ])

  openFromClipboardRef.current = () => {
    void openFromClipboard()
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.altKey || event.isComposing) return
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== 'v') return
      event.preventDefault()
      event.stopPropagation()
      openFromClipboardRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const closeDocument = useCallback(
    (documentId: string) => {
      markWorkspaceEdited()
      const currentDocuments = snapshotActiveDocument()
      const index = currentDocuments.findIndex(
        (document) => document.id === documentId,
      )
      if (index < 0) return

      const closing = currentDocuments[index]
      recordSnapshot({
        id: closing.id,
        name: closing.name,
        source: closing.source,
      })

      let nextDocuments = currentDocuments.filter(
        (document) => document.id !== documentId,
      )
      if (nextDocuments.length === 0) {
        nextDocuments = [
          {
            id: createDocumentId(),
            name: 'Untitled',
            source: '{}',
          },
        ]
      }

      documentsRef.current = nextDocuments
      setDocuments(nextDocuments)

      if (documentId !== activeDocumentId) return

      const fallback =
        nextDocuments[Math.min(index, nextDocuments.length - 1)]
      setActiveDocumentId(fallback.id)
      activateDocument(fallback)
    },
    [activateDocument, activeDocumentId, markWorkspaceEdited, recordSnapshot, snapshotActiveDocument],
  )

  const loadFile = useCallback(
    async (file: File) => {
      if (!file.name.toLocaleLowerCase().endsWith('.json')) {
        showToast('请选择 .json 文件')
        return
      }

      const content = await file.text()
      setDocumentName(file.name.replace(/\.json$/i, ''))
      handleSourceChange(content)
      showToast('文件已载入')
    },
    [handleSourceChange, showToast],
  )

  const clearDragActive = useCallback(() => {
    dragDepthRef.current = 0
    setDragActive(false)
  }, [])

  useEffect(() => {
    const isFileDrag = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }

    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0 || event.relatedTarget === null) {
        clearDragActive()
      }
    }

    const onDrop = (event: DragEvent) => {
      const file = isFileDrag(event) ? event.dataTransfer?.files[0] : undefined
      event.preventDefault()
      clearDragActive()
      if (file) void loadFile(file)
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') clearDragActive()
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', clearDragActive)
    window.addEventListener('blur', clearDragActive)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', clearDragActive)
      window.removeEventListener('blur', clearDragActive)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [clearDragActive, loadFile])

  const openCompare = useCallback(() => {
    if (compareTargets.length === 0) {
      setCompareOpen(false)
      showToast('请再打开一个 JSON 再对比')
      return
    }
    setHistoryOpen(false)
    setCompareOpen((open) => !open)
  }, [compareTargets.length, showToast])

  const downloadFile = () => {
    if (parseError) {
      showToast('无效 JSON 无法导出')
      return
    }

    const blob = new Blob([source], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${documentName.trim() || 'data'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    showToast('JSON 已下载')
  }

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
      showToast('已复制到剪贴板')
    } catch {
      showToast('复制失败，请在编辑器中手动复制')
    }
  }

  return (
    <div className={`app-shell ${dragActive ? 'is-dragging' : ''}`}>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <Braces size={18} strokeWidth={2.4} />
          </span>
          <span className="brand-name">JSON Canvas</span>
        </div>

        <div
          aria-label="JSONView 列表"
          className="document-tabs"
          role="tablist"
        >
          {documents.map((document) => {
            const active = document.id === activeDocumentId
            return (
              <div
                aria-selected={active}
                className={`document-meta ${active ? 'is-active' : ''} ${
                  active && parseError ? 'is-invalid' : ''
                }`}
                key={document.id}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  event.stopPropagation()
                  closeDocument(document.id)
                }}
                onClick={() => switchDocument(document.id)}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === 'Enter' || event.key === ' ')
                  ) {
                    event.preventDefault()
                    switchDocument(document.id)
                  }
                }}
                role="tab"
                tabIndex={active ? 0 : -1}
              >
                {active ? (
                  <input
                    aria-label="文档名称"
                    className="document-name"
                    onChange={(event) => {
                      markWorkspaceEdited()
                      setDocumentName(event.target.value)
                    }}
                    spellCheck={false}
                    value={documentName}
                  />
                ) : (
                  <span className="document-name document-name-label">
                    {document.name || 'Untitled'}
                  </span>
                )}
                <button
                  aria-label={`关闭 ${document.name || 'Untitled'}`}
                  className="document-close"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    closeDocument(document.id)
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  title="关闭"
                  type="button"
                >
                  <X size={10} strokeWidth={2} />
                </button>
              </div>
            )
          })}
          <button
            aria-label="新增 JSONView"
            className="toolbar-button add-document-view"
            onClick={createDocument}
            title="新增 JSONView"
            type="button"
          >
            <Plus size={15} />
          </button>
        </div>

        <span className={`validity ${parseError ? 'is-invalid' : ''}`}>
          {parseError ? <CircleAlert size={12} /> : <Check size={12} />}
          {parseError ? '语法错误' : '有效 JSON'}
        </span>

        <nav className="header-actions" aria-label="文档操作">
          <button
            className="toolbar-button"
            onClick={() => fileInputRef.current?.click()}
            title="打开 JSON"
            type="button"
          >
            <Upload size={17} />
          </button>
          <button
            className="toolbar-button"
            onClick={() => void openFromClipboard()}
            title="从剪贴板打开 (Ctrl+Shift+V)"
            type="button"
          >
            <ClipboardPaste size={17} />
          </button>
          <button className="toolbar-button" onClick={downloadFile} title="下载" type="button">
            <Download size={17} />
          </button>
          <div className="history-menu" ref={historyMenuRef}>
            <button
              aria-expanded={historyOpen}
              aria-haspopup="dialog"
              className={`toolbar-button ${historyOpen ? 'is-active' : ''}`}
              onClick={() => {
                setCompareOpen(false)
                setHistoryOpen((open) => !open)
              }}
              title="历史记录"
              type="button"
            >
              <History size={17} />
            </button>
            {historyOpen ? (
              <HistoryPanel
                entries={historyEntries}
                onClose={() => setHistoryOpen(false)}
                onDelete={(id) => setHistoryEntries(removeHistory(id))}
                onRestore={restoreHistoryEntry}
              />
            ) : null}
          </div>
          <div className="history-menu" ref={compareMenuRef}>
            <button
              aria-expanded={compareOpen}
              aria-haspopup="dialog"
              className={`toolbar-button ${compareOpen ? 'is-active' : ''}`}
              onClick={openCompare}
              title="版本对比"
              type="button"
            >
              <GitCompare size={17} />
            </button>
          </div>
          <span className="toolbar-divider" />
          <button
            className="toolbar-button theme-toggle"
            onClick={() => setDark((current) => !current)}
            title={dark ? '切换到浅色' : '切换到深色'}
            type="button"
          >
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </nav>

        <input
          accept=".json,application/json"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadFile(file)
            event.target.value = ''
          }}
          ref={fileInputRef}
          type="file"
        />
      </header>

      {compareOpen && compareTargetId && compareTargets.length > 0 ? (
        <ComparePanel
          currentName={documentName || 'Untitled'}
          diffs={compareDiffs}
          leftValue={compareLeftValue}
          onClose={() => setCompareOpen(false)}
          onFocus={(path) => {
            setCompareOpen(false)
            handleFocus(cardPathForSelection(jsonValue, path))
            setSelectedPath(path)
          }}
          onSelectTarget={setCompareTargetId}
          rightValue={jsonValue}
          targetId={compareTargetId}
          targets={compareTargets}
        />
      ) : null}

      <main
        className={`workspace ${editorVisible ? '' : 'editor-hidden'} ${
          resizingSource ? 'is-resizing' : ''
        }`}
        ref={workspaceRef}
        style={
          editorVisible && sourcePanelWidth !== null
            ? {
                gridTemplateColumns: `minmax(270px, ${sourcePanelWidth}%) 6px minmax(0, 1fr)`,
              }
            : undefined
        }
      >
        {editorVisible && (
          <section className="source-panel" ref={sourcePanelRef}>
            <div className="panel-header">
              <div className="panel-title">
                <span>Create Document</span>
                <small>{formatBytes(sourceBytes)}</small>
              </div>
              <div className="panel-actions">
                <div
                  className="font-size-control"
                  title="编辑器字号，Ctrl + 滚轮也可调节"
                >
                  <button
                    aria-label="缩小字号"
                    disabled={editorFontSize <= EDITOR_FONT_MIN}
                    onClick={() => changeEditorFontSize(editorFontSize - 1)}
                    type="button"
                  >
                    A−
                  </button>
                  <button
                    aria-label="重置字号"
                    className="font-size-value"
                    onClick={() => changeEditorFontSize(EDITOR_FONT_DEFAULT)}
                    type="button"
                  >
                    {editorFontSize}
                  </button>
                  <button
                    aria-label="放大字号"
                    disabled={editorFontSize >= EDITOR_FONT_MAX}
                    onClick={() => changeEditorFontSize(editorFontSize + 1)}
                    type="button"
                  >
                    A+
                  </button>
                </div>
                <button
                  className="icon-button"
                  onClick={() => openSourceSearchRef.current(false)}
                  title="查找 (Ctrl+F)"
                  type="button"
                >
                  <Search size={15} />
                </button>
                <button
                  className="panel-button"
                  onClick={() => void copySource()}
                  title="复制 JSON"
                  type="button"
                >
                  <Clipboard size={14} />
                  复制
                </button>
                <button
                  className="panel-button"
                  disabled={Boolean(parseError)}
                  onClick={formatSource}
                  title="格式化 JSON"
                  type="button"
                >
                  <Sparkles size={14} />
                  格式化
                </button>
                <button
                  className="panel-button"
                  disabled={sourceIsEmpty}
                  onClick={clearSource}
                  title="清空 JSON (Ctrl+Shift+Backspace)"
                  type="button"
                >
                  <Eraser size={14} />
                  清空
                </button>
                <button
                  className="icon-button"
                  onClick={() => setEditorVisible(false)}
                  title="隐藏源码"
                  type="button"
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
            </div>

            <div
              className="code-editor"
              onContextMenu={handleEditorContextMenu}
              style={{ ['--editor-font-size' as string]: `${editorFontSize}px` }}
            >
              <SourceSearch
                onOpenChange={setSourceSearchOpen}
                open={sourceSearchOpen}
                ref={sourceSearchRef}
                source={source}
                view={editorView}
              />
              <CodeMirror
                basicSetup={{
                  bracketMatching: true,
                  closeBrackets: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  highlightSelectionMatches: false,
                  lineNumbers: true,
                  searchKeymap: false,
                }}
                extensions={editorExtensions}
                height="100%"
                onChange={handleSourceChange}
                onCreateEditor={(view) => {
                  editorViewRef.current = view
                  setEditorView(view)
                }}
                onUpdate={handleEditorUpdate}
                theme="none"
                value={source}
              />
            </div>

            {parseError && (
              <div className="error-bar" title={parseError}>
                <CircleAlert size={14} />
                <span>{parseError}</span>
              </div>
            )}

            <footer className="source-footer">
              <span>{stats.values} 个值</span>
              <span>{stats.objects} 个对象</span>
              <span>{stats.arrays} 个数组</span>
              <span>深度 {stats.maxDepth}</span>
            </footer>
          </section>
        )}

        {editorVisible && (
          <div
            aria-label="调整源码与关系图的宽度"
            aria-orientation="vertical"
            aria-valuemax={70}
            aria-valuemin={20}
            aria-valuenow={Math.round(sourcePanelWidth ?? 25)}
            className="panel-resizer"
            onDoubleClick={() => setSourcePanelWidth(null)}
            onKeyDown={handleResizeKeyDown}
            onPointerCancel={finishSourceResize}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={finishSourceResize}
            role="separator"
            tabIndex={0}
            title="左右拖动调整宽度，双击恢复默认"
          />
        )}

        <section className="graph-panel" ref={graphPanelRef}>
          {!editorVisible && (
            <button
              aria-label="显示源码"
              className="reveal-editor"
              onClick={() => setEditorVisible(true)}
              title="显示源码"
              type="button"
            >
              <ChevronsRight size={15} strokeWidth={2.2} />
            </button>
          )}

          <Diagram
            dark={dark}
            definition={graph}
            focusRequest={focusRequest}
            graphCollapsed={graphCollapsed}
            onClearSelection={clearSelection}
            onToggleGraphCollapse={handleToggleGraphCollapse}
            onSearchChange={setSearchTerm}
            onSearchClose={closeGraphSearch}
            onSearchIndexChange={activateSearchMatch}
            onSearchOpen={openGraphSearch}
            onSelectEdge={handleSelectEdge}
            onToast={showToast}
            exportName={documentName}
            preserveViewportRequest={preserveViewportRequest}
            searchFocusNonce={graphSearchFocusNonce}
            searchIndex={searchIndex}
            searchOpen={searchOpen}
            searchTerm={searchTerm}
            selectedEdgeId={selectedEdgeId}
            selectedNodeId={selectedNodeId}
            selectedPath={selectedPath}
            stale={Boolean(parseError)}
          />
        </section>
      </main>

      {dragActive && (
        <div className="drop-overlay" onClick={clearDragActive} role="presentation">
          <Upload size={28} />
          <strong>放开以载入 JSON 文件</strong>
          <span>点击空白处或按 Esc 取消</span>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check size={15} />
          {toast}
        </div>
      )}

      {editorContextMenu &&
        createPortal(
          <div
            aria-label="源码字段操作菜单"
            className="json-row-context-menu source-context-menu"
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ left: editorContextMenu.x, top: editorContextMenu.y }}
          >
            <div className="json-row-context-menu-meta">
              <strong title={editorContextMenu.keyLabel}>
                {editorContextMenu.keyLabel}
              </strong>
              <code title={editorContextMenu.pathLabel}>
                {editorContextMenu.pathLabel}
              </code>
              <span>{editorContextMenu.type}</span>
            </div>
            <button
              autoFocus
              onClick={() => copyEditorContextItem('value')}
              role="menuitem"
              type="button"
            >
              <Copy size={13} />
              <span>复制 Value</span>
            </button>
            <button
              onClick={() => copyEditorContextItem('key')}
              role="menuitem"
              type="button"
            >
              <KeyRound size={13} />
              <span>复制 Key</span>
            </button>
            <button
              onClick={() => copyEditorContextItem('path')}
              role="menuitem"
              type="button"
            >
              <Link2 size={13} />
              <span>复制路径</span>
            </button>
          </div>,
          document.body,
        )}

      <div className="mobile-panel-toggle">
        <button
          className={editorVisible ? 'active' : ''}
          onClick={() => setEditorVisible(true)}
          type="button"
        >
          <ChevronRight size={14} />
          源码
        </button>
        <button
          className={!editorVisible ? 'active' : ''}
          onClick={() => setEditorVisible(false)}
          type="button"
        >
          <ChevronDown size={14} />
          图表
        </button>
      </div>
    </div>
  )
}
