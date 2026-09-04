import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  getViewportForBounds,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import { toPng } from 'html-to-image'
import { ImageDown, Maximize2, Minimize2, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SearchPanel } from './SearchPanel'
import {
  openJsonCardEditor,
  ReadOnlyJsonCardNode,
} from './ReadOnlyJsonCardNode'
import { getChannelOffset, NaturalEdge } from './NaturalEdge'
import { pathToId, type JsonPath } from './json'
import {
  layoutGraph,
  rowAnchorY,
  HEADER_HEIGHT,
  type GraphDefinition,
  type JsonFlowNode,
} from './graph'

function eventElement(event: { target: EventTarget | null }): Element | null {
  const target = event.target
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

function pathsEqual(left: JsonPath, right: JsonPath): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  )
}

function applyNodeSelection(
  node: JsonFlowNode,
  selectedPath: JsonPath | null,
  selectedNodeId: string | null,
  selectedEdge: Edge | undefined,
): JsonFlowNode {
  const selectionState = selectedEdge
    ? node.id === selectedEdge.source || node.id === selectedEdge.target
      ? 'selected'
      : 'dimmed'
    : selectedNodeId === node.id
      ? 'selected'
      : selectedNodeId !== null &&
          !(
            selectedNodeId === 'json-root' &&
            selectedPath !== null &&
            selectedPath.length === 0
          )
        ? 'dimmed'
        : 'normal'
  const sourcePathId = selectedEdge?.sourceHandle?.replace(/^source-/, '')
  let primitiveChanged = false
  const primitiveRows = node.data.primitiveRows.map((row) => {
    const selected =
      !selectedEdge &&
      selectedNodeId === node.id &&
      selectedPath !== null &&
      pathsEqual(row.path, selectedPath)
    if (row.selected === selected) return row
    primitiveChanged = true
    return { ...row, selected }
  })
  let containerChanged = false
  const containerRows = node.data.containerRows.map((row) => {
    const selected = selectedEdge
      ? node.id === selectedEdge.source && pathToId(row.path) === sourcePathId
      : selectedNodeId === node.id &&
        selectedPath !== null &&
        pathsEqual(row.path, selectedPath)
    if (row.selected === selected) return row
    containerChanged = true
    return { ...row, selected }
  })
  if (
    node.data.selectionState === selectionState &&
    !primitiveChanged &&
    !containerChanged
  ) {
    return node
  }
  return {
    ...node,
    data: {
      ...node.data,
      selectionState,
      primitiveRows: primitiveChanged ? primitiveRows : node.data.primitiveRows,
      containerRows: containerChanged ? containerRows : node.data.containerRows,
    },
  }
}

const nodeTypes = {
  jsonCard: ReadOnlyJsonCardNode,
} satisfies NodeTypes

const edgeTypes = {
  natural: NaturalEdge,
} satisfies EdgeTypes

// React Flow attaches a right-positioned edge to the outer edge of the
// 24px source hit area (right: -6px), and the target to the outer edge of
// its 5px handle. Include those offsets when building a shared corridor.
const SOURCE_HANDLE_ROUTE_OFFSET = 14
const TARGET_CHANNEL_GUTTER = 22

function layerRightByX(nodes: JsonFlowNode[]): Map<number, number> {
  const rights = new Map<number, number>()
  nodes.forEach((node) => {
    const layerX = node.position.x
    const right = layerX + (Number(node.style?.width) || 0)
    let matched = false
    rights.forEach((value, cachedX) => {
      if (Math.abs(cachedX - layerX) <= 2) {
        rights.set(cachedX, Math.max(value, right))
        matched = true
      }
    })
    if (!matched) rights.set(layerX, right)
  })
  return rights
}

function layerRightX(
  sourceNode: JsonFlowNode,
  rights: Map<number, number>,
): number {
  const layerX = sourceNode.position.x
  let right = sourceNode.position.x
  rights.forEach((value, cachedX) => {
    if (Math.abs(cachedX - layerX) <= 2) right = Math.max(right, value)
  })
  return right
}

interface EdgeChannel {
  index: number
  count: number
  x: number
}

interface EdgeGroup {
  edgeIds: string[]
  sourceY: number
  startY: number
  endY: number
  targetYs: number[]
  targetXs: number[]
}

function crossesVerticalSpan(
  y: number,
  group: EdgeGroup,
): boolean {
  return y > group.startY + 1 && y < group.endY - 1
}

