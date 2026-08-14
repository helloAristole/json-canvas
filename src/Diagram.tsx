import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReadOnlyJsonCardNode } from './ReadOnlyJsonCardNode'
import { getChannelOffset, NaturalEdge } from './NaturalEdge'
import { pathToId, type JsonPath } from './json'
import {
  layoutGraph,
  type GraphDefinition,
  type JsonFlowNode,
} from './graph'

const nodeTypes = {
  jsonCard: ReadOnlyJsonCardNode,
} satisfies NodeTypes

const edgeTypes = {
  natural: NaturalEdge,
} satisfies EdgeTypes

// React Flow attaches a right-positioned edge to the outer edge of the
// 24px source hit area (right: -6px), and the target to the outer edge of
// its 5px handle. Include those offsets when building a shared corridor.
const SOURCE_HANDLE_ROUTE_OFFSET = 18
const TARGET_HANDLE_ROUTE_OFFSET = -2.5

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

  return [...groups]
    .sort((left, right) => right.sourceY - left.sourceY)
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

  edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.source)
    const targetNode = nodeById.get(edge.target)
    if (!sourceNode || !targetNode) return

    const sourcePathId = edge.sourceHandle?.replace(/^source-/, '')
    const sourceRow = sourceNode.data.containerRows.find(
      (row) => pathToId(row.path) === sourcePathId,
    )
    if (!sourceRow) return

    const sourceY =
      sourceNode.position.y + 24 + (sourceRow.order + 0.5) * 24
    const targetY =
      targetNode.position.y + (Number(targetNode.style?.height) || 0) / 2
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
    const sourceX =
      (sourceNode?.position.x ?? 0) +
      (Number(sourceNode?.style?.width) || 0) +
      SOURCE_HANDLE_ROUTE_OFFSET
    const targetX =
      groups.reduce(
        (closest, group) =>
          group.targetXs.reduce(
            (groupClosest, value) => Math.min(groupClosest, value),
            closest,
          ),
        Number.POSITIVE_INFINITY,
      ) + TARGET_HANDLE_ROUTE_OFFSET
    const horizontalGap = Math.max(0, targetX - sourceX)

    groups.forEach((group, channelIndex) => {
      const channelX =
        sourceX + getChannelOffset(horizontalGap, channelIndex, groups.length)
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
}

interface DiagramCanvasProps {
  definition: GraphDefinition
  dark: boolean
  focusRequest: FocusRequest | null
  onClearSelection: () => void
  onSelectEdge: (edgeId: string, sourcePath: JsonPath) => void
  preserveViewportRequest: number
  selectedEdgeId: string | null
  selectedNodeId: string | null
  stale: boolean
}

function DiagramCanvas({
  definition,
  dark,
  focusRequest,
  onClearSelection,
  onSelectEdge,
  preserveViewportRequest,
  selectedEdgeId,
  selectedNodeId,
  stale,
}: DiagramCanvasProps) {
  const [nodes, setNodes] = useState<JsonFlowNode[]>([])
  const [layoutPending, setLayoutPending] = useState(true)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const signatureRef = useRef('')
  const layoutRunRef = useRef(0)
  const fitTimerRef = useRef<number | null>(null)
  const handledFocusRequestRef = useRef<string | null>(null)
  const handledPreserveRequestRef = useRef(0)
  const { fitBounds, fitView, getViewport, setViewport } =
    useReactFlow<JsonFlowNode>()

  useEffect(
    () => () => {
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current)
    },
    [],
  )

  const edges = useMemo(
    () => {
      const hasSelectedEdge =
        selectedEdgeId !== null &&
        definition.edges.some((edge) => edge.id === selectedEdgeId)
      const edgeChannels = getEdgeChannels(definition.edges, nodes)

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
                ? '#d8bf63'
                : '#aa9134'
              : edgeHovered
                ? dark
                  ? '#56d4a4'
                  : '#27a978'
              : dark
                ? '#686b75'
                : '#b8bbc2',
            strokeDasharray:
              edgeSelected || edgeHovered ? '6 5' : undefined,
            strokeWidth: edgeSelected || edgeHovered ? 1.6 : 1,
            opacity: hasSelectedEdge
              ? edgeSelected
                ? 1
                : 0.14
              : selectedNodeId && definition.dimUnselected
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
      definition.dimUnselected,
      definition.edges,
      hoveredEdgeId,
      nodes,
      selectedEdgeId,
      selectedNodeId,
    ],
  )

  const renderedNodes = useMemo<JsonFlowNode[]>(() => {
    if (selectedEdgeId !== null || hoveredEdgeId === null) return nodes
    const hoveredEdge = definition.edges.find(
      (edge) => edge.id === hoveredEdgeId,
    )
    if (!hoveredEdge) return nodes

    const sourcePathId = hoveredEdge.sourceHandle?.replace(/^source-/, '')
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        relationHoverState:
          node.id === hoveredEdge.target
            ? 'target'
            : node.id === hoveredEdge.source
              ? 'source'
              : undefined,
        hoveredSourcePathId:
          node.id === hoveredEdge.source ? sourcePathId : undefined,
      },
    }))
  }, [definition.edges, hoveredEdgeId, nodes, selectedEdgeId])

  useEffect(() => {
    const structureChanged = signatureRef.current !== definition.signature
    const preserveViewport =
      handledPreserveRequestRef.current !== preserveViewportRequest

    if (!structureChanged) {
      const viewportBeforeUpdate = getViewport()
      handledPreserveRequestRef.current = preserveViewportRequest
      setNodes((currentNodes) => {
        const currentById = new Map(currentNodes.map((node) => [node.id, node]))
        return definition.nodes.map((node) => {
          const current = currentById.get(node.id)
          return {
            ...node,
            position: current?.position ?? node.position,
            selected: current?.selected,
          }
        })
      })
      window.requestAnimationFrame(() => {
        void setViewport(viewportBeforeUpdate, { duration: 0 })
      })
      return
    }

    handledPreserveRequestRef.current = preserveViewportRequest
    signatureRef.current = definition.signature
    const run = layoutRunRef.current + 1
    layoutRunRef.current = run
    if (fitTimerRef.current !== null) {
      window.clearTimeout(fitTimerRef.current)
      fitTimerRef.current = null
    }
    const viewportBeforeLayout = preserveViewport ? getViewport() : null
    const anchorBeforeLayout = preserveViewport
      ? nodes.find((node) => node.id === 'json-root')
      : undefined
    setLayoutPending(true)

    layoutGraph(definition.nodes, definition.edges, 'RIGHT')
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
        setNodes(definition.nodes)
        setLayoutPending(false)
      })
  }, [
    definition,
    fitBounds,
    getViewport,
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

    window.requestAnimationFrame(() => {
      void fitView({
        nodes: [target],
        duration: 500,
        padding: 0.9,
        minZoom: 0.65,
        maxZoom: 1.1,
      })
    })
  }, [fitView, focusRequest, layoutPending, nodes])

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
            (event.target as HTMLElement).closest(
              '.json-node-row, .node-icon-button, .child-link, .row-source-handle',
            )
          ) {
            return
          }
          node.data.onSelect(node.data.path, node.data.path)
        }}
        onNodesChange={onNodesChange}
        onPaneClick={onClearSelection}
        panOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <Background
          color={dark ? '#454a58' : '#cbd2d9'}
          gap={16}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls
          className="json-flow-controls"
          fitViewOptions={{ duration: 400, padding: 0.24, maxZoom: 1.15 }}
          orientation="horizontal"
          position="bottom-center"
          showInteractive={false}
        />
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
