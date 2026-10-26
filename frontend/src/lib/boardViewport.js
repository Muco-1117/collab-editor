export const MIN_BOARD_SCALE = 0.1
export const MAX_BOARD_SCALE = 2

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function boardScale(value) {
  return Math.min(MAX_BOARD_SCALE, Math.max(MIN_BOARD_SCALE, finite(value, 1)))
}

export function boardRect(value = {}) {
  return {
    x: Math.max(0, finite(value.x)),
    y: Math.max(0, finite(value.y)),
    w: Math.max(150, finite(value.w, 220)),
    h: Math.max(110, finite(value.h, 150)),
  }
}

// The scroll plane has half a viewport of room around the world origin. This
// lets fit-to-content centre even a single card near (0, 0), while native scroll
// bars remain available for navigation at every zoom level.
export function boardPointAt(point, view, scale) {
  const zoom = boardScale(scale)
  return {
    x: (finite(point.x) + finite(view.scrollLeft) - finite(view.originX, finite(view.width) / 2)) / zoom,
    y: (finite(point.y) + finite(view.scrollTop) - finite(view.originY, finite(view.height) / 2)) / zoom,
  }
}

export function boardZoomScroll(view, previousScale, nextScale, anchor = null, nextOrigin = null) {
  const point = anchor || { x: finite(view.width) / 2, y: finite(view.height) / 2 }
  const world = boardPointAt(point, view, previousScale)
  const zoom = boardScale(nextScale)
  return {
    left: Math.max(
      0,
      world.x * zoom + finite(nextOrigin?.x, finite(view.originX, finite(view.width) / 2)) - finite(point.x),
    ),
    top: Math.max(
      0,
      world.y * zoom + finite(nextOrigin?.y, finite(view.originY, finite(view.height) / 2)) - finite(point.y),
    ),
  }
}

export function boardContentBounds(items) {
  if (!items?.length) return null
  const rects = items.map(boardRect)
  const left = Math.min(...rects.map((item) => item.x))
  const top = Math.min(...rects.map((item) => item.y))
  const right = Math.max(...rects.map((item) => item.x + item.w))
  const bottom = Math.max(...rects.map((item) => item.y + item.h))
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

export function boardFitView(items, view, padding = 40) {
  const width = Math.max(1, finite(view.width, 1))
  const height = Math.max(1, finite(view.height, 1))
  const bounds = boardContentBounds(items)
  const originX = finite(view.originX, width / 2)
  const originY = finite(view.originY, height / 2)
  if (!bounds) return { scale: 1, left: originX, top: originY }
  const availableWidth = Math.max(1, width - 2 * Math.min(padding, width / 4))
  const availableHeight = Math.max(1, height - 2 * Math.min(padding, height / 4))
  const scale = boardScale(Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height))
  return {
    scale,
    left: Math.max(0, ((bounds.left + bounds.right) / 2) * scale + originX - width / 2),
    top: Math.max(0, ((bounds.top + bounds.bottom) / 2) * scale + originY - height / 2),
  }
}
