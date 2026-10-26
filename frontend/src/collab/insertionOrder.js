import { fieldValue } from './collabState.js'
import { orderBetween } from './ordering.js'

function valueOf(element) {
  const value = Number(fieldValue(element, 'order', 0))
  return Number.isFinite(value) ? value : 0
}

// Concurrent inserts can legitimately share an order. When there is no numeric
// gap (including floating point exhaustion), create one without losing any
// element. The caller applies only these order patches to the latest states.
export function planInsertionOrder(elements, requestedIndex, step = 1024) {
  const index = Math.max(0, Math.min(requestedIndex, elements.length))
  const before = index ? valueOf(elements[index - 1]) : null
  const after = index < elements.length ? valueOf(elements[index]) : null
  const order = orderBetween(before, after, step)
  if (Number.isFinite(order) && (before === null || order > before) && (after === null || order < after)) {
    return { order, updates: [] }
  }

  const updates = elements.flatMap((element, position) => {
    const order = (position + 1) * step
    return valueOf(element) === order ? [] : [{ id: element.id, type: element.type, order }]
  })
  return {
    order: orderBetween(
      index ? index * step : null,
      index < elements.length ? (index + 1) * step : null,
      step,
    ),
    updates,
  }
}
