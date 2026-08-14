import type { Edge, Node } from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import {
  formatPath,
  getValueType,
  isContainer,
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
  matched: boolean
  selectionState: 'normal' | 'selected' | 'dimmed'
  relationHoverState?: 'source' | 'target'
  hoveredSourcePathId?: string
  primitiveRows: PrimitiveRow[]
  containerRows: ContainerRow[]
  onFocus: (path: JsonPath) => void
  onSelect: (sourcePath: JsonPath, nodePath: JsonPath) => void
  onCopy: (text: string, kind: 'key' | 'value') => void
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

export interface GraphDefinition {
  nodes: JsonFlowNode[]
  edges: Edge[]
  signature: string
  matchCount: number
  dimUnselected: boolean
}

const NODE_WIDTH = 220
const ROOT_NODE_WIDTH = 190
const ROW_HEIGHT = 24
const HEADER_HEIGHT = 24
const NODE_VERTICAL_GAP = 24
const MIN_KEY_COLUMN_WIDTH = 72
const MIN_VALUE_COLUMN_WIDTH = 112
const NODE_TONES: NodeTone[] = ['cyan', 'purple', 'green', 'amber', 'rose']

function nodeHeight(rowCount: number, collapsed: boolean): number {
  if (collapsed) return HEADER_HEIGHT
  return HEADER_HEIGHT + Math.max(rowCount, 1) * ROW_HEIGHT
}

function keyLabel(key: string | number, isRoot: boolean): string {
  if (isRoot) return 'value'
  return typeof key === 'number' ? `[${key}]` : key
}

function copyValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (isContainer(value)) return JSON.stringify(value, null, 2)
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

function pathsEqual(left: JsonPath, right: JsonPath): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  )
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
  const haystack = `${String(key)} ${formatPath(path)} ${
    isContainer(value) ? getValueType(value) : String(value)
  }`.toLocaleLowerCase()
  return haystack.includes(query)
}