function channelPairCrossingCount(
  left: EdgeGroup,
  right: EdgeGroup,
): number {
  const targetCrossings = left.targetYs.reduce(
    (count, targetY) =>
      count + (crossesVerticalSpan(targetY, right) ? 1 : 0),
    0,
  )
  const sourceCrossing = crossesVerticalSpan(right.sourceY, left) ? 1 : 0
  return targetCrossings + sourceCrossing
}

function channelOrderCost(left: EdgeGroup, right: EdgeGroup): number {
  // Crossing avoidance dominates; this fractional term only keeps a stable
  // bottom-to-top staircase when multiple channel orders are equally clean.
  const stableOrderPenalty = left.sourceY < right.sourceY ? 0.001 : 0
  return channelPairCrossingCount(left, right) + stableOrderPenalty
}

function channelOrderCrossingCount(groups: EdgeGroup[]): number {
  return groups.reduce(
    (total, left, leftIndex) =>
      total +
      groups
        .slice(leftIndex + 1)
        .reduce(
          (pairTotal, right) =>
            pairTotal + channelPairCrossingCount(left, right),
          0,
        ),
    0,
  )
}

function orderEdgeGroups(groups: EdgeGroup[]): EdgeGroup[] {
  const count = groups.length
  if (count <= 1) return groups

  const pairCosts = groups.map((left) =>
    groups.map((right) => channelOrderCost(left, right)),
  )

  if (count <= 12) {
    const stateCount = 1 << count
    const costs = new Float64Array(stateCount)
    costs.fill(Number.POSITIVE_INFINITY)
    costs[0] = 0
    const appendedGroup = new Int16Array(stateCount)
    appendedGroup.fill(-1)

    for (let mask = 1; mask < stateCount; mask += 1) {
      for (let rightIndex = 0; rightIndex < count; rightIndex += 1) {
        const rightBit = 1 << rightIndex
        if ((mask & rightBit) === 0) continue
        const previousMask = mask ^ rightBit
        let addedCost = 0

        for (let leftIndex = 0; leftIndex < count; leftIndex += 1) {
          if ((previousMask & (1 << leftIndex)) !== 0) {
            addedCost += pairCosts[leftIndex][rightIndex]
          }
        }

        const nextCost = costs[previousMask] + addedCost
        if (nextCost < costs[mask]) {
          costs[mask] = nextCost
          appendedGroup[mask] = rightIndex
        }
      }
    }

    const orderedIndexes: number[] = []
    let mask = stateCount - 1
    while (mask !== 0) {
      const groupIndex = appendedGroup[mask]
      if (groupIndex < 0) break
      orderedIndexes.push(groupIndex)
      mask ^= 1 << groupIndex
    }
    orderedIndexes.reverse()
    if (orderedIndexes.length === count) {
      return orderedIndexes.map((index) => groups[index])
    }
  }

  const sorted = [...groups].sort((left, right) => right.sourceY - left.sourceY)
  if (count > 16) return sorted

  return sorted
    .reduce<EdgeGroup[]>((ordered, group) => {
      let bestOrder = [...ordered, group]
      let bestCost = Number.POSITIVE_INFINITY

      for (let index = 0; index <= ordered.length; index += 1) {
        const candidate = [
          ...ordered.slice(0, index),
          group,
          ...ordered.slice(index),
        ]
        const cost = candidate.reduce(
          (total, left, leftIndex) =>
            total +
            candidate
              .slice(leftIndex + 1)
              .reduce(
                (pairTotal, right) =>
                  pairTotal + channelOrderCost(left, right),
                0,
              ),
          0,
        )
        if (cost < bestCost) {
          bestCost = cost
          bestOrder = candidate
        }
      }

      return bestOrder
    }, [])
}

