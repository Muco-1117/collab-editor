import { fieldValue } from './collabState.js'

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function compareElementOrder(left, right, field = 'order') {
  const difference = finiteNumber(fieldValue(left, field, 0)) - finiteNumber(fieldValue(right, field, 0))
  if (difference !== 0) return difference
  const leftId = String(left?.id || '')
  const rightId = String(right?.id || '')
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

export function orderBetween(before, after, step = 1024) {
  const left = before == null ? null : finiteNumber(before)
  const right = after == null ? null : finiteNumber(after)
  if (left == null && right == null) return step
  if (left == null) return right - step
  if (right == null) return left + step
  return (left + right) / 2
}
