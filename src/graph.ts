import type { Edge, Node } from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import {
  copyKeyForPath,
  formatPath,
  getValueType,
  isContainer,
  pathMatchesQuery,
  pathToId,
  type JsonPath,
  type JsonPrimitive,
  type JsonValue,
  type JsonValueType,
} from './json'

export interface PrimitiveRow {
  keyLabel: string
  copyKey: string
  copyValue: string
  order: number
  path: JsonPath
  value: JsonPrimitive
  type: Exclude<JsonValueType, 'object' | 'array'>
  isArrayItem: boolean
  isRoot: boolean
  matched: boolean
  selected: boolean
  diff?: 'added' | 'changed'
  multiline: boolean
  height: number
  offsetY: number
}

export interface ContainerRow {
  keyLabel: string
  copyKey: string
  copyValue: string
  order: number
  path: JsonPath
  focusPath: JsonPath
  type: 'object' | 'array'
  size: number
  linked: boolean
  expanded: boolean
  isArrayItem: boolean
  matched: boolean
  selected: boolean
  diff?: 'added' | 'changed'
  height: number
  offsetY: number
}

export interface JsonNodeData extends Record<string, unknown> {
  title: string
  pathLabel: string
  path: JsonPath
  kind: JsonValueType
  tone: NodeTone
  size: number
  keyColumnWidth: number
  collapsed: boolean
  copyValue: string
  cardValue: JsonValue
  matched: boolean
  diff?: 'added' | 'changed'
  selectionState: 'normal' | 'selected' | 'dimmed'
  relationHoverState?: 'source' | 'target'
  hoveredSourcePathId?: string
  onMeasuredHeight?: (id: string, height: number) => void
  primitiveRows: PrimitiveRow[]
  containerRows: ContainerRow[]
  onFocus: (path: JsonPath) => void
  onSelect: (sourcePath: JsonPath, nodePath: JsonPath) => void
  onCopy: (text: string, kind: 'key' | 'value' | 'path') => void
  onEditValue: (path: JsonPath, value: JsonValue) => void
  onToggle: (path: JsonPath) => void
  onToggleBranch: (path: JsonPath) => void
}

export type JsonFlowNode = Node<JsonNodeData, 'jsonCard'>
export type NodeTone = 'cyan' | 'purple' | 'rose' | 'green' | 'amber'

export interface GraphActions {
  onFocus: JsonNodeData['onFocus']
  onSelect: JsonNodeData['onSelect']
  onCopy: JsonNodeData['onCopy']
  onEditValue: JsonNodeData['onEditValue']
  onToggle: JsonNodeData['onToggle']
  onToggleBranch: JsonNodeData['onToggleBranch']
}

export interface SearchMatch {
  keyLabel: string
  nodeId: string
  path: JsonPath
  pathLabel: string
  valueText: string
}

export const MAX_GRAPH_NODES = 280
const MAX_GRAPH_DEPTH = 24
const MAX_SEARCH_MATCHES = 300

export interface GraphDefinition {
  nodes: JsonFlowNode[]
  edges: Edge[]
  signature: string
  matchCount: number
  matches: SearchMatch[]
  truncated: boolean
}

const NODE_WIDTH = 240
const ROOT_NODE_WIDTH = 220
const MAX_CARD_WIDTH = 380
const ROW_HEIGHT = 24
export const HEADER_HEIGHT = 24
const NODE_VERTICAL_GAP = 20
const LAYER_HORIZONTAL_GAP = 76
const LAYER_PADDING_LEFT = 24
const LAYER_PADDING_TOP = 24
const MIN_KEY_COLUMN_WIDTH = 72
const MIN_VALUE_COLUMN_WIDTH = 112
const MULTILINE_LINE_HEIGHT = 16
const MULTILINE_ROW_PADDING = 10
const MULTILINE_CJK_WIDTH = 11
const MULTILINE_ASCII_WIDTH = 6.25
const MAX_MULTILINE_LINES = 12
const NODE_TONES: NodeTone[] = ['cyan', 'purple', 'green', 'amber', 'rose']