export function buildGraph(
  value: JsonValue,
  collapsedIds: Set<string>,
  hiddenBranchIds: Set<string>,
  searchTerm: string,
  rootTitle: string,
  selectedPath: JsonPath | null,
  selectedNodeId: string | null,
  selectedEdgeId: string | null,
  actions: GraphActions,
): GraphDefinition {
  const nodes: JsonFlowNode[] = []
  const edges: Edge[] = []
  const query = searchTerm.trim().toLocaleLowerCase()
  let matchCount = 0

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

    entries.forEach(([key, child], order) => {
      const isRootPrimitive = path.length === 0 && !isContainer(current)
      const childPath = isRootPrimitive ? path : [...path, key]
      const matched = rowMatches(query, key, child, childPath)
      if (matched) matchCount += 1

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
          copyKey: String(key),
          copyValue: copyValue(child),
          order,
          path: childPath,
          focusPath: flattenedArray ? [...childPath, 0] : childPath,
          type: Array.isArray(child) ? 'array' : 'object',
          size: Array.isArray(child) ? child.length : Object.keys(child).length,
          linked,
          expanded: !hiddenBranchIds.has(pathToId(childPath)),
          isArrayItem: typeof key === 'number',
          matched,
          selected:
            selectedNodeId === id &&
            selectedPath !== null &&
            pathsEqual(childPath, selectedPath),
        })
      } else {
        primitiveRows.push({
          keyLabel: keyLabel(key, isRootPrimitive),
          copyKey: String(key),
          copyValue: copyValue(child),
          order,
          path: childPath,
          value: child,
          type: getValueType(child) as PrimitiveRow['type'],
          isArrayItem: typeof key === 'number',
          isRoot: isRootPrimitive,
          matched,
          selected:
            selectedNodeId === id &&
            selectedPath !== null &&
            pathsEqual(childPath, selectedPath),
        })
      }
    })

    const pathLabel = formatPath(path)
    const nodeMatched =
      Boolean(query) &&
      `${title} ${pathLabel} ${kind}`.toLocaleLowerCase().includes(query)
    if (nodeMatched) matchCount += 1
    const size = isContainer(current)
      ? Array.isArray(current)
        ? current.length
        : Object.keys(current).length
      : 1
    const rowCount = primitiveRows.length + containerRows.length
    const keyColumnWidth = getKeyColumnWidth([
      ...primitiveRows,
      ...containerRows,
    ])
    const nodeSelected = selectedNodeId === id
    const rootNodeSelected =
      selectedNodeId === 'json-root' &&
      selectedPath !== null &&
      selectedPath.length === 0
    const selectionState = nodeSelected
      ? 'selected'
      : selectedNodeId !== null && !rootNodeSelected
        ? 'dimmed'
        : 'normal'

    nodes.push({
      id,
      type: 'jsonCard',
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
        matched: nodeMatched || primitiveRows.some((row) => row.matched) || containerRows.some((row) => row.matched),
        selectionState,
        primitiveRows,
        containerRows,
        ...actions,
      },
      style: {
        width: Math.max(
          path.length === 0 ? ROOT_NODE_WIDTH : NODE_WIDTH,
          keyColumnWidth + MIN_VALUE_COLUMN_WIDTH + 14,
        ),
        height: nodeHeight(rowCount, collapsed),
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

  const selectedEdge = selectedEdgeId
    ? edges.find((edge) => edge.id === selectedEdgeId)
    : undefined
  if (selectedEdge) {
    const sourcePathId = selectedEdge.sourceHandle?.replace(/^source-/, '')
    nodes.forEach((node) => {
      const isEndpoint =
        node.id === selectedEdge.source || node.id === selectedEdge.target
      node.data = {
        ...node.data,
        selectionState: isEndpoint ? 'selected' : 'dimmed',
        containerRows:
          node.id === selectedEdge.source
            ? node.data.containerRows.map((row) => ({
                ...row,
                selected: pathToId(row.path) === sourcePathId,
              }))
            : node.data.containerRows,
      }
    })
  }

  const signature = `${nodes.map((node) => node.id).join('|')}::${edges
    .map((edge) => `${edge.source}:${edge.sourceHandle ?? ''}>${edge.target}`)
    .join('|')}`

  const dimUnselected =
    Boolean(selectedEdge) ||
    (selectedNodeId !== null &&
      !(
        selectedNodeId === 'json-root' &&
        selectedPath !== null &&
        selectedPath.length === 0
      ))

  return { nodes, edges, signature, matchCount, dimUnselected }
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

export async function layoutGraph(
  nodes: JsonFlowNode[],
  edges: Edge[],
  direction: 'RIGHT' | 'DOWN',
): Promise<JsonFlowNode[]> {
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
  const modelOrderById = new Map(
    nodes.map((node, index) => [node.id, index]),
  )

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
      .filter((bounds): bounds is { top: number; bottom: number } => bounds !== null)
    if (targetBounds.length < 2) return

    const position = positions.get(node.id)
    if (!position) return
    const top = Math.min(...targetBounds.map((bounds) => bounds.top))
    const bottom = Math.max(...targetBounds.map((bounds) => bounds.bottom))
    const desiredY = (top + bottom - (Number(node.style?.height) || 0)) / 2
    positions.set(node.id, {
      ...position,
      y: desiredY,
    })
  })

  if (direction === 'RIGHT') {
    const outgoingBySource = new Map<string, Edge[]>()
    edges.forEach((edge) => {
      const outgoing = outgoingBySource.get(edge.source) ?? []
      outgoing.push(edge)
      outgoingBySource.set(edge.source, outgoing)
    })

    const shiftBranch = (rootId: string, deltaY: number) => {
      const queue = [rootId]
      const visited = new Set<string>()

      while (queue.length > 0) {
        const nodeId = queue.shift()
        if (!nodeId || visited.has(nodeId)) continue
        visited.add(nodeId)

        const position = positions.get(nodeId)
        if (position) {
          positions.set(nodeId, { ...position, y: position.y + deltaY })
        }
        outgoingBySource
          .get(nodeId)
          ?.forEach((edge) => queue.push(edge.target))
      }
    }

    nodes.forEach((node) => {
      const outgoing = outgoingBySource.get(node.id)
      if (outgoing?.length !== 1) return

      const edge = outgoing[0]
      const sourcePosition = positions.get(node.id)
      const targetPosition = positions.get(edge.target)
      const targetNode = nodeById.get(edge.target)
      const sourceHandleId = edge.sourceHandle?.replace(/^source-/, '')
      const sourceRow = node.data.containerRows.find(
        (row) => pathToId(row.path) === sourceHandleId,
      )
      if (!sourcePosition || !targetPosition || !targetNode || !sourceRow) return

      const sourceY =
        sourcePosition.y +
        HEADER_HEIGHT +
        (sourceRow.order + 0.5) * ROW_HEIGHT
      const targetY =
        targetPosition.y + (Number(targetNode.style?.height) || 0) / 2
      shiftBranch(edge.target, sourceY - targetY)
    })

    const incomingNodeIds = new Set(edges.map((edge) => edge.target))
    const layerById = new Map<string, number>()
    const layerQueue = nodes
      .filter((node) => !incomingNodeIds.has(node.id))
      .map((node) => node.id)
    layerQueue.forEach((nodeId) => layerById.set(nodeId, 0))

    while (layerQueue.length > 0) {
      const nodeId = layerQueue.shift()
      if (!nodeId) continue
      const nextLayer = (layerById.get(nodeId) ?? 0) + 1
      outgoingBySource.get(nodeId)?.forEach((edge) => {
        if ((layerById.get(edge.target) ?? -1) >= nextLayer) return
        layerById.set(edge.target, nextLayer)
        layerQueue.push(edge.target)
      })
    }

    const layers = new Map<number, JsonFlowNode[]>()
    nodes.forEach((node) => {
      const position = positions.get(node.id)
      if (!position) return
      const layer = layerById.get(node.id) ?? 0
      const layerNodes = layers.get(layer) ?? []
      layerNodes.push(node)
      layers.set(layer, layerNodes)
    })

    const orderedLayers = [...layers.entries()].sort(
      ([left], [right]) => left - right,
    )
    orderedLayers.forEach(([, layerNodes]) => {
      let nextAvailableY = Number.NEGATIVE_INFINITY

      layerNodes
        .sort(
          (left, right) =>
            (modelOrderById.get(left.id) ?? 0) -
            (modelOrderById.get(right.id) ?? 0),
        )
        .forEach((node) => {
          const position = positions.get(node.id)
          if (!position) return

          if (position.y < nextAvailableY) {
            shiftBranch(node.id, nextAvailableY - position.y)
          }

          const adjustedPosition = positions.get(node.id)
          if (!adjustedPosition) return
          nextAvailableY =
            adjustedPosition.y +
            (Number(node.style?.height) || 0) +
            NODE_VERTICAL_GAP
        })
    })
  }

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }))
}
