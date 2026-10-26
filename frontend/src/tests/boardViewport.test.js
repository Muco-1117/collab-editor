import { describe, expect, it } from 'vitest'
import {
  boardContentBounds,
  boardFitView,
  boardPointAt,
  boardRect,
  boardScale,
  boardZoomScroll,
} from '../lib/boardViewport.js'

describe('whiteboard view coordinates', () => {
  it.each([0.1, 0.25, 0.5, 1, 2])('maps viewport pixels to world units at %s zoom', (scale) => {
    const view = { width: 1000, height: 700, scrollLeft: 500 + 300 * scale, scrollTop: 350 + 80 * scale }
    const point = boardPointAt({ x: 120 * scale, y: 60 * scale }, view, scale)
    expect(point).toEqual({ x: 420, y: 140 })
    const next = boardPointAt({ x: 200 * scale, y: 100 * scale }, view, scale)
    expect(next.x - point.x).toBeCloseTo(80)
    expect(next.y - point.y).toBeCloseTo(40)
  })

  it('keeps the world point beneath the pointer fixed while zooming', () => {
    const view = { width: 1000, height: 700, scrollLeft: 900, scrollTop: 640 }
    const anchor = { x: 190, y: 250 }
    const before = boardPointAt(anchor, view, 0.5)
    const scroll = boardZoomScroll(view, 0.5, 1.75, anchor)
    const after = boardPointAt(anchor, { ...view, scrollLeft: scroll.left, scrollTop: scroll.top }, 1.75)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('preserves the initial unpadded viewport when zoom adds navigation space', () => {
    const view = { width: 1000, height: 700, scrollLeft: 0, scrollTop: 0, originX: 0, originY: 0 }
    const scroll = boardZoomScroll(view, 1, 0.5, null, { x: 500, y: 350 })
    expect(scroll).toEqual({ left: 250, top: 175 })
    expect(
      boardPointAt(
        { x: 500, y: 350 },
        { ...view, originX: 500, originY: 350, scrollLeft: scroll.left, scrollTop: scroll.top },
        0.5,
      ),
    ).toEqual({ x: 500, y: 350 })
  })

  it('preserves the centre for toolbar zoom and clamps scrolling at the boundary', () => {
    const view = { width: 800, height: 600, scrollLeft: 420, scrollTop: 300 }
    expect(boardZoomScroll(view, 1, 2)).toEqual({ left: 840, top: 600 })
    expect(boardZoomScroll({ ...view, scrollLeft: 0, scrollTop: 0 }, 0.5, 2, { x: 0, y: 0 })).toEqual({
      left: 0,
      top: 0,
    })
  })

  it('fits distant cards and images inside both viewport axes with padding', () => {
    const rects = [
      { x: 40, y: 20, w: 220, h: 150 },
      { x: 1500, y: 900, w: 320, h: 220 },
    ]
    const view = { width: 380, height: 600 }
    const fit = boardFitView(rects, view, 24)
    const bounds = boardContentBounds(rects)
    const left = bounds.left * fit.scale + view.width / 2 - fit.left
    const top = bounds.top * fit.scale + view.height / 2 - fit.top
    expect(left).toBeGreaterThanOrEqual(23.99)
    expect(top).toBeGreaterThanOrEqual(23.99)
    expect(left + bounds.width * fit.scale).toBeLessThanOrEqual(view.width - 23.99)
    expect(top + bounds.height * fit.scale).toBeLessThanOrEqual(view.height - 23.99)
  })

  it('centres one card at the origin and uses a usable default for an empty canvas', () => {
    expect(boardFitView([{ x: 0, y: 0, w: 220, h: 150 }], { width: 800, height: 600 })).toEqual({
      scale: 1,
      left: 110,
      top: 75,
    })
    expect(boardFitView([], { width: 800, height: 600 })).toEqual({ scale: 1, left: 400, top: 300 })
  })

  it('bounds malformed coordinates and unsupported zoom values without returning NaN', () => {
    expect(boardRect({ x: -20, y: Infinity, w: 'not-a-width', h: 0 })).toEqual({ x: 0, y: 0, w: 220, h: 110 })
    expect(boardScale(Infinity)).toBe(1)
    expect(boardScale(0)).toBe(0.1)
    expect(boardScale(10)).toBe(2)
  })
})
