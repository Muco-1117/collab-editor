import { describe, expect, it } from 'vitest'
import {
  boardReplayStyle,
  cardsForHistoryColumn,
  normalizeHistoryRevision,
  sortHistoryElements,
  visibleHistoryElements,
} from '../lib/historyPreview.js'

function element(id, type, fields = {}) {
  return {
    id,
    type,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])),
  }
}

describe('history preview model', () => {
  it('keeps whiteboard geometry, color and layer in replay styles', () => {
    const card = element('card-a', 'CARD', {
      x: 315, y: 84, w: 286, h: 172, z: 7, color: '#dcecff',
    })

    expect(boardReplayStyle(card)).toEqual({
      transform: 'translate(315px, 84px)',
      width: '286px',
      height: '172px',
      zIndex: 7,
      background: '#dcecff',
    })
  })

  it('filters tombstones and preserves column and card order', () => {
    const elements = [
      element('column-b', 'COLUMN', { order: 2048 }),
      element('card-late', 'CARD', { column: 'column-a', order: 300 }),
      element('column-a', 'COLUMN', { order: 1024 }),
      element('card-early', 'CARD', { column: 'column-a', order: 100 }),
      element('card-deleted', 'CARD', { column: 'column-a', order: 1, '#tombstone': true }),
    ]

    const columns = sortHistoryElements(visibleHistoryElements(elements, 'COLUMN'))
    const cards = visibleHistoryElements(elements, 'CARD')

    expect(columns.map(({ id }) => id)).toEqual(['column-a', 'column-b'])
    expect(cardsForHistoryColumn(cards, 'column-a').map(({ id }) => id)).toEqual(['card-early', 'card-late'])
  })

  it('accepts every integral revision in range, including zero and current', () => {
    expect(normalizeHistoryRevision('0', 250)).toBe(0)
    expect(normalizeHistoryRevision('137', 250)).toBe(137)
    expect(normalizeHistoryRevision('250', 250)).toBe(250)
    expect(normalizeHistoryRevision('251', 250)).toBeNull()
    expect(normalizeHistoryRevision('1.5', 250)).toBeNull()
  })
})