export function rowAnchorY(row: { height: number; offsetY: number }): number {
  return HEADER_HEIGHT + row.offsetY + row.height / 2
}

function isLongText(value: JsonPrimitive, valueWidth = MIN_VALUE_COLUMN_WIDTH): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\n')) return true
  return textPixelWidth(value) > valueWidth - 8
}

function neededValueWidth(value: JsonPrimitive): number {
  if (typeof value !== 'string' || value.length === 0) {
    return MIN_VALUE_COLUMN_WIDTH
  }
  if (value.includes('\n')) return MAX_CARD_WIDTH
  return Math.min(MAX_CARD_WIDTH, textPixelWidth(value) + 12)
}

function textPixelWidth(text: string): number {
  const sample = text.length > 160 ? text.slice(0, 160) : text
  return Array.from(sample).reduce(
    (width, character) => width + charPixelWidth(character),
    0,
  )
}

function charPixelWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0
  return code > 0xff ? MULTILINE_CJK_WIDTH : MULTILINE_ASCII_WIDTH
}

function wrapLineCount(line: string, maxWidth: number): number {
  if (line.length === 0) return 1
  let lines = 1
  let used = 0
  for (const character of Array.from(line)) {
    const width = Math.min(maxWidth, charPixelWidth(character))
    if (used > 0 && used + width > maxWidth) {
      lines += 1
      used = 0
    }
    used += width
  }
  return lines
}

function estimateWrappedLines(text: string, maxWidth: number): number {
  return text.split('\n').reduce(
    (count, line) => count + wrapLineCount(line, maxWidth),
    0,
  )
}

function estimateRowHeight(
  value: JsonPrimitive,
  valueWidth: number,
): { height: number; multiline: boolean } {
  if (typeof value !== 'string' || !isLongText(value, valueWidth)) {
    return { height: ROW_HEIGHT, multiline: false }
  }
  const lines = Math.min(
    MAX_MULTILINE_LINES,
    estimateWrappedLines(
      value.replace(/\n+$/u, ''),
      Math.max(80, valueWidth - 12),
    ),
  )
  return {
    multiline: true,
    height: Math.max(
      ROW_HEIGHT,
      Math.ceil(MULTILINE_ROW_PADDING + lines * MULTILINE_LINE_HEIGHT),
    ),
  }
}

function assignRowMetrics(
  primitiveRows: PrimitiveRow[],
  containerRows: ContainerRow[],
  valueWidth: number,
): number {
  const rows: Array<PrimitiveRow | ContainerRow> = [
    ...primitiveRows,
    ...containerRows,
  ].sort((left, right) => left.order - right.order)

  let offsetY = 0
  rows.forEach((row) => {
    const measured =
      'value' in row
        ? estimateRowHeight(row.value, valueWidth)
        : { height: ROW_HEIGHT, multiline: false }
    row.height = measured.height
    row.offsetY = offsetY
    if ('value' in row) row.multiline = measured.multiline
    offsetY += measured.height
  })
  return offsetY
}

function keyLabel(key: string | number, isRoot: boolean): string {
  if (isRoot) return 'value'
  return typeof key === 'number' ? `[${key}]` : key
}

function primitiveCopyValue(value: JsonPrimitive): string {
  if (typeof value === 'string') return value
  return value === null ? 'null' : String(value)
}

function textWidthUnits(text: string): number {
  return Array.from(text).reduce(
    (width, character) =>
      width + (character.codePointAt(0)! > 0xff ? 2 : 1),
    0,
  )
}

function getKeyColumnWidth(
  rows: Array<PrimitiveRow | ContainerRow>,
): number {
  const longestKey = rows.reduce(
    (longest, row) => Math.max(longest, textWidthUnits(row.keyLabel)),
    0,
  )
  return Math.max(MIN_KEY_COLUMN_WIDTH, Math.ceil(longestKey * 6 + 8))
}

