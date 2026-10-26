import { describe, expect, it } from 'vitest'
import { createBoardPreview, createDocumentPreview, createKanbanPreview } from '../lib/contentPreview.js'

function element(id, type, fields = {}) {
  return {
    id,
    type,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])),
  }
}

describe('content library previews', () => {
  it('extracts ordered document text and real counts without deleted content or HTML interpretation', () => {
    const result = createDocumentPreview([
      element('second', 'TEXT', { order: 20, text: ' 第二段 ' }),
      element('first', 'TEXT', { order: 10, text: '<b>正文</b>' }),
      element('blank', 'TEXT', { order: 30, text: '' }),
      element('gone', 'TEXT', { text: '已删除内容', '#tombstone': true }),
      element('image', 'IMAGE', { assetId: 'asset' }),
      element('gone-image', 'IMAGE', { '#tombstone': true }),
    ])
    expect(result).toEqual({
      excerpt: '<b>正文</b>  第二段',
      paragraphCount: 3,
      imageCount: 1,
      characterCount: 12,
    })
    expect(createDocumentPreview([])).toEqual({
      excerpt: '',
      paragraphCount: 0,
      imageCount: 0,
      characterCount: 0,
    })
  })
  it('fits real whiteboard geometry without changing relative position, size or layer order', () => {
    const result = createBoardPreview([
      element('image', 'IMAGE', { x: 420, y: 600, w: 300, h: 200, z: 2, assetId: 'real-asset' }),
      element('note', 'CARD', { x: 120, y: 100, w: 220, h: 150, z: 1, text: '真实内容', color: '#dcecff' }),
      element('deleted', 'CARD', { x: 5000, '#tombstone': true }),
      element('unrelated', 'TEXT', { text: '不是白板内容' }),
    ])
    expect(result.count).toBe(2)
    expect(result.items.map((item) => item.id)).toEqual(['note', 'image'])
    expect(result.items[0]).toMatchObject({
      x: 120,
      y: 100,
      width: 220,
      height: 150,
      color: '#dcecff',
      text: '真实内容',
    })
    expect(result.items[1].assetId).toBe('real-asset')
    const [left, top, width, height] = result.viewBox.split(' ').map(Number)
    for (const item of result.items) {
      expect(item.x).toBeGreaterThanOrEqual(left)
      expect(item.y).toBeGreaterThanOrEqual(top)
      expect(item.x + item.width).toBeLessThanOrEqual(left + width)
      expect(item.y + item.height).toBeLessThanOrEqual(top + height)
    }
  })

  it('keeps malformed geometry finite and cannot turn a saved color into a remote resource', () => {
    const result = createBoardPreview([
      element('bad', 'CARD', { x: Infinity, y: 'bad', w: -2, h: NaN, color: 'url(https://example.com)' }),
    ])
    expect(result.viewBox.split(' ').map(Number).every(Number.isFinite)).toBe(true)
    expect(result.items[0]).toMatchObject({ x: 48, y: 48, width: 150, height: 150, color: '#fff1a8' })
    expect(createBoardPreview([])).toEqual({ items: [], viewBox: '0 0 640 360', count: 0 })
  })

  it('uses actual column membership, ignores deleted columns and tasks, and preserves ordering', () => {
    const result = createKanbanPreview([
      element('b', 'COLUMN', { title: '进行中', order: 200 }),
      element('a', 'COLUMN', { title: '待开始', order: 100 }),
      element('gone', 'COLUMN', { title: '已删除', '#tombstone': true }),
      element('late', 'CARD', { column: 'a', order: 20, text: '第二项' }),
      element('early', 'CARD', { column: 'a', order: 10, text: '第一项', coverId: 'asset-a' }),
      element('removed', 'CARD', { column: 'a', '#tombstone': true }),
      element('orphan', 'CARD', { column: 'gone', text: '已删除列中的任务' }),
    ])
    expect(result.columnCount).toBe(2)
    expect(result.cardCount).toBe(2)
    expect(result.columns.map((column) => column.id)).toEqual(['a', 'b'])
    expect(result.columns[0].cards.map((card) => card.text)).toEqual(['第一项', '第二项'])
    expect(result.columns[0].cards[0].coverId).toBe('asset-a')
    expect(result.columns[1].cards).toEqual([])
  })

  it('limits visible tasks while reporting real totals and omitted content', () => {
    const elements = [1, 2, 3, 4].flatMap((column) => [
      element(`col-${column}`, 'COLUMN', { title: `列表 ${column}`, order: column }),
      ...[1, 2, 3, 4, 5].map((card) =>
        element(`${column}-${card}`, 'CARD', { column: `col-${column}`, order: card, text: `任务 ${card}` }),
      ),
    ])
    const result = createKanbanPreview(elements)
    expect(result).toMatchObject({ columnCount: 4, cardCount: 20, remaining: 1 })
    expect(result.columns).toHaveLength(3)
    expect(result.columns[0]).toMatchObject({ count: 5, remaining: 2 })
    expect(result.columns[0].cards).toHaveLength(3)
    expect(result.distribution.map((column) => column.count)).toEqual([5, 5, 5, 5])
    expect(elements).toHaveLength(24)
  })
})
