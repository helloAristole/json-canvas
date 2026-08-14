import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  CircleAlert,
  Clipboard,
  Download,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Sparkles,
  Sun,
  Upload,
  X,
} from 'lucide-react'
import { Diagram, type FocusRequest } from './Diagram'
import { buildGraph, type GraphActions } from './graph'
import { findJsonPathAtOffset, locateJsonPath } from './jsonSource'
import {
  SAMPLE_JSON,
  getJsonError,
  getJsonStats,
  isContainer,
  pathToId,
  updateAtPath,
  type JsonPath,
  type JsonValue,
} from './json'

const STORAGE_KEY = 'json-canvas-document-v1'
const WORKSPACE_STORAGE_KEY = 'json-canvas-workspace-v2'
const THEME_KEY = 'json-canvas-theme'

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

function createDocumentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `json-view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function compactJsonIndentation(source: string): string {
  if (!source.trim()) return source

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
    if (!isContainer(current)) return
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
  const [selectedPath, setSelectedPath] = useState<JsonPath | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [preserveViewportRequest, setPreserveViewportRequest] = useState(0)
  const [dark, setDark] = useState(loadInitialTheme)
  const [editorVisible, setEditorVisible] = useState(true)
  const [sourcePanelWidth, setSourcePanelWidth] = useState<number | null>(null)
  const [resizingSource, setResizingSource] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const valueRef = useRef(jsonValue)
  const documentsRef = useRef(initialWorkspace.documents)
  const editorViewRef = useRef<EditorView | null>(null)
  const syncingSelectionRef = useRef(false)
  const expectedEditorSelectionRef = useRef<{
    anchor: number
    head: number
  } | null>(null)
  const selectionSyncTimerRef = useRef<number | null>(null)
  const selectionOriginRef = useRef<'graph' | 'editor' | null>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const sourcePanelRef = useRef<HTMLElement>(null)
  const resizePointerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimerRef = useRef<number | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const dispatchEditorSelection = useCallback(
    (
      view: EditorView,
      anchor: number,
      head = anchor,
      scrollIntoView = false,
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
          scrollIntoView,
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
    const activeDocument =
      documents.find((document) => document.id === activeDocumentId) ??
      documents[0]
    if (!activeDocument) return

    try {
      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ activeDocumentId, documents }),
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
  }, [activeDocumentId, documents])

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

    const range = locateJsonPath(
      source,
      selectedPath,
      selectedNodeId !== pathToId(selectedPath),
    )
    if (!range) {
      selectionOriginRef.current = null
      return
    }

    window.requestAnimationFrame(() => {
      if (selectionOriginRef.current !== 'graph') return
      selectionOriginRef.current = null
      dispatchEditorSelection(view, range.from, range.to, true)
    })
  }, [
    dispatchEditorSelection,
    parseError,
    selectedNodeId,
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
    const compactedSource = compactJsonIndentation(nextSource)
    selectionOriginRef.current = null
    setSelectedPath(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setSource(compactedSource)
    if (!compactedSource.trim()) {
      const emptyValue: JsonValue = {}
      valueRef.current = emptyValue
      setJsonValue(emptyValue)
      setParseError(null)
      return
    }

    try {
      const nextValue = JSON.parse(compactedSource) as JsonValue
      valueRef.current = nextValue
      setJsonValue(nextValue)
      setParseError(null)
    } catch (error) {
      setParseError(getJsonError(error))
    }
  }, [])

  const activateDocument = useCallback((document: JsonViewDocument) => {
    const compactedSource = compactJsonIndentation(document.source)
    selectionOriginRef.current = null
    setDocumentName(document.name)
    setSource(compactedSource)
    setSearchTerm('')
    setCollapsedIds(new Set())
    setHiddenBranchIds(new Set())
    setSelectedPath(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setFocusRequest(null)

    if (!compactedSource.trim()) {
      const emptyValue: JsonValue = {}
      valueRef.current = emptyValue
      setJsonValue(emptyValue)
      setParseError(null)
      return
    }

    try {
      const nextValue = JSON.parse(compactedSource) as JsonValue
      valueRef.current = nextValue
      setJsonValue(nextValue)
      setParseError(null)
    } catch (error) {
      const emptyValue: JsonValue = {}
      valueRef.current = emptyValue
      setJsonValue(emptyValue)
      setParseError(getJsonError(error))
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

  const handleCopyGraphItem = useCallback(
    (text: string, kind: 'key' | 'value') => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(text)
          showToast(`${kind === 'key' ? 'Key' : 'Value'} 已复制`)
        } catch {
          showToast('复制失败，请稍后重试')
        }
      })()
    },
    [showToast],
  )

  const handleEditGraphValue = useCallback(
    (path: JsonPath, nextValue: JsonValue) => {
      const nextJsonValue = updateAtPath(valueRef.current, path, () => nextValue)
      valueRef.current = nextJsonValue
      selectionOriginRef.current = null
      setJsonValue(nextJsonValue)
      setSource(JSON.stringify(nextJsonValue, null, 2))
      setParseError(null)
      setPreserveViewportRequest((current) => current + 1)
      showToast('Value 已更新')
    },
    [showToast],
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

  const graph = useMemo(
    () =>
      buildGraph(
        jsonValue,
        collapsedIds,
        hiddenBranchIds,
        searchTerm,
        documentName,
        selectedPath,
        selectedNodeId,
        selectedEdgeId,
        graphActions,
      ),
    [
      collapsedIds,
      documentName,
      graphActions,
      hiddenBranchIds,
      jsonValue,
      searchTerm,
      selectedEdgeId,
      selectedNodeId,
      selectedPath,
    ],
  )
  const stats = useMemo(() => getJsonStats(jsonValue), [jsonValue])
  const sourceBytes = useMemo(
    () => new TextEncoder().encode(source).byteLength,
    [source],
  )
  const jsonExtension = useMemo(
    () => [
      json(),
      syntaxHighlighting(
        HighlightStyle.define([
          {
            tag: tags.propertyName,
            color: dark ? '#7cc7f0' : '#287b9b',
            fontWeight: '600',
          },
          {
            tag: tags.string,
            color: dark ? '#f0a273' : '#aa3f49',
          },
          {
            tag: tags.number,
            color: dark ? '#73d6a2' : '#16845b',
          },
          {
            tag: tags.bool,
            color: dark ? '#c6a1f0' : '#7257f6',
          },
          {
            tag: tags.null,
            color: dark ? '#aeb5c4' : '#858b98',
            fontStyle: 'italic',
          },
          {
            tag: [tags.punctuation, tags.separator, tags.brace],
            color: dark ? '#9199aa' : '#656c79',
          },
          {
            tag: tags.escape,
            color: dark ? '#f1cf78' : '#a87413',
          },
          {
            tag: tags.invalid,
            color: dark ? '#ff7f8c' : '#d44e62',
            textDecoration: 'underline wavy',
          },
        ]),
      ),
    ],
    [dark],
  )

  const handleEditorUpdate = useCallback(
    (update: ViewUpdate) => {
      if (update.docChanged || !update.selectionSet) {
        return
      }

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
      if (selection.empty) {
        const line = update.state.doc.lineAt(selection.head)
        const firstContentIndex = line.text.search(/\S/)
        const firstContentOffset =
          firstContentIndex < 0 ? line.from : line.from + firstContentIndex
        if (offset <= firstContentOffset) offset = firstContentOffset
      }

      const sourceText = update.state.doc.toString()
      const location = findJsonPathAtOffset(sourceText, offset)
      if (!location) return

      const nodeIds = new Set(graph.nodes.map((node) => node.id))
      const nodePath = [...location.path]
      while (
        nodePath.length > 0 &&
        !nodeIds.has(pathToId(nodePath))
      ) {
        nodePath.pop()
      }

      const nodeId = pathToId(nodePath)
      if (!nodeIds.has(nodeId)) return

      selectionOriginRef.current = 'editor'
      setSelectedEdgeId(null)
      setSelectedPath(location.path)
      setSelectedNodeId(nodeId)
      setFocusRequest({ id: nodeId, nonce: Date.now() })
    },
    [graph.nodes],
  )

  const focusFirstMatch = () => {
    const node = graph.nodes.find((candidate) => candidate.data.matched)
    if (!node) return
    setFocusRequest({ id: node.id, nonce: Date.now() })
  }

  const formatSource = () => {
    if (parseError) {
      showToast('请先修复 JSON 语法错误')
      return
    }
    setSource(JSON.stringify(jsonValue, null, 2))
    showToast('已格式化')
  }

  const createDocument = useCallback(() => {
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
  }, [activateDocument, snapshotActiveDocument])

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
    <div
      className={`app-shell ${dragActive ? 'is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        setDragActive(false)
        const file = event.dataTransfer.files[0]
        if (file) void loadFile(file)
      }}
    >
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
                    onChange={(event) => setDocumentName(event.target.value)}
                    spellCheck={false}
                    value={documentName}
                  />
                ) : (
                  <span className="document-name document-name-label">
                    {document.name || 'Untitled'}
                  </span>
                )}
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
          <button className="toolbar-button" onClick={copySource} title="复制" type="button">
            <Clipboard size={17} />
          </button>
          <button className="toolbar-button" onClick={downloadFile} title="下载" type="button">
            <Download size={17} />
          </button>
          <span className="toolbar-divider" />
          <button
            className="toolbar-button"
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
                  className="icon-button"
                  onClick={() => setEditorVisible(false)}
                  title="隐藏源码"
                  type="button"
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
            </div>

            <div className="code-editor">
              <CodeMirror
                basicSetup={{
                  bracketMatching: true,
                  closeBrackets: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  highlightSelectionMatches: true,
                  lineNumbers: true,
                }}
                extensions={jsonExtension}
                height="100%"
                onChange={handleSourceChange}
                onCreateEditor={(view) => {
                  editorViewRef.current = view
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

        <section className="graph-panel">
          <div className="panel-header graph-header">
            <div className="panel-title graph-title">
              <span>关系图</span>
              <small>{graph.nodes.length} 个节点</small>
            </div>

            <div className="graph-tools">
              <label className="search-box">
                <Search size={14} />
                <input
                  aria-label="搜索键、值或路径"
                  onChange={(event) => setSearchTerm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') focusFirstMatch()
                  }}
                  placeholder="搜索键、值或路径"
                  value={searchTerm}
                />
                {searchTerm && (
                  <>
                    <span className="match-count">{graph.matchCount}</span>
                    <button
                      aria-label="清除搜索"
                      onClick={() => setSearchTerm('')}
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  </>
                )}
              </label>
              <button
                className="icon-button"
                onClick={() => {
                  setPreserveViewportRequest((current) => current + 1)
                  setCollapsedIds(collectContainerIds(jsonValue))
                }}
                title="全部折叠"
                type="button"
              >
                <Minimize2 size={16} />
              </button>
              <button
                className="icon-button"
                onClick={() => {
                  setPreserveViewportRequest((current) => current + 1)
                  setCollapsedIds(new Set())
                }}
                title="全部展开"
                type="button"
              >
                <Maximize2 size={16} />
              </button>
            </div>
          </div>

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
            onClearSelection={clearSelection}
            onSelectEdge={handleSelectEdge}
            preserveViewportRequest={preserveViewportRequest}
            selectedEdgeId={selectedEdgeId}
            selectedNodeId={selectedNodeId}
            stale={Boolean(parseError)}
          />
        </section>
      </main>

      {dragActive && (
        <div className="drop-overlay">
          <Upload size={28} />
          <strong>放开以载入 JSON 文件</strong>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check size={15} />
          {toast}
        </div>
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