function getEdgeChannels(
  edges: Edge[],
  nodes: JsonFlowNode[],
): Map<string, EdgeChannel> {
  const channels = new Map<string, EdgeChannel>()
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const groupsBySource = new Map<string, Map<string, EdgeGroup>>()
  const layerRights = layerRightByX(nodes)

  edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.source)
    const targetNode = nodeById.get(edge.target)
    if (!sourceNode || !targetNode) return

    const sourcePathId = edge.sourceHandle?.replace(/^source-/, '')
    const sourceRow = sourceNode.data.containerRows.find(
      (row) => pathToId(row.path) === sourcePathId,
    )
    if (!sourceRow) return

    const sourceY = sourceNode.position.y + rowAnchorY(sourceRow)
    const targetY = targetNode.position.y + HEADER_HEIGHT / 2
    const targetX = targetNode.position.x
    const sourceGroups =
      groupsBySource.get(edge.source) ?? new Map<string, EdgeGroup>()
    const groupKey = edge.sourceHandle ?? edge.id
    const group = sourceGroups.get(groupKey)

    if (group) {
      group.edgeIds.push(edge.id)
      group.targetYs.push(targetY)
      group.targetXs.push(targetX)
      group.startY = Math.min(group.startY, sourceY, targetY)
      group.endY = Math.max(group.endY, sourceY, targetY)
    } else {
      sourceGroups.set(groupKey, {
        edgeIds: [edge.id],
        sourceY,
        startY: Math.min(sourceY, targetY),
        endY: Math.max(sourceY, targetY),
        targetYs: [targetY],
        targetXs: [targetX],
      })
    }
    groupsBySource.set(edge.source, sourceGroups)
  })

  groupsBySource.forEach((sourceGroups, sourceId) => {
    const groupedRoutes = [...sourceGroups.values()]
    let groups = orderEdgeGroups(groupedRoutes)

    if (channelOrderCrossingCount(groups) > 0) {
      groups = orderEdgeGroups(
        groupedRoutes.flatMap((group) =>
          group.edgeIds.map((edgeId, index) => {
            const targetY = group.targetYs[index]
            return {
              edgeIds: [edgeId],
              sourceY: group.sourceY,
              startY: Math.min(group.sourceY, targetY),
              endY: Math.max(group.sourceY, targetY),
              targetYs: [targetY],
              targetXs: [group.targetXs[index]],
            }
          }),
        ),
      )
    }

    const sourceNode = nodeById.get(sourceId)
    if (!sourceNode) return
    const sourceX = layerRightX(sourceNode, layerRights) + SOURCE_HANDLE_ROUTE_OFFSET
    const targetLeft = groups.reduce(
      (closest, group) =>
        group.targetXs.reduce(
          (groupClosest, value) => Math.min(groupClosest, value),
          closest,
        ),
      Number.POSITIVE_INFINITY,
    )
    const maxChannelX = targetLeft - TARGET_CHANNEL_GUTTER
    const horizontalGap = Math.max(0, maxChannelX - sourceX)

    groups.forEach((group, channelIndex) => {
      const channelX = Math.min(
        maxChannelX,
        sourceX + getChannelOffset(horizontalGap, channelIndex, groups.length),
      )
      group.edgeIds.forEach((edgeId) => {
        channels.set(edgeId, {
          index: channelIndex,
          count: groups.length,
          x: channelX,
        })
      })
    })
  })

  return channels
}

export interface FocusRequest {
  id: string
  nonce: number
  path?: JsonPath
}

interface DiagramCanvasProps {
  definition: GraphDefinition
  dark: boolean
  exportName: string
  focusRequest: FocusRequest | null
  graphCollapsed: boolean
  onClearSelection: () => void
  onSearchChange: (value: string) => void
  onSearchClose: () => void
  onSearchIndexChange: (index: number) => void
  onSearchOpen: () => void
  onSelectEdge: (edgeId: string, sourcePath: JsonPath) => void
  onToast: (message: string) => void
  onToggleGraphCollapse: () => void
  preserveViewportRequest: number
  searchFocusNonce: number
  searchIndex: number
  searchOpen: boolean
  searchTerm: string
  selectedEdgeId: string | null
  selectedNodeId: string | null
  selectedPath: JsonPath | null
  stale: boolean
}

