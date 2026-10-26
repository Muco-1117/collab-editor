import { describe, expect, it } from 'vitest'
import { findDocumentMatches, MAX_FIND_QUERY_LENGTH, retainMatchIndex } from '../lib/documentSearch.js'

const text = (id, value, extra = {}) => ({
  id,
  type: 'TEXT',
  fields: { text: { value }, ...extra },
})

describe('document text search', () => {
  it('finds case-insensitive literal occurrences in paragraph order', () => {
    expect(findDocumentMatches([text('first', 'Vue vue VUE'), text('second', 'vue')], 'vUe')).toEqual([
      { id: 'first', start: 0, end: 3 },
      { id: 'first', start: 4, end: 7 },
      { id: 'first', start: 8, end: 11 },
      { id: 'second', start: 0, end: 3 },
    ])
  })

  it('treats regular expression characters literally', () => {
    const query = '[a+b]*(x)? $^.{|}\\'
    expect(findDocumentMatches([text('one', `前缀 ${query} 后缀`)], query)).toEqual([
      { id: 'one', start: 3, end: 3 + query.length },
    ])
  })

  it('keeps original UTF-16 offsets around emoji and case-folding characters', () => {
    expect(findDocumentMatches([text('one', '😀İ 前文Vue vue')], 'VUE')).toEqual([
      { id: 'one', start: 6, end: 9 },
      { id: 'one', start: 10, end: 13 },
    ])
    expect(findDocumentMatches([text('emoji', '😀想法😀')], '😀')).toEqual([
      { id: 'emoji', start: 0, end: 2 },
      { id: 'emoji', start: 4, end: 6 },
    ])
  })

  it('uses Unicode insensitive matching without inventing full-word transliteration', () => {
    expect(findDocumentMatches([text('greek', 'Σ σ ς')], 'σ')).toHaveLength(3)
    expect(findDocumentMatches([text('german', 'Straße')], 'STRASSE')).toEqual([])
  })

  it('ignores images, columns, tombstones and does not join paragraphs', () => {
    expect(
      findDocumentMatches(
        [
          text('one', 'find'),
          { ...text('image', 'find'), type: 'IMAGE' },
          { ...text('column', 'find'), type: 'COLUMN' },
          text('deleted', 'find', { '#tombstone': { value: true } }),
          text('two', ' fi'),
          text('three', 'nd'),
        ],
        'find',
      ),
    ).toEqual([{ id: 'one', start: 0, end: 4 }])
  })

  it('supports whitespace and multiline text with non-overlapping occurrences', () => {
    expect(findDocumentMatches([text('one', 'aaaa')], 'aa')).toEqual([
      { id: 'one', start: 0, end: 2 },
      { id: 'one', start: 2, end: 4 },
    ])
    expect(findDocumentMatches([text('two', 'one\n two')], '\n ')).toEqual([{ id: 'two', start: 3, end: 5 }])
  })

  it('returns true zero results for an empty query or absent text and bounds query length', () => {
    expect(findDocumentMatches([text('one', '')], 'missing')).toEqual([])
    expect(findDocumentMatches([text('one', 'anything')], '')).toEqual([])
    expect(findDocumentMatches(null, 'anything')).toEqual([])
    const long = 'x'.repeat(MAX_FIND_QUERY_LENGTH + 10)
    expect(findDocumentMatches([text('one', long)], long)).toEqual([
      { id: 'one', start: 0, end: MAX_FIND_QUERY_LENGTH },
    ])
  })

  it('retains the current occurrence after unrelated paragraphs are added or removed', () => {
    const current = { id: 'two', start: 8, end: 11 }
    expect(
      retainMatchIndex(
        [{ id: 'new', start: 0, end: 3 }, { id: 'two', start: 0, end: 3 }, current],
        current,
        1,
      ),
    ).toBe(2)
  })

  it('selects the nearest remaining occurrence when the active result changes', () => {
    const current = { id: 'two', start: 8, end: 11 }
    expect(
      retainMatchIndex(
        [
          { id: 'one', start: 0, end: 3 },
          { id: 'two', start: 15, end: 18 },
        ],
        current,
        0,
      ),
    ).toBe(1)
    expect(retainMatchIndex([{ id: 'one', start: 0, end: 3 }], current, 20)).toBe(0)
    expect(retainMatchIndex([], current, 1)).toBe(-1)
  })
})
