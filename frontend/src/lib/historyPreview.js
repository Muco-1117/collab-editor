import { compareElementOrder } from '../collab/ordering.js'

export function historyValue(element, field, fallback = '') {
  const raw = element?.fields?.[field]
  return raw && typeof raw === 'object' && Object.hasOwn(raw, 'value')
    ? raw.value ?? fallback
    : raw ?? fallback
}

export function visibleHistoryElements(elements, type) {
  return (elements || []).filter((element) => (
    element?.type === type && historyValue(element, '#tombstone', false) !== true
  ))
}

export function sortHistoryElements(elements, field = 'order') {
  return [...(elements || [])].sort((left, right) => compareElementOrder(left, right, field))
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function boardReplayStyle(card) {
  const x = Math.max(0, finiteNumber(historyValue(card, 'x', 48), 48))
  const y = Math.max(0, finiteNumber(historyValue(card, 'y', 48), 48))
  const width = Math.max(150, finiteNumber(historyValue(card, 'w', 220), 220))
  const height = Math.max(110, finiteNumber(historyValue(card, 'h', 150), 150))
  return {
    transform: `translate(${x}px, ${y}px)`,
    width: `${width}px`,
    height: `${height}px`,
    zIndex: finiteNumber(historyValue(card, 'z', 1), 1),
    background: historyValue(card, 'color', '#fff1a8'),
  }
}

export function cardsForHistoryColumn(cards, columnId) {
  return sortHistoryElements(
    (cards || []).filter((card) => String(historyValue(card, 'column', '')) === String(columnId)),
  )
}

export function normalizeHistoryRevision(value, maximum) {
  const revision = Number(value)
  const max = Number(maximum)
  if (!Number.isInteger(revision) || !Number.isFinite(max) || revision < 0 || revision > max) return null
  return revision
}