function branchTone(
  parentTone: NodeTone,
  index: number,
): NodeTone {
  const parentIndex = NODE_TONES.indexOf(parentTone)
  const baseIndex = parentIndex < 0 ? 0 : parentIndex
  return NODE_TONES[(baseIndex + index + 1) % NODE_TONES.length]
}

function rowMatches(
  query: string,
  key: string | number,
  value: JsonValue,
  path: JsonPath,
): boolean {
  if (!query) return false
  if (pathMatchesQuery(formatPath(path), query)) return true
  if (String(key).toLocaleLowerCase().includes(query)) return true
  if (isContainer(value)) return false
  const text = value === null ? 'null' : String(value)
  return text.length > 240
    ? text.slice(0, 240).toLocaleLowerCase().includes(query)
    : text.toLocaleLowerCase().includes(query)
}

function searchableTitle(title: string): string {
  return title.replace(/\[\d+\]/g, '')
}

function rowDiff(
  diffByPath: Map<string, 'added' | 'changed'> | undefined,
  path: JsonPath,
): 'added' | 'changed' | undefined {
  if (!diffByPath || diffByPath.size === 0) return undefined
  for (let length = path.length; length >= 0; length -= 1) {
    const kind = diffByPath.get(formatPath(path.slice(0, length)))
    if (kind === 'added') return 'added'
    if (kind === 'changed' && length === path.length) return 'changed'
  }
  return undefined
}

