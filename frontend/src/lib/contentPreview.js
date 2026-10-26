import {
  cardsForHistoryColumn,
  historyValue,
  sortHistoryElements,
  visibleHistoryElements,
} from './historyPreview.js'

function numberInRange(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback
}

function text(value, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
}

function color(value, fallback) {
  return typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
    ? value
    : fallback
}

export function createDocumentPreview(elements = []) {
  const paragraphs = sortHistoryElements(visibleHistoryElements(elements, 'TEXT'))
  const lines = paragraphs.map((paragraph) => text(historyValue(paragraph, 'text')).trim()).filter(Boolean)
  const characterCount = lines.reduce((count, line) => count + Array.from(line.replace(/\s/g, '')).length, 0)
  return {
    excerpt: lines.join('  ').slice(0, 220),
    paragraphCount: paragraphs.length,
    imageCount: visibleHistoryElements(elements, 'IMAGE').length,
    characterCount,
  }
}

export function createBoardPreview(elements = []) {
  const items = sortHistoryElements(
    [...visibleHistoryElements(elements, 'CARD'), ...visibleHistoryElements(elements, 'IMAGE')],
    'z',
  ).map((element) => ({
    id: element.id,
    type: element.type,
    x: numberInRange(historyValue(element, 'x', 48), 48, 0, 10_000_000),
    y: numberInRange(historyValue(element, 'y', 48), 48, 0, 10_000_000),
    width: numberInRange(historyValue(element, 'w', 220), 220, 150, 1_000_000),
    height: numberInRange(historyValue(element, 'h', 150), 150, 110, 1_000_000),
    color: color(historyValue(element, 'color'), element.type === 'IMAGE' ? '#ffffff' : '#fff1a8'),
    text: text(historyValue(element, 'text')).slice(0, 600),
    assetId: text(historyValue(element, 'assetId')),
    name: text(historyValue(element, 'name'), '白板图片'),
  }))

  if (!items.length) return { items, viewBox: '0 0 640 360', count: 0 }

  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const item of items) {
    left = Math.min(left, item.x)
    top = Math.min(top, item.y)
    right = Math.max(right, item.x + item.width)
    bottom = Math.max(bottom, item.y + item.height)
  }
  const width = Math.max(640, right - left + 64)
  const height = Math.max(360, bottom - top + 64)
  return {
    items,
    viewBox: `${(left + right - width) / 2} ${(top + bottom - height) / 2} ${width} ${height}`,
    count: items.length,
  }
}

export function createKanbanPreview(elements = [], columnLimit = 3, cardLimit = 3) {
  const allColumns = sortHistoryElements(visibleHistoryElements(elements, 'COLUMN'))
  const allCards = visibleHistoryElements(elements, 'CARD')
  const visibleColumnIds = new Set(allColumns.map((column) => String(column.id)))
  const cardCount = allCards.filter((card) =>
    visibleColumnIds.has(String(historyValue(card, 'column'))),
  ).length
  const distribution = allColumns.map((column) => ({
    id: column.id,
    title: text(historyValue(column, 'title'), '未命名列表') || '未命名列表',
    count: cardsForHistoryColumn(allCards, column.id).length,
  }))
  const columns = allColumns.slice(0, columnLimit).map((column) => {
    const cards = cardsForHistoryColumn(allCards, column.id)
    return {
      id: column.id,
      title: text(historyValue(column, 'title'), '未命名列表') || '未命名列表',
      count: cards.length,
      remaining: Math.max(0, cards.length - cardLimit),
      cards: cards.slice(0, cardLimit).map((card) => ({
        id: card.id,
        text: text(historyValue(card, 'text')).slice(0, 180),
        color: color(historyValue(card, 'color'), '#ffffff'),
        coverId: text(historyValue(card, 'coverId')),
        coverName: text(historyValue(card, 'coverName'), '任务封面'),
      })),
    }
  })
  return {
    columns,
    distribution,
    columnCount: allColumns.length,
    cardCount,
    remaining: allColumns.length - columns.length,
  }
}
