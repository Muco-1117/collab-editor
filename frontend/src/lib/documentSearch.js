import { fieldValue } from '../collab/collabState.js'

export const MAX_FIND_QUERY_LENGTH = 128

export function findDocumentMatches(elements, query) {
  const text = String(query ?? '').slice(0, MAX_FIND_QUERY_LENGTH)
  if (!text) return []
  const literal = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(literal, 'giu')
  const matches = []
  for (const element of elements || []) {
    if (element?.type !== 'TEXT' || fieldValue(element, '#tombstone', false) === true) continue
    const content = String(fieldValue(element, 'text', ''))
    // RegExp match indices address the original UTF-16 string, just like a
    // textarea selection. Lowercasing a whole string can change its length.
    for (const match of content.matchAll(pattern)) {
      matches.push({ id: element.id, start: match.index, end: match.index + match[0].length })
    }
  }
  return matches
}

export function retainMatchIndex(matches, previous, fallbackIndex = 0) {
  if (!matches.length) return -1
  if (previous) {
    const same = matches.findIndex(
      (match) => match.id === previous.id && match.start === previous.start && match.end === previous.end,
    )
    if (same !== -1) return same
    const paragraph = matches.findIndex((match) => match.id === previous.id && match.start >= previous.start)
    if (paragraph !== -1) return paragraph
    const sameParagraph = matches.findIndex((match) => match.id === previous.id)
    if (sameParagraph !== -1) return sameParagraph
  }
  return Math.min(Math.max(0, fallbackIndex), matches.length - 1)
}