export function buildGraph(
  value: JsonValue,
  collapsedIds: Set<string>,
  hiddenBranchIds: Set<string>,
  searchTerm: string,
  rootTitle: string,
  actions: GraphActions,
  diffByPath?: Map<string, 'added' | 'changed'>,
): GraphDefinition {
  const nodes: JsonFlowNode[] = []
  const edges: Edge[] = []
  const query = searchTerm.trim().toLocaleLowerCase()
  const matches: SearchMatch[] = []
  let truncated = false

  const visit = (
    current: JsonValue,
    path: JsonPath,
    title: string,
    tone: NodeTone,
    parentId?: string,
    sourcePath?: JsonPath,
    sourceChannelIndex?: number,
    sourceChannelCount?: number,
  ) => {
    if (nodes.length >= MAX_GRAPH_NODES || path.length > MAX_GRAPH_DEPTH) {
      truncated = true
      return
    }
    const id = pathToId(path)
    const kind = getValueType(current)
    const collapsed = collapsedIds.has(id)
    const primitiveRows: PrimitiveRow[] = []
    const containerRows: ContainerRow[] = []
    const entries: Array<[string | number, JsonValue]> = Array.isArray(current)
      ? current.map((item, index) => [index, item])
      : current !== null && typeof current === 'object'
        ? Object.entries(current)
        : [['value', current]]

    const isLeafPrimitive = !isContainer(current)
    entries.forEach(([key, child], order) => {
      const isRootPrimitive = path.length === 0 && isLeafPrimitive
      const childPath = isLeafPrimitive || isRootPrimitive ? path : [...path, key]
      const matched = rowMatches(query, key, child, childPath)
      if (matched && matches.length < MAX_SEARCH_MATCHES) {
        matches.push({
          keyLabel: String(key),
          nodeId: id,
          path: childPath,
          pathLabel: formatPath(childPath),
          valueText: isContainer(child)
            ? Array.isArray(child)
              ? `[${child.length} items]`
              : `{${Object.keys(child).length} keys}`
            : child === null
              ? 'null'
              : String(child),
        })
      }

      if (isContainer(child)) {
        const flattenedArray =
          Array.isArray(child) &&
          child.length > 0 &&
          child.every((item) => isContainer(item))
        const linked = Array.isArray(child)
          ? child.length > 0
          : Object.keys(child).length > 0
        containerRows.push({
          keyLabel: keyLabel(key, false),
          copyKey: copyKeyForPath(childPath, String(key)),
          copyValue: '',
          order,
          path: childPath,
          focusPath: flattenedArray ? [...childPath, 0] : childPath,
          type: Array.isArray(child) ? 'array' : 'object',
          size: Array.isArray(child) ? child.length : Object.keys(child).length,
          linked,
          expanded: !hiddenBranchIds.has(pathToId(childPath)),
          isArrayItem: typeof key === 'number',
          matched,
          selected: false,
          diff: rowDiff(diffByPath, childPath),
          height: ROW_HEIGHT,
          offsetY: 0,
        })
      } else {
        primitiveRows.push({
          keyLabel: isLeafPrimitive ? '' : keyLabel(key, isRootPrimitive),
          copyKey: copyKeyForPath(childPath, String(key)),
          copyValue: primitiveCopyValue(child),
          order,
          path: childPath,
          value: child,
          type: getValueType(child) as PrimitiveRow['type'],
          isArrayItem: typeof key === 'number',
          isRoot: isLeafPrimitive || isRootPrimitive,
          matched,
          selected: false,
          diff: rowDiff(diffByPath, childPath),
          multiline: false,
          height: ROW_HEIGHT,
          offsetY: 0,
        })
      }
    })

    const pathLabel = formatPath(path)
    const nodeMatched =
      Boolean(query) &&
      (pathMatchesQuery(pathLabel, query) ||
        searchableTitle(title).toLocaleLowerCase().includes(query))
    const size = isContainer(current)
      ? Array.isArray(current)
        ? current.length
        : Object.keys(current).length
      : 1
    const keyColumnWidth = isLeafPrimitive
      ? 0
      : getKeyColumnWidth([...primitiveRows, ...containerRows])
    const valueNeeded = Math.max(
      MIN_VALUE_COLUMN_WIDTH,
      ...primitiveRows.map((row) => neededValueWidth(row.value)),
    )
    const cardWidth = Math.min(
      MAX_CARD_WIDTH,
      Math.max(
        path.length === 0 ? ROOT_NODE_WIDTH : NODE_WIDTH,
        keyColumnWidth + valueNeeded + 14,
      ),
    )
    const valueColumnWidth = Math.max(80, cardWidth - keyColumnWidth - 14)
    const bodyHeight = assignRowMetrics(
      primitiveRows,
      containerRows,
      valueColumnWidth,
    )

    nodes.push({
      id,
      type: 'jsonCard',
      className: 'nodrag nopan',
      position: { x: 0, y: 0 },
      data: {
        title,
        pathLabel,
        path,
        kind,
        tone,
        size,
        keyColumnWidth,
        collapsed,
        copyValue: '',
        cardValue: current,
        matched: nodeMatched || primitiveRows.some((row) => row.matched) || containerRows.some((row) => row.matched),
        diff: rowDiff(diffByPath, path),
        selectionState: 'normal',
        primitiveRows,
        containerRows,
        ...actions,
      },
      style: {
        width: cardWidth,
        height: collapsed
          ? HEADER_HEIGHT
          : HEADER_HEIGHT + Math.max(bodyHeight, ROW_HEIGHT),
      },
    })

    if (parentId) {
      edges.push({
        id: `edge-${parentId}-${id}`,
        source: parentId,
        sourceHandle: sourcePath ? `source-${pathToId(sourcePath)}` : undefined,
        target: id,
        type: 'natural',
        data: {
          channelIndex: sourceChannelIndex ?? 0,
          channelCount: sourceChannelCount ?? 1,
        },
      })
    }

    if (!collapsed) {
      const linkedRows = containerRows.filter((row) => row.linked)
      linkedRows.forEach((row, branchIndex) => {
        if (!row.expanded) return
        const child = getChild(current, path, row.path)
        const childTone = branchTone(tone, branchIndex)

        if (
          Array.isArray(child) &&
          child.length > 0 &&
          child.every((item) => isContainer(item))
        ) {
          child.forEach((item, itemIndex) => {
            const itemPath = [...row.path, itemIndex]
            visit(
              item,
              itemPath,
              `${row.keyLabel}[${itemIndex}]`,
              childTone,
              id,
              row.path,
              branchIndex,
              linkedRows.length,
            )
          })
        } else {
          visit(
            child,
            row.path,
            row.keyLabel,
            childTone,
            id,
            row.path,
            branchIndex,
            linkedRows.length,
          )
        }
      })
    }
  }

  visit(value, [], rootTitle || 'Untitled', 'cyan')

  const signature = `${nodes
    .map((node) => `${node.id}:${node.style?.width}x${node.style?.height}`)
    .join('|')}::${edges
    .map((edge) => `${edge.source}:${edge.sourceHandle ?? ''}>${edge.target}`)
    .join('|')}`

  const rankedMatches = [...matches].sort((left, right) => {
    const needle = query.startsWith('$')
      ? query
      : query.startsWith('.')
        ? `$${query}`
        : query.includes('.') || query.includes('[')
          ? `$.${query}`
          : ''
    if (!needle) return 0
    const leftExact = left.pathLabel.toLocaleLowerCase() === needle ? 0 : 1
    const rightExact = right.pathLabel.toLocaleLowerCase() === needle ? 0 : 1
    return leftExact - rightExact
  })

  return {
    nodes,
    edges,
    signature,
    matchCount: rankedMatches.length,
    matches: rankedMatches,
    truncated,
  }
}