function DiagramCanvas({
  definition,
  dark,
  exportName,
  focusRequest,
  graphCollapsed,
  onClearSelection,
  onSearchChange,
  onSearchClose,
  onSearchIndexChange,
  onSearchOpen,
  onSelectEdge,
  onToast,
  onToggleGraphCollapse,
  preserveViewportRequest,
  searchFocusNonce,
  searchIndex,
  searchOpen,
  searchTerm,
  selectedEdgeId,
  selectedNodeId,
  selectedPath,
  stale,
}: DiagramCanvasProps) {
  const [nodes, setNodes] = useState<JsonFlowNode[]>([])
  const [layoutPending, setLayoutPending] = useState(true)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [heightRevision, setHeightRevision] = useState(0)
  const signatureRef = useRef('')
  const layoutRunRef = useRef(0)
  const fitTimerRef = useRef<number | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  const measuredHeightsRef = useRef(new Map<string, number>())
  const appliedHeightRevisionRef = useRef(0)
  const hasFittedRef = useRef(false)
  const handledFocusRequestRef = useRef<string | null>(null)
  const handledPreserveRequestRef = useRef(0)
  const nodesRef = useRef<JsonFlowNode[]>([])
  nodesRef.current = nodes
  const {
    fitBounds,
    fitView,
    getNodes,
    getNodesBounds,
    getViewport,
    setCenter,
    setViewport,
  } = useReactFlow<JsonFlowNode>()
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)

  const exportCanvasImage = useCallback(async () => {
    if (exportingRef.current) return
    const currentNodes = getNodes()
    if (currentNodes.length === 0) {
      onToast('画布为空，无法导出')
      return
    }

    const viewportElement = document.querySelector(
      '.graph-panel .react-flow__viewport',
    )
    if (!(viewportElement instanceof HTMLElement)) {
      onToast('导出失败')
      return
    }

    exportingRef.current = true
    setExporting(true)
    const previousTransform = viewportElement.style.transform
    try {
      const bounds = getNodesBounds(currentNodes)
      const maxSide = 4096
      let width = Math.max(720, Math.ceil(bounds.width + 80))
      let height = Math.max(480, Math.ceil(bounds.height + 80))
      const fit = Math.min(1, maxSide / width, maxSide / height)
      width = Math.max(1, Math.round(width * fit))
      height = Math.max(1, Math.round(height * fit))
      const viewport = getViewportForBounds(
        bounds,
        width,
        height,
        0.2,
        2,
        0.12,
      )
      const dataUrl = await toPng(viewportElement, {
        backgroundColor: dark ? '#1a1a1a' : '#e8eaee',
        cacheBust: true,
        height,
        pixelRatio: 2,
        width,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        },
      })
      const anchor = document.createElement('a')
      const safeName = (exportName.trim() || 'json-canvas').replace(
        /[<>:"/\\|?*]+/g,
        '_',
      )
      anchor.href = dataUrl
      anchor.download = `${safeName}.png`
      anchor.click()
      onToast('画布已导出')
    } catch {
      onToast('导出失败')
    } finally {
      viewportElement.style.transform = previousTransform
      exportingRef.current = false
      setExporting(false)
    }
  }, [dark, exportName, getNodes, getNodesBounds, onToast])

  const reportNodeHeight = useCallback((id: string, height: number) => {
    const next = Math.ceil(height)
    if (next <= 0) return
    const previous = measuredHeightsRef.current.get(id)
    if (previous !== undefined && Math.abs(previous - next) < 2) return
    const estimated = Number(
      nodesRef.current.find((node) => node.id === id)?.style?.height,
    )
    if (
      previous === undefined &&
      Number.isFinite(estimated) &&
      Math.abs(estimated - next) < 2
    ) {
      measuredHeightsRef.current.set(id, next)
      return
    }
    measuredHeightsRef.current.set(id, next)
    if (measureFrameRef.current !== null) return
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null
      setHeightRevision((value) => value + 1)
    })
  }, [])

  useEffect(
    () => () => {
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current)
      if (measureFrameRef.current !== null) {
        window.cancelAnimationFrame(measureFrameRef.current)
      }
    },
    [],
  )

  const edgeChannels = useMemo(
    () => getEdgeChannels(definition.edges, nodes),
    [definition.edges, nodes],
  )

  const edges = useMemo(
    () => {
      const hasSelectedEdge =
        selectedEdgeId !== null &&
        definition.edges.some((edge) => edge.id === selectedEdgeId)

      return definition.edges.map((edge) => {
        const edgeSelected = hasSelectedEdge && edge.id === selectedEdgeId
        const edgeHovered =
          !edgeSelected &&
          selectedEdgeId === null &&
          edge.id === hoveredEdgeId
        return {
          ...edge,
          animated: edgeHovered,
          data: {
            ...edge.data,
            channelIndex:
              edgeChannels.get(edge.id)?.index ??
              edge.data?.channelIndex ??
              0,
            channelCount:
              edgeChannels.get(edge.id)?.count ??
              edge.data?.channelCount ??
              1,
            channelX: edgeChannels.get(edge.id)?.x,
          },
          zIndex: edgeSelected ? 10 : edgeHovered ? 5 : 0,
          style: {
            stroke: edgeSelected
              ? dark
                ? '#e4c56a'
                : '#aa9134'
              : edgeHovered
                ? dark
                  ? '#4fd4a8'
                  : '#27a978'
              : dark
                ? '#9a9aa2'
                : '#8e949e',
            strokeDasharray:
              edgeSelected || edgeHovered ? '6 5' : undefined,
            strokeWidth: edgeSelected || edgeHovered ? 1.6 : 1,
            opacity: hasSelectedEdge
              ? edgeSelected
                ? 1
                : 0.14
              : selectedNodeId &&
                  !(
                    selectedNodeId === 'json-root' &&
                    selectedPath !== null &&
                    selectedPath.length === 0
                  )
                ? edge.target === selectedNodeId
                  ? 0.44
                  : 0.16
                : 1,
          },
        }
      })
    },
    [
      dark,
      definition.edges,
      edgeChannels,
      hoveredEdgeId,
      selectedEdgeId,
      selectedNodeId,
      selectedPath,
    ],
  )

  const renderedNodes = useMemo<JsonFlowNode[]>(() => {
    const selectedEdge = selectedEdgeId
      ? definition.edges.find((edge) => edge.id === selectedEdgeId)
      : undefined
    const withSelection = (node: JsonFlowNode): JsonFlowNode =>
      applyNodeSelection(node, selectedPath, selectedNodeId, selectedEdge)
    const withMeasure = (node: JsonFlowNode): JsonFlowNode => {
      const selected = withSelection(node)
      return {
        ...selected,
        data: {
          ...selected.data,
          onMeasuredHeight: reportNodeHeight,
        },
      }
    }
    if (selectedEdgeId !== null || hoveredEdgeId === null) {
      return nodes.map(withMeasure)
    }
    const hoveredEdge = definition.edges.find(
      (edge) => edge.id === hoveredEdgeId,
    )
    if (!hoveredEdge) return nodes.map(withMeasure)

    const sourcePathId = hoveredEdge.sourceHandle?.replace(/^source-/, '')
    return nodes.map((node) => {
      const measured = withMeasure(node)
      return {
        ...measured,
        data: {
          ...measured.data,
          relationHoverState:
            node.id === hoveredEdge.target
              ? 'target'
              : node.id === hoveredEdge.source
                ? 'source'
                : undefined,
          hoveredSourcePathId:
            node.id === hoveredEdge.source ? sourcePathId : undefined,
        },
      }
    })
  }, [
    definition.edges,
    hoveredEdgeId,
    nodes,
    reportNodeHeight,
    selectedEdgeId,
    selectedNodeId,
    selectedPath,
  ])

  useEffect(() => {
    const structureChanged = signatureRef.current !== definition.signature
    const heightRelayout = heightRevision !== appliedHeightRevisionRef.current
    const preserveViewport =
      handledPreserveRequestRef.current !== preserveViewportRequest

    const applyMeasuredHeight = (node: JsonFlowNode): JsonFlowNode => {
      const measuredHeight = measuredHeightsRef.current.get(node.id)
      if (measuredHeight == null) return node
      return {
        ...node,
        style: { ...node.style, height: measuredHeight },
      }
    }

    if (!structureChanged && !heightRelayout) {
      const viewportBeforeUpdate = getViewport()
      handledPreserveRequestRef.current = preserveViewportRequest
      setNodes((currentNodes) => {
        const currentById = new Map(currentNodes.map((node) => [node.id, node]))
        return definition.nodes.map((node) => {
          const current = currentById.get(node.id)
          return {
            ...applyMeasuredHeight(node),
            position: current?.position ?? node.position,
            selected: current?.selected,
          }
        })
      })
      if (!focusRequest) {
        window.requestAnimationFrame(() => {
          void setViewport(viewportBeforeUpdate, { duration: 0 })
        })
      }
      return
    }

    if (structureChanged) {
      measuredHeightsRef.current.clear()
      hasFittedRef.current = false
    }
    handledPreserveRequestRef.current = preserveViewportRequest
    signatureRef.current = definition.signature
    appliedHeightRevisionRef.current = heightRevision
    const run = layoutRunRef.current + 1
    layoutRunRef.current = run
    const keepViewport =
      preserveViewport || (heightRelayout && hasFittedRef.current)
    if (!keepViewport && fitTimerRef.current !== null) {
      window.clearTimeout(fitTimerRef.current)
      fitTimerRef.current = null
    }
    const viewportBeforeLayout = keepViewport ? getViewport() : null
    const anchorBeforeLayout = keepViewport
      ? nodesRef.current.find((node) => node.id === 'json-root')
      : undefined
    if (structureChanged) setLayoutPending(true)

    layoutGraph(
      definition.nodes.map(applyMeasuredHeight),
      definition.edges,
      'RIGHT',
    )
      .then((layoutedNodes) => {
        if (layoutRunRef.current !== run) return
        let nextNodes = layoutedNodes
        if (anchorBeforeLayout) {
          const nextAnchor = layoutedNodes.find(
            (node) => node.id === anchorBeforeLayout.id,
          )
          if (nextAnchor) {
            const deltaX =
              anchorBeforeLayout.position.x - nextAnchor.position.x
            const deltaY =
              anchorBeforeLayout.position.y - nextAnchor.position.y
            nextNodes = layoutedNodes.map((node) => ({
              ...node,
              position: {
                x: node.position.x + deltaX,
                y: node.position.y + deltaY,
              },
            }))
          }
        }

        setNodes(nextNodes)
        setLayoutPending(false)
        if (focusRequest) return
        if (viewportBeforeLayout) {
          window.requestAnimationFrame(() => {
            void setViewport(viewportBeforeLayout, { duration: 0 })
          })
          return
        }

        const bounds = nextNodes.reduce(
          (result, node) => {
            const width = Number(node.style?.width) || 0
            const height = Number(node.style?.height) || 0
            return {
              minX: Math.min(result.minX, node.position.x),
              minY: Math.min(result.minY, node.position.y),
              maxX: Math.max(result.maxX, node.position.x + width),
              maxY: Math.max(result.maxY, node.position.y + height),
            }
          },
          {
            minX: Number.POSITIVE_INFINITY,
            minY: Number.POSITIVE_INFINITY,
            maxX: Number.NEGATIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          },
        )
        fitTimerRef.current = window.setTimeout(() => {
          const graphHeight = bounds.maxY - bounds.minY
          hasFittedRef.current = true
          void fitBounds(
            {
              x: bounds.minX + 110,
              y: bounds.minY + graphHeight * 0.13 - 50,
              width: bounds.maxX - bounds.minX,
              height: graphHeight * 0.74,
            },
            { duration: 450, padding: 0.08 },
          )
        }, 120)
      })
      .catch(() => {
        if (layoutRunRef.current !== run) return
        setNodes(definition.nodes.map(applyMeasuredHeight))
        setLayoutPending(false)
      })
  }, [
    definition,
    fitBounds,
    focusRequest,
    getViewport,
    heightRevision,
    preserveViewportRequest,
    setViewport,
  ])

  useEffect(() => {
    if (!focusRequest || layoutPending) return
    const requestKey = `${focusRequest.id}:${focusRequest.nonce}`
    if (handledFocusRequestRef.current === requestKey) return
    const target = nodes.find((node) => node.id === focusRequest.id)
    if (!target) return
    handledFocusRequestRef.current = requestKey

    const focusPath = focusRequest.path
    const focusRow = focusPath
      ? [...target.data.primitiveRows, ...target.data.containerRows].find(
          (row) => pathToId(row.path) === pathToId(focusPath),
        )
      : undefined

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (focusRow) {
          const width = Number(target.style?.width) || 220
          void setCenter(
            target.position.x + width / 2,
            target.position.y + rowAnchorY(focusRow),
            { duration: 420, zoom: 1.28 },
          )
          return
        }

        void fitView({
          nodes: [{ id: target.id }],
          duration: 420,
          padding: 0.16,
          minZoom: 0.22,
          maxZoom: 1.6,
        })
      })
    })
  }, [fitView, focusRequest, layoutPending, nodes, setCenter])

  const onNodesChange = useCallback((changes: NodeChange<JsonFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  return (
    <div className="diagram-canvas">
      <ReactFlow<JsonFlowNode>
        autoPanOnNodeFocus={false}
        colorMode={dark ? 'dark' : 'light'}
        defaultEdgeOptions={{ type: 'natural' }}
        edges={edges}
        edgeTypes={edgeTypes}
        elementsSelectable={false}
        maxZoom={1.8}
        minZoom={0.12}
        nodeTypes={nodeTypes}
        nodes={renderedNodes}
        nodesConnectable={false}
        nodesDraggable={false}
        onlyRenderVisibleElements
        elevateNodesOnSelect={false}
        onEdgeClick={(event, edge) => {
          event.stopPropagation()
          setHoveredEdgeId(null)
          const sourceNode = nodes.find((node) => node.id === edge.source)
          const sourcePathId = edge.sourceHandle?.replace(/^source-/, '')
          const sourceRow = sourceNode?.data.containerRows.find(
            (row) => pathToId(row.path) === sourcePathId,
          )
          if (sourceRow) onSelectEdge(edge.id, sourceRow.path)
        }}
        onEdgeMouseEnter={(_, edge) => setHoveredEdgeId(edge.id)}
        onEdgeMouseLeave={(_, edge) =>
          setHoveredEdgeId((current) =>
            current === edge.id ? null : current,
          )
        }
        onNodeClick={(event, node) => {
          event.stopPropagation()
          if (
            eventElement(event)?.closest(
              '.json-node-row, .node-icon-button, .child-link, .row-source-handle',
            )
          ) {
            return
          }
          node.data.onSelect(node.data.path, node.data.path)
        }}
        onNodeDoubleClick={(event, node) => {
          event.stopPropagation()
          if (
            eventElement(event)?.closest(
              '.json-value, .json-node-row, .json-node-body, .child-link, .node-icon-button, .row-source-handle',
            )
          ) {
            return
          }
          openJsonCardEditor(node.id)
        }}
        onNodesChange={onNodesChange}
        onPaneClick={onClearSelection}
        panOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <Background
          color={dark ? '#3d3d42' : '#b7bdc6'}
          gap={16}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        {searchOpen && (
          <SearchPanel
            activeIndex={searchIndex}
            focusNonce={searchFocusNonce}
            matches={definition.matches}
            onActiveIndexChange={onSearchIndexChange}
            onClose={onSearchClose}
            onQueryChange={onSearchChange}
            query={searchTerm}
          />
        )}
        <div
          className="canvas-dock nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="canvas-toolbar">
            <button
              aria-expanded={searchOpen}
              aria-label="搜索键、值或路径"
              className="canvas-search-toggle"
              onClick={() => {
                if (searchOpen) {
                  onSearchClose()
                  return
                }
                onSearchOpen()
              }}
              title="搜索 (Ctrl+F)"
              type="button"
            >
              <Search size={13} strokeWidth={2.2} />
            </button>
            <button
              aria-label={graphCollapsed ? '全部展开' : '全部折叠'}
              aria-pressed={graphCollapsed}
              className="canvas-search-toggle"
              onClick={onToggleGraphCollapse}
              title={graphCollapsed ? '全部展开' : '全部折叠'}
              type="button"
            >
              {graphCollapsed ? (
                <Maximize2 size={13} strokeWidth={2.2} />
              ) : (
                <Minimize2 size={13} strokeWidth={2.2} />
              )}
            </button>
            <button
              aria-busy={exporting}
              aria-label="导出当前画布为图片"
              className="canvas-search-toggle"
              disabled={exporting}
              onClick={() => void exportCanvasImage()}
              title="导出画布为 PNG"
              type="button"
            >
              <ImageDown size={13} strokeWidth={2.2} />
            </button>
            <Controls
              className="json-flow-controls"
              fitViewOptions={{ duration: 400, padding: 0.24, maxZoom: 1.15 }}
              orientation="horizontal"
              position="bottom-center"
              showInteractive={false}
            />
          </div>
        </div>
      </ReactFlow>

      {layoutPending && (
        <div className="canvas-message layout-message">
          <span className="loading-dot" />
          正在整理布局
        </div>
      )}
      {stale && (
        <div className="canvas-message stale-message">
          源码存在错误，画布保留上一次有效结果
        </div>
      )}
      {!stale && definition.truncated ? (
        <div className="canvas-message stale-message">
          节点过多，仅展示前 {definition.nodes.length} 张卡片
        </div>
      ) : null}
    </div>
  )
}

export function Diagram(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <DiagramCanvas {...props} />
    </ReactFlowProvider>
  )
}
