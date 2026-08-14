import {
  BaseEdge,
  Position,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react'

export function getChannelOffset(
  horizontalGap: number,
  channelIndex: number,
  channelCount: number,
): number {
  const defaultOffset = Math.min(36, Math.max(18, horizontalGap / 2))
  if (channelCount <= 1) return defaultOffset

  const minimumOffset = Math.min(14, horizontalGap / 3)
  const maximumOffset = Math.max(minimumOffset, horizontalGap - 14)
  const availableWidth = maximumOffset - minimumOffset
  const channelSpacing = Math.min(
    12,
    availableWidth / Math.max(1, channelCount - 1),
  )
  const totalWidth = channelSpacing * (channelCount - 1)
  const startOffset = Math.min(
    maximumOffset - totalWidth,
    Math.max(minimumOffset, defaultOffset - totalWidth / 2),
  )
  return (
    startOffset +
    Math.min(Math.max(channelIndex, 0), channelCount - 1) * channelSpacing
  )
}

export function NaturalEdge({
  data,
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition = Position.Right,
  targetPosition = Position.Left,
  style,
}: EdgeProps) {
  const horizontalGap = Math.abs(targetX - sourceX)
  const channelIndex =
    typeof data?.channelIndex === 'number' ? data.channelIndex : 0
  const channelCount =
    typeof data?.channelCount === 'number' ? data.channelCount : 1
  const branchOffset = getChannelOffset(
    horizontalGap,
    channelIndex,
    channelCount,
  )
  const channelX =
    typeof data?.channelX === 'number' ? data.channelX : undefined
  const centerX =
    channelX ??
    (targetX >= sourceX ? sourceX + branchOffset : sourceX - branchOffset)
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    centerX,
    borderRadius: 4,
    offset: 10,
  })

  return <BaseEdge id={id} path={path} style={style} />
}