function getChild(parent: JsonValue, parentPath: JsonPath, childPath: JsonPath): JsonValue {
  const relativePart = childPath[parentPath.length]
  if (Array.isArray(parent) && typeof relativePart === 'number') return parent[relativePart]
  if (
    parent !== null &&
    typeof parent === 'object' &&
    !Array.isArray(parent) &&
    typeof relativePart === 'string'
  ) {
    return parent[relativePart]
  }
  return null
}

const elk = new ELK()

interface SubtreeLayout {
  bottomContour: number[]
  children: Array<{ layout: SubtreeLayout; subtreeOffsetY: number }>
  nodeHeight: number
  nodeId: string
  nodeOffsetY: number
  nodeWidth: number
  subtreeHeight: number
  topContour: number[]
}

function nodeBox(node: JsonFlowNode): { height: number; width: number } {
  return {
    height: Number(node.style?.height) || 0,
    width: Number(node.style?.width) || NODE_WIDTH,
  }
}

function childEdgesFor(
  nodeId: string,
  nodeById: Map<string, JsonFlowNode>,
  outgoingBySource: Map<string, Edge[]>,
): Edge[] {
  const parent = nodeById.get(nodeId)
  const edges = [...(outgoingBySource.get(nodeId) ?? [])]
  return edges.sort((left, right) => {
    const leftRow = parent?.data.containerRows.find(
      (row) => pathToId(row.path) === left.sourceHandle?.replace(/^source-/, ''),
    )
    const rightRow = parent?.data.containerRows.find(
      (row) => pathToId(row.path) === right.sourceHandle?.replace(/^source-/, ''),
    )
    const rowDelta = (leftRow?.offsetY ?? 0) - (rightRow?.offsetY ?? 0)
    if (rowDelta !== 0) return rowDelta
    return (leftRow?.order ?? 0) - (rightRow?.order ?? 0)
  })
}

function sourceRowAnchorY(parent: JsonFlowNode | undefined, edge: Edge): number {
  if (!parent) return HEADER_HEIGHT + ROW_HEIGHT / 2
  const handleId = edge.sourceHandle?.replace(/^source-/, '')
  const row = parent.data.containerRows.find(
    (item) => pathToId(item.path) === handleId,
  )
  return row ? rowAnchorY(row) : HEADER_HEIGHT + ROW_HEIGHT / 2
}

function packShift(
  mergedBottom: number[],
  topContour: number[],
): number {
  const overlap = Math.min(mergedBottom.length, topContour.length)
  let y = 0
  for (let depth = 0; depth < overlap; depth += 1) {
    y = Math.max(
      y,
      mergedBottom[depth] + NODE_VERTICAL_GAP - topContour[depth],
    )
  }
  return y
}

function mergePackedContour(
  mergedTop: number[],
  mergedBottom: number[],
  layout: SubtreeLayout,
  y: number,
) {
  layout.topContour.forEach((top, depth) => {
    const shiftedTop = top + y
    const shiftedBottom = layout.bottomContour[depth] + y
    if (depth >= mergedTop.length) {
      mergedTop[depth] = shiftedTop
      mergedBottom[depth] = shiftedBottom
      return
    }
    mergedTop[depth] = Math.min(mergedTop[depth], shiftedTop)
    mergedBottom[depth] = Math.max(mergedBottom[depth], shiftedBottom)
  })
}

function measureSubtree(
  nodeId: string,
  nodeById: Map<string, JsonFlowNode>,
  outgoingBySource: Map<string, Edge[]>,
): SubtreeLayout {
  const node = nodeById.get(nodeId)
  const { height: nodeHeight, width: nodeWidth } = node
    ? nodeBox(node)
    : { height: 0, width: NODE_WIDTH }
  const childEdges = childEdgesFor(nodeId, nodeById, outgoingBySource)

  if (childEdges.length === 0) {
    return {
      bottomContour: [nodeHeight],
      children: [],
      nodeHeight,
      nodeId,
      nodeOffsetY: 0,
      nodeWidth,
      subtreeHeight: nodeHeight,
      topContour: [0],
    }
  }

  const childLayouts = childEdges.map((edge) =>
    measureSubtree(edge.target, nodeById, outgoingBySource),
  )

  const packed: Array<{ layout: SubtreeLayout; y: number }> = []
  const mergedTop: number[] = []
  const mergedBottom: number[] = []

  childLayouts.forEach((layout, index) => {
    const preferredY =
      sourceRowAnchorY(node, childEdges[index]) -
      (layout.nodeOffsetY + layout.nodeHeight / 2)
    const y =
      packed.length === 0
        ? preferredY
        : Math.max(preferredY, packShift(mergedBottom, layout.topContour))
    packed.push({ layout, y })
    mergePackedContour(mergedTop, mergedBottom, layout, y)
  })

  const childrenTop = Math.min(...packed.map((item) => item.y))
  const childrenBottom = Math.max(
    ...packed.map((item) => item.y + item.layout.subtreeHeight),
  )
  const origin = Math.min(0, childrenTop)
  const nodeOffsetY = -origin
  const children = packed.map((item) => ({
    layout: item.layout,
    subtreeOffsetY: item.y - origin,
  }))
  const subtreeHeight = Math.max(
    nodeOffsetY + nodeHeight,
    childrenBottom - origin,
  )

  const topContour = [nodeOffsetY]
  const bottomContour = [nodeOffsetY + nodeHeight]
  children.forEach((child) => {
    child.layout.topContour.forEach((top, depth) => {
      const contourDepth = depth + 1
      const shiftedTop = top + child.subtreeOffsetY
      const shiftedBottom =
        child.layout.bottomContour[depth] + child.subtreeOffsetY
      if (contourDepth >= topContour.length) {
        topContour[contourDepth] = shiftedTop
        bottomContour[contourDepth] = shiftedBottom
        return
      }
      topContour[contourDepth] = Math.min(topContour[contourDepth], shiftedTop)
      bottomContour[contourDepth] = Math.max(
        bottomContour[contourDepth],
        shiftedBottom,
      )
    })
  })

  return {
    bottomContour,
    children,
    nodeHeight,
    nodeId,
    nodeOffsetY,
    nodeWidth,
    subtreeHeight,
    topContour,
  }
}

function collectLayerWidths(
  layout: SubtreeLayout,
  depth: number,
  widths: number[],
) {
  widths[depth] = Math.max(widths[depth] ?? 0, layout.nodeWidth)
  layout.children.forEach((child) => {
    collectLayerWidths(child.layout, depth + 1, widths)
  })
}

function layerOrigins(widths: number[]): number[] {
  const origins = [LAYER_PADDING_LEFT]
  widths.forEach((width, depth) => {
    origins[depth + 1] = origins[depth] + width + LAYER_HORIZONTAL_GAP
  })
  return origins
}

function assignSubtreePositions(
  layout: SubtreeLayout,
  depth: number,
  subtreeY: number,
  origins: number[],
  positions: Map<string, { x: number; y: number }>,
) {
  positions.set(layout.nodeId, {
    x: origins[depth] ?? LAYER_PADDING_LEFT,
    y: subtreeY + layout.nodeOffsetY,
  })
  layout.children.forEach((child) => {
    assignSubtreePositions(
      child.layout,
      depth + 1,
      subtreeY + child.subtreeOffsetY,
      origins,
      positions,
    )
  })
}

function layoutGraphRight(
  nodes: JsonFlowNode[],
  edges: Edge[],
): JsonFlowNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const outgoingBySource = new Map<string, Edge[]>()
  const incomingTargets = new Set<string>()
  edges.forEach((edge) => {
    const outgoing = outgoingBySource.get(edge.source) ?? []
    outgoing.push(edge)
    outgoingBySource.set(edge.source, outgoing)
    incomingTargets.add(edge.target)
  })

  const positions = new Map<string, { x: number; y: number }>()
  const roots = nodes.filter((node) => !incomingTargets.has(node.id))
  let forestY = LAYER_PADDING_TOP
  roots.forEach((root) => {
    const layout = measureSubtree(root.id, nodeById, outgoingBySource)
    const widths: number[] = []
    collectLayerWidths(layout, 0, widths)
    assignSubtreePositions(
      layout,
      0,
      forestY,
      layerOrigins(widths),
      positions,
    )
    forestY += layout.subtreeHeight + NODE_VERTICAL_GAP
  })

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }))
}

export async function layoutGraph(
  nodes: JsonFlowNode[],
  edges: Edge[],
  direction: 'RIGHT' | 'DOWN',
): Promise<JsonFlowNode[]> {
  if (direction === 'RIGHT') {
    return layoutGraphRight(nodes, edges)
  }

  const graph = await elk.layout({
    id: 'json-graph',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': String(NODE_VERTICAL_GAP),
      'elk.padding': '[top=36,left=36,bottom=52,right=36]',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: Number(node.style?.width) || NODE_WIDTH,
      height: Number(node.style?.height) || 180,
      layoutOptions: {
        'elk.nodeSize.constraints': 'FIXED',
      },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  })

  const positions = new Map(
    graph.children?.map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  )
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  nodes.forEach((node) => {
    const targets = edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => edge.target)
    if (targets.length < 2) return

    const targetBounds = targets
      .map((targetId) => {
        const position = positions.get(targetId)
        const target = nodeById.get(targetId)
        if (!position || !target) return null
        return {
          top: position.y,
          bottom: position.y + (Number(target.style?.height) || 0),
        }
      })
      .filter(
        (bounds): bounds is { top: number; bottom: number } =>
          bounds !== null,
      )
    if (targetBounds.length < 2) return

    const position = positions.get(node.id)
    if (!position) return
    const top = Math.min(...targetBounds.map((bounds) => bounds.top))
    const bottom = Math.max(...targetBounds.map((bounds) => bounds.bottom))
    positions.set(node.id, {
      ...position,
      y: (top + bottom - (Number(node.style?.height) || 0)) / 2,
    })
  })

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }))
}
